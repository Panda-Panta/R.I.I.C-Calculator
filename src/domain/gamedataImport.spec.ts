import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OperatorRecord } from './operators'
import { selectUnlockedSkills } from './operatorInventory'

const importer = fileURLToPath(new URL('../../scripts/import-gamedata.mjs', import.meta.url))
const auditor = fileURLToPath(new URL('../../scripts/audit-riic-data.mjs', import.meta.url))
const tempPrefix = path.join(tmpdir(), 'riic-gamedata-import-')
let directory: string
let source: string
let output: string

function sourceBuilding() {
  return {
    chars: {
      char_stage_test: {
        buffChar: [
          { buffData: [
            { buffId: 'power_beta', cond: { phase: 'PHASE_2', level: 1 } },
            { buffId: 'manu_alpha', cond: { phase: 'PHASE_0', level: 1 } },
          ] },
          { buffData: [
            { buffId: 'dorm_level30', cond: { phase: 'PHASE_0', level: 30 } },
            { buffId: 'workshop_initial', cond: { phase: 'PHASE_0', level: 1 } },
          ] },
        ],
      },
    },
    buffs: {
      manu_alpha: { buffName: '制造初始', roomType: 'MANUFACTURE', skillIcon: 'manufacture', description: '<@cc.vup>制造效率+10%</>' },
      power_beta: { buffName: '发电升级', roomType: 'POWER', skillIcon: 'power', description: '无人机充能+20%' },
      workshop_initial: { buffName: '加工初始', roomType: 'WORKSHOP', skillIcon: 'workshop', description: '加工效率+10%' },
      dorm_level30: { buffName: '宿舍解锁', roomType: 'DORMITORY', skillIcon: 'dorm', description: '心情恢复+0.65' },
    },
  }
}

function writeBuilding(value: object) {
  writeFileSync(path.join(source, 'building_data.json'), JSON.stringify(value))
}

function run(script: string) {
  return spawnSync(process.execPath, [script, source], { cwd: directory, encoding: 'utf8' })
}

function imported(): { schemaVersion: number; skillCount: number; skillStageCount: number; operators: OperatorRecord[] } {
  const result = run(importer)
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(readFileSync(output, 'utf8'))
}

beforeEach(() => {
  directory = mkdtempSync(tempPrefix)
  source = path.join(directory, 'input')
  output = path.join(directory, 'src', 'data', 'operators.generated.json')
  mkdirSync(source)
  writeBuilding(sourceBuilding())
  writeFileSync(path.join(source, 'character_table.json'), JSON.stringify({
    char_stage_test: { name: '阶段测试', rarity: 'TIER_6', profession: 'MEDIC', isSpChar: true },
  }))
  writeFileSync(path.join(source, 'data_version.txt'), 'test-stage-data')
})

afterEach(() => {
  const target = path.resolve(directory)
  if (!target.startsWith(path.resolve(tempPrefix))) throw new Error('Unexpected test cleanup path')
  rmSync(target, { recursive: true, force: true })
})

describe('GameData reimport preserves actual skill stages', () => {
  it('exports every slot version while keeping the highest-stage snapshot compatible', () => {
    const payload = imported()
    expect(payload.operators[0]!.skillSlots).toEqual([
      [
        expect.objectContaining({ buffId: 'manu_alpha', roomType: 'MANUFACTURE', unlockPhase: 0, unlockLevel: 1, description: '制造效率+10%' }),
        expect.objectContaining({ buffId: 'power_beta', roomType: 'POWER', unlockPhase: 2, unlockLevel: 1 }),
      ],
      [
        expect.objectContaining({ buffId: 'workshop_initial', roomType: 'WORKSHOP', unlockPhase: 0, unlockLevel: 1 }),
        expect.objectContaining({ buffId: 'dorm_level30', roomType: 'DORMITORY', unlockPhase: 0, unlockLevel: 30 }),
      ],
    ])
    expect(payload.operators[0]!.skills.map(skill => skill.buffId)).toEqual(['power_beta', 'dorm_level30'])
    expect(payload.skillCount).toBe(2)
    expect(payload.skillStageCount).toBe(4)
    expect(payload.operators[0]!.isAlter).toBe(true)
  })

  it('supports actual levels and earlier-stage unlocks after promotion on freshly imported data', () => {
    const operator = imported().operators[0]!
    expect(selectUnlockedSkills(operator, 0, 29).map(skill => skill.buffId)).toEqual(['manu_alpha', 'workshop_initial'])
    expect(selectUnlockedSkills(operator, 0, 30).map(skill => skill.buffId)).toEqual(['manu_alpha', 'dorm_level30'])
    expect(selectUnlockedSkills(operator, 2, 1).map(skill => skill.buffId)).toEqual(['power_beta', 'dorm_level30'])
  })

  it('cleans repeated skill markup delimiters while preserving numeric comparisons', () => {
    const building = sourceBuilding()
    building.buffs.manu_alpha.description = '<@cc.vup>+10</>点<<$cc.bd_b1><@cc.rem>人间烟火</></>，心情<12'
    writeBuilding(building)
    expect(imported().operators[0]!.skillSlots![0]![0]!.description).toBe('+10点人间烟火，心情<12')
  })

  it('ignores empty source placeholders without losing independent skill slots', () => {
    const building = sourceBuilding()
    building.chars.char_stage_test.buffChar.splice(1, 0, { buffData: [] })
    writeBuilding(building)
    const operator = imported().operators[0]!
    expect(operator.skillSlots).toHaveLength(2)
    expect(selectUnlockedSkills(operator, 0, 30).map(skill => skill.buffId)).toEqual(['manu_alpha', 'dorm_level30'])
    expect(run(auditor).status).toBe(0)
  })

  it('audits freshly imported stages and rejects a missing low-stage version', () => {
    const payload = imported()
    expect(run(auditor).status).toBe(0)
    expect(payload.operators[0]!.skillSlots).toBeDefined()
    payload.operators[0]!.skillSlots![0]!.shift()
    payload.skillStageCount = 3
    writeFileSync(output, JSON.stringify(payload))
    const audit = run(auditor)
    expect(audit.status).toBe(1)
    expect(audit.stderr).toContain('Skill stage mismatch')
  })

  it('rejects a legacy maximum-only catalog in the audit', () => {
    const payload = imported()
    delete payload.operators[0]!.skillSlots
    writeFileSync(output, JSON.stringify(payload))
    const audit = run(auditor)
    expect(audit.status).toBe(1)
    expect(audit.stderr).toContain('Missing skillSlots')
  })

  it('audits unlock conditions independently of the highest-stage snapshot', () => {
    const payload = imported()
    expect(payload.operators[0]!.skillSlots).toBeDefined()
    payload.operators[0]!.skillSlots![1]![1]!.unlockLevel = 29
    writeFileSync(output, JSON.stringify(payload))
    const audit = run(auditor)
    expect(audit.status).toBe(1)
    expect(audit.stderr).toContain('Skill stage mismatch')
  })

  it('rejects a maximum snapshot that disagrees with its retained slot version', () => {
    const payload = imported()
    payload.operators[0]!.skills[0]!.unlockPhase = 0
    writeFileSync(output, JSON.stringify(payload))
    const audit = run(auditor)
    expect(audit.status).toBe(1)
    expect(audit.stderr).toContain('Highest-stage snapshot mismatch')
  })

  it('does not overwrite existing data when a low-stage buff definition is missing', () => {
    const building = sourceBuilding()
    delete (building.buffs as Partial<typeof building.buffs>).manu_alpha
    writeBuilding(building)
    mkdirSync(path.dirname(output), { recursive: true })
    writeFileSync(output, 'previous verified catalog')
    const result = run(importer)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Missing buff definition')
    expect(readFileSync(output, 'utf8')).toBe('previous verified catalog')
  })

  it('does not turn an unknown unlock phase into an initial skill', () => {
    const building = sourceBuilding()
    building.chars.char_stage_test.buffChar[0]!.buffData[1]!.cond.phase = 'PHASE_UNKNOWN'
    writeBuilding(building)
    const result = run(importer)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unknown skill unlock phase')
  })

  it('keeps unobtainable mode-only operators out of the selectable catalog', () => {
    const building = sourceBuilding()
    writeBuilding({ ...building, chars: { ...building.chars, char_mode_test: building.chars.char_stage_test } })
    writeFileSync(path.join(source, 'character_table.json'), JSON.stringify({
      char_stage_test: { name: '阶段测试', rarity: 'TIER_6', profession: 'MEDIC', isSpChar: true },
      char_mode_test: { name: '模式专用', rarity: 'TIER_6', profession: 'MEDIC', isNotObtainable: true },
    }))
    expect(imported().operators.map(operator => operator.charId)).toEqual(['char_stage_test'])
  })
})
