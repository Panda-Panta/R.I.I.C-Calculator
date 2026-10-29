import { facilityCapacity } from '../domain/facilities'
import { compileOperatorInventory, type OperatorInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { normalizeProductionWeights } from '../domain/productionWeights'
import { MOWER_OPERATOR_LIST_FIELDS, type MowerSlot, type RosterWorkspace } from '../domain/roster'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { validateScheduleInventory } from '../scheduler/inventoryValidation'
import { readMowerOperatorList } from '../scheduler/mowerBackupConfig'
import { compiledScheduleToRuntimeConfig, isOrdinaryReplacementCandidate } from '../scheduler/scheduleAdapter'
import { physicalBackupOperatorIds } from './combinationModel'
import { preservesFormedCombinations } from './combinationIntegrity'
import { applyGeneratedRecoveryPolicy } from './generatedRecoveryPolicy'
import { applyGeneratedWarmupPolicy } from './generatedWarmupPolicy'
import { generateContextualCrewCandidates } from './jointBackupCrewSeeds'
import { buildMainRosterHybridPolicyVariables } from './mainRosterHybridRecovery'
import type { MainRosterHybridDomain, MainRosterHybridInput, MainRosterHybridMaterialization, MainRosterHybridVariable } from './mainRosterHybridTypes'
import { generateMolecularCandidates } from './molecularSynthesis'
import { productionWorkspaceHourlyScore } from './productionSingletons'
import { recoveryGroupCapacityIssues } from './recoveryGroupCapacity'
import { validatePhysicalRoster } from './rosterDraft'

type Construction = { id: string; label: string; workspace: RosterWorkspace }
const text = (error: unknown) => error instanceof Error ? error.message : String(error)
const positionKey = (key: string) => key.replace(/_(\d+)$/, ':$1')
const entries = (workspace: RosterWorkspace) => Object.values(workspace.mainPlan.facilities).filter(room => room.level > 0)
  .flatMap(room => room.slots.map((slot, index) => ({ room, slot, index, key: `${room.roomId}:${index}` })))
const references = (slot: MowerSlot) => [
  ...(slot.occupant.kind === 'operator' ? [slot.occupant.operatorId] : []), ...slot.replacements,
  ...(slot.groupBindings ?? []).flatMap(binding => binding.replacements),
].filter(ref => ref !== 'Free').map(id)
const canonicalSlot = (slot: MowerSlot | undefined) => slot && { ...slot,
  occupant: slot.occupant.kind === 'operator' ? { ...slot.occupant, operatorId: id(slot.occupant.operatorId) } : slot.occupant,
  replacements: slot.replacements.map(id), ...(slot.groupBindings ? { groupBindings: slot.groupBindings.map(binding => ({ ...binding, replacements: binding.replacements.map(id) })) } : {}),
}

/** Exact original-user positions, including relief roles and ordered extra bindings. */
function actorPositions(workspace: RosterWorkspace, operator: string): string[] {
  return entries(workspace).flatMap(({ room, slot, key }) => [
    ...(slot.occupant.kind === 'operator' && id(slot.occupant.operatorId) === operator ? [`${key}:main`] : []),
    ...slot.replacements.flatMap((ref, index) => id(ref) === operator && room.type !== 'dormitory' && isOrdinaryReplacementCandidate(ref, room.type)
      ? [`${key}:backup:${index}`] : []),
    ...(slot.groupBindings ?? []).flatMap((binding, column) => binding.replacements.flatMap((ref, index) => id(ref) === operator &&
      room.type !== 'dormitory' && isOrdinaryReplacementCandidate(ref, room.type) ? [`${key}:binding:${column}:${index}`] : [])),
  ])
}

function userLocks(input: MainRosterHybridInput) {
  const positions = new Set((input.lockedPositions ?? []).map(positionKey)), operators = new Set((input.lockedOperators ?? []).map(id))
  // These are original user choices, never occupants/cores auto-formed in the incumbent.
  for (const { slot, key } of entries(input.userBase)) if (slot.occupant.kind === 'operator') {
    positions.add(key)
    if (slot.occupant.kind === 'operator') operators.add(id(slot.occupant.operatorId))
  }
  return { lockedPositions: positions, lockedOperators: operators }
}

function admission(input: MainRosterHybridInput, workspace: RosterWorkspace, inventory: OperatorInventory, locks: ReturnType<typeof userLocks>): string[] {
  const diagnostics: string[] = [], reject = (code: string, message: string) => diagnostics.push(`[${code}] ${message}`)
  if (!inventory.valid) inventory.diagnostics.forEach(issue => reject('INVENTORY_INVALID', issue.message))
  if (input.userBase.compatibility.backupPlans.length || workspace.compatibility.backupPlans.length) reject('HYBRID_SIDE_PLANS_UNSUPPORTED', '有限主班域不包含条件副表。')
  for (const before of Object.values(input.userBase.mainPlan.facilities)) {
    const after = workspace.mainPlan.facilities[before.roomId]
    if (!after || before.type !== after.type || before.level !== after.level || before.product !== after.product) reject('USER_LAYOUT', `不能改变原始设施类别、等级或产物：${before.roomId}`)
  }
  if (JSON.stringify(normalizeProductionWeights(input.userBase.productionWeights)) !== JSON.stringify(normalizeProductionWeights(workspace.productionWeights))) reject('USER_WEIGHTS', '不能改变原始产出权重。')
  const beforePositions = new Map(entries(input.userBase).map(position => [position.key, position.slot]))
  const afterPositions = new Map(entries(workspace).map(position => [position.key, position.slot]))
  // An explicit group/list on a vacant user seat must survive without locking that seat vacant.
  for (const [key, before] of beforePositions) {
    const after = afterPositions.get(key)
    if (before.groupId && before.groupId !== after?.groupId) reject('USER_GROUP', `不能改变原始用户分组：${key}`)
    if (before.replacements.length && JSON.stringify(before.replacements.map(id)) !== JSON.stringify(after?.replacements.map(id))) reject('USER_REPLACEMENTS', `不能改变原始候补名单和顺序：${key}`)
    if (before.groupBindings?.length && JSON.stringify(canonicalSlot(before)?.groupBindings) !== JSON.stringify(after && canonicalSlot(after)?.groupBindings)) reject('USER_BINDINGS', `不能改变原始用户绑定列：${key}`)
    if (before.metadata && JSON.stringify(before.metadata) !== JSON.stringify(after?.metadata)) reject('USER_SLOT_METADATA', `不能改变原始工位保留字段：${key}`)
  }
  for (const key of locks.lockedPositions) if (!beforePositions.has(key) || JSON.stringify(canonicalSlot(beforePositions.get(key))) !== JSON.stringify(canonicalSlot(afterPositions.get(key)))) {
    reject('USER_LOCK_POSITION', `原始完整工位被改变或不存在：${key}`)
  }
  for (const operator of locks.lockedOperators) if (JSON.stringify(actorPositions(input.userBase, operator)) !== JSON.stringify(actorPositions(workspace, operator))) {
    reject('USER_LOCK_OPERATOR', `原始主班/替班/绑定位置被改变：${operator}`)
  }
  for (const field of MOWER_OPERATOR_LIST_FIELDS) {
    const before = readMowerOperatorList(field, input.userBase.mainPlan.conf[field]).map(id), after = readMowerOperatorList(field, workspace.mainPlan.conf[field]).map(id)
    let cursor = 0
    for (const operator of after) if (operator === before[cursor]) cursor++
    if (cursor !== before.length) reject('USER_POLICY', `不能删除或重排原始策略名单：${field}`)
  }
  if (input.userBase.mainPlan.conf.ling_xi !== workspace.mainPlan.conf.ling_xi) reject('USER_POLICY', '不能改变原始令夕模式。')
  diagnostics.push(...validatePhysicalRoster(workspace).map(issue => `[${issue.code}] ${issue.message}`))
  const physical = new Set<string>(), owned = new Set(inventory.operators.map(operator => operator.charId))
  for (const room of Object.values(workspace.mainPlan.facilities)) {
    if (room.level <= 0 || room.type === 'gaming') continue
    const capacity = facilityCapacity(room.type, room.level)
    if (room.slots.length !== capacity) reject('INCOMPLETE_ROOM', `完整域须有全部实际工位：${room.roomId}`)
    for (const slot of room.slots) {
      if (slot.occupant.kind !== 'operator' && !(room.type === 'dormitory' && slot.occupant.kind === 'free')) reject('INCOMPLETE_PRIMARY', `主位尚未明确：${room.roomId}`)
      for (const actor of references(slot)) if (!owned.has(actor)) reject('INVENTORY_OPERATOR_NOT_OWNED', `实际主班/候补/宿舍引用未持有：${actor}`)
      const actors = [
        ...(slot.occupant.kind === 'operator' ? [id(slot.occupant.operatorId)] : []), ...physicalBackupOperatorIds(room, slot),
        ...(room.type === 'dormitory' ? [] : (slot.groupBindings ?? []).flatMap(binding => binding.replacements.filter(ref => isOrdinaryReplacementCandidate(ref, room.type)).map(id))),
      ]
      for (const actor of actors) {
        if (physical.has(actor)) reject('PHYSICAL_ROLE_CONFLICT', `本有限域要求独立实体主替角色：${actor}`)
        physical.add(actor)
      }
    }
  }
  const schedule = compileRosterSchedule(workspace)
  diagnostics.push(...schedule.diagnostics.filter(issue => issue.severity === 'error' || ['UNKNOWN_OPERATOR', 'UNKNOWN_POLICY'].includes(issue.code)).map(issue => `[${issue.code}] ${issue.message}`))
  diagnostics.push(...validateScheduleInventory(schedule, inventory).diagnostics.map(issue => `[${issue.code}] ${issue.message}`))
  for (const position of compiledScheduleToRuntimeConfig(schedule).positions) if (!position.dormitory && !position.permanent && !position.candidates.length) {
    reject('INCOMPLETE_BACKUP', `普通工作主位缺少实际普通替班：${position.id}`)
  }
  if (inventory.valid && !preservesFormedCombinations(input.userBase, workspace, inventory)) reject('USER_COMPLETE_CORE', '不能拆散原始用户完整组合。')
  const warmup = applyGeneratedWarmupPolicy(structuredClone(workspace), inventory)
  diagnostics.push(...warmup.diagnostics.filter(issue => issue.severity === 'error').map(issue => `[${issue.code}] ${issue.message}`))
  if (warmup.addedExhaustOperatorIds.length) reject('WARMUP_EXHAUSTION_REQUIRED', '原向量缺少实际暖机主班耗尽策略；验证不能改写初始表。')
  diagnostics.push(...recoveryGroupCapacityIssues(workspace).map(issue => `[${issue.code}] ${issue.message}`))
  return [...new Set(diagnostics)]
}

function changes(before: RosterWorkspace, after: RosterWorkspace) {
  const changedFacilities = Object.values(after.mainPlan.facilities).filter(room => JSON.stringify(room) !== JSON.stringify(before.mainPlan.facilities[room.roomId])).map(room => room.roomId)
  const actors = new Set([...entries(before), ...entries(after)].flatMap(position => references(position.slot)))
  // Group/target-order changes affect the actual job even with identical physical seats.
  const signature = (workspace: RosterWorkspace, actor: string) => entries(workspace).filter(position => references(position.slot).includes(actor))
    .map(position => [position.key, canonicalSlot(position.slot)])
  const changedOperators = [...actors].filter(actor => JSON.stringify(signature(before, actor)) !== JSON.stringify(signature(after, actor)))
  for (const field of MOWER_OPERATOR_LIST_FIELDS) {
    const previous = Array.isArray(before.mainPlan.conf[field]) ? (before.mainPlan.conf[field] as string[]).map(id) : []
    const next = Array.isArray(after.mainPlan.conf[field]) ? (after.mainPlan.conf[field] as string[]).map(id) : []
    for (const actor of [...previous, ...next]) if (previous.indexOf(actor) !== next.indexOf(actor) && !changedOperators.includes(actor)) changedOperators.push(actor)
  }
  return { changedFacilities, changedOperators }
}

function constructions(input: MainRosterHybridInput, inventory: OperatorInventory, locks: ReturnType<typeof userLocks>, limit: number, diagnostics: string[]): Construction[] {
  const values: Construction[] = [{ id: 'incumbent', label: '原始完整初始表', workspace: structuredClone(input.incumbent) }]
  if (limit === 1 || !inventory.valid) return values
  let molecular: ReturnType<typeof generateMolecularCandidates> = []
  try {
    molecular = generateMolecularCandidates(structuredClone(input.userBase), input.entries, inventory, {
      seed: input.constructionSeed ?? 42, branchCount: 3, requireWarmupExhaustion: true,
      lockedPositions: locks.lockedPositions, lockedOperators: locks.lockedOperators,
    })
  } catch (error) { diagnostics.push(`[CONSTRUCTION_UNSUPPORTED] ${text(error)}`) }
  const prepared = molecular.map(candidate => ({ id: candidate.id, workspace: structuredClone(candidate.workspace) }))
  for (const candidate of prepared) {
    try {
      applyGeneratedWarmupPolicy(candidate.workspace, inventory)
      applyGeneratedRecoveryPolicy(candidate.workspace)
    } catch (error) { diagnostics.push(`[CONSTRUCTION_PREPARATION_UNSUPPORTED] ${candidate.id}: ${text(error)}`) }
  }
  let crews: ReturnType<typeof generateContextualCrewCandidates> = { candidates: [], diagnostics: [] }
  try {
    crews = generateContextualCrewCandidates([{ id: 'incumbent', workspace: structuredClone(input.incumbent) }, ...prepared], inventory, { ...locks, maxCandidates: 2 })
    diagnostics.push(...crews.diagnostics.map(issue => `[${issue.code}] ${issue.message}`))
  } catch (error) { diagnostics.push(`[CREW_CONSTRUCTION_UNSUPPORTED] ${text(error)}`) }
  const alternatives = [...prepared.slice(0, 2), ...crews.candidates, ...prepared.slice(2)]
  const seen = new Set([JSON.stringify(input.incumbent)])
  for (const candidate of alternatives) {
    const workspace = structuredClone(candidate.workspace), fingerprint = JSON.stringify(workspace)
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    values.push({ id: `construction-${values.length}:${candidate.id}`, label: candidate.id, workspace })
    if (values.length >= Math.min(4, limit)) break
  }
  return values
}

function vectors(cardinalities: readonly number[]): number[][] {
  return cardinalities.reduce<number[][]>((prefixes, count) => prefixes.flatMap(prefix => Array.from({ length: count }, (_, value) => [...prefix, value])), [[]])
}

/** Research-only finite real-roster model. G is a static proposal feature, never a native F label. */
export function buildMainRosterHybridDomain(input: MainRosterHybridInput): MainRosterHybridDomain {
  const started = performance.now(), requested = input.maxVectors ?? 128
  if (!Number.isSafeInteger(requested) || requested < 1) throw new Error('有限主班向量预算必须为正有限整数。')
  const limit = Math.min(128, requested), diagnostics: string[] = []
  if (requested > 128) diagnostics.push('[VECTOR_LIMIT_CLAMPED] 首轮域固定最多128个声明向量。')
  const inventory = compileOperatorInventory(input.entries), locks = userLocks(input)
  const choices = constructions(input, inventory, locks, limit, diagnostics)
  const policies = buildMainRosterHybridPolicyVariables({ ...input, lockedPositions: [...locks.lockedPositions], lockedOperators: [...locks.lockedOperators] }, choices.map(choice => choice.workspace))
  diagnostics.push(...policies.diagnostics)
  const variables: MainRosterHybridVariable[] = [
    { id: 'whole-roster', family: 'construction', options: choices.map(({ id, label }) => ({ id, label })) },
    ...structuredClone(policies.variables),
  ]
  const cardinalities = () => variables.map(variable => variable.options.length)
  while (cardinalities().reduce((product, count) => product * count, 1) > limit) {
    const variable = [...variables].reverse().find(variable => variable.options.length > 1)!
    variable.options.pop()
  }
  const initial = variables.map(() => 0), dimensions = cardinalities(), indexes = variables.map((_, index) => index)
  const materializations: MainRosterHybridDomain['materializations'] = {}, table: Record<string, number> = {}
  const forbidden: MainRosterHybridDomain['publicSpec']['forbidden'] = []
  let gCalls = policies.gCalls ?? 0
  for (const vector of vectors(dimensions)) {
    const base = structuredClone(choices[vector[0]!]!.workspace)
    let decoded: ReturnType<typeof policies.decode>
    try { decoded = policies.decode(base, vector.slice(1)) }
    catch (error) { decoded = { status: 'unknown', workspace: base, diagnostics: [`[POLICY_DECODE_UNSUPPORTED] ${text(error)}`], gCalls: 0 } }
    gCalls += decoded.gCalls
    const workspace = decoded.workspace ?? base
    const materialized: MainRosterHybridMaterialization = { vector, status: decoded.status, workspace,
      primaryHourlyScore: null, diagnostics: [...decoded.diagnostics], ...changes(input.incumbent, workspace) }
    if (decoded.status === 'ready') {
      try {
        const errors = admission(input, workspace, inventory, locks)
        materialized.diagnostics.push(...errors)
        if (errors.length) materialized.status = 'rejected'
        else {
          gCalls++
          const score = productionWorkspaceHourlyScore(workspace, inventory)
          if (score !== undefined && Number.isFinite(score)) materialized.primaryHourlyScore = score
          else { materialized.status = 'unknown'; materialized.diagnostics.push('[PRIMARY_G_UNKNOWN] 完整基地静态主班G未量化。') }
        }
      } catch (error) { materialized.status = 'unknown'; materialized.diagnostics.push(`[DOMAIN_UNSUPPORTED] ${text(error)}`) }
    }
    const key = vector.join(',')
    materializations[key] = materialized
    if (materialized.status === 'ready' && materialized.primaryHourlyScore !== null) table[key] = materialized.primaryHourlyScore
    else forbidden.push({ vars: [...indexes], values: [...vector] })
  }
  const rows = Object.values(materializations)
  return { schemaVersion: 1, sceneId: input.sceneId, variables, initial, materializations,
    publicSpec: { id: input.sceneId, domains: dimensions, initial: [...initial], unary: dimensions.map(count => Array<number>(count).fill(0)),
      factors: [{ vars: indexes, table }], forbidden, resources: [], metadata: {
        proofScope: 'declared-finite-primary-G-model-only', modelKind: 'fully-measured-high-order-table', objective: 'primary-hourly-G',
        sparseFactorizationClaim: false, nativeEvaluations: 0, initialStatus: materializations[initial.join(',')]!.status,
        excludedVectors: rows.filter(row => row.status !== 'ready').map(row => ({ vector: row.vector, status: row.status, diagnostics: row.diagnostics })),
        gCallsScope: 'domain-materialization-and-policy-G; construction-internal-G-not-included',
      } },
    evidence: { declaredVectors: rows.length, ready: rows.filter(row => row.status === 'ready').length,
      rejected: rows.filter(row => row.status === 'rejected').length, unknown: rows.filter(row => row.status === 'unknown').length,
      gCalls, elapsedMs: Math.max(0, performance.now() - started), diagnostics },
  }
}
