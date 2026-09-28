import { describe, it, expect } from 'vitest'
import {
  buildOperatorSearchIndex,
  searchOperators,
  getOperatorAvatarUrl,
  getOperatorName,
  isRunOrderOperator,
  getRoomDisplayName,
  getAssignedSummaryMap,
  computeReplacementScope,
} from './operatorHelpers'
import { OPERATORS } from '../domain/operators'
import { createDefaultWorkspace } from './defaults'

describe('operatorHelpers', () => {
  it('recognizes Closure and U-Official as trade run-order replacements', () => {
    expect(isRunOrderOperator('可露希尔')).toBe(true)
    expect(isRunOrderOperator('U-Official')).toBe(true)
  })
  describe('searchOperators & buildOperatorSearchIndex', () => {
    const index = buildOperatorSearchIndex(OPERATORS)

    it('indexes operators with full pinyin and pinyin initials', () => {
      const amiya = index.find((op) => op.name === '阿米娅')
      expect(amiya).toBeDefined()
      expect(amiya!.fullPinyin).toContain('amiya')
      expect(amiya!.firstLetters).toContain('amy')
    })

    it('searches by Chinese character name', () => {
      const results = searchOperators('银灰', index)
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]!.name).toBe('银灰')
    })

    it('searches by full pinyin', () => {
      const results = searchOperators('yinhui', index)
      expect(results.some((op) => op.name === '银灰')).toBe(true)
    })

    it('searches by pinyin initials', () => {
      const results = searchOperators('yh', index)
      expect(results.some((op) => op.name === '银灰')).toBe(true)
    })

    it('searches by English appellation', () => {
      const results = searchOperators('silverash', index)
      expect(results.some((op) => op.name === '银灰')).toBe(true)
    })

    it('returns capped results when query is empty', () => {
      const results = searchOperators('', index, 20)
      expect(results.length).toBe(20)
    })
  })

  describe('getOperatorName', () => {
    it('resolves charId to Chinese operator name without showing char_id', () => {
      expect(getOperatorName('char_102_texas')).toBe('德克萨斯')
      expect(getOperatorName('char_002_amiya')).toBe('阿米娅')
      expect(getOperatorName('char_300_phenxi')).toBe('菲亚梅塔')
      expect(getOperatorName('char_4042_lumen')).toBe('流明')
    })

    it('resolves English appellation to Chinese operator name', () => {
      expect(getOperatorName('Texas')).toBe('德克萨斯')
      expect(getOperatorName('texas')).toBe('德克萨斯')
      expect(getOperatorName('Amiya')).toBe('阿米娅')
      expect(getOperatorName('Fiammetta')).toBe('菲亚梅塔')
    })

    it('preserves Chinese names, Free, and Current', () => {
      expect(getOperatorName('德克萨斯')).toBe('德克萨斯')
      expect(getOperatorName('Free')).toBe('Free')
      expect(getOperatorName('Current')).toBe('Current')
    })
  })

  describe('getOperatorAvatarUrl', () => {
    it('returns standard avatar webp URL for operators', () => {
      expect(getOperatorAvatarUrl('银灰')).toBe('/avatar/%E9%93%B6%E7%81%B0.webp')
      expect(getOperatorAvatarUrl('char_172_svrash')).toBe('/avatar/%E9%93%B6%E7%81%B0.webp')
    })

    it('returns Free and Current avatar URLs', () => {
      expect(getOperatorAvatarUrl('Free')).toBe('/avatar/Free.webp')
      expect(getOperatorAvatarUrl('Current')).toBe('/avatar/Current.webp')
    })
  })

  describe('getRoomDisplayName', () => {
    it('formats output rooms with B-indices and facility types', () => {
      expect(getRoomDisplayName('room_1_1', 'manufacture')).toBe('B101 (制造站)')
      expect(getRoomDisplayName('room_1_3', 'power')).toBe('B103 (发电站)')
    })

    it('formats functional facilities', () => {
      expect(getRoomDisplayName('central')).toBe('控制中枢')
      expect(getRoomDisplayName('dormitory_1')).toBe('宿舍1')
      expect(getRoomDisplayName('meeting')).toBe('会客室')
    })
  })

  describe('getAssignedSummaryMap', () => {
    it('maps on-duty operators to their room names', () => {
      const ws = createDefaultWorkspace()
      ws.mainPlan.facilities.room_1_1.slots[0] = {
        occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
        groupId: null,
        replacements: [],
      }
      ws.mainPlan.facilities.central.slots[0] = {
        occupant: { kind: 'operator', operatorId: 'char_102_texas' },
        groupId: null,
        replacements: [],
      }

      const assigned = getAssignedSummaryMap(ws.mainPlan)
      expect(assigned.get('char_002_amiya')).toBe('B101 (制造站)')
      expect(assigned.get('char_102_texas')).toBe('控制中枢')
    })
  })

  describe('computeReplacementScope', () => {
    it('identifies all affected main slots, replacement slots, and conf lists', () => {
      const ws = createDefaultWorkspace()
      // Main slot
      ws.mainPlan.facilities.room_1_1.slots[0] = {
        occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
        groupId: 'team_a',
        replacements: ['char_103_angel'],
      }
      // Replacement slot in another room
      ws.mainPlan.facilities.room_2_1.slots[0] = {
        occupant: { kind: 'operator', operatorId: 'char_102_texas' },
        groupId: null,
        replacements: ['char_002_amiya'],
      }
      // Conf list
      ws.mainPlan.conf.exhaust_require = ['char_002_amiya']

      const scope = computeReplacementScope(ws.mainPlan, 'char_002_amiya')
      expect(scope.totalCount).toBe(3)
      expect(scope.mainLocations).toHaveLength(1)
      expect(scope.mainLocations[0]!.roomName).toBe('B101 (制造站)')
      expect(scope.mainLocations[0]!.slotIndex).toBe(0)
      expect(scope.replacementLocations).toHaveLength(1)
      expect(scope.replacementLocations[0]!.roomName).toBe('B201 (制造站)')
      expect(scope.confLocations).toContain('exhaust_require')
    })
  })
})
