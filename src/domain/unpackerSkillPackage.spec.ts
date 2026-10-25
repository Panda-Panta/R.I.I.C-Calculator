import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

interface GameSource {
  commit: string
  sourceVersion: string
  sources: Record<string, { url: string; sha256: string }>
  counts: { operators: number; buffDefinitions: number; skillStages: number; highestSkills: number; terms: number }
  unpackerEvidence?: { manifest: string; sha256: string; dataVersion: string }
}

const skillRoot = fileURLToPath(new URL('../../.codex/skills/arknights-riic-mechanics/', import.meta.url))
const validatorUrl = new URL('../../.codex/skills/arknights-riic-mechanics/scripts/validate.mjs', import.meta.url).href
const prefix = path.join(tmpdir(), 'riic-unpacker-skill-')
const versionOf = (value: string) => /VersionControl:([^\s]+)/.exec(value)![1]!
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const jsonText = (value: object) => JSON.stringify(value, null, 2) + '\n'
const unknownRoots = ['recycleData', 'recycleRoomConsts', 'recycleRoomInputItemDatas', 'recycleRoomOutputPoolDatas', 'recycleRoomOutputPoolContentDatas']
let directory: string
let fixture: string
let source: GameSource

function evidenceFor(snapshot: GameSource) {
  return {
    schemaVersion: 1,
    provider: 'ArknightsUnpacker',
    checkedAt: '2026-10-25T12:00:00.000Z',
    tool: {
      version: '0.1.10',
      commit: '7'.repeat(40),
      decoderVersion: 'pc-fbs-fixture',
      schemaCommit: '1'.repeat(40),
      normalizerSha256: '2'.repeat(64),
      sourceFiles: [{ path: 'src/arknights_unpacker/gamedata/normalize.py', sha256: '2'.repeat(64) }],
    },
    localGame: {
      sourceVersion: snapshot.sourceVersion,
      dataVersion: versionOf(snapshot.sourceVersion),
      resourceVersion: '26-10-22-13-56-52-fixture',
      activeIndex: { filename: 'hot_update_list.json', sha256: '3'.repeat(64) },
    },
    mirror: {
      repository: 'Kengxxiao/ArknightsGameData',
      commit: snapshot.commit,
      sourceVersion: snapshot.sourceVersion,
      sources: Object.fromEntries(Object.entries(snapshot.sources).map(([name, value]) => [name, { ...value, bytes: 100 }])),
    },
    tables: Object.fromEntries(Object.keys(snapshot.sources).map(name => [
      name.replace(/\.(?:json|txt)$/, ''),
      {
        source: { filename: 'fixture-' + name + '.ab', layer: 'hot-update', logicalName: 'gamedata/excel/' + name, sha256: '4'.repeat(64), bytes: 100 },
        raw: { sha256: '5'.repeat(64), bytes: 100 },
        normalized: { sha256: '6'.repeat(64), bytes: 100 },
      },
    ])),
    verification: { ...snapshot.counts, itemNames: 10, workshopFormulas: 20, roomLevels: 30,
      buffCategoryMapping: { '1': 'FUNCTION', '2': 'OUTPUT', '3': 'RECOVERY' },
      comparedFields: ['operators.slots.unlock', 'building.buffs.description'],
    },
    unknownFields: { buildingRoots: [...unknownRoots] },
    evidenceBoundary: 'Known PC fields only; five recycle roots come from the fixed mirror.',
  }
}

let evidence: ReturnType<typeof evidenceFor>

function bindEvidence() {
  const bytes = jsonText(evidence)
  writeFileSync(path.join(fixture, 'references/unpacker-source-manifest.json'), bytes)
  source.unpackerEvidence = { manifest: 'unpacker-source-manifest.json', sha256: digest(bytes), dataVersion: versionOf(source.sourceVersion) }
  writeFileSync(path.join(fixture, 'references/gamedata-source-manifest.json'), jsonText(source))
}

function validate() {
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    'const { validateSkill } = await import(process.argv[1]); validateSkill(process.argv[2], { verifyManifest: false });',
    validatorUrl, fixture], { encoding: 'utf8' })
}

beforeEach(() => {
  directory = mkdtempSync(prefix)
  fixture = path.join(directory, 'arknights-riic-mechanics')
  mkdirSync(fixture)
  cpSync(skillRoot, fixture, { recursive: true })
  source = JSON.parse(readFileSync(path.join(fixture, 'references/gamedata-source-manifest.json'), 'utf8'))
  evidence = evidenceFor(source)
  bindEvidence()
})

afterEach(() => {
  const target = path.resolve(directory)
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('riic-unpacker-skill-')) {
    throw new Error('Unexpected cleanup path')
  }
  rmSync(target, { recursive: true, force: true })
})

describe('skill package binds local extraction evidence to the fixed published snapshot', () => {
  it('accepts matching PC and mirror evidence', () => {
    const result = validate()
    expect(result.status, result.stderr).toBe(0)
  })

  it('keeps packages without the optional extraction receipt compatible', () => {
    delete source.unpackerEvidence
    writeFileSync(path.join(fixture, 'references/gamedata-source-manifest.json'), jsonText(source))
    const result = validate()
    expect(result.status, result.stderr).toBe(0)
  })

  it('rejects a receipt whose bytes no longer match the bound SHA-256', () => {
    source.unpackerEvidence!.sha256 = '0'.repeat(64)
    writeFileSync(path.join(fixture, 'references/gamedata-source-manifest.json'), jsonText(source))
    const result = validate()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Unpacker evidence SHA-256')
  })

  it('rejects a correctly hashed receipt for a different local data version', () => {
    evidence.localGame.dataVersion = '0.0.0'
    bindEvidence()
    const result = validate()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Unpacker data version')
  })

  it('rejects a correctly hashed receipt checked against a different mirror commit', () => {
    evidence.mirror.commit = '0'.repeat(40)
    bindEvidence()
    const result = validate()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Unpacker mirror commit')
  })

  it('rejects a different fixed mirror table even if the receipt is rehashed', () => {
    evidence.mirror.sources['character_table.json']!.sha256 = '0'.repeat(64)
    bindEvidence()
    const result = validate()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Unpacker mirror source: character_table.json')
  })

  it('rejects a claimed stage count that does not match the catalog', () => {
    evidence.verification.skillStages += 1
    bindEvidence()
    const result = validate()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Unpacker skillStages count')
  })

  it('rejects a machine-specific AB path in the distributable receipt', () => {
    evidence.tables.building_data!.source.filename = 'D:\\Games\\private\\fixture.ab'
    bindEvidence()
    const result = validate()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Unpacker source filename')
  })

  it('retains the five PC fields that were not independently decoded', () => {
    evidence.unknownFields.buildingRoots = []
    bindEvidence()
    const result = validate()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Unpacker unknown building fields')
  })
})