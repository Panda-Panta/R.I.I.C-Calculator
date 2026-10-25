import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { JSDOM } from 'jsdom'

const roomLabels = { MANUFACTURE: '制造站', TRADING: '贸易站', POWER: '发电站', CONTROL: '控制中枢',
  DORMITORY: '宿舍', MEETING: '会客室', WORKSHOP: '加工站', TRAINING: '训练室', HIRE: '办公室', RECYCLE: '回收站' }
const compact = value => value.replace(/\s+/g, '')

/** Prior evidence selects identities to recheck; it never supplies this generation's result. */
export function selectPrtsOperators(operators, added, previous = {}) {
  const byId = new Map(operators.map(operator => [operator.sourceId, operator]))
  const required = new Set(added.map(operator => operator.sourceId))
  for (const entry of previous.prts ?? []) {
    const identity = entry.characterId ?? operators.find(operator => operator.name === entry.name)?.sourceId
    assert.ok(identity && byId.has(identity), `Missing previously checked PRTS operator: ${entry.characterId ?? entry.name}`)
    required.add(identity)
  }
  return operators.filter(operator => required.has(operator.sourceId))
}

/** Expand row/column spans so unlock, slot, facility and text remain associated with one skill. */
function tableRows(table) {
  const rows = []
  for (const [rowIndex, row] of [...table.rows].entries()) {
    rows[rowIndex] ??= []
    let column = 0
    for (const cell of row.cells) {
      while (rows[rowIndex][column] !== undefined) column++
      const text = cell.textContent.replace(/\s+/g, ' ').trim()
      for (let down = 0; down < Math.max(1, cell.rowSpan); down++) {
        rows[rowIndex + down] ??= []
        for (let across = 0; across < Math.max(1, cell.colSpan); across++) rows[rowIndex + down][column + across] = text
      }
      column += Math.max(1, cell.colSpan)
    }
  }
  const header = rows.find(row => row.includes('条件') && row.includes('描述') && row.some(cell => /^技能\d+$/.test(cell)))
  if (!header) return []
  const nameColumn = header.findIndex(cell => /^技能\d+$/.test(cell))
  const slot = Number(header[nameColumn].match(/\d+/)[0])
  return rows.filter(row => row !== header).map(row => ({
    slot, condition: row[header.indexOf('条件')] ?? '', name: row[nameColumn] ?? '',
    room: row[header.indexOf('房间')] ?? '', description: row[header.indexOf('描述')] ?? '',
  }))
}

function unlockMatches(condition, unlock) {
  const phase = condition.match(/精英([012])/)
  const level = condition.match(/(?:等级|Lv\.?|LV\.?)\s*(\d+)/)
  return phase?.[1] === unlock.phase.slice(-1) && Number(level?.[1] ?? 1) === unlock.level
}

/** Every current stage is verified against the supplied fixed PRTS page, not copied manifest checks. */
export function verifyPrtsOperator(operator, responseBytes, checkedGameDataCommit) {
  const page = JSON.parse(responseBytes.toString('utf8'))
  assert.equal(page.parse?.title, operator.name, `${operator.name}: PRTS title`)
  assert.ok(Number.isInteger(page.parse.revid) && page.parse.revid > 0, `${operator.name}: PRTS revision`)
  assert.equal(typeof page.parse.text?.['*'], 'string', `${operator.name}: PRTS HTML`)
  const dom = new JSDOM(page.parse.text['*'])
  try {
    const tables = [...dom.window.document.querySelectorAll('table')].filter(table => tableRows(table).length)
    const rows = tables.flatMap(tableRows)
    const text = value => {
      const element = dom.window.document.createElement('div')
      // GameData uses <@cc.vup>...</> tokens, which are not normal HTML tags.
      element.innerHTML = value.replace(/<[^>]+>/g, '')
      return element.textContent.replace(/\s+/g, ' ').trim()
    }
    const checks = operator.slots.flatMap((slot, slotIndex) => slot.map(skill => {
      const candidates = rows.filter(row => row.slot === slotIndex + 1 && compact(row.name) === compact(skill.buffName))
      assert.ok(candidates.length, `${operator.name}/${skill.buffId}: PRTS skill row`)
      const description = text(skill.description)
      const matchingText = candidates.filter(row => compact(row.description).includes(compact(description)))
      assert.ok(matchingText.length, `${operator.name}/${skill.buffId}: PRTS text`)
      const matchingStage = matchingText.filter(row => unlockMatches(row.condition, skill.unlock))
      assert.ok(matchingStage.length, `${operator.name}/${skill.buffId}: PRTS unlock`)
      assert.ok(matchingStage.some(row => compact(row.room) === roomLabels[skill.roomType]), `${operator.name}/${skill.buffId}: PRTS room`)
      return { buffId: skill.buffId, name: skill.buffName, unlock: skill.unlock, description, matched: true }
    }))
    const matchedSlots = new Set(operator.slots.map((slot, index) => slot.length ? index + 1 : null))
    const logisticsText = tables.filter(table => tableRows(table).some(row => matchedSlots.has(row.slot)))
      .map(table => table.textContent.replace(/\s+/g, ' ').trim()).join('\n')
    return { name: operator.name, characterId: operator.sourceId, revision: page.parse.revid,
      url: `https://prts.wiki/w/${encodeURIComponent(operator.name)}?oldid=${page.parse.revid}`,
      responseSha256: createHash('sha256').update(responseBytes).digest('hex'), checkedGameDataCommit, logisticsText, checks }
  } finally {
    dom.window.close()
  }
}

/** Independently pinned extensions survive regeneration; core sources and checks are rebuilt. */
export function mergeLogisticsEvidence(previous, fresh) {
  assert.ok(Array.isArray(fresh.prts), 'Generation must supply fresh PRTS checks')
  const retained = { ...previous }
  delete retained.unpackerEvidence
  const merged = { ...retained, ...fresh }
  // Repeating generation at the same source keeps the original upgrade delta.
  if (fresh.gameData?.commit && previous.gameData?.commit === fresh.gameData.commit
    && previous.delta?.toCommit === fresh.gameData.commit && fresh.delta
    && fresh.delta.fromCommit === fresh.delta.toCommit) merged.delta = previous.delta
  return merged
}

/** A retained numeric extension cannot silently contradict the incoming GameData. */
export function assertRecycleRulesCurrent(previous, building) {
  if (!previous.recycleRules) return
  const constants = building.recycleRoomConsts
  const expected = {
    secondsPerMaterialAt100Percent: constants.recycleTimeRequirement,
    capacityByLevel: building.recycleData.phases.map(phase => constants.recycleBaseCapacity + phase.recycleCapacity),
    operatorsByLevel: building.rooms.RECYCLE.phases.map(phase => phase.maxStationedNum),
    electricityByLevel: building.rooms.RECYCLE.phases.map(phase => phase.electricity),
    basePercentByLevel: building.recycleData.phases.map(phase => phase.recycleSpeed * 100),
    staffedBonusPercent: building.recycleData.basicSpeedBuff * 100,
    boostPercent: constants.recycleBoostSpeed * 100,
    boostUnlockLevel: constants.recycleSpeedUpUnlockLevel,
    boostLimitSeconds: constants.recycleBoostLimit,
  }
  for (const [key, value] of Object.entries(expected)) {
    if (Object.hasOwn(previous.recycleRules, key)) {
      assert.deepEqual(previous.recycleRules[key], value, `recycleRules.${key} changed; review extension evidence before generation`)
    }
  }
}
