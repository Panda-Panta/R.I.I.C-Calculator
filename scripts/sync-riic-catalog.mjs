import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pinyin } from 'pinyin-pro'
import { verifyUnpackerRiicEvidence } from './unpacker-riic-evidence.mjs'
import { selectPrtsOperators, verifyPrtsOperator, mergeLogisticsEvidence, assertRecycleRulesCurrent } from './riic-catalog-evidence.mjs'

// Offline generation: downloaded sources are hashed and cross-checked before any output.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const input = path.resolve(process.argv[2] ?? '')
const output = process.argv[3] && path.resolve(process.argv[3])
const unpackerRoot = process.argv[4] && path.resolve(process.argv[4])
if (!process.argv[2] || !output || output === root || process.argv.length > 5) {
  throw new Error('Usage: node scripts/sync-riic-catalog.mjs <verified source directory> <staging directory> [Unpacker export directory]')
}
const read = file => JSON.parse(fs.readFileSync(path.join(input, file), 'utf8'))
const old = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const downloads = read('downloads.json')
const toolboxDownloads = read('arkntools-downloads.json')
for (const file of [...downloads.files, ...toolboxDownloads.files]) {
  assert.equal(sha256(fs.readFileSync(path.join(input, file.name))), file.sha256, file.name)
}
const commit = downloads.commit
assert.match(commit, /^[a-f0-9]{40}$/)
const sourceVersion = fs.readFileSync(path.join(input, 'data_version.txt'), 'utf8').trim()
const version = sourceVersion.match(/VersionControl:(.+)/)?.[1]
assert.ok(version)
const building = read('building_data.json')
const characters = read('character_table.json')
const constants = read('gamedata_const.json')
const items = read('item_table.json').items
const toolbox = read('arkntools-data-building.json')
const toolboxCharacters = read('arkntools-data-character.json')
const toolboxChinese = read('arkntools-locales-cn-building.json')
const unpackerEvidence = unpackerRoot ? verifyUnpackerRiicEvidence({
  pcDirectory: path.join(unpackerRoot, 'normalized-tables'), mirrorDirectory: input,
  extractionReceiptPath: path.join(unpackerRoot, 'extraction-receipt.json'),
  normalizationReceiptPath: path.join(unpackerRoot, 'normalization-receipt.json'),
  sourceManifestPath: path.join(unpackerRoot, 'raw-tables/sources.json'), mirrorCommit: commit,
}) : null
const unpackerSource = unpackerEvidence ? { unpackerEvidence: { manifest: 'unpacker-source-manifest.json',
  sha256: sha256(Buffer.from(JSON.stringify(unpackerEvidence, null, 2) + '\n')),
  dataVersion: unpackerEvidence.localGame.dataVersion } } : {}
const oldCatalog = old('.codex/skills/arknights-riic-mechanics/references/catalog.json')
const previousCatalogManifest = { ...oldCatalog.manifest }
delete previousCatalogManifest.unpackerEvidence
const oldDisplay = old('src/data/riic-skills-database.json')
const oldProfiles = old('src/data/operators.generated.json')
const previousEvidenceFile = '.codex/skills/arknights-riic-mechanics/references/logistics-update-manifest.json'
const previousEvidence = fs.existsSync(path.join(root, previousEvidenceFile)) ? old(previousEvidenceFile) : {}
const oldById = new Map(oldCatalog.operators.map(operator => [operator.sourceId, operator]))
const oldDisplayById = new Map(oldDisplay.map(operator => [operator.sourceId, operator]))
const generatedAt = downloads.retrievedAt
const sources = Object.fromEntries(downloads.files.filter(file => !file.name.startsWith('arkntools-'))
  .map(file => [file.name, { url: file.url, sha256: file.sha256 }]))
const clean = text => text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
const roomNames = { MANUFACTURE: '制造站', TRADING: '贸易站', POWER: '发电站', CONTROL: '控制中枢',
  DORMITORY: '宿舍', MEETING: '会客室', WORKSHOP: '加工站', TRAINING: '训练室', HIRE: '人力办公室', RECYCLE: '回收站' }
const professions = { PIONEER: '先锋', WARRIOR: '近卫', SNIPER: '狙击', TANK: '重装', MEDIC: '医疗',
  SUPPORT: '辅助', CASTER: '术师', SPECIAL: '特种' }
const phases = { PHASE_0: '初始', PHASE_1: '精英1', PHASE_2: '精英2' }
const operators = []
const displays = []
const decoded = {}
const comparisons = []
for (const [id, base] of Object.entries(characters)) {
  if (!base.name || id.startsWith('trap_') || base.profession === 'TOKEN' || base.isNotObtainable) continue
  const riic = building.chars[id]
  if (!riic?.buffChar?.length) continue
  const prior = oldById.get(id)
  const slots = riic.buffChar.map(slot => (slot.buffData ?? []).map(entry => {
    const buff = building.buffs[entry.buffId]
    assert.ok(buff, `${id}/${entry.buffId}`)
    assert.ok(phases[entry.cond?.phase], `${id}/${entry.buffId}: unlock phase`)
    return { ...buff, buffId: entry.buffId, unlock: entry.cond }
  }))
  const operator = { name: base.name, sourceId: id, rarity: base.rarity,
    levelCaps: base.phases.map(phase => phase.maxLevel), nationId: base.nationId ?? null,
    groupId: base.groupId ?? null, teamId: base.teamId ?? null, maxManpower: riic.maxManpower,
    isAlter: prior?.isAlter ?? Boolean(base.isSpChar), slots,
    source: { kind: 'gamedata', commit, characterId: id } }
  operators.push(operator)
  if (prior) {
    const comparable = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'source'))
    comparisons.push({ id, name: base.name, unchanged: JSON.stringify(comparable(prior)) === JSON.stringify(comparable(operator)) })
  }
  const priorDisplay = oldDisplayById.get(id)
  const py = toolboxCharacters[id.replace(/^char_/, '')]?.pinyin
  const display = { name: base.name, appellation: base.appellation ?? '', rarity: Number(base.rarity.replace('TIER_', '')),
    profession: professions[base.profession], pinyin: priorDisplay?.pinyin ?? py?.full ?? pinyin(base.name, { toneType: 'none', separator: '' }),
    pinyinInitial: priorDisplay?.pinyinInitial ?? py?.head ?? pinyin(base.name, { pattern: 'first', toneType: 'none', separator: '' }),
    sourceId: id, nationId: operator.nationId, groupId: operator.groupId, teamId: operator.teamId, skills: [] }
  const decodedSkills = []
  for (const [slotIndex, slot] of slots.entries()) for (const skill of slot) {
    const phase = phases[skill.unlock.phase]
    const priorSkill = priorDisplay?.skills.find(value => value.buffId === skill.buffId && value.slot === slotIndex + 1)
    const value = { slot: slotIndex + 1, buffId: skill.buffId, buffName: skill.buffName,
      room: roomNames[skill.roomType] ?? skill.roomType, roomCode: skill.roomType,
      phase, level: skill.unlock.level, unlockDesc: phase + (skill.unlock.level > 1 ? ` Lv.${skill.unlock.level}` : ''),
      efficiency: skill.efficiency, buffColor: skill.buffColor, textColor: skill.textColor,
      description: clean(skill.description), synergy: priorSkill?.synergy ?? null, skillIcon: skill.skillIcon }
    display.skills.push(value)
    decodedSkills.push({ ...value, buffCategory: skill.buffCategory, targets: skill.targets,
      targetGroupSortId: skill.targetGroupSortId,
      termReferences: [...new Set([...skill.description.matchAll(/<+\$(cc\.[^>]+)>/g)].map(match => match[1]))] })
  }
  displays.push(display)
  decoded[base.name] = { ...display, skills: decodedSkills, isAlter: operator.isAlter }
}
operators.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
displays.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
const added = operators.filter(operator => !oldById.has(operator.sourceId))
const removed = oldCatalog.operators.filter(operator => !operators.some(value => value.sourceId === operator.sourceId))
assert.equal(removed.length, 0, 'Source update removed existing operators; review before generation')

// Toolbox preserves one entry per stage; raw GameData remains authoritative.
const toolboxChecks = []
for (const operator of operators) {
  const entries = toolbox.char[operator.sourceId.replace(/^char_/, '')]
  assert.ok(entries, `${operator.name}: missing toolbox operator`)
  const raw = operator.slots.flat()
  assert.equal(entries.length, raw.length, `${operator.name}: toolbox stage count`)
  for (const skill of raw) {
    const tag = skill.buffId.replaceAll('[', '_').replaceAll(']', '')
    const entry = entries.find(entry => entry.id === tag && entry.unlock === `${skill.unlock.phase.slice(-1)}_${skill.unlock.level}`)
    assert.ok(entry, `${operator.name}/${skill.buffId}: toolbox unlock`)
    const data = toolbox.buff.data[tag]
    assert.equal(toolboxChinese.buff.name[tag], skill.buffName, `${operator.name}/${tag}: name`)
    assert.equal(toolbox.buff.info[data.desc].building, skill.roomType, `${operator.name}/${tag}: room`)
    assert.equal(toolboxChinese.buff.description[data.desc], skill.description, `${operator.name}/${tag}: text`)
    assert.equal(data.icon, skill.skillIcon, `${operator.name}/${tag}: icon`)
    toolboxChecks.push({ operatorId: operator.sourceId, buffId: skill.buffId, unlock: entry.unlock })
  }
}
const prtsChecks = []
for (const operator of selectPrtsOperators(operators, added, previousEvidence)) {
  const file = `prts-${operator.name}.json`
  prtsChecks.push(verifyPrtsOperator(operator, fs.readFileSync(path.join(input, file)), commit))
}
assertRecycleRulesCurrent(previousEvidence, building)
const terms = Object.fromEntries(Object.entries(constants.termDescriptionDict).filter(([key]) => key.startsWith('cc.')))
const counts = { operators: operators.length, buffDefinitions: Object.keys(building.buffs).length,
  highestSkills: operators.reduce((sum, operator) => sum + operator.slots.filter(slot => slot.length).length, 0),
  skillStages: operators.reduce((sum, operator) => sum + operator.slots.flat().length, 0), terms: Object.keys(terms).length }
const gameManifest = { generatedAt, repository: 'https://github.com/Kengxxiao/ArknightsGameData', commit,
  locale: 'zh_CN', sourceVersion, sources, counts, ...unpackerSource,
  evidenceType: 'Pinned extracted GameData, cross-checked with Toolbox and new operator PRTS pages; numeric regressions are separate from live-game verification.' }
const resourceNames = { 'data/building.json': 'building', 'data/character.json': 'character',
  'locales/cn/building.json': 'cnBuilding', 'locales/cn/character.json': 'cnCharacter', 'locales/cn/term.json': 'cnTerm' }
const toolboxManifest = { schemaVersion: 1, provider: 'arkntools', route: 'https://arkntools.app/#/riic',
  retrievedAt: toolboxDownloads.retrievedAt, checkUrl: 'https://data.arkntools.app/check.json', check: read('arkntools-check.json'),
  mapUrl: downloads.files.find(file => file.name === 'arkntools-map.json').url,
  mapSha256: sha256(fs.readFileSync(path.join(input, 'arkntools-map.json'))),
  resources: Object.fromEntries(toolboxDownloads.files.map(file => [resourceNames[file.key],
    { url: file.url, filename: path.basename(new URL(file.url).pathname), sha256: file.sha256 }])),
  verification: { operators: counts.operators, skillStageEntries: toolboxChecks.length,
    skillTagLabels: Object.keys(toolboxChinese.buff.name).length, terms: counts.terms,
    comparison: 'All obtainable operator stages match GameData skill IDs, unlocks, facility types, names, raw descriptions and icons.' } }
const manifest = { ...previousCatalogManifest, generatedAt, sourceVersion, sourceCommit: commit, ...unpackerSource,
  operatorCount: counts.operators, buffDefinitionCount: counts.buffDefinitions, skillStageCount: counts.skillStages,
  highestSkillCount: counts.highestSkills, buildingSha256: sources['building_data.json'].sha256,
  charactersSha256: sources['character_table.json'].sha256, sources,
  crossCheckManifest: 'logistics-update-manifest.json',
  annotations: { ...oldCatalog.manifest.annotations,
    isAlter: 'Previously audited isAlter flags are retained; new entries use character_table.isSpChar. RIIC term membership overrides roster affiliation where applicable.' } }
const computedDelta = { fromCommit: oldCatalog.manifest.sourceCommit, toCommit: commit, fromVersion: oldCatalog.manifest.sourceVersion,
  toVersion: sourceVersion, addedOperators: added.map(operator => ({ id: operator.sourceId, name: operator.name })),
  removedOperators: removed, changedExistingOperators: comparisons.filter(value => !value.unchanged),
  unchangedExistingOperators: comparisons.filter(value => value.unchanged).length,
  previousCounts: { operators: oldProfiles.operatorCount, highestSkills: oldProfiles.skillCount, skillStages: oldProfiles.skillStageCount }, counts }
const crossCheck = mergeLogisticsEvidence(previousEvidence, { generatedAt, gameData: { commit, version, counts }, toolbox: toolboxManifest, ...unpackerSource,
  prts: prtsChecks, delta: computedDelta, coverage: 'All stages are data-checked; executable coverage is documented and tested separately.' })
const delta = crossCheck.delta
const files = []
function write(file, value, pretty = true) {
  const target = path.join(output, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, pretty ? 2 : 0) + '\n'
  fs.writeFileSync(target, text)
  files.push({ path: file, sha256: sha256(Buffer.from(text)), bytes: Buffer.byteLength(text) })
}
const skillRoot = '.codex/skills/arknights-riic-mechanics/references/'
write(skillRoot + 'catalog.json', { manifest, operators, itemNames: Object.fromEntries(Object.entries(items).map(([id, item]) => [id, item.name])), building })
write(skillRoot + 'catalog.decoded.json', { metadata: { ...old(skillRoot + 'catalog.decoded.json').metadata,
  generatedAt, sourceVersion, sourceCommit: commit, operatorCount: counts.operators, skillStageCount: counts.skillStages }, operators: decoded })
write(skillRoot + 'terms.json', { sourcePath: sources['gamedata_const.json'].url, dataVersion: version,
  sourceSha256: sources['gamedata_const.json'].sha256, sourceCommit: commit, terms })
write(skillRoot + 'gamedata-source-manifest.json', gameManifest)
if (unpackerEvidence) {
  write(skillRoot + 'unpacker-source-manifest.json', unpackerEvidence)
  write('src/data/riic-unpacker-source-manifest.json', unpackerEvidence)
}
write(skillRoot + 'logistics-update-manifest.json', crossCheck)
write('src/data/riic-skills-database.json', displays, false)
write('src/data/riic-gamedata-source-manifest.json', gameManifest)
write('src/data/arkntools-riic-source-manifest.json', toolboxManifest)
write('src/data/riic-term-evidence.json', { sourcePath: sources['gamedata_const.json'].url, dataVersion: version,
  sourceSha256: sources['gamedata_const.json'].sha256, sourceCommit: commit, terms, crossCheckSource: toolboxManifest })
write('src/data/support-facilities.generated.json', { sourceCommit: commit, sourceVersion, buildingSha256: sources['building_data.json'].sha256,
  recycle: { phases: building.rooms.RECYCLE.phases.map((phase, index) => ({ level: index + 1,
    capacity: building.recycleRoomConsts.recycleBaseCapacity + building.recycleData.phases[index].recycleCapacity,
    operatorCapacity: phase.maxStationedNum, electricity: phase.electricity, baseSpeed: building.recycleData.phases[index].recycleSpeed })),
    staffedSpeed: building.recycleData.basicSpeedBuff, ...building.recycleRoomConsts,
    inputItems: Object.values(building.recycleRoomInputItemDatas).map(item => ({ ...item, name: items[item.itemId].name })) },
  workshop: { formulas: Object.values(building.workshopFormulas).map(formula => ({ formulaId: formula.formulaId,
    itemId: formula.itemId, name: items[formula.itemId]?.name ?? formula.itemId, baseByproductRate: formula.extraOutcomeRate })) } })
let html = fs.readFileSync(path.join(root, skillRoot, 'riic_skills_browser.html'), 'utf8')
assert.match(html, /const operators = \[[^\n]*\];/)
html = html.replace(/const operators = \[[^\n]*\];/, `const operators = ${JSON.stringify(displays)};`)
html = html.replace(/\d+ 干员 \/ \d+ 技能阶段 · v[\d.]+/, `${counts.operators} 干员 / ${counts.skillStages} 技能阶段 · v${version}`)
if (!html.includes('data-room="RECYCLE"')) {
  html = html.replace(/( *<button[^\n]+data-room="HIRE"[^\n]+\n)/, '$1        <button class="btn-tab" data-room="RECYCLE">回收站 <span class="tab-count">0</span></button>\n')
}
html = html.replace(/(data-room="([A-Z]+)"[^\n]+<span class="tab-count">)\d+(<\/span>)/g, (_, prefix, room, suffix) =>
  prefix + displays.flatMap(operator => operator.skills).filter(skill => room === 'ALL' || skill.roomCode === room).length + suffix)
write(skillRoot + 'riic_skills_browser.html', html)
const imported = spawnSync(process.execPath, [path.join(root, 'scripts/import-gamedata.mjs'), input], { cwd: output, encoding: 'utf8' })
assert.equal(imported.status, 0, imported.stderr)
const generated = fs.readFileSync(path.join(output, 'src/data/operators.generated.json'))
files.push({ path: 'src/data/operators.generated.json', sha256: sha256(generated), bytes: generated.length })
const profiles = JSON.parse(generated)
assert.equal(profiles.operatorCount, counts.operators)
assert.equal(profiles.skillCount, counts.highestSkills)
assert.equal(profiles.skillStageCount, counts.skillStages)
write('delta.json', delta)
write('prts-logistics.json', prtsChecks)
fs.writeFileSync(path.join(output, 'generated-files.json'), JSON.stringify(files, null, 2) + '\n')
console.log(JSON.stringify({ counts, added: delta.addedOperators, unchangedExistingOperators: delta.unchangedExistingOperators,
  changedExistingOperators: delta.changedExistingOperators, unpackerChecks: unpackerEvidence?.verification ?? null, toolboxChecks: toolboxChecks.length, prtsSkillChecks: prtsChecks.flatMap(page => page.checks).length, output,
  afterApplyingStagedFiles: {
    commands: ['npm run skill:manifest', 'npm run skill:validate',
      'node --use-system-ca .codex/skills/arknights-riic-mechanics/scripts/check-freshness.mjs'],
    note: 'Apply reviewed staged files first, rebuild the skill hash manifest, validate the package, then check all pinned sources online before publishing or importing. Offline regeneration does not confirm source freshness.'
  } }, null, 2))
