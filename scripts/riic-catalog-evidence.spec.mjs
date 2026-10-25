import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { selectPrtsOperators, verifyPrtsOperator, mergeLogisticsEvidence, assertRecycleRulesCurrent } from './riic-catalog-evidence.mjs'

const operator = {
  sourceId: 'char_fixture', name: '示例', slots: [[
    { buffId: 'example[000]', buffName: '初级', roomType: 'RECYCLE', description: '进驻回收站时，材料转化效率+20%', unlock: { phase: 'PHASE_0', level: 1 } },
    { buffId: 'example[010]', buffName: '高级', roomType: 'RECYCLE', description: '进驻回收站时，材料转化效率+30%', unlock: { phase: 'PHASE_2', level: 1 } },
  ]],
}
const table = '<table><tr><th>条件</th><th>图标</th><th>技能1</th><th>房间</th><th>描述</th></tr>' +
  '<tr><td>精英0</td><td></td><td>初级</td><td>回收站</td><td>进驻回收站时，材料转化效率+20%</td></tr>' +
  '<tr><td>精英2</td><td></td><td>高级</td><td>回收站</td><td>进驻回收站时，材料转化效率+30%</td></tr></table>'
const response = (html = table, extra = {}) => Buffer.from(JSON.stringify({ parse: { title: operator.name, revid: 123, text: { '*': html }, ...extra } }))

describe('offline RIIC evidence regeneration', () => {
  it('rechecks previously covered operators even when there are no additions', () => {
    expect(selectPrtsOperators([operator], [], { prts: [{ characterId: operator.sourceId, name: operator.name }] })).toEqual([operator])
  })

  it('deduplicates prior coverage and additions by current character identity', () => {
    expect(selectPrtsOperators([operator], [operator], { prts: [{ characterId: operator.sourceId, name: '旧名' }] })).toEqual([operator])
    expect(selectPrtsOperators([operator], [], { prts: [{ name: operator.name }] })).toEqual([operator])
  })

  it('does not silently drop a tracked identity that is absent from current data', () => {
    expect(() => selectPrtsOperators([], [], { prts: [{ characterId: operator.sourceId, name: operator.name }] })).toThrow(/Missing previously checked/)
  })

  it('retains extension metadata while replacing core evidence with newly checked values', () => {
    const previous = { generatedAt: 'old', gameData: { commit: 'old' }, prts: [{ matched: 'old' }],
      prtsRecycle: { revision: 99 }, mowerRecycle: { commit: 'mower' }, recycleRules: { capacityByLevel: [5, 10, 10] },
      futureExtension: { origin: 'fixed' } }
    const fresh = { generatedAt: 'new', gameData: { commit: 'new' }, prts: [{ matched: true }] }
    const result = mergeLogisticsEvidence(previous, fresh)
    expect(result.prts).toEqual(fresh.prts)
    expect(result.gameData).toEqual(fresh.gameData)
    for (const key of ['prtsRecycle', 'mowerRecycle', 'recycleRules', 'futureExtension']) expect(result[key]).toEqual(previous[key])
    expect(previous.prts).toEqual([{ matched: 'old' }])
    expect(() => mergeLogisticsEvidence(previous, { gameData: {} })).toThrow(/fresh PRTS checks/)
  })

  it('keeps the original source transition when regenerating the same fixed input', () => {
    const previous = { gameData: { commit: 'current' }, delta: { fromCommit: 'old', toCommit: 'current', changedExistingOperators: [{ name: '旅骨' }] } }
    const fresh = { gameData: { commit: 'current' }, prts: [], delta: { fromCommit: 'current', toCommit: 'current', changedExistingOperators: [] } }
    expect(mergeLogisticsEvidence(previous, fresh).delta).toEqual(previous.delta)
    const next = { ...fresh, gameData: { commit: 'next' }, delta: { fromCommit: 'current', toCommit: 'next', changedExistingOperators: [] } }
    expect(mergeLogisticsEvidence(previous, next).delta).toEqual(next.delta)
  })

  it('requires local extraction evidence to be supplied again for each generated snapshot', () => {
    const previous = { prts: [], unpackerEvidence: { dataVersion: '78.0.0', sha256: 'old' }, mowerRecycle: { commit: 'retained' } }
    const current = mergeLogisticsEvidence(previous, { prts: [] })
    expect(current).not.toHaveProperty('unpackerEvidence')
    expect(current.mowerRecycle).toEqual(previous.mowerRecycle)
    const fresh = { dataVersion: '78.4.0', sha256: 'new' }
    expect(mergeLogisticsEvidence(previous, { prts: [], unpackerEvidence: fresh }).unpackerEvidence).toEqual(fresh)
    expect(previous.unpackerEvidence.dataVersion).toBe('78.0.0')
  })

  it('binds evidence to actual input bytes and the current GameData comparison', () => {
    const bytes = response()
    const result = verifyPrtsOperator(operator, bytes, 'current-commit')
    expect(result.revision).toBe(123)
    expect(result.responseSha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(result.checkedGameDataCommit).toBe('current-commit')
    expect(result.checks.map(check => check.buffId)).toEqual(['example[000]', 'example[010]'])
    expect(result.checks.every(check => check.matched)).toBe(true)
  })

  it('fails when a previously covered page disagrees with current skill text', () => {
    expect(() => verifyPrtsOperator(operator, response(table.replace('效率+30%', '效率+25%')), 'new')).toThrow(/PRTS text/)
  })

  it('decodes GameData display tokens before comparing the wiki text', () => {
    const formatted = { ...operator, slots: [operator.slots[0].map(skill => ({ ...skill,
      description: skill.description.replace(/\+(\d+)%/, '<@cc.vup>+$1%</>'),
    }))] }
    expect(verifyPrtsOperator(formatted, response(), 'new').checks).toHaveLength(2)
  })

  it('matches each skill stage in its own row rather than another skill phase anywhere on the page', () => {
    const changed = { ...operator, slots: [[{ ...operator.slots[0][0], unlock: { phase: 'PHASE_2', level: 1 } }]] }
    expect(() => verifyPrtsOperator(changed, response(), 'new')).toThrow(/PRTS unlock/)
  })

  it('does not accept a matching stage from the wrong independent slot', () => {
    const changed = { ...operator, slots: [[], operator.slots[0]] }
    expect(() => verifyPrtsOperator(changed, response(), 'new')).toThrow(/PRTS skill row/)
  })

  it('checks stated unlock levels and shared table cells', () => {
    const leveled = { ...operator, slots: [[{ ...operator.slots[0][0], unlock: { phase: 'PHASE_0', level: 30 } }]] }
    expect(() => verifyPrtsOperator(leveled, response(), 'new')).toThrow(/PRTS unlock/)
    expect(verifyPrtsOperator(leveled, response(table.replace('精英0', '精英0 等级30')), 'new').checks).toHaveLength(1)
    const shared = table.replace('<td>精英0</td>', '<td rowspan="2">精英0</td>').replace('<td>精英2</td>', '')
    const bothInitial = { ...operator, slots: [operator.slots[0].map(skill => ({ ...skill, unlock: { phase: 'PHASE_0', level: 1 } }))] }
    expect(verifyPrtsOperator(bothInitial, response(shared), 'new').checks).toHaveLength(2)
  })

  it('requires a real revision and the requested operator page', () => {
    expect(() => verifyPrtsOperator(operator, response(table, { revid: 0 }), 'new')).toThrow(/PRTS revision/)
    expect(() => verifyPrtsOperator(operator, response(table, { title: '其他页面' }), 'new')).toThrow(/PRTS title/)
  })

  it('rejects retained recycle numbers that drift from the newly supplied GameData', () => {
    const building = { recycleRoomConsts: { recycleBaseCapacity: 5, recycleTimeRequirement: 172800,
      recycleBoostSpeed: .5, recycleSpeedUpUnlockLevel: 3, recycleBoostLimit: 345600 },
    recycleData: { basicSpeedBuff: .01, phases: [{ recycleCapacity: 0, recycleSpeed: 1 }] },
    rooms: { RECYCLE: { phases: [{ maxStationedNum: 1, electricity: 0 }] } } }
    const manifest = { recycleRules: { secondsPerMaterialAt100Percent: 172800, capacityByLevel: [5],
      operatorsByLevel: [1], electricityByLevel: [0], basePercentByLevel: [100], staffedBonusPercent: 1,
      boostPercent: 50, boostUnlockLevel: 3, boostLimitSeconds: 345600, implementationBoundary: 'Preserved scope' } }
    expect(() => assertRecycleRulesCurrent(manifest, building)).not.toThrow()
    building.recycleData.phases[0].recycleSpeed = 1.1
    expect(() => assertRecycleRulesCurrent(manifest, building)).toThrow(/recycleRules.basePercentByLevel/)
  })
})
