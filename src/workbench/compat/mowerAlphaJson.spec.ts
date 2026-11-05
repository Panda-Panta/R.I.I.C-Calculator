import { describe, expect, it } from 'vitest'
import { exportMowerJson, importMowerJson } from './mowerJson'
import { containsRetiredRescueCondition, migrateMowerAlphaDocument } from './mowerAlphaMigration'

const load = (fields: Record<string, unknown>) => importMowerJson(JSON.stringify({ default: 'plan1', plan1: {}, ...fields }))
const save = (fields: Record<string, unknown>) => JSON.parse(exportMowerJson(load(fields)))

describe('Mower alpha ab0a4e5 document compatibility', () => {
  it('resolves every additional conf operator list and emits native name strings', () => {
    const conf = Object.fromEntries(['resting_priority_replacement', 'free_room_exclusions', 'resting_standby', 'free_blacklist'].map(key => [key, '阿米娅，未知干员']))
    const workspace = load({ conf })
    for (const key of Object.keys(conf)) expect(workspace.mainPlan.conf[key]).toEqual(['char_002_amiya', '未知干员'])
    const exported = JSON.parse(exportMowerJson(workspace))
    for (const key of Object.keys(conf)) expect(exported.conf[key]).toBe('阿米娅,未知干员')
  })

  it('makes extra group bindings editable with IDs and preserves binding extensions', () => {
    const workspace = load({ plan1: { central: { plans: [{ agent: '阿米娅', group: 'first', replacement: ['德克萨斯'], group_bindings: [{ group: 'second', replacement: ['能天使', '未知干员'], color: 'custom' }, { group: '', replacement: [] }], custom: 7 }] } } })
    const slot = workspace.mainPlan.facilities.central.slots[0]!
    expect(slot.groupBindings).toEqual([{ groupId: 'second', replacements: ['char_103_angel', '未知干员'], metadata: { color: 'custom' } }, { groupId: null, replacements: [] }])
    slot.groupBindings![0]!.replacements = ['char_102_texas']
    const exported = JSON.parse(exportMowerJson(workspace))
    expect(exported.plan1.central.plans[0]).toMatchObject({ custom: 7, group_bindings: [{ group: 'second', replacement: ['德克萨斯'], color: 'custom' }, { group: '', replacement: [] }] })
  })

  it('keeps backup additions, removals, group columns and explicit empty order overrides', () => {
    const backups = [{ name: 'alpha', trigger: { left: 'True' }, plan: { recycle: { plans: [{ agent: '阿米娅', group_bindings: [{ group: 'B', replacement: ['能天使'] }] }] } }, task: { recycle: ['阿米娅', 'Current'] }, conf: { rest_in_full: '能天使', removed_operators: { rest_in_full: '阿米娅', refresh_trading: '但书@room_1_1' }, dorm_order: '', dorm_order_override: true, future_policy: 7 }, future_backup: true }]
    expect(save({ backup_plans: backups }).backup_plans).toEqual(backups)
  })

  it('round-trips new group tasks with names declared in main and backup binding columns', () => {
    const backups = [
      { name: '整组任务', group_tasks: [
        { group: '主绑组', action: 'off', mode: 'forced', future: 7 },
        { group: '附加绑组' },
        { group: '副表绑组', action: 'on' },
      ] },
      { name: '岗位覆盖', plan: { contact: { plans: [{ agent: '絮雨', group: '副表绑组' }] } } },
    ]
    const advanced = { group_resting_thresholds: { 主绑组: .35, 附加绑组: 1 }, future_setting: true }
    const exported = save({
      plan1: { central: { plans: [{ agent: '阿米娅', group: '主绑组', group_bindings: [{ group: '附加绑组' }] }] } },
      backup_plans: backups,
      advanced_settings: advanced,
    })
    expect(exported.backup_plans).toEqual(backups)
    expect(exported.advanced_settings).toEqual(advanced)
  })

  it.each([
    { group_tasks: null },
    { group_tasks: [{ group: '不存在' }] },
    { group_tasks: [{ group: '主绑组', action: 'on', mode: 'while_active' }] },
    { group_tasks: [{ group: '主绑组' }, { group: '主绑组', action: 'on' }] },
  ])('rejects invalid Mower group tasks at import: %j', backup => {
    expect(() => load({
      plan1: { central: { plans: [{ agent: '阿米娅', group: '主绑组' }] } },
      backup_plans: [{ name: '任务', ...backup }],
    })).toThrow('副表 任务：')
  })

  it('normalizes the native drone reserve at both file boundaries without rewriting saved state on export', () => {
    const imported = load({ advanced_settings: { drone_count_limit: 0, future_setting: 9 } })
    expect(imported.compatibility.migrationWarnings).toContain('已按 Mower alpha 迁移无人机使用阈值为 20 架')
    expect(JSON.parse(exportMowerJson(imported)).advanced_settings).toEqual({ drone_count_limit: 20, future_setting: 9 })
    const saved = { drone_count_limit: '19.0' }
    imported.compatibility.unrecognizedFields.advanced_settings = saved
    expect(JSON.parse(exportMowerJson(imported)).advanced_settings.drone_count_limit).toBe(20)
    expect(saved.drone_count_limit).toBe('19.0')
    expect(save({ advanced_settings: {} }).advanced_settings).toEqual({})
    expect(() => load({ advanced_settings: { drone_count_limit: 19.5 } })).toThrow('无人机使用阈值必须为整数')
  })

  it('keeps a legacy global threshold locally and exports the minimum accepted by Mower', () => {
    const workspace = load({ advanced_settings: { resting_threshold: .2, group_resting_thresholds: { g: .4 } } })
    expect(JSON.parse(exportMowerJson(workspace)).advanced_settings).toEqual({
      resting_threshold: .35, group_resting_thresholds: { g: .4 },
    })
    expect(workspace.compatibility.unrecognizedFields.advanced_settings).toMatchObject({ resting_threshold: .2 })
    expect(() => load({ advanced_settings: { group_resting_thresholds: { g: .34 } } })).toThrow('绑组心情阈值')
  })

  it('migrates retired advanced settings while preserving other and unknown settings', () => {
    const exported = save({ advanced_settings: { dorm_order: 'dormitory_3_2,dormitory_2_low,dormitory_3_3', reload_room: 'room_1_1', experimental_dorm_logic: true, refresh_backup_plan_after_mood: true, workshop_low_priority_rest: true, free_room: true, product_switching: { custom: true }, future_setting: 3 } })
    expect(exported.conf.dorm_order).toBe('dormitory_3,dormitory_2_low,dormitory_1,dormitory_2,dormitory_4')
    expect(exported.advanced_settings).toEqual({ free_room: true, product_switching: { custom: true }, future_setting: 3 })
  })

  it('prefers current main dorm order and migrates legacy backup default and custom overrides', () => {
    const exported = save({ conf: { dorm_order: 'dormitory_2' }, advanced_settings: { dorm_order: 'dormitory_3' }, backup_plans: [{ conf: { dorm_order: 'dormitory_1,dormitory_2,dormitory_3,dormitory_4' } }, { conf: { dorm_order: 'dormitory_4_2' } }, { conf: { dorm_order: 'dormitory_4', dorm_order_override: false } }] })
    expect(exported.conf.dorm_order).toBe('dormitory_2,dormitory_1,dormitory_3,dormitory_4')
    expect(exported.backup_plans.map((p: { conf: unknown }) => p.conf)).toEqual([{ dorm_order: '', dorm_order_override: false }, { dorm_order: 'dormitory_4,dormitory_1,dormitory_2,dormitory_3', dorm_order_override: true }, { dorm_order: '', dorm_order_override: false }])
  })

  it('retires actual rescue calls but keeps quoted mentions and preserves retired originals locally', () => {
    const retired = { name: 'retired', trigger: { left: { left: 'op_data . rescue_needed ( )', operator: '==', right: 'True' }, operator: 'and', right: 'True' }, conf: { removed_operators: { rest_in_full: '阿米娅' } } }
    const literal = { name: 'literal', trigger: { left: '"op_data.rescue_needed()"', operator: '==', right: '"example"' } }
    const workspace = load({ backup_plans: [retired, literal, { name: 'normal', trigger: { left: 'True' }, trigger_timing: 'BEGINNING', exit_trigger_timing: 'END', future: 1 }] })
    expect(workspace.compatibility.backupPlans).toEqual([literal, { name: 'normal', trigger: { left: 'True' }, future: 1 }])
    expect(workspace.compatibility.retiredBackupPlans).toEqual([retired])
    expect(workspace.compatibility.migrationWarnings?.length).toBeGreaterThan(0)
    expect(JSON.parse(exportMowerJson(workspace)).backup_plans).toEqual(workspace.compatibility.backupPlans)
  })

  it('does not retire string literals, comments, attribute references or malformed calls', () => {
    for (const expression of ['"op_data.rescue_needed()"', "'op_data.rescue_needed()'", 'False # op_data.rescue_needed()', 'op_data.rescue_needed', 'other.op_data.rescue_needed()', 'op_data.rescue_needed(', "'op_data.rescue_needed()"])
      expect(containsRetiredRescueCondition(expression), expression).toBe(false)
    expect(containsRetiredRescueCondition('False or (op_data.rescue_needed())')).toBe(true)
  })

  it('leaves original source objects untouched during retirement', () => {
    const input = { backup_plans: [{ trigger: 'op_data.rescue_needed()', trigger_timing: 'END' }], advanced_settings: { reload_room: 'room_1_1' } }
    const original = structuredClone(input)
    migrateMowerAlphaDocument(input)
    expect(input).toEqual(original)
  })

  it('keeps the device fragment recipe distinct on export', () => {
    const workspace = load({ plan1: { room_1_1: { name: '制造站', plans: [], product: 'orirock_device' } } })
    expect(workspace.mainPlan.facilities.room_1_1.product).toBe('fragment')
    expect(workspace.compatibility.facilityMetadata?.room_1_1?.rawProduct).toBe('orirock_device')
    const exported = JSON.parse(exportMowerJson(workspace))
    expect(exported.plan1.room_1_1.product).toBe('orirock_device')
  })
})
