import { beforeEach, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useRosterWorkbenchStore } from './store'
import { computeReplacementScope } from './operatorHelpers'

beforeEach(() => setActivePinia(createPinia()))

function fixture() {
  const store = useRosterWorkbenchStore()
  store.updateSlot('room_1_1', 0, {
    occupant: { kind: 'operator', operatorId: 'char_123_fang' }, groupId: 'A', replacements: ['char_123_fang', 'unrelated'],
    groupBindings: [{ groupId: 'B', replacements: ['char_123_fang'], metadata: { keep: '芬' } }], metadata: { keep: '芬' },
  })
  store.updateConf({ resting_priority_replacement: ['char_123_fang'], free_room_exclusions: ['char_123_fang'],
    resting_standby: ['char_123_fang'], free_blacklist: ['char_123_fang'], refresh_trading: ['芬(room_1_1)'],
    removed_operators: { free_blacklist: ' 芬(room_2_1)，杜林 ' },
    operator_mood_limits: { 芬: { lower: 1, upper: 20 }, unknown: { lower: 2, upper: 22 } }, unknown: { name: '芬' },
  })
  store.workspace.compatibility.unrecognizedFields.advanced_settings = { dorm_isolation: [['芬', '杜林'], ['char_123_fang']],
    favorite: '芬,char_123_fang,杜林', future: { name: '芬' } }
  store.workspace.compatibility.backupPlans = [{ name: 'native backup', trigger: "op_data.operators['芬'].is_resting()", future: '芬',
    conf: { resting_standby: '芬', removed_operators: { free_blacklist: ['char_123_fang'] }, operator_mood_limits: { char_123_fang: { lower: 0, upper: 18 } }, future: '芬' },
    task: { room_1_1: ['芬', 'Current'] },
    plan: { room_1_1: { plans: [{ agent: '芬', group: 'A', replacement: ['芬'], group_bindings: [{ group: 'B', replacement: ['芬'], future: '芬' }], future: '芬' }], future: '芬' } },
  }]
  return store
}

it('previews all 21 supported references without editing them and replaces the same references without touching extensions', () => {
  const store = fixture(), before = JSON.stringify(store.workspace)
  const impact = computeReplacementScope(store.workspace.mainPlan, 'char_123_fang', store.workspace.compatibility)
  expect(impact.totalCount).toBe(21)
  expect(impact.mainLocations).toHaveLength(1)
  expect(impact.replacementLocations).toHaveLength(1)
  expect(impact.confLocations).toHaveLength(5)
  expect(impact.additionalLocations).toHaveLength(14)
  expect(JSON.stringify(store.workspace)).toBe(before)
  store.replaceOperatorGlobally('char_123_fang', 'char_240_wyvern')
  const slot = store.workspace.mainPlan.facilities.room_1_1.slots[0]!
  expect(slot).toEqual({ occupant: { kind: 'operator', operatorId: 'char_240_wyvern' }, groupId: 'A', replacements: ['char_240_wyvern', 'unrelated'],
    groupBindings: [{ groupId: 'B', replacements: ['char_240_wyvern'], metadata: { keep: '芬' } }], metadata: { keep: '芬' } })
  expect(store.workspace.mainPlan.conf).toMatchObject({ resting_priority_replacement: ['char_240_wyvern'], free_room_exclusions: ['char_240_wyvern'],
    resting_standby: ['char_240_wyvern'], free_blacklist: ['char_240_wyvern'], refresh_trading: ['香草(room_1_1)'],
    removed_operators: { free_blacklist: ' 香草(room_2_1)，杜林 ' },
    operator_mood_limits: { 香草: { lower: 1, upper: 20 }, unknown: { lower: 2, upper: 22 } }, unknown: { name: '芬' } })
  expect(store.workspace.compatibility.unrecognizedFields.advanced_settings).toEqual({ dorm_isolation: [['香草', '杜林'], ['char_240_wyvern']],
    favorite: '香草,char_240_wyvern,杜林', future: { name: '芬' } })
  expect(store.workspace.compatibility.backupPlans).toEqual([{ name: 'native backup', trigger: "op_data.operators['芬'].is_resting()", future: '芬',
    conf: { resting_standby: '香草', removed_operators: { free_blacklist: ['char_240_wyvern'] }, operator_mood_limits: { char_240_wyvern: { lower: 0, upper: 18 } }, future: '芬' },
    task: { room_1_1: ['香草', 'Current'] },
    plan: { room_1_1: { plans: [{ agent: '香草', group: 'A', replacement: ['香草'], group_bindings: [{ group: 'B', replacement: ['香草'], future: '芬' }], future: '芬' }], future: '芬' } },
  }])
})

it('keeps the legacy main-plan preview entry while including additional bindings and all supported main policies', () => {
  const store = fixture()
  expect(computeReplacementScope(store.workspace.mainPlan, 'char_123_fang').totalCount).toBe(10)
})
