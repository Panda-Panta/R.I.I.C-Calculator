// JSONL bridge to a frozen, unmodified RIIC source snapshot. stdout is RPC only.
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const sha = value => createHash('sha256').update(value).digest('hex')
const log = value => process.stderr.write(`[native-roster] ${value}\n`)
const usage = 'node native_adapter.mjs --node-modules <installed-node_modules> --out <new-evidence-directory>'

function parseArguments(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (!['--node-modules', '--out'].includes(flag)) throw new Error(`Unknown option ${flag}; ${usage}`)
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
    args[flag.slice(2)] = resolve(value)
  }
  if (!args['node-modules'] || !args.out) throw new Error(usage)
  if (!existsSync(args['node-modules'])) throw new Error(`Missing dependencies: ${args['node-modules']}`)
  if (existsSync(args.out)) throw new Error(`Refusing to overwrite existing evidence: ${args.out}`)
  return args
}

async function freezeEngine(args) {
  const require = createRequire(pathToFileURL(resolve(args['node-modules'], '../package.json')))
  const vitePath = require.resolve('vite')
  const { build, version } = require(require.resolve('esbuild', { paths: [vitePath] }))
  // Node can resolve the installed pnpm real target on Windows even when
  // esbuild cannot traverse the cross-directory package symlink directly.
  const pinyinPackage = require.resolve('pinyin-pro/package.json')
  const pinyinMetadata = JSON.parse(readFileSync(pinyinPackage, 'utf8'))
  const pinyinEntry = resolve(dirname(pinyinPackage), pinyinMetadata.exports['.'].import.default)
  const exports = [
    "export { createDefaultWorkspace } from './src/workbench/defaults';",
    "export { OPERATORS } from './src/domain/operators';",
    "export { compileOperatorInventory } from './src/domain/operatorInventory';",
    "export { inventoryOperatorRecords } from './src/domain/operatorContext';",
    "export { resolveOperatorCharId } from './src/domain/operatorIdentifiers';",
    "export { validateRosterWorkspace } from './src/workbench/validate';",
    "export { validatePhysicalRoster } from './src/optimizer/rosterDraft';",
    "export { recoveryGroupCapacityIssues } from './src/optimizer/recoveryGroupCapacity';",
    "export { runScheduleSimulationBridge } from './src/workbench/scheduleSimulationBridge';",
    "export { simulateCandidateWithProgress } from './src/optimizer/candidateSimulation';",
    "export { summarizeIncome } from './src/optimizer/incomeComparison';",
    "export { simulationOutputAmounts, scoreSimulationProduction } from './src/simulator/productionScore';",
    "export { projectRosterConfig } from './src/optimizer/rosterProjection';",
    "export { projectControlOutput } from './src/optimizer/controlImpact';",
    "export { buildBackupSnapshot } from './src/optimizer/backupSnapshot';",
    "export { productionRoomId } from './src/optimizer/productionSingletons';",
    "export { applyGeneratedWarmupPolicy } from './src/optimizer/generatedWarmupPolicy';",
    "export { applyGeneratedRecoveryPolicy } from './src/optimizer/generatedRecoveryPolicy';",
    "export { currentMoraleRates } from './src/engine/morale';",
    "export { evaluateDormitoryRecovery } from './src/engine/dormitoryRecovery';",
    "export { eligibleSingleRecoveryTargets, hasSingleRecoverySkill } from './src/engine/singleRecoveryEligibility';",
    "export { compileRosterSchedule } from './src/scheduler/compileRosterSchedule';",
    "export { compiledScheduleToRuntimeConfig } from './src/scheduler/scheduleAdapter';",
    "export { createRosterRuntime } from './src/scheduler/rosterRuntime';",
    "export { getMowerSourceRuntime } from './src/scheduler/mowerSourceRuntime';",
    "export { initializeMowerAlphaMoodLimits } from './src/scheduler/mowerMoodLimits';",
  ]
  const captured = new Map()
  mkdirSync(args.out, { recursive: true })
  const enginePath = resolve(args.out, 'frozen-engine.mjs')
  const built = await build({
    absWorkingDir: sourceRoot,
    stdin: { contents: exports.join('\n'), resolveDir: sourceRoot, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', outfile: enginePath, metafile: true,
    nodePaths: [args['node-modules']],
    alias: { 'pinyin-pro': pinyinEntry },
    logLevel: 'silent',
    plugins: [{ name: 'hash-source-inputs', setup(builder) {
      builder.onLoad({ filter: /\.(?:[cm]?js|tsx?|json)$/ }, input => {
        const bytes = readFileSync(input.path)
        captured.set(resolve(input.path), sha(bytes))
        const loader = input.path.endsWith('.json') ? 'json' : input.path.endsWith('.tsx') ? 'tsx'
          : input.path.endsWith('.ts') ? 'ts' : 'js'
        return { contents: bytes.toString('utf8'), loader, resolveDir: dirname(input.path) }
      })
    } }],
  })
  const inputs = Object.keys(built.metafile.inputs).filter(path => path !== '<stdin>').map(path => {
    const absolute = resolve(sourceRoot, path)
    const capturedHash = captured.get(absolute)
    if (!capturedHash || capturedHash !== sha(readFileSync(absolute))) throw new Error(`Source changed during freeze: ${absolute}`)
    return { path: relative(sourceRoot, absolute).replaceAll('\\', '/'), sha256: capturedHash }
  }).sort((a, b) => a.path.localeCompare(b.path))
  const manifest = {
    sourceRoot, sourceSha256: sha(JSON.stringify(inputs)), inputs,
    engineSha256: sha(readFileSync(enginePath)),
    adapterSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
    nodeVersion: process.version, esbuildVersion: version, frozenAt: new Date().toISOString(),
    evidence: 'Unmodified local RIIC TypeScript bundled for Node; constructed declared inventories, not user/game observations.',
  }
  writeFileSync(resolve(args.out, 'source-manifest.json'), JSON.stringify(manifest, null, 2))
  return { engine: await import(pathToFileURL(enginePath).href), manifest }
}

function maximumInventory(engine, names) {
  const requested = [...new Set(names)]
  const caps = { 1: [30], 2: [30], 3: [40, 55], 4: [45, 60, 70], 5: [50, 70, 80], 6: [50, 80, 90] }
  const entries = requested.map(name => {
    const record = engine.OPERATORS.find(op => op.name === name)
    if (!record) throw new Error(`Scenario requests an unknown real operator: ${name}`)
    const stages = caps[record.rarity]
    return { operator: record.charId, elitePhase: stages.length - 1, level: stages.at(-1) }
  })
  const compiled = engine.compileOperatorInventory(entries)
  if (!compiled.valid) throw new Error(`Invalid declared inventory: ${JSON.stringify(compiled.diagnostics)}`)
  return { entries, compiled }
}

function smallBase(engine) {
  const workspace = engine.createDefaultWorkspace()
  for (const room of Object.values(workspace.mainPlan.facilities)) {
    room.level = 0
    room.slots = []
  }
  workspace.productionWeights = { exp: 1, gold: .8, orders: .2, fragments: 0, orundum: 0 }
  // One staffed resident and four explicit usable beds. A built, unstaffed power
  // plant supplies physical building power; drones are disabled in this study.
  workspace.mainPlan.facilities.room_1_3.level = 3
  workspace.mainPlan.facilities.dormitory_1.level = 5
  workspace.mainPlan.facilities.dormitory_1.slots = [
    { occupant: { kind: 'operator', operatorId: engine.resolveOperatorCharId('闪灵') }, groupId: null, replacements: [] },
    ...Array.from({ length: 4 }, () => ({ occupant: { kind: 'free' }, groupId: null, replacements: [] })),
  ]
  return workspace
}

function setCrew(engine, workspace, roomId, main, backup, groupId) {
  if (main.length !== backup.length) throw new Error('A declared crew must have complete main and relief roles')
  const room = workspace.mainPlan.facilities[roomId]
  room.slots = main.map((name, index) => ({
    occupant: { kind: 'operator', operatorId: engine.resolveOperatorCharId(name) },
    replacements: [engine.resolveOperatorCharId(backup[index])], groupId,
  }))
}

function scenarioDefinitions(engine) {
  return [
    {
      id: 'native-gold-relief', name: '单席金条：实际主班与普通替班选择',
      options: [['香草', '夜烟', '砾'], ['斑点', '温米']],
      variableNames: ['金条主班', '金条普通替班'],
      names: ['香草', '夜烟', '砾', '斑点', '温米', '闪灵'],
      targets: ['room_1_1'], bedUsage: [[1, 1, 1], [0, 0]],
      build(vector) {
        const w = smallBase(engine)
        Object.assign(w.mainPlan.facilities.room_1_1, { type: 'manufacture', level: 1, product: 'gold' })
        setCrew(engine, w, 'room_1_1', [this.options[0][vector[0]]], [this.options[1][vector[1]]], 'gold-crew')
        return w
      },
    },
    {
      id: 'native-automation-provider', name: '完整制造组与发电站提供者联动',
      options: [['温蒂＋森蚺＋清流', '砾＋斑点＋夜烟'], ['承曦格雷伊', '正义骑士号']],
      variableNames: ['完整制造主班组', '同组发电站提供者'],
      names: ['温蒂', '森蚺', '清流', '砾', '斑点', '夜烟', '维伊', '白面鸮', '赫默', '承曦格雷伊', '正义骑士号', '雷蛇', '闪灵'],
      targets: ['room_1_1'], bedUsage: [[3, 3], [1, 1]],
      build(vector) {
        const w = smallBase(engine)
        Object.assign(w.mainPlan.facilities.room_1_1, { type: 'manufacture', level: 3, product: 'gold' })
        const crew = vector[0] === 0 ? ['温蒂', '森蚺', '清流'] : ['砾', '斑点', '夜烟']
        setCrew(engine, w, 'room_1_1', crew, ['维伊', '白面鸮', '赫默'], 'linked-crew')
        setCrew(engine, w, 'room_1_3', [this.options[1][vector[1]]], ['雷蛇'], 'linked-crew')
        return w
      },
    },
    {
      id: 'native-trading-exp', name: '经验与订单：完整主替小组及共同恢复床位',
      options: [['能天使／伺夜', '吉星／石英', '空弦／深巡'], ['红豆／霜叶', '白雪／断罪者']],
      variableNames: ['贸易主替小组', '经验主替小组'],
      names: ['能天使', '伺夜', '吉星', '石英', '空弦', '深巡', '红豆', '霜叶', '白雪', '断罪者', '闪灵'],
      targets: ['room_1_1', 'room_2_1'], bedUsage: [[1, 1, 1], [1, 1]],
      build(vector) {
        const w = smallBase(engine)
        Object.assign(w.mainPlan.facilities.room_1_1, { type: 'trading', level: 3, product: 'money' })
        Object.assign(w.mainPlan.facilities.room_2_1, { type: 'manufacture', level: 3, product: 'exp' })
        const trade = [['能天使', '伺夜'], ['吉星', '石英'], ['空弦', '深巡']][vector[0]]
        const exp = [['红豆', '霜叶'], ['白雪', '断罪者']][vector[1]]
        setCrew(engine, w, 'room_1_1', [trade[0]], [trade[1]], 'trade-crew')
        setCrew(engine, w, 'room_2_1', [exp[0]], [exp[1]], 'exp-crew')
        return w
      },
    },
    {
      id: 'native-joint-base', name: '联合基地：完整金条组、经验、贸易、提供者、恢复与替班',
      options: [
        ['温蒂＋森蚺＋清流', '砾＋斑点＋夜烟'],
        ['红豆／霜叶', '白雪／断罪者'],
        ['能天使／伺夜', '吉星／石英', '空弦／深巡'],
        ['承曦格雷伊', '正义骑士号'],
        ['闪灵', '调香师'],
        ['维伊＋白面鸮＋赫默', '香草＋梅尔＋雪猎'],
      ],
      variableNames: ['金条完整主班组', '经验主替小组', '贸易主替小组',
        '同组发电站提供者', '第一宿舍恢复提供者', '金条完整普通替班组'],
      names: ['温蒂', '森蚺', '清流', '砾', '斑点', '夜烟', '红豆', '霜叶', '白雪', '断罪者',
        '能天使', '伺夜', '吉星', '石英', '空弦', '深巡', '承曦格雷伊', '正义骑士号', '雷蛇',
        '闪灵', '调香师', '杜林', '维伊', '白面鸮', '赫默', '香草', '梅尔', '雪猎'],
      targets: ['room_1_1', 'room_2_1', 'room_3_1'], bedCapacity: 8,
      bedUsage: [[3, 3], [1, 1], [1, 1, 1], [1, 1], [0, 0], [0, 0]],
      build(vector) {
        const w = smallBase(engine)
        // Two level-three dormitories plus three level-three output rooms use
        // 240 power. The one level-three power plant supplies 270, with no
        // virtual buildings or invented beds.
        w.mainPlan.facilities.dormitory_1.level = 3
        w.mainPlan.facilities.dormitory_1.slots[0].occupant.operatorId =
          engine.resolveOperatorCharId(this.options[4][vector[4]])
        w.mainPlan.facilities.dormitory_2.level = 3
        w.mainPlan.facilities.dormitory_2.slots = structuredClone(w.mainPlan.facilities.dormitory_1.slots)
        w.mainPlan.facilities.dormitory_2.slots[0].occupant.operatorId = engine.resolveOperatorCharId('杜林')
        Object.assign(w.mainPlan.facilities.room_1_1, { type: 'manufacture', level: 3, product: 'gold' })
        Object.assign(w.mainPlan.facilities.room_2_1, { type: 'manufacture', level: 3, product: 'exp' })
        Object.assign(w.mainPlan.facilities.room_3_1, { type: 'trading', level: 3, product: 'money' })
        const gold = vector[0] === 0 ? ['温蒂', '森蚺', '清流'] : ['砾', '斑点', '夜烟']
        const relief = vector[5] === 0 ? ['维伊', '白面鸮', '赫默'] : ['香草', '梅尔', '雪猎']
        const exp = [['红豆', '霜叶'], ['白雪', '断罪者']][vector[1]]
        const trade = [['能天使', '伺夜'], ['吉星', '石英'], ['空弦', '深巡']][vector[2]]
        setCrew(engine, w, 'room_1_1', gold, relief, 'joint-gold-and-power')
        setCrew(engine, w, 'room_1_3', [this.options[3][vector[3]]], ['雷蛇'], 'joint-gold-and-power')
        setCrew(engine, w, 'room_2_1', [exp[0]], [exp[1]], 'joint-exp')
        setCrew(engine, w, 'room_3_1', [trade[0]], [trade[1]], 'joint-trade')
        return w
      },
    },
  ]
}

function* categoricalVectors(domains, index = 0, prefix = []) {
  if (index === domains.length) { yield prefix; return }
  for (let value = 0; value < domains[index]; value++) yield* categoricalVectors(domains, index + 1, [...prefix, value])
}

function decode(engine, definition, vector) {
  if (!Array.isArray(vector) || vector.length !== definition.options.length ||
      vector.some((value, index) => !Number.isInteger(value) || value < 0 || value >= definition.options[index].length)) {
    return { workspace: null, issues: ['Vector is outside this declared categorical domain'] }
  }
  const workspace = definition.build(vector)
  const policy = engine.applyGeneratedWarmupPolicy(workspace, definition.inventory.compiled)
  const issues = policy.diagnostics.filter(issue => issue.severity === 'error').map(issue => `${issue.code}: ${issue.message}`)
  engine.applyGeneratedRecoveryPolicy(workspace)
  issues.push(...engine.validatePhysicalRoster(workspace).map(issue => `${issue.code}: ${issue.message}`))
  issues.push(...engine.recoveryGroupCapacityIssues(workspace).map(issue => `${issue.code}: ${issue.message}`))
  const owned = new Set(definition.inventory.compiled.operators.map(op => op.charId))
  for (const room of Object.values(workspace.mainPlan.facilities)) for (const slot of room.slots) {
    const actors = [...(slot.occupant.kind === 'operator' ? [slot.occupant.operatorId] : []), ...slot.replacements]
    for (const actor of actors) if (!owned.has(actor)) issues.push(`Unowned physical actor ${actor}`)
  }
  return { workspace, issues: [...new Set(issues)] }
}

function projectCheap(engine, definition, workspace) {
  const projections = [workspace, engine.buildBackupSnapshot(workspace)].map(snapshot => {
    const config = engine.projectRosterConfig(snapshot)
    config.operatorRecords = engine.inventoryOperatorRecords(definition.inventory.compiled)
    const active = Object.values(snapshot.mainPlan.facilities).flatMap(room => room.slots.flatMap(slot =>
      slot.occupant.kind === 'operator' ? [slot.occupant.operatorId] : []))
    return engine.projectControlOutput(config, {
      selectedRoomIds: definition.targets.map(engine.productionRoomId),
      timeContext: { workHoursByOperator: new Map(active.map(id => [id, 0])), warmupModel: 'continuous' },
    })
  })
  if (projections.some(projection => !projection.complete || !Number.isFinite(projection.daily.score))) {
    throw new Error(`Static projection is unsupported: ${projections.flatMap(p => p.diagnostics).join('; ')}`)
  }
  return {
    score: .775 * projections[0].daily.score + .225 * projections[1].daily.score,
    main: projections[0].daily, relief: projections[1].daily,
  }
}

const cycleSources = [
  'src/engine/morale.ts:currentMoraleRates',
  'src/engine/dormitoryRecovery.ts:evaluateDormitoryRecovery',
  'src/scheduler/mowerMoodLimits.ts:initializeMowerAlphaMoodLimits',
  'src/optimizer/manufacturingCrewValuation.ts:normalThreshold/exhaustDue/reference recovery beds',
  'src/optimizer/controlImpact.ts:projectControlOutput',
]
const cycleAssumptions = [
  'Fixed-context reference only: every other group stays on its primary shift at full morale.',
  'Depletion is frozen at full primary morale; recovery is frozen at the reference rest-entry morale.',
  'Reference beds are free slots in alternating dormitory/slot order; no queue or eligibility competition between groups.',
  'Every primary is restored to its upper mood limit before the next reference primary phase; native early returns are not inferred.',
  'The configured ordinary threshold/exhaustion trigger supplies a reference work duration, not a native task event proof.',
  'The actual unlocked skills, provider identities, room levels and level-cap atmosphere feed the shared static interpreters.',
  'Reward includes primary and relief static output of this group only, in weighted production units per complete reference cycle.',
  'No F label, sampled native event history, regeneration, stationary queue or full-schedule feasibility is inferred.',
]

function referenceCycles(engine, definition, workspace) {
  const groups = new Map(), records = engine.inventoryOperatorRecords(definition.inventory.compiled)
  for (const room of Object.values(workspace.mainPlan.facilities)) {
    if (room.level <= 0 || room.type === 'dormitory') continue
    for (const [index, slot] of room.slots.entries()) {
      if (slot.occupant.kind !== 'operator') continue
      const key = slot.groupId?.trim() || `${room.roomId}:${index}`
      groups.set(key, [...groups.get(key) ?? [], { roomId: room.roomId, index, slot }])
    }
  }
  const configFor = snapshot => {
    const config = engine.projectRosterConfig(snapshot)
    config.operatorRecords = records
    return config
  }
  const mainConfig = configFor(workspace)
  const depletion = engine.currentMoraleRates(mainConfig)
  const compiled = engine.compileRosterSchedule(workspace, { restingThreshold: .65, operationDurationHours: 0 })
  const runtimeConfig = engine.compiledScheduleToRuntimeConfig(compiled)
  runtimeConfig.mowerAlpha = true
  const data = engine.getMowerSourceRuntime(engine.createRosterRuntime(runtimeConfig)).data
  engine.initializeMowerAlphaMoodLimits(data, runtimeConfig.mowerSourceRules.lingMode, runtimeConfig.mowerMoodLimits)
  const dorms = Object.values(workspace.mainPlan.facilities).filter(room => room.type === 'dormitory')
  const freeByDorm = dorms.map((room, dormIndex) => room.level > 0
    ? room.slots.flatMap((slot, slotIndex) => slot.occupant.kind === 'free' ? [{ dormIndex, slotIndex, roomId: room.roomId }] : []) : [])
  const beds = []
  for (let index = 0; index < Math.max(0, ...freeByDorm.map(row => row.length)); index++) {
    for (const row of freeByDorm) if (row[index]) beds.push(row[index])
  }
  const result = { supported: true, groups: [], issues: [] }
  for (const [groupId, positions] of groups) {
    try {
      const ids = positions.map(position => position.slot.occupant.operatorId)
      const actors = ids.map(id => data.operators[id])
      if (actors.some(actor => !actor || actor.workaholic || actor.multiGroup || actor.independentRest || actor.restingPriority === 'standby')) {
        throw new Error('Reference cycle requires complete ordinary primary actors without permanent/standby/multiple bindings')
      }
      if (ids.length > beds.length) throw new Error('Not enough explicit free reference beds')
      const actorRates = Object.fromEntries(ids.map(id => {
        const rate = depletion.rates[id]
        if (!Number.isFinite(rate) || rate < 0) throw new Error(`Unquantified active depletion ${id}`)
        return [id, rate]
      }))
      const margin = actors.some(actor => actor.restInFull) ? 10 : 30
      const mandatory = actors.filter(actor => actor.exhaustRequire)
      const triggerActors = mandatory.length ? mandatory : actors
      const thresholds = Object.fromEntries(actors.map(actor => {
        const threshold = actor.lowerLimit + (actor.upperLimit - actor.lowerLimit) * runtimeConfig.mowerPolicy.restingThreshold
        return [actor.name, actor.customMoodLimit ? threshold : Math.min(Math.floor(threshold), actor.upperLimit - 2)]
      }))
      const workHours = Math.min(...triggerActors.map(actor => {
        const rate = actorRates[actor.name]
        if (!rate) return Infinity
        return mandatory.length
          ? Math.max(0, (actor.upperLimit - actor.lowerLimit - 2) / rate, (actor.upperLimit - actor.lowerLimit) / rate - margin / 60)
          : Math.max(0, (actor.upperLimit - thresholds[actor.name]) / rate)
      }))
      if (!Number.isFinite(workHours) || workHours <= 0) throw new Error('No finite positive reference work phase')
      const entryMorale = Object.fromEntries(actors.map(actor => [actor.name, Math.max(0, actor.upperLimit - actorRates[actor.name] * workHours)]))
      const resting = structuredClone(workspace), reliefIds = []
      for (const position of positions) {
        if (position.slot.replacements.length !== 1) throw new Error('Reference cycle requires one complete ordinary relief per primary')
        const backup = position.slot.replacements[0]
        reliefIds.push(backup)
        resting.mainPlan.facilities[position.roomId].slots[position.index].occupant = { kind: 'operator', operatorId: backup }
      }
      const referenceBeds = ids.map((id, index) => ({ ...beds[index], id }))
      for (const bed of referenceBeds) {
        resting.mainPlan.facilities[bed.roomId].slots[bed.slotIndex].occupant = { kind: 'operator', operatorId: bed.id }
      }
      const restConfig = configFor(resting)
      restConfig.operatorMorale = { ...restConfig.operatorMorale, ...entryMorale }
      const moods = new Map(Object.entries(restConfig.operatorMorale))
      const recoveryRates = {}
      for (const [dormIndex, dorm] of dorms.entries()) {
        if (!referenceBeds.some(bed => bed.dormIndex === dormIndex)) continue
        const present = restConfig.facilityOperatorIds.dormitories[dormIndex].map(id => records[id])
        if (present.some(record => !record)) throw new Error('Reference dorm contains a missing actual inventory record')
        const targets = new Map()
        for (const provider of present) if (engine.hasSingleRecoverySkill(provider)) {
          const eligible = engine.eligibleSingleRecoveryTargets(present, provider.charId, id => moods.get(id) ?? 24)
          const selected = eligible.sort((a, b) => (moods.get(a.charId) ?? 24) - (moods.get(b.charId) ?? 24))[0]
          if (selected) targets.set(provider.charId, selected.charId)
        }
        const recovery = engine.evaluateDormitoryRecovery(restConfig, dormIndex, moods, dorm.level * 1000, targets)
        if (recovery.unquantified.length) throw new Error(recovery.unquantified.join('; '))
        Object.assign(recoveryRates, Object.fromEntries(recovery.rates))
      }
      for (const id of ids) if (!Number.isFinite(recoveryRates[id]) || recoveryRates[id] <= 0) throw new Error(`Unquantified reference recovery ${id}`)
      const restHours = Math.max(...actors.map(actor => (actor.upperLimit - entryMorale[actor.name]) / recoveryRates[actor.name]))
      if (!Number.isFinite(restHours) || restHours < 0) throw new Error('No finite reference recovery phase')
      const reliefDepletion = engine.currentMoraleRates(restConfig)
      for (const id of reliefIds) {
        const rate = reliefDepletion.rates[id]
        if (!Number.isFinite(rate) || rate < 0 || 24 - rate * restHours < -1e-8) {
          throw new Error(`Relief cannot sustain this full-recovery reference: ${id}`)
        }
      }
      const selectedRoomIds = [...new Set(positions.map(p => p.roomId).filter(id => definition.targets.includes(id)))].map(engine.productionRoomId)
      const project = config => engine.projectControlOutput(config, {
        selectedRoomIds, timeContext: { workHoursByOperator: new Map(Object.keys(records).map(id => [id, 0])), warmupModel: 'continuous' },
      })
      const mainOutput = project(mainConfig), reliefOutput = project(restConfig)
      if (![mainOutput, reliefOutput].every(output => output.complete && Number.isFinite(output.daily.score))) throw new Error('Reference group output is unquantified')
      result.groups.push({
        group_id: groupId, work_hours: workHours, rest_hours: restHours,
        reward: mainOutput.daily.score / 24 * workHours + reliefOutput.daily.score / 24 * restHours,
        bed_units: ids.length, wait_hours: 0,
        primary_reward_per_hour: mainOutput.daily.score / 24,
        relief_reward_per_hour: reliefOutput.daily.score / 24,
        primary_consumption: actorRates,
        recovery_rates: Object.fromEntries(ids.map(id => [id, recoveryRates[id]])),
        reference_exit_morale: entryMorale, ordinary_thresholds: thresholds,
        upper_limits: Object.fromEntries(actors.map(actor => [actor.name, actor.upperLimit])),
        reference_beds: referenceBeds,
      })
    } catch (error) {
      result.supported = false
      result.issues.push(`${groupId}: ${error.message ?? String(error)}`)
    }
  }
  if (!result.groups.length) result.supported = false
  return result
}

function prepareScenarios(engine, args, manifest) {
  const definitions = scenarioDefinitions(engine)
  const publicSpecs = []
  for (const definition of definitions) {
    definition.inventory = maximumInventory(engine, definition.names)
    const domains = definition.options.map(options => options.length)
    const table = {}, forbidden = [], staticEvidence = [], vectorCycles = {}
    const variables = domains.map((_, index) => index)
    const initial = domains.map(() => 0)
    for (const vector of categoricalVectors(domains)) {
      const decoded = decode(engine, definition, vector)
      if (decoded.issues.length) {
        forbidden.push({ vars: variables, values: vector })
        staticEvidence.push({ vector, valid: false, issues: decoded.issues })
        continue
      }
      const projection = projectCheap(engine, definition, decoded.workspace)
      table[vector.join(',')] = projection.score
      staticEvidence.push({ vector, valid: true, ...projection })
      vectorCycles[vector.join(',')] = referenceCycles(engine, definition, decoded.workspace)
    }
    if (!Number.isFinite(table[initial.join(',')])) throw new Error(`${definition.id}: initial vector is not model-feasible`)
    let unary, factors, residual = 0
    if (domains.length === 2) {
      const base = table['0,0']
      unary = [Array.from({ length: domains[0] }, (_, a) => table[`${a},0`] ?? 0),
        Array.from({ length: domains[1] }, (_, b) => (table[`0,${b}`] ?? base) - base)]
      const interactions = Object.fromEntries(Object.entries(table).map(([key, score]) => {
        const [a, b] = key.split(',').map(Number)
        return [key, score - unary[0][a] - unary[1][b]]
      }))
      factors = [{ vars: variables, table: interactions }]
      for (const [key, score] of Object.entries(table)) {
        const [a, b] = key.split(',').map(Number)
        residual = Math.max(residual, Math.abs(score - unary[0][a] - unary[1][b] - interactions[key]))
      }
    } else {
      // The joint base has genuine shared context. Retain its complete STATIC
      // G table as a higher-order factor rather than inventing sparse coupling.
      unary = domains.map(size => Array(size).fill(0))
      factors = [{ vars: variables, table }]
    }
    const spec = {
      id: definition.id, name: definition.name, domains, initial, unary, factors, forbidden,
      resources: [{ name: 'explicit_recovery_beds', capacity: definition.bedCapacity ?? 4, usage: definition.bedUsage }],
      metadata: {
        source: 'native-riic-constructed-fixture', source_sha256: manifest.sourceSha256,
        variable_names: definition.variableNames, choices: definition.options,
        inventory: definition.inventory.entries,
        model: 'G is 0.775*main static projection + 0.225*all-relief static projection; factors represent this finite static table exactly, not F.',
        model_cartesian_size: domains.reduce((product, size) => product * size, 1),
        model_feasible_vectors: Object.keys(table).length,
        maximum_factor_order: domains.length,
        decomposition_residual_max: residual,
        sparsity_claim: domains.length > 2 ? 'None: one dense higher-order static factor.' : 'Two-variable static factor only.',
        model_limits: ['Fixed reference duty ratio; no recovery queues or joint timing.',
          'Warmup uses explicit zero-hour static context; no drones.',
          'This public table contains G only; no full or short F evaluations are used to build it.',
          'No finite schedule proof is supplied; native F checks actual simulated scheduling.'],
        full_window: { warmupHours: 24, sampleHours: 72 },
        short_window: { warmupHours: 6, sampleHours: 18 },
        output_mode: 'potential', drone_target: 'none',
        metric_units: { exp: 'experience/day', order_lmd: 'completed order face LMD/day', gold: 'gold bars/day', change_cost: 'categorical decisions changed from initial' },
        renewal: {
          beds: definition.bedCapacity ?? 4, vector_cycles: vectorCycles,
          sources: cycleSources, assumptions: cycleAssumptions,
          reward_units: 'Shared weighted production units earned during one complete fixed-context reference primary/relief cycle.',
          wait_hours_scope: 'Zero by the explicit isolated/no-queue reference assumption; not observed native waiting.',
          complete_native_cycles_observed: false,
        },
        scope: 'Named real operators at explicitly declared maximum stages; synthetic inventory, not a user/game roster.',
      },
    }
    definition.spec = spec
    publicSpecs.push(spec)
    writeFileSync(resolve(args.out, `${definition.id}-static-model.json`), JSON.stringify({ spec, staticEvidence }, null, 2))
  }
  writeFileSync(resolve(args.out, 'public-scenarios.json'), JSON.stringify(publicSpecs, null, 2))
  return { definitions: new Map(definitions.map(definition => [definition.id, definition])), publicSpecs }
}

function evaluate(engine, definition, request, args, manifest, evaluationNumber) {
  const started = performance.now()
  const seed = request.seed ?? 42
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('seed must be a uint32')
  const fidelity = request.fidelity ?? 'full'
  if (!['short', 'full'].includes(fidelity)) throw new Error('fidelity must be short or full')
  const decoded = decode(engine, definition, request.vector)
  const label = `evaluation-${String(evaluationNumber).padStart(5, '0')}`
  const inputPath = resolve(args.out, `${label}-input.json`)
  const outputPath = resolve(args.out, `${label}-report.json`)
  const resultPath = resolve(args.out, `${label}-result.json`)
  const window = fidelity === 'short' ? { warmupHours: 6, sampleHours: 18 } : { warmupHours: 24, sampleHours: 72 }
  const options = {
    ...window, maxStepHours: .25, maxEvents: 200000, recordSegments: false,
    productionWeights: { exp: 1, gold: .8, orders: .2, fragments: 0, orundum: 0 },
    operatorInventory: definition.inventory.entries,
    production: { outputMode: 'potential', runOrderMode: 'ideal', droneTarget: 'none', seed },
  }
  const assumptions = { restingThreshold: .65, operationDurationHours: 0, idleOperators: [] }
  const input = { scene_id: definition.id, vector: request.vector, fidelity, seed,
    workspace: decoded.workspace, options, assumptions }
  const inputBytes = JSON.stringify(input)
  writeFileSync(inputPath, inputBytes)
  let report = null, error, incomeCase = null
  if (!decoded.issues.length) {
    const response = engine.runScheduleSimulationBridge(decoded.workspace, options, assumptions)
    report = response.report
    error = response.error
    if (report) incomeCase = engine.summarizeIncome(report)
  }
  const valid = !decoded.issues.length && !!incomeCase?.eligible
  let score = null
  const metrics = { exp: null, order_lmd: null, gold: null,
    change_cost: Array.isArray(request.vector) ? request.vector.filter(value => value !== 0).length : null }
  if (valid) {
    const amounts = engine.simulationOutputAmounts(report)
    const daily = 24 / report.observedHours
    score = engine.scoreSimulationProduction(report).total
    metrics.exp = amounts.exp * daily
    metrics.gold = amounts.gold * daily
    metrics.order_lmd = amounts.orderLmd * daily
  }
  if (report) writeFileSync(outputPath, JSON.stringify(report))
  const result = {
    scene_id: definition.id, vector: request.vector, valid, score, metrics, fidelity, seed,
    elapsed_ms: performance.now() - started,
    issues: [...decoded.issues, ...(incomeCase?.issues ?? []), ...(error ? [error] : [])],
    evidence: { input: inputPath, report: report ? outputPath : null, result: resultPath,
      input_sha256: sha(inputBytes), source_sha256: manifest.sourceSha256,
      engine_sha256: manifest.engineSha256,
      elapsed_hours: report?.elapsedHours ?? null, observed_hours: report?.observedHours ?? null,
      eligible: incomeCase?.eligible ?? false,
      proof_scope: 'Frozen RIIC Node simulator on a declared fixture; potential output, not real game/device evidence.' },
  }
  writeFileSync(resultPath, JSON.stringify(result, null, 2))
  appendFileSync(resolve(args.out, 'evaluations.jsonl'), JSON.stringify(result) + '\n')
  log(`${definition.id} [${request.vector}] ${fidelity} valid=${valid} ${result.elapsed_ms.toFixed(1)}ms`)
  return result
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  const { engine, manifest } = await freezeEngine(args)
  const { definitions, publicSpecs } = prepareScenarios(engine, args, manifest)
  log(`Ready: ${publicSpecs.length} scenarios; source ${manifest.sourceSha256}`)
  let evaluationNumber = 0
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!line.trim()) continue
    let request, response
    try {
      request = JSON.parse(line)
      if (request.op === 'scenarios') response = { scenarios: publicSpecs }
      else if (request.op === 'evaluate') {
        const definition = definitions.get(request.scene_id)
        if (!definition) throw new Error(`Unknown scene_id ${request.scene_id}`)
        response = evaluate(engine, definition, request, args, manifest, ++evaluationNumber)
      } else throw new Error(`Unknown op ${request.op}`)
    } catch (error) {
      response = { valid: false, score: null, error: error.message ?? String(error),
        vector: request?.vector ?? null, scene_id: request?.scene_id ?? null,
        fidelity: request?.fidelity ?? null, seed: request?.seed ?? null }
      log(response.error)
    }
    if (request?.request_id !== undefined) response.request_id = request.request_id
    process.stdout.write(JSON.stringify(response) + '\n')
  }
}

main().catch(error => { log(error.stack ?? String(error)); process.exitCode = 1 })
