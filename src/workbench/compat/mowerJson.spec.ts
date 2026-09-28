import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  importMowerJson,
  exportMowerJson,
  resolveOperatorCharId,
  restoreOperatorMowerName,
} from './mowerJson'
import { createDefaultWorkspace } from '../defaults'
import { useRosterWorkbenchStore } from '../store'
import { validateRosterWorkspace } from '../validate'
import { runCalculationBridge } from '../calculationBridge'

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadFixture(filename: string): string {
  return readFileSync(resolve(__dirname, 'fixtures', filename), 'utf-8')
}

interface ExportedSlot {
  agent: string
  group: string
  replacement: string[]
  [key: string]: unknown
}

interface ExportedFacility {
  name: string
  product?: string
  plans: ExportedSlot[]
  [key: string]: unknown
}

interface ExportedConf {
  ling_xi: number
  exhaust_require: string
  rest_in_full: string
  resting_priority: string
  workaholic: string
  refresh_trading: string
  refresh_drained: string
  ope_resting_priority: string
  [key: string]: unknown
}

interface ExportedMowerDocument {
  default: string
  conf: ExportedConf
  backup_plans: unknown[]
  [key: string]: unknown
}

describe('Mower JSON Compatibility Layer', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })
  describe('Real Mower Fixtures & Layouts', () => {
    it('imports real 252 fixture (mower-252-3gold.json) with accurate rooms, inferred levels, and conf', () => {
      const raw = loadFixture('mower-252-3gold.json')
      const ws = importMowerJson(raw)

      expect(ws.schemaVersion).toBe(8)
      expect(ws.compatibility.defaultPlanKey).toBe('plan1')

      const facilities = ws.mainPlan.facilities

      // 252 layout verification: 5 manufacture, 2 trading, 2 power
      const manufactureRooms = ['room_1_1', 'room_2_1', 'room_2_2', 'room_2_3', 'room_3_1'] as const
      const tradingRooms = ['room_1_2', 'room_3_2'] as const
      const powerRooms = ['room_1_3', 'room_3_3'] as const

      for (const id of manufactureRooms) {
        expect(facilities[id].type).toBe('manufacture')
      }
      for (const id of tradingRooms) {
        expect(facilities[id].type).toBe('trading')
      }
      for (const id of powerRooms) {
        expect(facilities[id].type).toBe('power')
      }

      // 2-power-plant inferred levels
      // Dormitories are level 1 in 2-power-plant layout
      expect(facilities.dormitory_1.level).toBe(1)
      expect(facilities.dormitory_2.level).toBe(1)
      expect(facilities.dormitory_3.level).toBe(1)
      expect(facilities.dormitory_4.level).toBe(1)

      // Right-side facilities and central are max level
      expect(facilities.central.level).toBe(5)
      expect(facilities.meeting.level).toBe(3)
      expect(facilities.factory.level).toBe(3)
      expect(facilities.contact.level).toBe(3)

      // Power plants are level 3
      expect(facilities.room_1_3.level).toBe(3)
      expect(facilities.room_3_3.level).toBe(3)

      // Manufacture & trading levels inferred from active staff
      // room_1_1: 3 operators -> level 3
      expect(facilities.room_1_1.level).toBe(3)
      // room_2_2: 2 operators -> level 2
      expect(facilities.room_2_2.level).toBe(2)
      // room_3_2: 1 operator -> level 1
      expect(facilities.room_3_2.level).toBe(1)

      // Product mapping
      expect(facilities.room_1_1.product).toBe('exp')
      expect(facilities.room_1_2.product).toBe('money')
      expect(facilities.room_2_1.product).toBe('gold')
      expect(facilities.room_1_3.product).toBeUndefined()

      // Operator resolution
      // Known operator: 薇薇安娜 -> char_4098_vvana
      expect(facilities.central.slots[0]!.occupant).toEqual({
        kind: 'operator',
        operatorId: 'char_4098_vvana',
      })
      expect(facilities.central.slots[0]!.groupId).toBe('骑士组')
      expect(facilities.central.slots[0]!.replacements).toEqual(['char_474_glady'])

      // Known operators mapped to charId: 薇薇安娜, Mon3tr (char_4179_monstr), 八幡海铃 (char_4186_tmoris), Lancet-2 (char_285_medic2)
      expect(facilities.central.slots[1]!.replacements).toContain('char_4179_monstr')
      expect(facilities.central.slots[4]!.replacements).toContain('char_4186_tmoris')
      expect(facilities.room_3_3.slots[0]!.occupant).toEqual({
        kind: 'operator',
        operatorId: 'char_285_medic2',
      })

      // Free placeholder
      expect(facilities.dormitory_4.slots[4]!.occupant).toEqual({ kind: 'free' })

      // Conf policy fields
      expect(ws.mainPlan.conf.ling_xi).toBe(3)
      expect(ws.mainPlan.conf.exhaust_require).toContain('char_446_aroma')
      expect(ws.mainPlan.conf.exhaust_require).toContain('char_4230_mcnist')
      expect(ws.mainPlan.conf.resting_priority).toContain('char_4145_ulpia')
      expect(ws.mainPlan.conf.workaholic).toEqual(['char_285_medic2'])
      expect(ws.mainPlan.conf.refresh_trading).toEqual([])
      expect(ws.mainPlan.conf.refresh_drained).toEqual(['char_4064_mlynar'])
      expect(ws.mainPlan.conf.ope_resting_priority).toEqual(['char_1027_greyy2'])
    })

    it('round-trips mower-252-3gold.json through export preserving top-level siblings and products', () => {
      const raw = loadFixture('mower-252-3gold.json')
      const ws = importMowerJson(raw)
      const exported = exportMowerJson(ws)
      const parsed = JSON.parse(exported) as ExportedMowerDocument

      expect(parsed.default).toBe('plan1')
      expect(parsed.backup_plans).toEqual([])
      expect(typeof parsed.plan1).toBe('object')
      expect(typeof parsed.conf).toBe('object')

      const plan1 = parsed.plan1 as Record<string, ExportedFacility>
      expect(plan1.room_1_1!.name).toBe('制造站')
      expect(plan1.room_1_1!.product).toBe('exp3')
      expect(plan1.room_1_2!.name).toBe('贸易站')
      expect(plan1.room_1_2!.product).toBe('lmd')
      expect(plan1.room_1_3!.name).toBe('发电站')
      expect(plan1.room_1_3!.product).toBeUndefined()

      const conf = parsed.conf
      expect(conf.ling_xi).toBe(3)
      expect(conf.exhaust_require).toBe('阿罗玛,槐琥,伊内丝,红云,稀音,刻俄柏,温蒂,清流,森蚺,艾丽妮,逻各斯,机械师')
      expect(conf.workaholic).toBe('Lancet-2')
      expect(conf.refresh_trading).toBe('')

      // Operator names restored on export
      const centralPlans = plan1.central!.plans
      expect(centralPlans[0]!.agent).toBe('薇薇安娜')
      expect(centralPlans[0]!.replacement).toEqual(['歌蕾蒂娅'])
      expect(centralPlans[1]!.replacement).toEqual(['Mon3tr'])
      expect(centralPlans[4]!.replacement).toEqual(['八幡海铃'])
    })

    it('imports real 252 2-gold fixture (mower-252-2gold.json / 252二赤金Test.json) and verifies all validation features', () => {
      const raw = loadFixture('mower-252-2gold.json')
      const ws = importMowerJson(raw)

      expect(ws.schemaVersion).toBe(8)
      expect(ws.compatibility.defaultPlanKey).toBe('plan1')

      const facilities = ws.mainPlan.facilities

      // 1. Full workspace passes validation with 0 critical errors and 0 warnings
      const res = validateRosterWorkspace(ws)
      expect(res.isValid).toBe(true)
      expect(res.criticalErrors).toHaveLength(0)
      expect(res.warnings).toHaveLength(0)
      expect(res.power).toEqual({
        generation: 540,
        consumption: 540,
        margin: 0,
        sufficient: true,
      })

      // 2. 同一替补候选可在多个设施出现 (e.g. 但书 in room_1_2 and room_3_2)
      const room12Reps = facilities.room_1_2.slots[0]!.replacements
      const room32Reps = facilities.room_3_2.slots[0]!.replacements
      expect(room12Reps).toContain('char_4032_provs') // 但书
      expect(room32Reps).toContain('char_4032_provs') // 但书

      // Assigning any candidate across multiple facilities does NOT produce DUPLICATE_REPLACEMENT
      facilities.room_3_3.slots[0]!.replacements = ['char_377_gdglow'] // 澄闪 in room_1_3 and room_3_3
      const resMultiCandidate = validateRosterWorkspace(ws)
      expect(resMultiCandidate.criticalErrors.find((e) => e.code === 'DUPLICATE_REPLACEMENT')).toBeUndefined()
      facilities.room_3_3.slots[0]!.replacements = ['char_1027_greyy2'] // revert to 格雷伊

      // 3. 菲亚梅塔宿舍位的替补可引用当前主力
      // Fiammetta in dormitory_4 has replacements: 森蚺 (central), 温蒂 (room_2_2), 清流 (room_2_2), 红云 (room_1_1)
      const fiamSlot = facilities.dormitory_4.slots[0]!
      expect(fiamSlot.occupant).toEqual({ kind: 'operator', operatorId: 'char_300_phenxi' })
      expect(fiamSlot.replacements).toEqual([
        'char_416_zumama',
        'char_400_weedy',
        'char_385_finlpp',
        'char_190_clour',
      ])
      expect(res.criticalErrors.find((e) => e.code === 'CONFLICTING_REPLACEMENT')).toBeUndefined()

      // 4. 普通宿舍宿管无替补不警告
      // Dormitory keepers (流明, 蜜莓, 刺玫, 杜林, 聆音, 爱丽丝, 波登可, 至简, 桃金娘, 车尔尼)
      expect(facilities.dormitory_1.slots[0]!.replacements).toEqual([])
      expect(facilities.dormitory_2.slots[0]!.replacements).toEqual([])
      expect(facilities.dormitory_3.slots[0]!.replacements).toEqual([])
      expect(facilities.dormitory_4.slots[1]!.replacements).toEqual([])
      expect(res.warnings.filter((w) => w.code === 'NO_REPLACEMENT' && w.roomId.startsWith('dormitory_'))).toHaveLength(0)

      // 5. 宿舍 Free 休息池占位不警告
      expect(facilities.dormitory_1.slots[3]!.occupant).toEqual({ kind: 'free' })
      expect(facilities.dormitory_2.slots[2]!.occupant).toEqual({ kind: 'free' })
      expect(facilities.dormitory_3.slots[2]!.occupant).toEqual({ kind: 'free' })
      expect(facilities.dormitory_4.slots[4]!.occupant).toEqual({ kind: 'free' })
      expect(res.warnings.filter((w) => w.code === 'PLACEHOLDER_SLOT' && w.roomId.startsWith('dormitory_'))).toHaveLength(0)

      // 6. 验证错误/警告必须显示中文干员名，不显示 char_id
      facilities.room_1_3.slots[0]!.replacements = ['char_4098_vvana'] // 薇薇安娜 is primary in central
      const resConflict = validateRosterWorkspace(ws)
      const conflictErr = resConflict.criticalErrors.find((e) => e.code === 'CONFLICTING_REPLACEMENT')
      expect(conflictErr).toBeDefined()
      expect(conflictErr?.message).toContain('薇薇安娜')
      expect(conflictErr?.message).not.toContain('char_4098_vvana')
      facilities.room_1_3.slots[0]!.replacements = ['char_377_gdglow'] // revert
    })

    it('runs the real 252 2-gold fixture through the legacy calculation bridge', () => {
      const ws = importMowerJson(loadFixture('mower-252-2gold.json'))
      const result = runCalculationBridge(ws)

      expect(result.success).toBe(true)
      expect(result.validation.isValid).toBe(true)
      expect(result.report).not.toBeNull()
      expect(result.report?.layoutValid).toBe(true)
    })

    it('imports and exports real 342 pure LMD fixture (mower-342-pure-lmd.json)', () => {
      const raw = loadFixture('mower-342-pure-lmd.json')
      const ws = importMowerJson(raw)

      expect(ws.compatibility.defaultPlanKey).toBe('plan1')

      // 342 layout: 4 manufacture, 3 trading, 2 power
      const facilities = ws.mainPlan.facilities
      expect(facilities.room_1_1.type).toBe('manufacture')
      expect(facilities.room_1_2.type).toBe('trading')
      expect(facilities.room_1_3.type).toBe('power')
      expect(facilities.room_2_1.type).toBe('manufacture')
      expect(facilities.room_2_2.type).toBe('manufacture')
      expect(facilities.room_2_3.type).toBe('trading')
      expect(facilities.room_3_1.type).toBe('manufacture')
      expect(facilities.room_3_2.type).toBe('trading')
      expect(facilities.room_3_3.type).toBe('power')

      // All dormitories level 1 in 2-power-plant setup
      expect(facilities.dormitory_1.level).toBe(1)
      expect(facilities.dormitory_4.level).toBe(1)

      const exported = exportMowerJson(ws)
      const parsed = JSON.parse(exported) as ExportedMowerDocument
      expect(parsed.default).toBe('plan1')
      const plan1 = parsed.plan1 as Record<string, ExportedFacility>
      expect(plan1.room_2_3!.name).toBe('贸易站')
      expect(plan1.room_2_3!.product).toBe('lmd')
    })

    it('imports and exports real 342 orirock fixture (mower-342-orirock.json) with fragment mapping', () => {
      const raw = loadFixture('mower-342-orirock.json')
      const ws = importMowerJson(raw)

      const facilities = ws.mainPlan.facilities
      // room_3_1 produces orirock
      expect(facilities.room_3_1.type).toBe('manufacture')
      expect(facilities.room_3_1.product).toBe('fragment')

      const exported = exportMowerJson(ws)
      const parsed = JSON.parse(exported) as ExportedMowerDocument
      const plan1 = parsed.plan1 as Record<string, ExportedFacility>
      expect(plan1.room_3_1!.product).toBe('orirock')
    })
  })

  describe('Facility Level Inference Rules', () => {
    it('infers all facilities to max level when there are 3 power plants', () => {
      const threePowerJson = JSON.stringify({
        default: 'plan1',
        plan1: {
          room_1_1: { name: '制造站', plans: [], product: 'gold' },
          room_1_2: { name: '制造站', plans: [], product: 'gold' },
          room_1_3: { name: '发电站', plans: [] },
          room_2_1: { name: '制造站', plans: [], product: 'gold' },
          room_2_2: { name: '贸易站', plans: [], product: 'lmd' },
          room_2_3: { name: '发电站', plans: [] },
          room_3_1: { name: '制造站', plans: [], product: 'gold' },
          room_3_2: { name: '贸易站', plans: [], product: 'lmd' },
          room_3_3: { name: '发电站', plans: [] },
          dormitory_1: { name: '', plans: [] },
          dormitory_2: { name: '', plans: [] },
          dormitory_3: { name: '', plans: [] },
          dormitory_4: { name: '', plans: [] },
          central: { name: '', plans: [] },
          meeting: { name: '', plans: [] },
          factory: { name: '', plans: [] },
          contact: { name: '', plans: [] },
        },
        conf: { ling_xi: 1 },
      })

      const ws = importMowerJson(threePowerJson)
      const facilities = ws.mainPlan.facilities

      expect(facilities.room_1_1.level).toBe(3)
      expect(facilities.room_1_3.level).toBe(3)
      expect(facilities.room_2_2.level).toBe(3)
      expect(facilities.dormitory_1.level).toBe(5)
      expect(facilities.dormitory_4.level).toBe(5)
      expect(facilities.central.level).toBe(5)
      expect(facilities.meeting.level).toBe(3)
      expect(facilities.contact.level).toBe(3)
    })

    it('infers stepped levels for 2 power plants with empty manufacturing room falling back to 1', () => {
      const twoPowerJson = JSON.stringify({
        default: 'plan1',
        plan1: {
          room_1_1: { name: '制造站', plans: [], product: 'gold' }, // 0 staff -> level 1
          room_1_2: {
            name: '制造站',
            plans: [
              { agent: '阿米娅', group: '', replacement: [] },
              { agent: 'Free', group: '', replacement: [] },
            ],
            product: 'gold',
          }, // 2 staff -> level 2
          room_1_3: { name: '发电站', plans: [] },
          room_2_1: {
            name: '贸易站',
            plans: [
              { agent: 'Current', group: '', replacement: [] },
            ],
            product: 'lmd',
          }, // 1 staff -> level 1
          room_2_2: {
            name: '贸易站',
            plans: [
              { agent: '阿米娅', group: '', replacement: [] },
              { agent: '德克萨斯', group: '', replacement: [] },
              { agent: '拉普兰德', group: '', replacement: [] },
            ],
            product: 'lmd',
          }, // 3 staff -> level 3
          room_2_3: { name: '制造站', plans: [], product: 'gold' },
          room_3_1: { name: '制造站', plans: [], product: 'gold' },
          room_3_2: { name: '制造站', plans: [], product: 'gold' },
          room_3_3: { name: '发电站', plans: [] },
          dormitory_1: { name: '', plans: [] },
        },
        conf: { ling_xi: 1 },
      })

      const ws = importMowerJson(twoPowerJson)
      const f = ws.mainPlan.facilities

      expect(f.room_1_1.level).toBe(1)
      expect(f.room_1_2.level).toBe(2)
      expect(f.room_2_1.level).toBe(1)
      expect(f.room_2_2.level).toBe(3)
      expect(f.room_1_3.level).toBe(3)
      expect(f.dormitory_1.level).toBe(1)
    })

    it('does not arbitrarily infer levels when power plant count is not 2 or 3', () => {
      const singlePowerJson = JSON.stringify({
        default: 'plan1',
        plan1: {
          room_1_1: { name: '制造站', plans: [], product: 'gold' },
          room_1_3: { name: '发电站', plans: [] },
        },
        conf: { ling_xi: 1 },
      })

      const ws = importMowerJson(singlePowerJson)
      // Defaults from createDefaultWorkspace are kept untouched
      expect(ws.mainPlan.facilities.room_1_3.type).toBe('power')
    })
  })

  describe('Operator Mapping & Lossless Unknown Round-Trip', () => {
    it('resolves known operators by Chinese name, appellation, or charId', () => {
      expect(resolveOperatorCharId('阿米娅')).toBe('char_002_amiya')
      expect(resolveOperatorCharId('Amiya')).toBe('char_002_amiya')
      expect(resolveOperatorCharId('amiya')).toBe('char_002_amiya')
      expect(resolveOperatorCharId('char_002_amiya')).toBe('char_002_amiya')
      expect(resolveOperatorCharId('薇薇安娜')).toBe('char_4098_vvana')
      expect(resolveOperatorCharId('Viviana')).toBe('char_4098_vvana')
    })

    it('preserves unknown operators without loss in resolve and restore', () => {
      expect(resolveOperatorCharId('CustomOperator_999')).toBe('CustomOperator_999')
      expect(restoreOperatorMowerName('CustomOperator_999')).toBe('CustomOperator_999')
      expect(resolveOperatorCharId('未知干员X')).toBe('未知干员X')
      expect(restoreOperatorMowerName('未知干员X')).toBe('未知干员X')
      expect(resolveOperatorCharId('FakeOperator_DoesNotExist')).toBe('FakeOperator_DoesNotExist')
      expect(restoreOperatorMowerName('FakeOperator_DoesNotExist')).toBe('FakeOperator_DoesNotExist')
    })

    it('restores known charId to Mower Chinese display name on export', () => {
      expect(restoreOperatorMowerName('char_002_amiya')).toBe('阿米娅')
      expect(restoreOperatorMowerName('char_4098_vvana')).toBe('薇薇安娜')
    })

    it('handles Free, Current, and empty slot occupants correctly in round-trip', () => {
      const testJson = JSON.stringify({
        default: 'plan1',
        plan1: {
          central: {
            name: '',
            plans: [
              { agent: 'Free', group: '', replacement: [] },
              { agent: 'Current', group: 'g1', replacement: [] },
              { agent: '', group: '', replacement: [] },
            ],
          },
        },
        conf: { ling_xi: 1 },
      })

      const ws = importMowerJson(testJson)
      const slots = ws.mainPlan.facilities.central.slots
      expect(slots[0]!.occupant).toEqual({ kind: 'free' })
      expect(slots[1]!.occupant).toEqual({ kind: 'current' })
      expect(slots[2]!.occupant).toEqual({ kind: 'empty' })

      const exported = exportMowerJson(ws)
      const parsed = JSON.parse(exported) as ExportedMowerDocument
      const plan1 = parsed.plan1 as Record<string, ExportedFacility>
      const plans = plan1.central!.plans
      expect(plans[0]!.agent).toBe('Free')
      expect(plans[1]!.agent).toBe('Current')
      expect(plans[2]!.agent).toBe('')
    })
  })

  describe('Product Mappings', () => {
    it('correctly maps all product codenames bidirectionally', () => {
      const productJson = JSON.stringify({
        default: 'plan1',
        plan1: {
          room_1_1: { name: '制造站', plans: [], product: 'exp3' },
          room_1_2: { name: '制造站', plans: [], product: 'exp' },
          room_2_1: { name: '制造站', plans: [], product: 'orirock' },
          room_2_2: { name: '制造站', plans: [], product: 'fragment' },
          room_2_3: { name: '制造站', plans: [], product: 'gold' },
          room_3_1: { name: '贸易站', plans: [], product: 'lmd' },
          room_3_2: { name: '贸易站', plans: [], product: 'money' },
          room_3_3: { name: '贸易站', plans: [], product: 'orundum' },
        },
        conf: { ling_xi: 1 },
      })

      const ws = importMowerJson(productJson)
      const f = ws.mainPlan.facilities
      expect(f.room_1_1.product).toBe('exp')
      expect(f.room_1_2.product).toBe('exp')
      expect(f.room_2_1.product).toBe('fragment')
      expect(f.room_2_2.product).toBe('fragment')
      expect(f.room_2_3.product).toBe('gold')
      expect(f.room_3_1.product).toBe('money')
      expect(f.room_3_2.product).toBe('money')
      expect(f.room_3_3.product).toBe('orundum')

      const exported = JSON.parse(exportMowerJson(ws)) as ExportedMowerDocument
      const p = exported.plan1 as Record<string, ExportedFacility>
      expect(p.room_1_1!.product).toBe('exp3')
      expect(p.room_1_2!.product).toBe('exp3')
      expect(p.room_2_1!.product).toBe('orirock')
      expect(p.room_2_2!.product).toBe('orirock')
      expect(p.room_2_3!.product).toBe('gold')
      expect(p.room_3_1!.product).toBe('lmd')
      expect(p.room_3_2!.product).toBe('lmd')
      expect(p.room_3_3!.product).toBe('orundum')
    })
  })

  describe('Lossless Envelope & Unknown Fields Preservation', () => {
    it('preserves top-level unknown fields, secondary plans, and backup_plans', () => {
      const envelopeJson = JSON.stringify({
        default: 'plan_custom',
        plan_custom: {
          central: { name: '', plans: [] },
        },
        plan2: {
          central: { name: '', plans: [{ agent: '阿米娅', group: '', replacement: [] }] },
        },
        conf: {
          ling_xi: 2,
          exhaust_require: '阿米娅',
          free_blacklist: ['char_102_texas', 'char_103_angel'],
          custom_conf_attr: 'keep_me',
        },
        backup_plans: [
          { name: 'backup1', trigger: { left: 'time', operator: '>', right: '12:00' } },
        ],
        unrecognized_root_prop: { version: 'mower-v3' },
      })

      const ws = importMowerJson(envelopeJson)
      expect(ws.compatibility.defaultPlanKey).toBe('plan_custom')
      expect(ws.compatibility.backupPlans).toHaveLength(1)
      expect(ws.mainPlan.conf.free_blacklist).toEqual(['char_102_texas', 'char_103_angel'])
      expect(ws.mainPlan.conf.custom_conf_attr).toBe('keep_me')

      const exported = JSON.parse(exportMowerJson(ws)) as ExportedMowerDocument
      expect(exported.default).toBe('plan_custom')
      expect(exported.plan_custom).toBeDefined()
      expect(exported.plan2).toBeDefined()
      const backups = exported.backup_plans as Array<{ name: string }>
      expect(backups[0]!.name).toBe('backup1')
      expect(exported.unrecognized_root_prop).toEqual({ version: 'mower-v3' })
      expect(exported.conf.free_blacklist).toEqual(['char_102_texas', 'char_103_angel'])
      expect(exported.conf.custom_conf_attr).toBe('keep_me')
    })

    it('preserves unknown fields inside facilities, slots, and non-standard rooms', () => {
      const detailedJson = JSON.stringify({
        default: 'plan1',
        plan1: {
          room_1_1: {
            name: '制造站',
            product: 'gold',
            facility_custom_key: 12345,
            plans: [
              {
                agent: '阿米娅',
                group: 'team_a',
                replacement: [],
                slot_extra_annotation: 'shift_primary',
              },
            ],
          },
          unknown_room_99: {
            name: '神秘房间',
            plans: [],
          },
        },
        conf: { ling_xi: 1 },
      })

      const ws = importMowerJson(detailedJson)
      const exported = JSON.parse(exportMowerJson(ws)) as ExportedMowerDocument
      const plan1 = exported.plan1 as Record<string, ExportedFacility>

      expect(plan1.room_1_1!.facility_custom_key).toBe(12345)
      expect(plan1.room_1_1!.plans[0]!.slot_extra_annotation).toBe('shift_primary')
      expect(plan1.unknown_room_99).toEqual({ name: '神秘房间', plans: [] })
    })
  })

  describe('Conf Parsing & Serialization', () => {
    it('handles ling_xi fallback when invalid or out of range', () => {
      const invalidLingXi = JSON.stringify({
        default: 'plan1',
        plan1: {},
        conf: { ling_xi: 99 },
      })
      const ws = importMowerJson(invalidLingXi)
      expect(ws.mainPlan.conf.ling_xi).toBe(1)
    })

    it('parses Chinese comma and whitespace in the 7 policy list fields', () => {
      const confJson = JSON.stringify({
        default: 'plan1',
        plan1: {},
        conf: {
          ling_xi: 1,
          exhaust_require: ' 阿罗玛 ， 槐琥,  伊内丝 ',
          rest_in_full: '',
          resting_priority: '令,夕',
        },
      })
      const ws = importMowerJson(confJson)
      expect(ws.mainPlan.conf.exhaust_require).toEqual(['char_446_aroma', 'char_243_waaifu', 'char_4087_ines'])
      expect(ws.mainPlan.conf.rest_in_full).toEqual([])
      expect(ws.mainPlan.conf.resting_priority).toEqual(['char_2023_ling', 'char_2015_dusk'])

      const exported = JSON.parse(exportMowerJson(ws)) as ExportedMowerDocument
      expect(exported.conf.exhaust_require).toBe('阿罗玛,槐琥,伊内丝')
      expect(exported.conf.rest_in_full).toBe('')
      expect(exported.conf.resting_priority).toBe('令,夕')
    })
  })

  describe('Error Handling & Pure Function Guarantees', () => {
    it('throws clear error for malformed JSON syntax', () => {
      expect(() => importMowerJson('{not a valid json')).toThrow(/Invalid Mower JSON/)
      expect(() => importMowerJson('')).toThrow(/Invalid Mower JSON/)
    })

    it('throws clear error when root is not a JSON object', () => {
      expect(() => importMowerJson('null')).toThrow(/Invalid Mower JSON/)
      expect(() => importMowerJson('123')).toThrow(/Invalid Mower JSON/)
      expect(() => importMowerJson('[]')).toThrow(/Invalid Mower JSON/)
      expect(() => importMowerJson('"string"')).toThrow(/Invalid Mower JSON/)
    })

    it('throws clear error when specified main plan is missing or not an object', () => {
      const missingPlanJson = JSON.stringify({ default: 'plan_x', plan_other: {} })
      expect(() => importMowerJson(missingPlanJson)).toThrow(/Main plan "plan_x" not found/)

      const nonObjectPlan = JSON.stringify({ default: 'plan1', plan1: 'not_an_object' })
      expect(() => importMowerJson(nonObjectPlan)).toThrow(/Main plan "plan1" must be an object/)
    })

    it('remains purely functional without mutating the input string or global state', () => {
      const raw = loadFixture('mower-252-3gold.json')
      const originalCopy = raw.slice()

      const ws1 = importMowerJson(raw)
      const ws2 = importMowerJson(raw)

      expect(raw).toBe(originalCopy)
      expect(ws1).not.toBe(ws2)
      expect(ws1.mainPlan.facilities).not.toBe(ws2.mainPlan.facilities)
      expect(ws1).toEqual(ws2)
    })
  })

  describe('Task 7 TDD Refinements & Regression Safeguards', () => {
    it('ensures managed top-level fields are never overwritten by unrecognizedFields or otherPlans', () => {
      const json = JSON.stringify({
        default: 'plan1',
        plan1: { central: { name: '', plans: [] } },
        conf: { ling_xi: 1 },
        backup_plans: [],
      })
      const ws = importMowerJson(json)
      ws.compatibility.unrecognizedFields = {
        default: 'hacked_default',
        plan1: { central: 'corrupted' },
        conf: { ling_xi: 999 },
        backup_plans: 'not_an_array',
      }
      ws.compatibility.otherPlans = {
        default: 'another_hacked_default',
        conf: 'bad_conf',
      }
      const exported = JSON.parse(exportMowerJson(ws)) as Record<string, unknown>
      expect(exported.default).toBe('plan1')
      expect(exported.backup_plans).toEqual([])
      expect(typeof exported.plan1).toBe('object')
      expect((exported.plan1 as Record<string, unknown>).central).toEqual({ name: '', plans: [] })
      expect((exported.conf as Record<string, unknown>).ling_xi).toBe(1)
    })

    it('preserves exact room key sets on real fixtures without injecting train or gaming, while default workspace exports all rooms', () => {
      const fixtures = [
        'mower-252-3gold.json',
        'mower-342-pure-lmd.json',
        'mower-342-orirock.json',
      ]
      for (const fixName of fixtures) {
        const rawStr = loadFixture(fixName)
        const rawJson = JSON.parse(rawStr) as { plan1: Record<string, unknown> }
        const ws = importMowerJson(rawStr)
        const exported = JSON.parse(exportMowerJson(ws)) as { plan1: Record<string, unknown> }

        const expectedKeys = Object.keys(rawJson.plan1).sort()
        const exportedKeys = Object.keys(exported.plan1).sort()
        expect(exportedKeys).toEqual(expectedKeys)
        expect(exportedKeys).not.toContain('train')
        expect(exportedKeys.some((k) => k.startsWith('gaming'))).toBe(false)
      }

      const defaultWs = createDefaultWorkspace()
      const exportedDefault = JSON.parse(exportMowerJson(defaultWs)) as { plan1: Record<string, unknown> }
      const defaultKeys = Object.keys(exportedDefault.plan1)
      expect(defaultKeys).toContain('train')
      expect(defaultKeys).toContain('gaming_1')
      expect(defaultKeys.length).toBe(21)
    })

    it('attaches slot metadata directly to MowerSlot entity so it travels with slot movements or swaps', () => {
      const json = JSON.stringify({
        default: 'plan1',
        plan1: {
          room_1_1: {
            name: '制造站',
            plans: [
              { agent: '阿米娅', group: 'grp1', replacement: [], slot_uuid: 'unique-123', custom_flag: true },
            ],
          },
          room_1_2: {
            name: '制造站',
            plans: [
              { agent: '白雪', group: 'grp2', replacement: [], slot_uuid: 'unique-456' },
            ],
          },
        },
        conf: { ling_xi: 1 },
      })
      const ws = importMowerJson(json)
      expect((ws.compatibility as unknown as { slotMetadata?: unknown }).slotMetadata).toBeUndefined()
      expect((ws.mainPlan.facilities.room_1_1.slots[0] as unknown as { metadata?: unknown })?.metadata).toEqual({
        slot_uuid: 'unique-123',
        custom_flag: true,
      })

      // Swap slots between room_1_1 and room_1_2
      const slot1 = ws.mainPlan.facilities.room_1_1.slots[0]!
      const slot2 = ws.mainPlan.facilities.room_1_2.slots[0]!
      ws.mainPlan.facilities.room_1_1.slots = [slot2]
      ws.mainPlan.facilities.room_1_2.slots = [slot1]

      const exported = JSON.parse(exportMowerJson(ws)) as {
        plan1: {
          room_1_1: { plans: Array<Record<string, unknown>> }
          room_1_2: { plans: Array<Record<string, unknown>> }
        }
      }
      expect(exported.plan1.room_1_2.plans[0]?.slot_uuid).toBe('unique-123')
      expect(exported.plan1.room_1_2.plans[0]?.custom_flag).toBe(true)
      expect(exported.plan1.room_1_2.plans[0]?.agent).toBe('阿米娅')

      expect(exported.plan1.room_1_1.plans[0]?.slot_uuid).toBe('unique-456')
      expect(exported.plan1.room_1_1.plans[0]?.agent).toBe('白雪')
    })

    it('ensures slot metadata cannot overwrite managed agent, group, or replacement fields', () => {
      const json = JSON.stringify({
        default: 'plan1',
        plan1: {
          room_1_1: {
            name: '制造站',
            plans: [
              { agent: '阿米娅', group: 'my_group', replacement: ['白雪'], extra: 1 },
            ],
          },
        },
        conf: { ling_xi: 1 },
      })
      const ws = importMowerJson(json)
      const slot = ws.mainPlan.facilities.room_1_1.slots[0]! as unknown as {
        occupant: unknown
        groupId: string | null
        replacements: string[]
        metadata?: Record<string, unknown>
      }
      slot.metadata = {
        agent: '恶意篡改干员',
        group: '恶意分组',
        replacement: ['恶意替补'],
        extra: 2,
      }
      slot.occupant = { kind: 'operator', operatorId: 'char_102_texas' }
      slot.groupId = 'good_group'
      slot.replacements = ['char_103_angel']

      const exported = JSON.parse(exportMowerJson(ws)) as {
        plan1: { room_1_1: { plans: Array<Record<string, unknown>> } }
      }
      const exportedSlot = exported.plan1.room_1_1.plans[0]!
      expect(exportedSlot.agent).toBe('德克萨斯')
      expect(exportedSlot.group).toBe('good_group')
      expect(exportedSlot.replacement).toEqual(['能天使'])
      expect(exportedSlot.extra).toBe(2)
    })

    it('rejects non-object elements inside plans array with a clear Invalid Mower JSON error', () => {
      const invalidSlotTypes = [
        'not_an_object',
        null,
        123,
        true,
        ['nested_array'],
      ]
      for (const badSlot of invalidSlotTypes) {
        const json = JSON.stringify({
          default: 'plan1',
          plan1: {
            room_1_1: {
              name: '制造站',
              plans: [badSlot],
            },
          },
          conf: { ling_xi: 1 },
        })
        expect(() => importMowerJson(json)).toThrow(/Invalid Mower JSON/)
      }
    })
  })

  describe('Task7 Batch 2 Compatibility and TDD Fixes', () => {
    it('round-trips unknown/custom facility name and unparseable product when unedited', () => {
      const json = JSON.stringify({
        default: 'plan1',
        plan1: {
          room_1_1: {
            name: '自定义训练设施',
            product: 'mysterious_crystal',
            plans: [],
          },
        },
        conf: { ling_xi: 1 },
      })
      const ws = importMowerJson(json)
      expect(ws.compatibility.facilityMetadata?.room_1_1?.rawName).toBe('自定义训练设施')
      expect(ws.compatibility.facilityMetadata?.room_1_1?.rawProduct).toBe('mysterious_crystal')

      const exported = JSON.parse(exportMowerJson(ws)) as {
        plan1: { room_1_1: { name: string; product: string; rawName?: unknown; rawProduct?: unknown } }
      }
      expect(exported.plan1.room_1_1.name).toBe('自定义训练设施')
      expect(exported.plan1.room_1_1.product).toBe('mysterious_crystal')
      expect(exported.plan1.room_1_1.rawName).toBeUndefined()
      expect(exported.plan1.room_1_1.rawProduct).toBeUndefined()
    })

    it('ensures user edited type or product strictly overrides raw/metadata values', () => {
      const json = JSON.stringify({
        default: 'plan1',
        plan1: {
          room_1_1: {
            name: '自定义设施',
            product: 'custom_rock',
            plans: [],
          },
        },
        conf: { ling_xi: 1 },
      })
      const ws = importMowerJson(json)

      // User edits type to trading
      ws.mainPlan.facilities.room_1_1.type = 'trading'
      // User edits product to money
      ws.mainPlan.facilities.room_1_1.product = 'money'

      // Even if metadata has malicious or raw values trying to override
      if (ws.compatibility.facilityMetadata?.room_1_1) {
        ws.compatibility.facilityMetadata.room_1_1.name = '恶意覆盖名称'
        ws.compatibility.facilityMetadata.room_1_1.product = '恶意覆盖产物'
      }

      const exported = JSON.parse(exportMowerJson(ws)) as {
        plan1: { room_1_1: { name: string; product: string } }
      }
      expect(exported.plan1.room_1_1.name).toBe('贸易站')
      expect(exported.plan1.room_1_1.product).toBe('lmd')

      // If user edits type to power, product is omitted
      ws.mainPlan.facilities.room_1_1.type = 'power'
      ws.mainPlan.facilities.room_1_1.product = undefined
      const exportedPower = JSON.parse(exportMowerJson(ws)) as {
        plan1: { room_1_1: { name: string; product?: string } }
      }
      expect(exportedPower.plan1.room_1_1.name).toBe('发电站')
      expect(exportedPower.plan1.room_1_1.product).toBeUndefined()
    })

    it('recognizes case-insensitive and whitespace-padded Free/Current and exports normative Free/Current', () => {
      const json = JSON.stringify({
        default: 'plan1',
        plan1: {
          room_1_1: {
            name: '制造站',
            plans: [
              { agent: '  free  ', group: '', replacement: [] },
              { agent: 'FREE', group: '', replacement: [] },
              { agent: ' current ', group: '', replacement: [] },
              { agent: 'CURRENT', group: '', replacement: [] },
              { agent: '   ', group: '', replacement: [] },
            ],
            product: 'gold',
          },
        },
        conf: { ling_xi: 1 },
      })
      const ws = importMowerJson(json)
      const slots = ws.mainPlan.facilities.room_1_1.slots
      expect(slots[0]!.occupant).toEqual({ kind: 'free' })
      expect(slots[1]!.occupant).toEqual({ kind: 'free' })
      expect(slots[2]!.occupant).toEqual({ kind: 'current' })
      expect(slots[3]!.occupant).toEqual({ kind: 'current' })
      expect(slots[4]!.occupant).toEqual({ kind: 'empty' })

      const exported = JSON.parse(exportMowerJson(ws)) as {
        plan1: { room_1_1: { plans: Array<{ agent: string }> } }
      }
      const exportedSlots = exported.plan1.room_1_1.plans
      expect(exportedSlots[0]!.agent).toBe('Free')
      expect(exportedSlots[1]!.agent).toBe('Free')
      expect(exportedSlots[2]!.agent).toBe('Current')
      expect(exportedSlots[3]!.agent).toBe('Current')
      expect(exportedSlots[4]!.agent).toBe('')
    })

    it('resolves conf list operator names to charId on import and restores Chinese names on export', () => {
      const json = JSON.stringify({
        default: 'plan1',
        plan1: {},
        conf: {
          ling_xi: 1,
          exhaust_require: '阿罗玛,机械师,未知干员XYZ',
          rest_in_full: ['阿罗玛', '机械师'],
          resting_priority: '乌尔比安',
          workaholic: 'Lancet-2',
          refresh_trading: '',
          refresh_drained: '玛恩纳',
          ope_resting_priority: '承曦格雷伊',
        },
      })
      const ws = importMowerJson(json)
      expect(ws.mainPlan.conf.exhaust_require).toEqual(['char_446_aroma', 'char_4230_mcnist', '未知干员XYZ'])
      expect(ws.mainPlan.conf.rest_in_full).toEqual(['char_446_aroma', 'char_4230_mcnist'])
      expect(ws.mainPlan.conf.resting_priority).toEqual(['char_4145_ulpia'])
      expect(ws.mainPlan.conf.workaholic).toEqual(['char_285_medic2'])
      expect(ws.mainPlan.conf.refresh_drained).toEqual(['char_4064_mlynar'])
      expect(ws.mainPlan.conf.ope_resting_priority).toEqual(['char_1027_greyy2'])

      const exported = JSON.parse(exportMowerJson(ws)) as { conf: ExportedConf }
      expect(exported.conf.exhaust_require).toBe('阿罗玛,机械师,未知干员XYZ')
      expect(exported.conf.rest_in_full).toBe('阿罗玛,机械师')
      expect(exported.conf.resting_priority).toBe('乌尔比安')
      expect(exported.conf.workaholic).toBe('Lancet-2')
      expect(exported.conf.refresh_drained).toBe('玛恩纳')
      expect(exported.conf.ope_resting_priority).toBe('承曦格雷伊')
    })

    it('enables store.replaceOperatorGlobally to match and update conf operator lists', () => {
      const json = JSON.stringify({
        default: 'plan1',
        plan1: {
          room_1_1: {
            name: '制造站',
            plans: [{ agent: '阿罗玛', group: '', replacement: [] }],
            product: 'gold',
          },
        },
        conf: {
          ling_xi: 1,
          exhaust_require: '阿罗玛,机械师',
          rest_in_full: '',
          resting_priority: '',
          workaholic: '',
          refresh_trading: '',
          refresh_drained: '',
          ope_resting_priority: '',
        },
      })
      const ws = importMowerJson(json)
      const store = useRosterWorkbenchStore()
      store.loadWorkspace(ws)

      // Replace char_446_aroma (阿罗玛) with char_4064_mlynar (玛恩纳)
      store.replaceOperatorGlobally('char_446_aroma', 'char_4064_mlynar')

      expect(store.workspace.mainPlan.conf.exhaust_require).toEqual(['char_4064_mlynar', 'char_4230_mcnist'])
      expect(store.workspace.mainPlan.facilities.room_1_1.slots[0]?.occupant).toEqual({
        kind: 'operator',
        operatorId: 'char_4064_mlynar',
      })

      const exported = JSON.parse(exportMowerJson(store.workspace)) as {
        plan1: { room_1_1: { plans: Array<{ agent: string }> } }
        conf: ExportedConf
      }
      expect(exported.plan1.room_1_1.plans[0]?.agent).toBe('玛恩纳')
      expect(exported.conf.exhaust_require).toBe('玛恩纳,机械师')
    })

    it('preserves missing conf and backup_plans fields when imported without them, but exports standard defaults for new workspaces', () => {
      // Missing conf and backup_plans
      const minimalJson = JSON.stringify({
        default: 'plan1',
        plan1: {
          room_1_1: { name: '制造站', plans: [], product: 'gold' },
        },
      })
      const ws = importMowerJson(minimalJson)
      expect(ws.compatibility.importedHasConf).toBe(false)
      expect(ws.compatibility.importedHasBackupPlans).toBe(false)

      const exported = JSON.parse(exportMowerJson(ws)) as Record<string, unknown>
      expect('conf' in exported).toBe(false)
      expect('backup_plans' in exported).toBe(false)
      expect(exported.default).toBe('plan1')

      // Newly created workspace has standard conf and backup_plans
      const defaultWs = createDefaultWorkspace()
      expect(defaultWs.compatibility.importedHasConf).toBeUndefined()
      expect(defaultWs.compatibility.importedHasBackupPlans).toBeUndefined()

      const exportedDefault = JSON.parse(exportMowerJson(defaultWs)) as Record<string, unknown>
      expect('conf' in exportedDefault).toBe(true)
      expect('backup_plans' in exportedDefault).toBe(true)
    })

    it('exports rooms in original importedPresentRooms order, and appends newly configured rooms at the end', () => {
      const json = JSON.stringify({
        default: 'plan1',
        plan1: {
          central: { name: '', plans: [] },
          room_2_3: { name: '发电站', plans: [] },
          room_1_1: { name: '制造站', plans: [], product: 'gold' },
        },
        conf: { ling_xi: 1 },
      })
      const ws = importMowerJson(json)
      expect(ws.compatibility.importedPresentRooms).toEqual(['central', 'room_2_3', 'room_1_1'])

      // Unedited export preserves original JSON room order
      const exportedUnedited = JSON.parse(exportMowerJson(ws)) as { plan1: Record<string, unknown> }
      expect(Object.keys(exportedUnedited.plan1)).toEqual(['central', 'room_2_3', 'room_1_1'])

      // After user edits room_3_1 via store, room_3_1 is appended at the end
      const store = useRosterWorkbenchStore()
      store.loadWorkspace(ws)
      store.updateFacility('room_3_1', { type: 'trading', product: 'money' })

      const exportedEdited = JSON.parse(exportMowerJson(store.workspace)) as { plan1: Record<string, unknown> }
      expect(Object.keys(exportedEdited.plan1)).toEqual(['central', 'room_2_3', 'room_1_1', 'room_3_1'])
    })

    it('exports unknown rawProduct as-is when unedited, clears rawProduct on store patch, and falls back to safe default gold/lmd on undefined', () => {
      const json = JSON.stringify({
        default: 'plan1',
        plan1: {
          room_1_1: { name: '制造站', plans: [], product: 'unknown_gear' },
          room_1_2: { name: '贸易站', plans: [], product: 'unknown_currency' },
        },
        conf: { ling_xi: 1 },
      })
      const ws = importMowerJson(json)
      expect(ws.compatibility.facilityMetadata?.room_1_1?.rawProduct).toBe('unknown_gear')
      expect(ws.compatibility.facilityMetadata?.room_1_2?.rawProduct).toBe('unknown_currency')

      // 1. Unedited export preserves rawProduct without being shadowed by serializeProduct default
      const exported1 = JSON.parse(exportMowerJson(ws)) as {
        plan1: {
          room_1_1: { product: string }
          room_1_2: { product: string }
        }
      }
      expect(exported1.plan1.room_1_1.product).toBe('unknown_gear')
      expect(exported1.plan1.room_1_2.product).toBe('unknown_currency')

      // 2. User clears product to undefined via store updateFacility
      const store = useRosterWorkbenchStore()
      store.loadWorkspace(ws)
      store.updateFacility('room_1_1', { product: undefined })
      store.updateFacility('room_1_2', { product: undefined })

      expect(store.workspace.compatibility.facilityMetadata?.room_1_1?.rawProduct).toBeUndefined()
      expect(store.workspace.compatibility.facilityMetadata?.room_1_2?.rawProduct).toBeUndefined()

      // Export now uses safe default gold for manufacture and lmd for trading
      const exported2 = JSON.parse(exportMowerJson(store.workspace)) as {
        plan1: {
          room_1_1: { product: string }
          room_1_2: { product: string }
        }
      }
      expect(exported2.plan1.room_1_1.product).toBe('gold')
      expect(exported2.plan1.room_1_2.product).toBe('lmd')

      // 3. User sets product to standard value
      store.updateFacility('room_1_1', { product: 'exp' })
      const exported3 = JSON.parse(exportMowerJson(store.workspace)) as {
        plan1: {
          room_1_1: { product: string }
        }
      }
      expect(exported3.plan1.room_1_1.product).toBe('exp3')
    })

    it('immediately throws Invalid Mower JSON when known room rawFacility is not an object', () => {
      const badFacilities: unknown[] = [null, 'string', 123, true, []]
      for (const bad of badFacilities) {
        const json = JSON.stringify({
          default: 'plan1',
          plan1: {
            room_1_1: bad,
          },
        })
        expect(() => importMowerJson(json)).toThrow(/Invalid Mower JSON/)
      }
    })

    it('immediately throws structural error when conf or backup_plans is present but of wrong type', () => {
      const badConfs: unknown[] = [null, 'not_an_obj', [], 123, true]
      for (const bad of badConfs) {
        const json = JSON.stringify({
          default: 'plan1',
          plan1: {},
          conf: bad,
        })
        expect(() => importMowerJson(json)).toThrow(/Invalid Mower JSON/)
      }

      const badBackups: unknown[] = [null, 'not_an_arr', {}, 123, true]
      for (const bad of badBackups) {
        const json = JSON.stringify({
          default: 'plan1',
          plan1: {},
          backup_plans: bad,
        })
        expect(() => importMowerJson(json)).toThrow(/Invalid Mower JSON/)
      }
    })
  })
})



it('preserves native balanced ling_xi=0 without changing it to perception mode',()=>{
 const document=JSON.parse(exportMowerJson(createDefaultWorkspace()))
 document.conf.ling_xi=0
 const workspace=importMowerJson(JSON.stringify(document))
 expect(workspace.mainPlan.conf.ling_xi).toBe(0)
 expect(JSON.parse(exportMowerJson(workspace)).conf.ling_xi).toBe(0)
})
