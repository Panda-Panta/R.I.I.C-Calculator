import { describe, it, expect } from 'vitest'
import { createDefaultWorkspace } from './defaults'
import { importMowerJson, exportMowerJson } from './compat/mowerJson'
import {
  serializeBackupTrigger,
  validateBackupTrigger,
  humanizeBackupTrigger,
  createDefaultBackupPlan,
  getFacilityRoomDisplayName,
  getFacilityMaxSlots,
  isDormitoryRoom,
  formatConfListToString,
  parseConfStringToOperatorNames,
} from './backupPlanHelpers'

describe('backupPlanHelpers', () => {
  describe('serializeBackupTrigger', () => {
    it('serializes string expressions directly', () => {
      expect(serializeBackupTrigger("op_data.operators['令'].is_resting() == True")).toBe("op_data.operators['令'].is_resting() == True")
    })

    it('serializes AST nodes into expression text', () => {
      const ast = {
        left: "op_data.operators['薇薇安娜'].is_resting()",
        operator: "and",
        right: "op_data.operators['阿罗玛'].is_working()",
      }
      expect(serializeBackupTrigger(ast)).toBe("(op_data.operators['薇薇安娜'].is_resting() and op_data.operators['阿罗玛'].is_working())")
    })

    it('handles nested AST nodes', () => {
      const nested = {
        left: {
          left: "op_data.operators['森蚺'].is_resting()",
          operator: "==",
          right: "True",
        },
        operator: "or",
        right: "False",
      }
      expect(serializeBackupTrigger(nested)).toBe("((op_data.operators['森蚺'].is_resting() == True) or False)")
    })

    it('handles empty / boolean / number values', () => {
      expect(serializeBackupTrigger(true)).toBe('True')
      expect(serializeBackupTrigger(false)).toBe('False')
      expect(serializeBackupTrigger(42)).toBe('42')
      expect(serializeBackupTrigger(null)).toBe('')
    })

    it.each([
      ['max', ['1', '9', '3'], 'max(1, 9, 3)'], ['min', ['1', '9', '3'], 'min(1, 9, 3)'],
      ['sum', ['1', '9', '3'], 'sum([1, 9, 3])'], ['any', ['True', 'False'], 'any([True, False])'],
      ['all', ['True', 'False'], 'all([True, False])'], ['abs', ['-8'], 'abs(-8)'],
      ['max', ['7'], 'max([7])'], ['min', ['7'], 'min([7])'],
    ])('uses upstream FunctionExpression serialization for %s %j', (name, args, text) => {
      expect(serializeBackupTrigger({ function: name, args })).toBe(text)
    })

    it('serializes nested functions and empty logic trees consistently with runtime', () => {
      expect(serializeBackupTrigger({ function: 'sum', args: ['1', { function: 'abs', args: ['-2'] }] })).toBe('sum([1, abs(-2)])')
      expect(serializeBackupTrigger({})).toBe('False')
      expect(serializeBackupTrigger({ left: ' ', right: '\t' })).toBe('False')
    })
  })

  describe('validateBackupTrigger', () => {
    it('validates correct expression and extracts participants', () => {
      const result = validateBackupTrigger("op_data.operators['令'].is_resting() == True")
      expect(result.valid).toBe(true)
      expect(result.participants).toContain('char_2023_ling')
    })

    it('validates correct AST node', () => {
      const result = validateBackupTrigger({
        left: "op_data.operators['薇薇安娜'].is_resting()",
        operator: "and",
        right: "op_data.operators['阿罗玛'].is_working()",
      })
      expect(result.valid).toBe(true)
      expect(result.participants).toHaveLength(2)
    })

    it('detects syntax error', () => {
      const result = validateBackupTrigger("op_data.operators['令'].is_resting( == True")
      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('detects unknown operator error', () => {
      const result = validateBackupTrigger("op_data.operators['未知神秘人'].is_resting()")
      expect(result.valid).toBe(false)
      expect(result.error).toContain('未知干员')
    })

    it('validates nested functions and observes their participants without altering unknown fields', () => {
      const source = { function: 'all', args: [{ function: 'any', args: ["op_data.operators['令'].is_resting()"], future: { value: 1 } }], future: 'keep' }
      const before = structuredClone(source), result = validateBackupTrigger(source)
      expect(result.valid).toBe(true)
      expect(result.participants).toEqual(['char_2023_ling'])
      expect(source).toEqual(before)
      expect(humanizeBackupTrigger(source)).toContain('令休息中')
    })

    it('preserves function trees and unknown fields through the actual JSON import/export path', () => {
      const source = JSON.parse(exportMowerJson(createDefaultWorkspace()))
      const trigger = { function: 'all', args: [{ function: 'max', args: ['1', '2'], future: 'nested' }, 'True'], future: { mode: 1 } }
      source.backup_plans = [{ name: '函数条件', trigger, plan: {}, conf: {}, future: ['keep'] }]
      const imported = importMowerJson(JSON.stringify(source))
      const exported = JSON.parse(exportMowerJson(imported))
      expect(exported.backup_plans[0].trigger).toEqual(trigger)
      expect(exported.backup_plans[0].future).toEqual(['keep'])
      expect(validateBackupTrigger(exported.backup_plans[0].trigger).valid).toBe(true)
    })

    it('distinguishes an empty source from a valid empty logic tree and rejects invalid function AST', () => {
      expect(validateBackupTrigger('').valid).toBe(false)
      expect(validateBackupTrigger(null).valid).toBe(false)
      expect(validateBackupTrigger({}).valid).toBe(true)
      expect(validateBackupTrigger({ function: 'eval', args: ['1'] }).valid).toBe(false)
      expect(validateBackupTrigger({ function: 'abs', args: ['1', '2'] }).error).toContain('只接受一项参数')
      let source: unknown = 'True'
      for (let i = 0; i < 34; i++) source = { function: 'any', args: [source] }
      expect(validateBackupTrigger(source).error).toContain('条件树超过限制')
    })
  })

  describe('humanizeBackupTrigger', () => {
    it('turns operator methods into readable Chinese summary', () => {
      const ast = {
        left: "op_data.operators['薇薇安娜'].is_resting()",
        operator: "and",
        right: "op_data.operators['阿罗玛'].is_working()",
      }
      const summary = humanizeBackupTrigger(ast)
      expect(summary).toContain('薇薇安娜休息中')
      expect(summary).toContain('且')
      expect(summary).toContain('阿罗玛工作中')
    })

    it('formats True / False nicely', () => {
      expect(humanizeBackupTrigger('True')).toBe('始终触发 (True)')
      expect(humanizeBackupTrigger('False')).toBe('不触发 (False)')
    })
  })

  describe('createDefaultBackupPlan', () => {
    it('creates a standard backup plan structure', () => {
      const plan = createDefaultBackupPlan(3)
      expect(plan.name).toBe('副表 #3')
      expect(plan.trigger_timing).toBeUndefined()
      expect(plan.trigger).toBe('True')
      expect(plan.group_ids).toEqual(['default'])
      expect(plan.type).toBe('global')
      expect(plan.task).toEqual({})
      expect(plan.conf?.ling_xi).toBe(1)
    })
  })

  describe('facility utilities', () => {
    it('maps facility room display names', () => {
      expect(getFacilityRoomDisplayName('central')).toBe('控制中枢')
      expect(getFacilityRoomDisplayName('dormitory_1')).toBe('宿舍 1')
      expect(getFacilityRoomDisplayName('room_2_1')).toBe('B201')
    })

    it('returns max slots', () => {
      expect(getFacilityMaxSlots('central')).toBe(5)
      expect(getFacilityMaxSlots('dormitory_3')).toBe(5)
      expect(getFacilityMaxSlots('room_1_1')).toBe(3)
      expect(getFacilityMaxSlots('meeting')).toBe(2)
      expect(getFacilityMaxSlots('contact')).toBe(1)
    })

    it('checks dormitory room', () => {
      expect(isDormitoryRoom('dormitory_1')).toBe(true)
      expect(isDormitoryRoom('room_1_1')).toBe(false)
    })

    it('parses and formats conf lists', () => {
      const parsed = parseConfStringToOperatorNames('令，夕, 薇薇安娜')
      expect(parsed).toEqual(['令', '夕', '薇薇安娜'])
      expect(formatConfListToString(['char_2023_ling', 'char_2013_cerber'])).toBe('令, 刻俄柏')
    })
  })
})
