import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const TABLES = ['building_data', 'character_table', 'gamedata_const', 'item_table', 'data_version']
const BUFF_CATEGORIES = { 1: 'FUNCTION', 2: 'OUTPUT', 3: 'RECOVERY' }
const RECYCLE_ROOTS = ['recycleData', 'recycleRoomConsts', 'recycleRoomInputItemDatas',
  'recycleRoomOutputPoolDatas', 'recycleRoomOutputPoolContentDatas']
const ROOMS = ['CONTROL', 'POWER', 'MANUFACTURE', 'TRADING', 'DORMITORY', 'MEETING', 'HIRE', 'WORKSHOP', 'TRAINING', 'RECYCLE']
const sha256 = value => createHash('sha256').update(value).digest('hex')
const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'))
const basename = value => String(value).replaceAll('\\', '/').split('/').at(-1)
const record = value => value && typeof value === 'object' && !Array.isArray(value)
const fingerprint = filename => {
  const bytes = fs.readFileSync(filename)
  return { sha256: sha256(bytes), bytes: bytes.length }
}

function checkHash(filename, expected, label) {
  assert.ok(expected && /^[a-f0-9]{64}$/.test(expected.sha256 ?? ''), `${label}: missing SHA-256 receipt`)
  const actual = fingerprint(filename)
  assert.equal(actual.sha256, expected.sha256, `${label}: SHA-256 mismatch`)
  if (expected.bytes !== undefined) assert.equal(actual.bytes, expected.bytes, `${label}: byte count mismatch`)
  return actual
}

// Report the first exact mismatch without dumping whole game tables or local paths.
function compare(actual, expected, label) {
  if (Object.is(actual, expected)) return
  if (Array.isArray(actual) && Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, `${label}: length mismatch`)
    actual.forEach((value, index) => compare(value, expected[index], `${label}[${index}]`))
  } else if (record(actual) && record(expected)) {
    const keys = Object.keys(actual).sort(), expectedKeys = Object.keys(expected).sort()
    assert.deepEqual(keys, expectedKeys, `${label}: keys mismatch`)
    for (const key of keys) compare(actual[key], expected[key], `${label}.${key}`)
  } else assert.deepEqual(actual, expected, `${label}: value mismatch`)
}

function operators(building, characters, label) {
  const result = {}, names = new Set()
  for (const [id, value] of Object.entries(characters)) {
    if (!value.name || id.startsWith('trap_') || value.profession === 'TOKEN' || value.isNotObtainable) continue
    const data = building.chars[id]
    if (!data?.buffChar?.length) continue
    assert.ok(!names.has(value.name), `${label}: duplicate operator name ${value.name}`)
    names.add(value.name)
    const slots = data.buffChar.map((slot, index) => {
      assert.ok(Array.isArray(slot.buffData), `${label}.${id}.slots[${index}]: missing stages`)
      const unlocks = new Set()
      return slot.buffData.map(stage => {
        assert.ok(building.buffs[stage.buffId], `${label}.${id}: missing buff ${stage.buffId}`)
        assert.match(stage.cond?.phase ?? '', /^PHASE_[012]$/, `${label}.${id}: unknown phase`)
        assert.ok(Number.isInteger(stage.cond.level) && stage.cond.level >= 1, `${label}.${id}: invalid level`)
        const unlock = `${stage.cond.phase}/${stage.cond.level}`
        assert.ok(!unlocks.has(unlock), `Duplicate unlock stage: ${label}.${id}.slots[${index}]/${unlock}`)
        unlocks.add(unlock)
        return { buffId: stage.buffId, cond: stage.cond }
      })
    })
    result[id] = { name: value.name, appellation: value.appellation ?? '', rarity: value.rarity,
      profession: value.profession, levelCaps: value.phases.map(phase => phase.maxLevel),
      nationId: value.nationId ?? null, groupId: value.groupId ?? null, teamId: value.teamId ?? null,
      isAlter: Boolean(value.isSpChar), maxManpower: data.maxManpower, slots }
  }
  assert.ok(Object.keys(result).length > 0, `${label}: no obtainable RIIC operators`)
  return result
}

function buffDefinitions(building, local) {
  return Object.fromEntries(Object.entries(building.buffs).map(([id, value]) => {
    if (!local) return [id, value]
    const category = BUFF_CATEGORIES[value.buffCategory]
    assert.ok(category, `buffCategory: unknown PC category ${value.buffCategory} for ${id}`)
    return [id, { ...value, buffCategory: category }]
  }))
}

function roomLevels(building) {
  return Object.fromEntries(ROOMS.map(name => {
    const room = building.rooms[name]
    assert.ok(room && Array.isArray(room.phases), `rooms.${name}: missing room phases`)
    return [name, { name: room.name, maxCount: room.maxCount,
      phases: room.phases.map(phase => ({ electricity: phase.electricity,
        maxStationedNum: phase.maxStationedNum, manpowerCost: phase.manpowerCost })) }]
  }))
}

const workshopFormulas = building => Object.fromEntries(Object.entries(building.workshopFormulas).map(([id, value]) =>
  [id, { formulaId: value.formulaId, itemId: value.itemId, extraOutcomeRate: value.extraOutcomeRate }]))
const itemNames = table => Object.fromEntries(Object.entries(table.items).map(([id, value]) => [id, value.name]))
const terms = table => Object.fromEntries(Object.entries(table.termDescriptionDict).filter(([id]) => id.startsWith('cc.')))

/**
 * Verify production-normalized local PC exports against a pinned GameData mirror.
 * Paths point to the two five-table directories and the existing Unpacker receipts;
 * only the returned sanitized object is suitable for the portable skill package.
 * This verifies bytes and listed RIIC semantics, not the decoder or live game effects.
 */
export function verifyUnpackerRiicEvidence({ pcDirectory, mirrorDirectory, extractionReceiptPath,
  normalizationReceiptPath, sourceManifestPath, mirrorCommit }) {
  assert.match(mirrorCommit ?? '', /^[a-f0-9]{40}$/, 'Invalid pinned mirror commit')
  const extraction = readJson(extractionReceiptPath)
  const normalization = readJson(normalizationReceiptPath)
  const sources = readJson(sourceManifestPath)
  for (const [label, receipt] of [['extraction', extraction], ['normalization', normalization], ['sources', sources]]) {
    assert.ok(Array.isArray(receipt.diagnostics) && !receipt.diagnostics.length, `${label}: nonempty or missing diagnostics`)
  }
  assert.ok(extraction.complete && sources.complete && extraction.missingTables?.length === 0, 'Extraction must be complete')
  compare([...extraction.requestedTables].sort(), [...TABLES].sort(), 'requested tables')
  const rawDirectory = path.dirname(sourceManifestPath)
  for (const [name, expected] of Object.entries(extraction.outputFiles)) {
    assert.equal(name, basename(name), 'Raw receipt filename must be relative')
    checkHash(path.join(rawDirectory, name), expected, `raw ${name}`)
  }
  checkHash(sourceManifestPath, extraction.outputFiles['sources.json'], 'sources receipt')
  const pc = {}, mirror = {}, tableEvidence = {}, mirrorSources = {}
  const downloadsPath = path.join(mirrorDirectory, 'downloads.json')
  const downloads = fs.existsSync(downloadsPath) ? readJson(downloadsPath) : null
  if (downloads) assert.equal(downloads.commit, mirrorCommit, 'Mirror receipt commit mismatch')
  for (const table of TABLES) {
    const name = table === 'data_version' ? 'data_version.txt' : `${table}.json`
    const normalized = checkHash(path.join(pcDirectory, name), normalization.outputFiles[name], `normalized ${name}`)
    const preserved = normalization.preservedRawInputs[table]
    const source = sources.tables[table]?.source
    assert.ok(source && preserved, `Missing AB source receipt: ${table}`)
    const ab = checkHash(preserved.path, preserved, `AB ${table}`)
    assert.equal(ab.sha256, source.sha256, `AB ${table}: extraction receipt mismatch`)
    assert.equal(source.decoder_version, extraction.decoderVersion, `AB ${table}: decoder version mismatch`)
    assert.equal(basename(preserved.path), basename(source.path), `AB ${table}: source filename mismatch`)
    const raw = checkHash(path.join(rawDirectory, `${table}.json`), extraction.outputFiles[`${table}.json`], `raw ${table}`)
    const mirrorHash = fingerprint(path.join(mirrorDirectory, name))
    if (downloads) checkHash(path.join(mirrorDirectory, name), downloads.files.find(file => file.name === name), `mirror ${name}`)
    mirrorSources[name] = { url: `https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/${mirrorCommit}/zh_CN/gamedata/excel/${name}`, ...mirrorHash }
    tableEvidence[table] = { source: { filename: basename(source.path), layer: source.layer,
      logicalName: source.logical_name, ...ab }, raw, normalized }
    if (table !== 'data_version') {
      pc[table] = readJson(path.join(pcDirectory, name))
      mirror[table] = readJson(path.join(mirrorDirectory, name))
    }
  }
  const sourceVersion = fs.readFileSync(path.join(pcDirectory, 'data_version.txt'), 'utf8').trim()
  const mirrorVersion = fs.readFileSync(path.join(mirrorDirectory, 'data_version.txt'), 'utf8').trim()
  assert.equal(sourceVersion, mirrorVersion, 'PC and mirror data versions differ')
  assert.equal(readJson(path.join(rawDirectory, 'data_version.json')).raw.trim(), sourceVersion, 'Raw and normalized data versions differ')
  const dataVersion = /VersionControl:([^\s]+)/.exec(sourceVersion)?.[1]
  assert.ok(dataVersion, 'Missing PC VersionControl')
  for (const [label, receipt] of [['extraction', extraction], ['normalization', normalization], ['sources', sources]]) {
    assert.equal(receipt.version, dataVersion, `${label}: data version mismatch`)
    assert.equal(receipt.resourceVersion ?? receipt.resource_version, extraction.resourceVersion, `${label}: resource version mismatch`)
  }
  const localOperators = operators(pc.building_data, pc.character_table, 'PC operators')
  const mirrorOperators = operators(mirror.building_data, mirror.character_table, 'mirror operators')
  compare(localOperators, mirrorOperators, 'operators')
  compare(buffDefinitions(pc.building_data, true), buffDefinitions(mirror.building_data, false), 'buffs')
  compare(terms(pc.gamedata_const), terms(mirror.gamedata_const), 'terms')
  compare(itemNames(pc.item_table), itemNames(mirror.item_table), 'item names')
  const localRooms = roomLevels(pc.building_data)
  compare(localRooms, roomLevels(mirror.building_data), 'rooms')
  const formulas = workshopFormulas(pc.building_data)
  compare(formulas, workshopFormulas(mirror.building_data), 'workshop formulas')
  const unknownRoots = RECYCLE_ROOTS.filter(name => !Object.hasOwn(pc.building_data, name))
  for (const name of RECYCLE_ROOTS) {
    assert.ok(Object.hasOwn(mirror.building_data, name), `Mirror missing recycle source: ${name}`)
    if (!unknownRoots.includes(name)) compare(pc.building_data[name], mirror.building_data[name], `building.${name}`)
  }
  assert.ok(typeof extraction.toolVersion === 'string' && extraction.toolVersion.length, 'Missing Unpacker version')
  assert.ok(typeof extraction.decoderVersion === 'string' && extraction.decoderVersion.length, 'Missing decoder version')
  assert.ok(typeof extraction.resourceVersion === 'string' && extraction.resourceVersion.length, 'Missing game resource version')
  assert.match(sources.manifest_sha256 ?? '', /^[a-f0-9]{64}$/, 'Missing active index SHA-256')
  assert.match(extraction.toolGitCommit ?? '', /^[a-f0-9]{40}$/, 'Missing Unpacker commit')
  assert.match(extraction.schemaCommit ?? '', /^[a-f0-9]{40}$/, 'Missing decoder schema commit')
  assert.match(normalization.normalizerSha256 ?? '', /^[a-f0-9]{64}$/, 'Missing normalizer SHA-256')
  const sourceFiles = extraction.toolSourceFiles.map(file => {
    const relative = file.path.replaceAll('\\', '/')
    assert.ok(!/^(?:[A-Za-z]:|\/)/.test(relative) && !relative.split('/').includes('..'), 'Tool source paths must be relative')
    assert.match(file.sha256 ?? '', /^[a-f0-9]{64}$/, 'Missing tool source SHA-256')
    return { path: relative, sha256: file.sha256 }
  })
  assert.ok(sourceFiles.some(file => file.path.endsWith('/gamedata/normalize.py') && file.sha256 === normalization.normalizerSha256),
    'Normalizer does not match extracted tool source receipt')
  const entries = Object.values(localOperators)
  return { schemaVersion: 1, provider: 'ArknightsUnpacker', checkedAt: new Date().toISOString(),
    tool: { version: extraction.toolVersion, commit: extraction.toolGitCommit,
      ref: extraction.toolGitRef ?? null,
      workingTreeDirty: typeof extraction.toolGitDirty === 'boolean' ? extraction.toolGitDirty : null,
      decoderVersion: extraction.decoderVersion, schemaCommit: extraction.schemaCommit,
      normalizerSha256: normalization.normalizerSha256, sourceFiles },
    localGame: { sourceVersion, dataVersion, resourceVersion: extraction.resourceVersion,
      activeIndex: { filename: basename(sources.manifest), sha256: sources.manifest_sha256 } },
    mirror: { repository: 'Kengxxiao/ArknightsGameData', commit: mirrorCommit, sourceVersion: mirrorVersion, sources: mirrorSources },
    tables: tableEvidence,
    verification: { operators: entries.length, buffDefinitions: Object.keys(pc.building_data.buffs).length,
      skillStages: entries.reduce((sum, value) => sum + value.slots.flat().length, 0),
      highestSkills: entries.reduce((sum, value) => sum + value.slots.filter(slot => slot.length).length, 0),
      terms: Object.keys(terms(pc.gamedata_const)).length, itemNames: Object.keys(itemNames(pc.item_table)).length,
      workshopFormulas: Object.keys(formulas).length,
      roomLevels: Object.values(localRooms).reduce((sum, value) => sum + value.phases.length, 0),
      buffCategoryMapping: BUFF_CATEGORIES,
      comparedFields: ['Obtainable RIIC operator identities, rarity, profession, level caps and max manpower',
        'Every slot, phase and level; every known buff field including description, targets and efficiency',
        'All cc. terms including nested descriptions; all item names',
        'Room names/counts and each level electricity, staffing and manpower cost',
        'Workshop formula IDs, product IDs and base byproduct probabilities'] },
    unknownFields: { buildingRoots: unknownRoots },
    evidenceBoundary: 'Only installed active-manifest PC resources and the pinned mirror were compared. Absent PC building roots remain unverified by extraction and use separately pinned mirror evidence. This does not prove server freshness, decoder correctness, full skill algorithm coverage, live game behavior or agent-platform installation.' }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    assert.equal(args.length, 7, 'Usage: node scripts/unpacker-riic-evidence.mjs <normalized-pc-dir> <mirror-dir> <extraction-receipt.json> <normalization-receipt.json> <sources.json> <mirror-commit> <output.json>')
    const [pcDirectory, mirrorDirectory, extractionReceiptPath, normalizationReceiptPath, sourceManifestPath, mirrorCommit, output] = args
    const evidence = verifyUnpackerRiicEvidence({ pcDirectory, mirrorDirectory, extractionReceiptPath, normalizationReceiptPath, sourceManifestPath, mirrorCommit })
    fs.writeFileSync(path.resolve(output), JSON.stringify(evidence, null, 2) + '\n')
    console.log(JSON.stringify({ provider: evidence.provider, dataVersion: evidence.localGame.dataVersion,
      mirrorCommit: evidence.mirror.commit, verification: evidence.verification, unknownFields: evidence.unknownFields }, null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
