import { describe, it, expect } from 'vitest'
import { createDefaultConfig } from '../domain/defaults'
import { calculate } from '../engine/calculate'
import { createDefaultWorkspace } from './defaults'
import { migrateAppConfigToWorkspace, COMPAT_OPERATOR_GROUPS_KEY } from './migrate'
import { compileMainPlanToAppConfig } from './adapter'
import { MOWER_OUTPUT_ROOM_IDS } from './model'

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj
  }
  Object.freeze(obj)
  for (const key of Object.keys(obj)) {
    const val = (obj as Record<string, unknown>)[key]
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val)
    }
  }
  return obj
}


describe('compileMainPlanToAppConfig', () => {
  it('compiles workspace main plan into valid AppConfig and calculates without errors', () => {
    const ws = createDefaultWorkspace()
    const baseConfig = createDefaultConfig()

    ws.mainPlan.facilities.room_1_1.slots = [
      {
        occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
        groupId: 'group1',
        replacements: ['char_103_angel'],
      },
      { occupant: { kind: 'free' }, groupId: null, replacements: [] },
      { occupant: { kind: 'empty' }, groupId: null, replacements: [] },
    ]

    const config = compileMainPlanToAppConfig(ws.mainPlan, ws, baseConfig)

    expect(config.schemaVersion).toBe(7)
    expect(config.rooms[0]!.operatorIds).toEqual(['char_002_amiya'])
    expect(config.rooms[0]!.operatorCount).toBe(1)
    expect(config.operatorBackups['char_002_amiya']).toBe('char_103_angel')
    expect(config.operatorGroups).toEqual([
      { id: 'group1', name: 'group1', operatorIds: ['char_002_amiya'] },
    ])

    // Verify engine calculates cleanly
    const report = calculate(config)
    expect(report.layoutValid).toBe(true)
    expect(report.summary).not.toBeNull()
  })

  it('deterministically maps 9 Mower output IDs (room_1_1..room_3_3) to B101..B303', () => {
    const ws = createDefaultWorkspace()
    const baseConfig = createDefaultConfig()

    expect(MOWER_OUTPUT_ROOM_IDS).toHaveLength(9)

    // Set distinctive products and levels on each output room
    const roomConfigTypes: Array<{
      type: 'manufacture' | 'trading' | 'power'
      product?: 'gold' | 'exp' | 'fragment' | 'money' | 'orundum'
      level: number
      opId?: string
    }> = [
      { type: 'manufacture', product: 'gold', level: 3, opId: 'char_002_amiya' },
      { type: 'manufacture', product: 'exp', level: 2, opId: 'char_102_texas' },
      { type: 'manufacture', product: 'fragment', level: 1 },
      { type: 'trading', product: 'money', level: 3, opId: 'char_103_angel' },
      { type: 'trading', product: 'orundum', level: 2, opId: 'char_106_franka' },
      { type: 'power', level: 3 },
      { type: 'power', level: 3 },
      { type: 'power', level: 3 },
      { type: 'manufacture', product: 'gold', level: 3, opId: 'char_107_liskam' },
    ]

    MOWER_OUTPUT_ROOM_IDS.forEach((roomId, idx) => {
      const cfg = roomConfigTypes[idx]!
      const fac = ws.mainPlan.facilities[roomId]
      fac.type = cfg.type
      fac.level = cfg.level
      fac.product = cfg.product
      fac.slots = cfg.opId
        ? [{ occupant: { kind: 'operator', operatorId: cfg.opId }, groupId: null, replacements: [] }]
        : []
    })

    const config = compileMainPlanToAppConfig(ws.mainPlan, ws, baseConfig)

    expect(config.rooms).toHaveLength(9)
    for (let i = 0; i < 9; i++) {
      const room = config.rooms[i]!
      const floor = Math.floor(i / 3) + 1
      const col = (i % 3) + 1
      const expectedId = `B${floor}0${col}`
      const cfg = roomConfigTypes[i]!

      expect(room.id).toBe(expectedId)
      expect(room.type).toBe(cfg.type)
      expect(room.level).toBe(cfg.level)

      if (cfg.type === 'manufacture') {
        expect(room.product).toBe(cfg.product)
      } else if (cfg.type === 'trading') {
        expect(room.strategy).toBe(cfg.product === 'orundum' ? 'orundum' : 'gold')
      }

      if (cfg.opId) {
        expect(room.operatorIds).toEqual([cfg.opId])
        expect(room.operatorCount).toBe(1)
      } else {
        expect(room.operatorIds).toEqual([])
        expect(room.operatorCount).toBe(0)
      }
    }
  })

  it('filters Free, Current, and Empty occupants across all facility slots', () => {
    const ws = createDefaultWorkspace()
    const baseConfig = createDefaultConfig()

    ws.mainPlan.facilities.room_1_1.slots = [
      { occupant: { kind: 'operator', operatorId: 'char_002_amiya' }, groupId: null, replacements: [] },
      { occupant: { kind: 'free' }, groupId: null, replacements: [] },
      { occupant: { kind: 'current' }, groupId: null, replacements: [] },
      { occupant: { kind: 'empty' }, groupId: null, replacements: [] },
    ]

    ws.mainPlan.facilities.central.slots = [
      { occupant: { kind: 'free' }, groupId: null, replacements: [] },
      { occupant: { kind: 'operator', operatorId: 'char_102_texas' }, groupId: null, replacements: [] },
      { occupant: { kind: 'current' }, groupId: null, replacements: [] },
    ]

    ws.mainPlan.facilities.dormitory_1.slots = [
      { occupant: { kind: 'empty' }, groupId: null, replacements: [] },
      { occupant: { kind: 'operator', operatorId: 'char_103_angel' }, groupId: null, replacements: [] },
    ]

    const config = compileMainPlanToAppConfig(ws.mainPlan, ws, baseConfig)

    expect(config.rooms[0]!.operatorIds).toEqual(['char_002_amiya'])
    expect(config.rooms[0]!.operatorCount).toBe(1)
    expect(config.controlOperatorIds).toEqual(['char_102_texas'])
    expect(config.facilityOperatorIds.dormitories[0]).toEqual(['char_103_angel'])
  })

  it('maps central, dormitories, meeting, factory, contact, train and their levels & assignments', () => {
    const ws = createDefaultWorkspace()
    const baseConfig = createDefaultConfig()

    ws.mainPlan.facilities.central.slots = [
      { occupant: { kind: 'operator', operatorId: 'char_002_amiya' }, groupId: null, replacements: [] },
    ]

    ws.mainPlan.facilities.dormitory_1.level = 1
    ws.mainPlan.facilities.dormitory_1.slots = [
      { occupant: { kind: 'operator', operatorId: 'char_102_texas' }, groupId: null, replacements: [] },
    ]
    ws.mainPlan.facilities.dormitory_2.level = 2
    ws.mainPlan.facilities.dormitory_2.slots = []
    ws.mainPlan.facilities.dormitory_3.level = 3
    ws.mainPlan.facilities.dormitory_3.slots = [
      { occupant: { kind: 'operator', operatorId: 'char_103_angel' }, groupId: null, replacements: [] },
    ]
    ws.mainPlan.facilities.dormitory_4.level = 4
    ws.mainPlan.facilities.dormitory_4.slots = []

    ws.mainPlan.facilities.meeting.level = 2
    ws.mainPlan.facilities.meeting.slots = [
      { occupant: { kind: 'operator', operatorId: 'char_106_franka' }, groupId: null, replacements: [] },
    ]

    ws.mainPlan.facilities.factory.level = 1
    ws.mainPlan.facilities.factory.slots = [
      { occupant: { kind: 'operator', operatorId: 'char_107_liskam' }, groupId: null, replacements: [] },
    ]

    ws.mainPlan.facilities.contact.level = 3
    ws.mainPlan.facilities.contact.slots = [
      { occupant: { kind: 'operator', operatorId: 'char_108_silent' }, groupId: null, replacements: [] },
    ]

    ws.mainPlan.facilities.train.level = 2
    ws.mainPlan.facilities.train.slots = [
      { occupant: { kind: 'operator', operatorId: 'char_109_fmout' }, groupId: null, replacements: [] },
    ]

    const config = compileMainPlanToAppConfig(ws.mainPlan, ws, baseConfig)

    expect(config.controlOperatorIds).toEqual(['char_002_amiya'])
    expect(config.facilities.dormitories).toEqual([1, 2, 3, 4])
    expect(config.facilityOperatorIds.dormitories).toEqual([
      ['char_102_texas'],
      [],
      ['char_103_angel'],
      [],
    ])

    expect(config.facilities.reception).toBe(2)
    expect(config.facilityOperatorIds.reception).toEqual(['char_106_franka'])

    expect(config.facilities.workshop).toBe(1)
    expect(config.facilityOperatorIds.workshop).toEqual(['char_107_liskam'])

    expect(config.facilities.office).toBe(3)
    expect(config.facilityOperatorIds.office).toEqual(['char_108_silent'])

    expect(config.facilities.training).toBe(2)
    expect(config.facilityOperatorIds.training).toEqual(['char_109_fmout'])
  })

  it('maps only first valid ordered replacement per primary into operatorBackups', () => {
    const ws = createDefaultWorkspace()
    const baseConfig = createDefaultConfig()

    ws.mainPlan.facilities.room_1_1.slots = [
      {
        occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
        groupId: null,
        // multiple replacements configured; only the first valid replacement should map
        replacements: ['char_102_texas', 'char_103_angel', 'char_106_franka'],
      },
      {
        occupant: { kind: 'operator', operatorId: 'char_107_liskam' },
        groupId: null,
        // leading empty strings should be skipped to find first valid non-empty replacement
        replacements: ['', '  ', 'char_108_silent'],
      },
      {
        occupant: { kind: 'operator', operatorId: 'char_109_fmout' },
        groupId: null,
        // no valid replacement
        replacements: ['', '  '],
      },
    ]

    const config = compileMainPlanToAppConfig(ws.mainPlan, ws, baseConfig)

    expect(config.operatorBackups['char_002_amiya']).toBe('char_102_texas')
    expect(config.operatorBackups['char_107_liskam']).toBe('char_108_silent')
    expect(config.operatorBackups['char_109_fmout']).toBeUndefined()
  })

  it('projects repeated ordered candidates onto unique legacy backups without losing workspace data', () => {
    const ws = createDefaultWorkspace()
    const baseConfig = createDefaultConfig()

    ws.mainPlan.facilities.room_1_1.slots = [
      {
        occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
        groupId: null,
        replacements: ['char_4032_provs', 'char_102_texas'],
      },
    ]
    ws.mainPlan.facilities.room_1_2.slots = [
      {
        occupant: { kind: 'operator', operatorId: 'char_103_angel' },
        groupId: null,
        replacements: ['char_4032_provs', 'char_106_franka'],
      },
    ]
    ws.mainPlan.facilities.dormitory_4.slots = [
      {
        occupant: { kind: 'operator', operatorId: 'char_300_phenxi' },
        groupId: null,
        replacements: ['char_002_amiya', 'char_103_angel'],
      },
    ]

    const config = compileMainPlanToAppConfig(ws.mainPlan, ws, baseConfig)

    expect(config.operatorBackups['char_002_amiya']).toBe('char_4032_provs')
    expect(config.operatorBackups['char_103_angel']).toBe('char_106_franka')
    expect(config.operatorBackups['char_300_phenxi']).toBeUndefined()
    expect(ws.mainPlan.facilities.room_1_2.slots[0]!.replacements).toEqual([
      'char_4032_provs',
      'char_106_franka',
    ])
  })

  it('does not project shift-run candidates as ordinary trading-room backups', () => {
    const ws = createDefaultWorkspace()
    const baseConfig = createDefaultConfig()
    ws.mainPlan.facilities.room_1_1.type = 'trading'
    ws.mainPlan.facilities.room_1_1.slots = [{
      occupant: { kind: 'operator', operatorId: 'char_4055_bgsnow' },
      groupId: null,
      replacements: ['char_4032_provs', 'char_4037_demetr'],
    }]
    ws.mainPlan.facilities.room_1_2.type = 'trading'
    ws.mainPlan.facilities.room_1_2.slots = [{
      occupant: { kind: 'operator', operatorId: 'char_402_tuye' },
      groupId: null,
      replacements: ['char_4032_provs', 'char_427_vigil'],
    }]

    const config = compileMainPlanToAppConfig(ws.mainPlan, ws, baseConfig)

    expect(config.operatorBackups.char_4055_bgsnow).toBe('char_4037_demetr')
    expect(config.operatorBackups.char_402_tuye).toBe('char_427_vigil')
  })

  it('uses non-empty dormitory beds as the steady-state occupancy approximation', () => {
    const ws = createDefaultWorkspace()
    const baseConfig = createDefaultConfig()
    ws.mainPlan.facilities.dormitory_1.slots = [
      { occupant: { kind: 'operator', operatorId: 'char_338_iris' }, groupId: null, replacements: [] },
      { occupant: { kind: 'free' }, groupId: null, replacements: [] },
      { occupant: { kind: 'current' }, groupId: null, replacements: [] },
      { occupant: { kind: 'empty' }, groupId: null, replacements: [] },
    ]

    const config = compileMainPlanToAppConfig(ws.mainPlan, ws, baseConfig)

    expect(config.dormitoryOccupantCount).toBe(3)
  })

  it('preserves Mower workaholics as occupied zero-morale workers without ordinary backup projection', () => {
    const ws = createDefaultWorkspace()
    const baseConfig = createDefaultConfig()
    ws.mainPlan.facilities.room_3_3.type = 'power'
    ws.mainPlan.facilities.room_3_3.slots = [{
      occupant: { kind: 'operator', operatorId: 'char_285_medic2' },
      groupId: null,
      replacements: ['char_253_greyy'],
    }]
    ws.mainPlan.conf.workaholic = ['char_285_medic2']

    const config = compileMainPlanToAppConfig(ws.mainPlan, ws, baseConfig)

    expect(config.workaholicOperatorIds).toEqual(['char_285_medic2'])
    expect(config.operatorBackups.char_285_medic2).toBeUndefined()
  })

  it('uses the edition default order mode when an imported room becomes a trading station', () => {
    const ws = createDefaultWorkspace()
    const baseConfig = createDefaultConfig()
    ws.mainPlan.facilities.room_1_2.type = 'trading'
    ws.mainPlan.facilities.room_1_2.level = 2

    const config = compileMainPlanToAppConfig(ws.mainPlan, ws, baseConfig)

    expect(baseConfig.rooms[1]!.type).toBe('manufacture')
    expect(config.rooms[1]!.type).toBe('trading')
    expect(config.rooms[1]!.specialOrder).toBe('shiftRun')
  })

  it('aggregates group labels from all facilities and preserves existing group names if present', () => {
    const ws = createDefaultWorkspace()
    const baseConfig = createDefaultConfig()
    baseConfig.operatorGroups = [
      { id: 'group_alpha', name: '阿尔法攻坚组', operatorIds: [] },
    ]

    ws.mainPlan.facilities.room_1_1.slots = [
      {
        occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
        groupId: 'group_alpha',
        replacements: [],
      },
      {
        occupant: { kind: 'operator', operatorId: 'char_102_texas' },
        groupId: 'group_beta',
        replacements: [],
      },
    ]

    ws.mainPlan.facilities.central.slots = [
      {
        occupant: { kind: 'operator', operatorId: 'char_103_angel' },
        groupId: 'group_alpha',
        replacements: [],
      },
    ]

    const config = compileMainPlanToAppConfig(ws.mainPlan, ws, baseConfig)

    const alpha = config.operatorGroups.find((g) => g.id === 'group_alpha')
    const beta = config.operatorGroups.find((g) => g.id === 'group_beta')

    expect(alpha).toBeDefined()
    expect(alpha!.name).toBe('阿尔法攻坚组')
    expect(alpha!.operatorIds).toEqual(['char_002_amiya', 'char_103_angel'])

    expect(beta).toBeDefined()
    expect(beta!.name).toBe('group_beta')
    expect(beta!.operatorIds).toEqual(['char_102_texas'])
  })

  it('preserves existing non-layout calculation settings and unsupported legacy fields', () => {
    const ws = createDefaultWorkspace()
    const baseConfig = createDefaultConfig()

    // Non-layout calculation settings
    baseConfig.hours = 48
    baseConfig.dormitoryOccupantCount = 15
    baseConfig.droneTarget = 'B102'
    baseConfig.operatorMorale = { char_002_amiya: 18, char_102_texas: 10 }
    baseConfig.zeroMoraleOperatorIds = ['char_106_franka']
    baseConfig.efficiencyResources.droneCapacity = 250
    baseConfig.efficiencyResources.manufacturePerceptionInformation = 5
    baseConfig.rooms[0]!.skillBonus = 0.25
    baseConfig.rooms[0]!.quality = 'beta'
    baseConfig.rooms[0]!.specialOrder = 'closure'
    baseConfig.rooms[0]!.powerStaffed = true

    // Unsupported legacy fields attached dynamically
    const baseWithExtras = baseConfig as unknown as Record<string, unknown>
    baseWithExtras.customStrategyMetadata = { version: 'legacy-1', note: 'do-not-lose' }
    baseWithExtras.legacyRunFlags = ['turbo', 'night_shift']

    // Unrecognized fields in workspace compatibility envelope
    ws.compatibility.unrecognizedFields.unrecognizedTopLevel = 'envelope-preserved'

    const config = compileMainPlanToAppConfig(ws.mainPlan, ws, baseConfig)
    const configWithExtras = config as unknown as Record<string, unknown>


    expect(config.hours).toBe(48)
    expect(config.dormitoryOccupantCount).toBe(15)
    expect(config.droneTarget).toBe('B102')
    expect(config.operatorMorale).toEqual({ char_002_amiya: 18, char_102_texas: 10 })
    expect(config.zeroMoraleOperatorIds).toEqual(['char_106_franka'])
    expect(config.efficiencyResources.droneCapacity).toBe(250)
    expect(config.efficiencyResources.manufacturePerceptionInformation).toBe(5)
    expect(config.rooms[0]!.skillBonus).toBe(0.25)
    expect(config.rooms[0]!.quality).toBe('beta')
    expect(config.rooms[0]!.specialOrder).toBe('closure')
    expect(config.rooms[0]!.powerStaffed).toBe(true)

    expect(configWithExtras.customStrategyMetadata).toEqual({ version: 'legacy-1', note: 'do-not-lose' })
    expect(configWithExtras.legacyRunFlags).toEqual(['turbo', 'night_shift'])
    expect(configWithExtras.unrecognizedTopLevel).toBeUndefined()
    expect(ws.compatibility.unrecognizedFields.unrecognizedTopLevel).toBe('envelope-preserved')
  })

  it('enforces input immutability: never mutates workspace, mainPlan, or existingConfig', () => {
    const ws = createDefaultWorkspace()
    const baseConfig = createDefaultConfig()

    ws.mainPlan.facilities.room_1_1.slots = [
      {
        occupant: { kind: 'operator', operatorId: 'char_002_amiya' },
        groupId: 'g1',
        replacements: ['char_103_angel'],
      },
    ]

    // Deep freeze all input parameters to guarantee that compileMainPlanToAppConfig is pure
    deepFreeze(ws)
    deepFreeze(ws.mainPlan)
    deepFreeze(baseConfig)

    expect(() => compileMainPlanToAppConfig(ws.mainPlan, ws, baseConfig)).not.toThrow()

    // Result should be a distinct object
    const result = compileMainPlanToAppConfig(ws.mainPlan, ws, baseConfig)
    expect(result).not.toBe(baseConfig)
    expect(result.rooms).not.toBe(baseConfig.rooms)
    expect(result.rooms[0]).not.toBe(baseConfig.rooms[0])
  })

  it('satisfies equivalence round-trip: createDefaultConfig -> migrate -> compile -> calculate yields identical report', () => {
    const originalConfig = createDefaultConfig()
    const baselineReport = calculate(originalConfig)

    // 1. Migrate v7 config -> v8 workspace
    const workspace = migrateAppConfigToWorkspace(originalConfig)

    // 2. Compile v8 workspace main plan back to v7 config
    const compiledConfig = compileMainPlanToAppConfig(workspace.mainPlan, workspace, originalConfig)

    // 3. AppConfig structure must match representable defaults
    expect(compiledConfig).toEqual(originalConfig)

    // 4. Calculation report from compiled config must be strictly identical to baseline report
    const roundTripReport = calculate(compiledConfig)
    expect(roundTripReport).toEqual(baselineReport)
    expect(roundTripReport.power).toEqual({
      generation: 810,
      consumption: 810,
      margin: 0,
      sufficient: true,
    })
    expect(roundTripReport.layoutValid).toBe(true)
  })

  it('overrides default existingConfig values with migrated preserved simulation fields during compile', () => {
    const legacy = createDefaultConfig()
    legacy.operatorMorale = { char_002_amiya: 12, char_102_texas: 18 }
    legacy.zeroMoraleOperatorIds = ['char_103_angel']
    legacy.hours = 48
    legacy.dormitoryOccupantCount = 12
    legacy.droneTarget = 'B103'
    legacy.efficiencyResources.droneCapacity = 260
    legacy.efficiencyResources.manufacturePerceptionInformation = 7
    legacy.efficiencyResources.extraWorkplaceOperatorIds = ['char_108_silent']

    const ws = migrateAppConfigToWorkspace(legacy)
    const freshDefaultConfig = createDefaultConfig()

    const compiled = compileMainPlanToAppConfig(ws.mainPlan, ws, freshDefaultConfig)

    expect(compiled.operatorMorale).toEqual({ char_002_amiya: 12, char_102_texas: 18 })
    expect(compiled.zeroMoraleOperatorIds).toEqual(['char_103_angel'])
    expect(compiled.hours).toBe(48)
    expect(compiled.dormitoryOccupantCount).toBe(12)
    expect(compiled.droneTarget).toBe('B103')
    expect(compiled.efficiencyResources.droneCapacity).toBe(260)
    expect(compiled.efficiencyResources.manufacturePerceptionInformation).toBe(7)
    expect(compiled.efficiencyResources.extraWorkplaceOperatorIds).toEqual(['char_108_silent'])
  })

  it('preserves group display names after migrate and compile even when compiler receives a fresh default config', () => {
    const legacy = createDefaultConfig()
    legacy.rooms[0]!.operatorIds = ['char_002_amiya']
    legacy.operatorGroups = [
      { id: 'group_prod', name: '高效产出组', operatorIds: ['char_002_amiya'] },
    ]

    const ws = migrateAppConfigToWorkspace(legacy)
    expect(ws.compatibility.unrecognizedFields[COMPAT_OPERATOR_GROUPS_KEY]).toBeDefined()

    const freshDefaultConfig = createDefaultConfig()
    expect(freshDefaultConfig.operatorGroups).toEqual([])

    const compiled = compileMainPlanToAppConfig(ws.mainPlan, ws, freshDefaultConfig)

    const prodGroup = compiled.operatorGroups.find((g) => g.id === 'group_prod')
    expect(prodGroup).toBeDefined()
    expect(prodGroup?.name).toBe('高效产出组')
    expect(prodGroup?.operatorIds).toEqual(['char_002_amiya'])
  })

  it('round-trips empty planName as empty using undefined/null checks rather than truthiness', () => {
    const legacy = createDefaultConfig()
    legacy.planName = ''

    const ws = migrateAppConfigToWorkspace(legacy)
    expect(ws.mainPlan.name).toBe('')

    const freshConfig = createDefaultConfig()
    freshConfig.planName = '非空默认'

    const compiled = compileMainPlanToAppConfig(ws.mainPlan, ws, freshConfig)
    expect(compiled.planName).toBe('')
  })

  it('preserves arbitrary unknown compatibility fields in workspace envelope only and does not spread untrusted unknown fields over AppConfig layout keys', () => {
    const ws = createDefaultWorkspace()
    const baseConfig = createDefaultConfig()

    ws.compatibility.unrecognizedFields.arbitraryEnvelopeKey = { secret: 42 }
    ws.compatibility.unrecognizedFields.rooms = 'malicious-rooms-override'

    const compiled = compileMainPlanToAppConfig(ws.mainPlan, ws, baseConfig)
    const compiledRecord = compiled as unknown as Record<string, unknown>


    expect(ws.compatibility.unrecognizedFields.arbitraryEnvelopeKey).toEqual({ secret: 42 })
    expect(compiledRecord.arbitraryEnvelopeKey).toBeUndefined()
    expect(Array.isArray(compiled.rooms)).toBe(true)
    expect(compiled.rooms).toHaveLength(9)
  })
})
