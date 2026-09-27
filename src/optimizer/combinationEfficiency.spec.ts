import { describe, expect, it } from 'vitest'
import rawCatalog from '../data/riic-combinations.json'
import { createDefaultConfig } from '../domain/defaults'
import { OPERATORS } from '../domain/operators'
import { evaluateOperators } from '../engine/operatorRules'
import {
  selectCombinationCandidates,
  type CandidateAssignment,
  type CandidateAvailability,
  type CandidateRoom,
} from './combinationCandidates'

type RawCandidate = {
  id: string
  facility: CandidateRoom
  operatorNames: string[]
  supportAssignments: Array<{ facility: CandidateRoom; roomKey: string; operatorNames: string[] }>
  conditions: { slotCount: { exact: number } }
  coverageScope: 'complete-team' | 'partial-template' | 'support-policy'
  operatorRoles?: Record<string, string>
  sourceReferences: { operatorSkillBuffIds: Array<{ operatorName: string; buffIds: string[] }> }
}

const catalog = rawCatalog as unknown as { candidates: RawCandidate[] }
const id = (name: string) => OPERATORS.find((operator) => operator.name === name)!.charId
const allOwned = OPERATORS.map((operator) => operator.charId)
const resolved = new Map(selectCombinationCandidates(allOwned).available.map((candidate) => [candidate.id, candidate]))

function candidate(candidateId: string): CandidateAvailability {
  const value = resolved.get(candidateId)
  if (!value) throw new Error(`candidate unavailable from complete 429 roster: ${candidateId}`)
  return value
}

function cleanConfig() {
  const config = createDefaultConfig()
  config.controlOperatorIds = []
  config.rooms.forEach((room) => { room.operatorIds = [] })
  config.facilityOperatorIds = { dormitories: [[], [], [], []], reception: [], office: [], workshop: [], training: [] }
  return config
}

function roomType(facility: CandidateRoom): 'manufacture' | 'trading' | 'power' {
  switch (facility) {
    case 'MANUFACTURE': return 'manufacture'
    case 'TRADING': return 'trading'
    case 'POWER': return 'power'
    default: throw new Error(`${facility} is not an output room`)
  }
}

/** Places the consumer result into the real AppConfig buckets, retaining distinct roomKeys. */
function applyAssignments(candidateValue: CandidateAvailability) {
  const config = cleanConfig()
  const keyedOutputRooms = new Map<string, number>()
  const assignments = [candidateValue.targetAssignment, ...candidateValue.supportAssignments]
  for (const assignment of assignments) place(config, assignment, keyedOutputRooms)
  return config
}

function place(
  config: ReturnType<typeof cleanConfig>,
  assignment: CandidateAssignment,
  keyedOutputRooms: Map<string, number>,
) {
  const ids = assignment.operators.map((operator) => operator.charId)
  switch (assignment.runtimeFacilityKey) {
    case 'controlOperatorIds':
      config.controlOperatorIds.push(...ids)
      return
    case 'office': config.facilityOperatorIds.office.push(...ids); return
    case 'training': config.facilityOperatorIds.training.push(...ids); return
    case 'reception': config.facilityOperatorIds.reception.push(...ids); return
    case 'dormitories': config.facilityOperatorIds.dormitories[0]!.push(...ids); return
    case 'workshop': config.facilityOperatorIds.workshop.push(...ids); return
    case 'rooms': {
      const type = roomType(assignment.facility)
      const prior = keyedOutputRooms.get(assignment.roomKey)
      const roomIndex = prior ?? config.rooms.findIndex((room) => room.type === type && room.operatorIds.length === 0)
      if (roomIndex < 0) throw new Error(`no available ${type} room for ${assignment.roomKey}`)
      keyedOutputRooms.set(assignment.roomKey, roomIndex)
      config.rooms[roomIndex]!.operatorIds.push(...ids)
      return
    }
  }
}

function targetRoom(config: ReturnType<typeof cleanConfig>, candidateValue: CandidateAvailability) {
  const type = roomType(candidateValue.facility)
  return config.rooms.find((room) => room.type === type && room.operatorIds.some((operatorId) => operatorId === candidateValue.targetAssignment.operators[0]?.charId))!
}

describe('RIIC combination candidate structure', () => {
  it('keeps all 56 directory candidates room-valid and non-overlapping', () => {
    const issues: string[] = []
    for (const item of catalog.candidates) {
      const seen = new Set<string>()
      const targetOperators = item.operatorNames
      if (item.conditions.slotCount.exact !== targetOperators.length) issues.push(`${item.id}: slotCount`)
      if ((item.facility === 'MANUFACTURE' || item.facility === 'TRADING') && targetOperators.length > 3) issues.push(`${item.id}: target overflow`)
      if (item.facility === 'POWER' && targetOperators.length > 1) issues.push(`${item.id}: power target overflow`)
      for (const name of targetOperators) {
        const operator = OPERATORS.find((entry) => entry.name === name)
        if (!operator) { issues.push(`${item.id}: unknown target ${name}`); continue }
        const passive = item.operatorRoles?.[name]?.startsWith('passive-') ?? false
        if (!passive && !operator.skills.some((skill) => skill.roomType === item.facility)) issues.push(`${item.id}: target facility ${name}`)
        if (seen.has(name)) issues.push(`${item.id}: duplicate target ${name}`)
        seen.add(name)
      }
      for (const support of item.supportAssignments) {
        if (!support.roomKey) issues.push(`${item.id}: missing support roomKey`)
        if (support.facility === 'POWER' && support.operatorNames.length > 1) issues.push(`${item.id}: power support overflow ${support.roomKey}`)
        for (const name of support.operatorNames) {
          const operator = OPERATORS.find((entry) => entry.name === name)
          if (!operator) { issues.push(`${item.id}: unknown support ${name}`); continue }
          if (!item.operatorRoles?.[name]?.startsWith('passive-') && !operator.skills.some((skill) => skill.roomType === support.facility)) issues.push(`${item.id}: support facility ${name}`)
          if (seen.has(name)) issues.push(`${item.id}: repeated across room keys ${name}`)
          seen.add(name)
        }
      }
      for (const reference of item.sourceReferences.operatorSkillBuffIds) {
        const operator = OPERATORS.find((entry) => entry.name === reference.operatorName)
        if (!operator || reference.buffIds.some((buffId) => !operator.skills.some((skill) => skill.buffId === buffId))) issues.push(`${item.id}: invalid buff evidence ${reference.operatorName}`)
      }
    }
    expect(catalog.candidates).toHaveLength(56)
    expect(issues).toEqual([])
  })

  it('maps support rooms to real AppConfig buckets without sharing a roomKey by accident', () => {
    const value = candidate('manu-exp-p3-makoto')
    const config = applyAssignments(value)
    expect(config.rooms.find((room) => room.type === 'manufacture')!.operatorIds).toEqual(['结城理', '砾', '阿罗玛'].map(id))
    expect(config.rooms.find((room) => room.type === 'power')!.operatorIds).toEqual([id('埃癸斯')])
    expect(config.facilityOperatorIds.training).toEqual([id('岳羽由加莉')])
    expect(config.facilityOperatorIds.reception).toEqual([id('虎狼丸')])
  })
})

describe('RIIC combination candidate evaluator probes', () => {
  it('uses source-derived fixed values for Bubble, Rhine and Aigis layouts', () => {
    // 3 base + Bubble 67 - Vulcan 5 + Totter 30 = 95 skill; base efficiency 100.
    let value = candidate('manu-gold-bubble-vulcan'); let config = applyAssignments(value); let room = targetRoom(config, value); room.product = 'gold'
    expect(evaluateOperators(room, config).efficiencyPercent).toBe(195)

    // 3 base + Dorothy(10+25) + Silence 30 + Crownslayer 35 + Mon3tr 2.
    value = candidate('manu-exp-rhine-trio'); config = applyAssignments(value); room = targetRoom(config, value); room.product = 'exp'
    expect(evaluateOperators(room, config).efficiencyPercent).toBe(205)

    // Aigis 15 + Makoto-in-manufacture 5 + one power-station base 5.
    value = candidate('power-aigis-makoto'); config = applyAssignments(value); room = targetRoom(config, value)
    expect(evaluateOperators(room, config).efficiencyPercent).toBe(125)
  })

  it('uses room-local Karlan, fireworks and SEES inputs', () => {
    let value = candidate('trade-karlan-jaye'); let config = applyAssignments(value); let room = targetRoom(config, value)
    // 3 base + SilverAsh20 + Cliffheart15 + Jaye120 - Gnosis15 - Gnosis15.
    expect(evaluateOperators(room, config).efficiencyPercent).toBe(228)

    value = candidate('trade-wuyou-duoling-fireworks'); config = applyAssignments(value); config.dormitoryOccupantCount = 20; room = targetRoom(config, value)
    // 2 base + Uyou: 55 fireworks; Duoling affects morale cost, not current efficiency.
    expect(evaluateOperators(room, config).efficiencyPercent).toBe(157)
    expect(evaluateOperators(room, config).unquantifiedSkills).toEqual([])

    value = candidate('manu-exp-p3-makoto'); config = applyAssignments(value); room = targetRoom(config, value); room.product = 'gold'
    // 3 base + Makoto (20 + 4×5) + Gravel35 + Aroma(25 + warmed-up 20).
    expect(evaluateOperators(room, config).efficiencyPercent).toBe(223)
  })

  it('keeps Abyssal factory counts local to manufacturing and separates Greyy from Lancet', () => {
    let value = candidate('manu-exp-abyssal'); let config = applyAssignments(value); let room = targetRoom(config, value); room.product = 'exp'
    // Add the third manufacturing hunter: H=3, two recipients in target room => 2×3×10.
    config.rooms.filter((entry) => entry.type === 'manufacture')[1]!.operatorIds = [id('乌尔比安')]
    expect(evaluateOperators(room, config).efficiencyPercent).toBe(162)

    const greyy = candidate('power-grey-effective-station')
    const lancet = candidate('power-lancet-murdock-effective-stations')
    expect(greyy.targetAssignment.operators[0]!.name).toBe('承曦格雷伊')
    expect(lancet.targetAssignment.operators[0]!.name).toBe('Lancet-2')
    expect(greyy.constraints.conflicts.join(' ')).toContain('Lancet-2')

    config = applyAssignments(greyy); room = targetRoom(config, greyy)
    // Greyy direct charging at default drone capacity: 23 plus one power-station base 5.
    expect(evaluateOperators(room, config).efficiencyPercent).toBe(128)
  })
})
