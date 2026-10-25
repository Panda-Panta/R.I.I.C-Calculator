import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const modulePath = fileURLToPath(new URL('../../scripts/unpacker-riic-evidence.mjs', import.meta.url))
const { verifyUnpackerRiicEvidence } = await import(modulePath)
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const version = 'Stream://torappu-data/v078/rel78.0\nChange:126729 on 2026/10/22\nVersionControl:78.4.0\n'
const commit = 'a'.repeat(40)
const tableNames = ['building_data', 'character_table', 'gamedata_const', 'item_table', 'data_version']
let root: string
let options: Record<string, string>
let pc: Record<string, any>
let mirror: Record<string, any>
let extraction: Record<string, any>
let normalization: Record<string, any>
let sources: Record<string, any>

function json(filename: string, value: unknown) {
  mkdirSync(path.dirname(filename), { recursive: true })
  writeFileSync(filename, JSON.stringify(value) + '\n')
}
function bytes(filename: string) {
  const value = readFileSync(filename)
  return { sha256: sha(value), bytes: value.length }
}
function save() {
  for (const [name, value] of Object.entries(pc)) json(path.join(options.pcDirectory!, name + '.json'), value)
  for (const [name, value] of Object.entries(mirror)) json(path.join(options.mirrorDirectory!, name + '.json'), value)
  for (const directory of [options.pcDirectory!, options.mirrorDirectory!]) writeFileSync(path.join(directory, 'data_version.txt'), version)
  normalization.outputFiles = Object.fromEntries(tableNames.map(name => {
    const file = name === 'data_version' ? 'data_version.txt' : name + '.json'
    return [file, bytes(path.join(options.pcDirectory!, file))]
  }))
  json(options.normalizationReceiptPath!, normalization)
  json(options.extractionReceiptPath!, extraction)
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'riic-unpacker-evidence-'))
  const rawDirectory = path.join(root, 'raw')
  const pcDirectory = path.join(root, 'normalized')
  const mirrorDirectory = path.join(root, 'mirror')
  for (const directory of [rawDirectory, pcDirectory, mirrorDirectory]) mkdirSync(directory)
  const buff = (id: string, description: string) => ({ buffId: id, buffName: id, roomType: 'WORKSHOP',
    buffCategory: 'OUTPUT', description, efficiency: 0, targets: ['F_EVOLVE'], skillIcon: 'workshop', targetGroupSortId: 0 })
  const skillSlots = [{ buffData: [
    { buffId: 'craft_alpha', cond: { phase: 'PHASE_0', level: 1 } },
    { buffId: 'craft_beta', cond: { phase: 'PHASE_2', level: 1 } },
  ] }]
  const rooms = Object.fromEntries(['CONTROL', 'POWER', 'MANUFACTURE', 'TRADING', 'DORMITORY', 'MEETING', 'HIRE', 'WORKSHOP', 'TRAINING', 'RECYCLE'].map(name => [name, {
    name, maxCount: 1, phases: [{ electricity: 0, maxStationedNum: 1, manpowerCost: 100 }],
  }]))
  mirror = {
    building_data: { chars: { char_test: { buffChar: skillSlots, maxManpower: 8640000 } },
      buffs: { craft_alpha: buff('craft_alpha', '进驻加工站时，副产品概率提升50%'), craft_beta: buff('craft_beta', '进驻加工站时，副产品概率提升90%') },
      rooms, workshopFormulas: { '65': { formulaId: '65', itemId: '31094', extraOutcomeRate: .1 } },
      recycleData: { phases: [] }, recycleRoomConsts: {}, recycleRoomInputItemDatas: {},
      recycleRoomOutputPoolDatas: {}, recycleRoomOutputPoolContentDatas: {} },
    character_table: { char_test: { name: '测试干员', appellation: 'Test', rarity: 'TIER_6', profession: 'WARRIOR',
      isNotObtainable: false, isSpChar: false, nationId: 'iberia', groupId: null, teamId: null, phases: [{ maxLevel: 50 }, { maxLevel: 80 }, { maxLevel: 90 }] } },
    gamedata_const: { termDescriptionDict: { 'cc.test': { termId: 'cc.test', description: '包含以下干员\n测试干员' } } },
    item_table: { items: { '31094': { name: '手性屈光体' } } },
  }
  pc = structuredClone(mirror)
  for (const value of Object.values(pc.building_data.buffs)) (value as any).buffCategory = 2
  for (const name of ['recycleData', 'recycleRoomConsts', 'recycleRoomInputItemDatas', 'recycleRoomOutputPoolDatas', 'recycleRoomOutputPoolContentDatas']) delete pc.building_data[name]
  sources = { version: '78.4.0', resource_version: '26-10-22-test', manifest: 'D:\\Private\\active.idx', manifest_sha256: 'b'.repeat(64),
    complete: true, diagnostics: [], tables: {} }
  normalization = { version: '78.4.0', resourceVersion: sources.resource_version, normalizerSha256: 'c'.repeat(64), diagnostics: [], preservedRawInputs: {} }
  extraction = { retrievedAt: '2026-10-25T00:00:00.000Z', toolVersion: '0.1.10', toolGitCommit: 'd'.repeat(40),
    decoderVersion: 'pc-fbs-test', schemaCommit: 'e'.repeat(40), complete: true, diagnostics: [], missingTables: [],
    requestedTables: tableNames, version: '78.4.0', resourceVersion: sources.resource_version,
    toolSourceFiles: [{ path: 'src/arknights_unpacker/gamedata/normalize.py', sha256: normalization.normalizerSha256 }], outputFiles: {} }
  for (const name of tableNames) {
    const sourcePath = path.join(rawDirectory, name + '.bin')
    writeFileSync(sourcePath, name)
    normalization.preservedRawInputs[name] = { path: sourcePath, ...bytes(sourcePath) }
    sources.tables[name] = { source: { path: 'D:\\Private\\' + name + '.bin', layer: 'hot', logical_name: 'gamedata/excel/' + name, sha256: sha(name), decoder_version: extraction.decoderVersion } }
    const rawPath = path.join(rawDirectory, name + '.json')
    json(rawPath, name === 'data_version' ? { raw: version } : pc[name])
    extraction.outputFiles[name + '.json'] = bytes(rawPath)
  }
  options = { pcDirectory, mirrorDirectory, extractionReceiptPath: path.join(root, 'extraction.json'),
    normalizationReceiptPath: path.join(root, 'normalization.json'), sourceManifestPath: path.join(rawDirectory, 'sources.json'), mirrorCommit: commit }
  json(options.sourceManifestPath!, sources)
  extraction.outputFiles['sources.json'] = bytes(options.sourceManifestPath!)
  save()
})
afterEach(() => {
  const target = path.resolve(root)
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('riic-unpacker-evidence-')) {
    throw new Error('Refusing cleanup outside the dedicated Unpacker test directory')
  }
  rmSync(target, { recursive: true, force: true })
})

describe('local Unpacker evidence against a pinned mirror', () => {
  it('binds the semantic comparison to the actual inputs and preserves the extraction gap without private paths', () => {
    const evidence = verifyUnpackerRiicEvidence(options)
    expect(evidence.verification).toMatchObject({ operators: 1, skillStages: 2, highestSkills: 1, buffDefinitions: 2, terms: 1 })
    expect(evidence.mirror.commit).toBe(commit)
    expect(evidence.mirror.sources['character_table.json'].sha256).toBe(bytes(path.join(options.mirrorDirectory!, 'character_table.json')).sha256)
    expect(evidence.tables.character_table.source.filename).toBe('character_table.bin')
    expect(evidence.unknownFields.buildingRoots).toContain('recycleRoomConsts')
    expect(JSON.stringify(evidence)).not.toContain(root)
    expect(JSON.stringify(evidence)).not.toContain('D:')
    expect(evidence.tool.workingTreeDirty).toBeNull()
    extraction.toolGitDirty = true
    save()
    expect(verifyUnpackerRiicEvidence(options).tool.workingTreeDirty).toBe(true)
  })
  it('rejects changed low-stage conditions even when the maximum snapshot is unchanged', () => {
    pc.building_data.chars.char_test.buffChar[0].buffData[0].cond.level = 30
    save()
    expect(() => verifyUnpackerRiicEvidence(options)).toThrow(/slots/)
  })
  it('rejects duplicate unlock stages instead of silently taking the final version', () => {
    pc.building_data.chars.char_test.buffChar[0].buffData.push(structuredClone(pc.building_data.chars.char_test.buffChar[0].buffData[0]))
    save()
    expect(() => verifyUnpackerRiicEvidence(options)).toThrow(/Duplicate.*stage/)
  })
  it.each(['efficiency', 'description'])('rejects a changed known buff %s', field => {
    pc.building_data.buffs.craft_beta[field] = field === 'efficiency' ? 1 : '仅同站特定对象存在时，副产品概率提升90%'
    save()
    expect(() => verifyUnpackerRiicEvidence(options)).toThrow(/buffs/)
  })
  it('rejects a newly obtainable operator omitted from the PC extraction', () => {
    delete pc.character_table.char_test
    save()
    expect(() => verifyUnpackerRiicEvidence(options)).toThrow(/operators/)
  })
  it('rejects changed identity and nested RIIC term content', () => {
    pc.character_table.char_test.groupId = 'abyssal'
    save()
    expect(() => verifyUnpackerRiicEvidence(options)).toThrow(/operators/)
    pc.character_table = structuredClone(mirror.character_table)
    pc.gamedata_const.termDescriptionDict['cc.test'].description += '、其他干员'
    save()
    expect(() => verifyUnpackerRiicEvidence(options)).toThrow(/terms/)
  })
  it('rejects normalized-byte tampering and incomplete extraction receipts', () => {
    writeFileSync(path.join(options.pcDirectory!, 'building_data.json'), '{}')
    expect(() => verifyUnpackerRiicEvidence(options)).toThrow(/normalized.*SHA-256/)
    save()
    extraction.complete = false
    save()
    expect(() => verifyUnpackerRiicEvidence(options)).toThrow(/complete/)
  })
  it('rejects numeric formula and facility changes outside operator descriptions', () => {
    pc.building_data.workshopFormulas['65'].extraOutcomeRate = .2
    save()
    expect(() => verifyUnpackerRiicEvidence(options)).toThrow(/workshop formulas/)
    pc.building_data.workshopFormulas['65'].extraOutcomeRate = .1
    pc.building_data.rooms.RECYCLE.phases[0].electricity = -10
    save()
    expect(() => verifyUnpackerRiicEvidence(options)).toThrow(/rooms/)
  })
  it('rejects changed data versions and a newly decoded recycle value that contradicts the mirror', () => {
    writeFileSync(path.join(options.mirrorDirectory!, 'data_version.txt'), version.replace('78.4.0', '78.5.0'))
    expect(() => verifyUnpackerRiicEvidence(options)).toThrow(/versions differ/)
    save()
    pc.building_data.recycleRoomConsts = { recycleTimeRequirement: 1 }
    save()
    expect(() => verifyUnpackerRiicEvidence(options)).toThrow(/building.recycleRoomConsts/)
  })
  it('rejects a changed preserved AB and an unknown buff category', () => {
    const ab = normalization.preservedRawInputs.building_data.path
    writeFileSync(ab, 'changed input')
    expect(() => verifyUnpackerRiicEvidence(options)).toThrow(/AB.*SHA-256/)
    writeFileSync(ab, 'building_data')
    pc.building_data.buffs.craft_alpha.buffCategory = 999
    save()
    expect(() => verifyUnpackerRiicEvidence(options)).toThrow(/buffCategory/)
  })
})
