import type { CandidateSimulationJob } from './candidateSimulation'
import type { MowerGroupBinding, MowerRoomId, MowerSlot, RosterWorkspace } from '../domain/roster'
import { MOWER_OPERATOR_LIST_FIELDS } from '../domain/roster'
import { OPERATOR_MAP } from '../domain/operators'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { compileOperatorInventory } from '../domain/operatorInventory'
import { parseProduct } from '../domain/mowerProducts'
import { facilityCapacity } from '../domain/facilities'
import { exportMowerJson } from '../workbench/compat/mowerJson'
import { validateRosterWorkspace } from '../workbench/validate'
import { compileRosterSchedule } from '../scheduler/compileRosterSchedule'
import { validateScheduleInventory } from '../scheduler/inventoryValidation'
import { backupParticipants } from '../scheduler/backupPlans'
import { readBackupGroups } from '../scheduler/backupGroups'
import { readMowerOperatorList } from '../scheduler/mowerBackupConfig'
import { recoveryGroupCapacityIssues } from './recoveryGroupCapacity'
import {
  GENERATED_BACKUP_PLAN_NAME, GENERATED_BACKUP_TIMING, generatedBackupTriggerExpression,
  type GeneratedBackupDescriptor,
} from './generatedBackupTypes'

type AdmissionJob = Pick<CandidateSimulationJob, 'workspace' | 'options' | 'assumptions' | 'generatedBackup'>
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function reject(code: string, message: string): never { throw new Error(`[GENERATED_BACKUP_${code}] ${message}`) }
const diagnostic = (code: string, message: string) => `[${code}] ${message}`

function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!record(value) || required.some(key => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) reject('SCHEMA', '生成副表包含缺失或不支持的字段')
}
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => equal(value, b[i]))
  if (!record(a) || !record(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && equal(a[key], b[key]))
}
const extra = (value: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))

function descriptor(value: unknown): GeneratedBackupDescriptor {
  fields(value, ['version', 'trigger'])
  if (value.version !== 'joint-production-v1') reject('VERSION', '不支持的自动副表版本')
  fields(value.trigger, ['observers', 'activeWhen'])
  if (!Array.isArray(value.trigger.observers)) reject('OBSERVER', '观察者必须为列表')
  for (const observer of value.trigger.observers) {
    fields(observer, ['operatorId', 'roomId'], ['requirePositiveMood'])
    if (typeof observer.operatorId !== 'string' || typeof observer.roomId !== 'string') reject('OBSERVER', '观察者必须指定干员和房间')
  }
  // The shared builder validates the bounded family, known operators and unique observers.
  const result = value as unknown as GeneratedBackupDescriptor
  generatedBackupTriggerExpression(result.trigger)
  return result
}
function operator(value: unknown): string {
  if (typeof value !== 'string' || !OPERATOR_MAP.has(id(value))) return reject('UNKNOWN_OPERATOR', `无效干员：${String(value)}`)
  return id(value)
}
function binding(value: unknown, original?: MowerGroupBinding): MowerGroupBinding {
  fields(value, ['group', 'replacement'], Object.keys(original?.metadata ?? {}))
  if (typeof value.group !== 'string' || !Array.isArray(value.replacement) || !equal(extra(value, ['group', 'replacement']), original?.metadata ?? {})) reject('METADATA', '绑组结构或保留字段不一致')
  return { groupId: value.group || null, replacements: value.replacement.map(operator),
    ...(original?.metadata ? { metadata: structuredClone(original.metadata) } : {}) }
}
function slot(value: unknown, original: MowerSlot): MowerSlot {
  fields(value, ['agent', 'group', 'replacement'], ['group_bindings', ...Object.keys(original.metadata ?? {})])
  if (typeof value.group !== 'string' || !Array.isArray(value.replacement) ||
    !equal(extra(value, ['agent', 'group', 'replacement', 'group_bindings']), original.metadata ?? {})) reject('METADATA', '岗位结构或保留字段不一致')
  if (value.group_bindings !== undefined && !Array.isArray(value.group_bindings)) reject('SCHEMA', '绑组必须为列表')
  const bindings = value.group_bindings as unknown[] | undefined
  if (original.groupBindings?.some((entry, i) => i >= (bindings?.length ?? 0) && Object.keys(entry.metadata ?? {}).length)) reject('METADATA', '不能删除未知绑组字段')
  const { groupBindings: _oldBindings, ...preserved } = original
  return { ...structuredClone(preserved), occupant: { kind: 'operator', operatorId: operator(value.agent) },
    groupId: value.group || null, replacements: value.replacement.map(operator),
    ...(bindings !== undefined ? { groupBindings: bindings.map((entry, i) => binding(entry, original.groupBindings?.[i])) } : {}) }
}
function nativePlan(workspace: RosterWorkspace): Record<string, unknown> {
  const native = JSON.parse(exportMowerJson(workspace))
  return native[native.default]
}

/** Only complete, canonical manufacturing/trading overlays; no task, config or arbitrary condition. */
function effectiveModes(job: AdmissionJob, generated: GeneratedBackupDescriptor): [RosterWorkspace, RosterWorkspace, string[]] {
  const workspace = job.workspace
  if (workspace.compatibility.importedHasBackupPlans === false) reject('EXPORT_PRESENCE', '生成副表必须包含在原生导出中')
  if (readBackupGroups(workspace).some(group => group.id !== 'default')) reject('GROUPS', '自动副表首版不支持自定义副表分组')
  if (workspace.compatibility.backupPlans.length !== 1) reject('COUNT', '自动候选必须恰有一张生成副表')
  const raw = workspace.compatibility.backupPlans[0]
  fields(raw, ['name', 'trigger', 'trigger_timing', 'exit_trigger_timing', 'plan'])
  if (raw.name !== GENERATED_BACKUP_PLAN_NAME || raw.trigger !== generatedBackupTriggerExpression(generated.trigger) ||
    raw.trigger_timing !== GENERATED_BACKUP_TIMING || raw.exit_trigger_timing !== GENERATED_BACKUP_TIMING) reject('CANONICAL', '副表名称、时机或条件与生成描述不一致')
  if (!record(raw.plan) || !Object.keys(raw.plan).length) reject('PLAN', '必须包含发生变化的完整生产房间')
  const off = structuredClone(workspace)
  off.compatibility.backupPlans = []
  const on = structuredClone(off), main = nativePlan(off), rooms = Object.keys(raw.plan)
  for (const roomId of rooms) {
    const facility = on.mainPlan.facilities[roomId as MowerRoomId], value = raw.plan[roomId], original = main[roomId]
    if (!facility || facility.level <= 0 || !['manufacture', 'trading'].includes(facility.type) || !record(value) || !record(original)) reject('ROOM', `不支持的覆盖房间：${roomId}`)
    if (!Array.isArray(value.plans) || !value.plans.length || value.plans.length !== facility.slots.length ||
      facility.slots.length !== facilityCapacity(facility.type, facility.level) || facility.slots.some(slot => slot.occupant.kind !== 'operator')) reject('CAPACITY', `变化房间的两个模式都必须保留全部明确岗位：${roomId}`)
    if (value.name !== original.name || !equal(extra(value, ['name', 'plans', 'product']), extra(original, ['name', 'plans', 'product']))) reject('METADATA', `不能改变设施类别、等级或保留字段：${roomId}`)
    const product = parseProduct(value.product)
    if (!product) reject('PRODUCT', `未知副表产物：${roomId}`)
    facility.product = product
    facility.slots = value.plans.map((entry, i) => slot(entry, facility.slots[i]!))
    if (equal(value, original)) reject('UNCHANGED', `副表不能重复未变化房间：${roomId}`)
  }
  const expected = nativePlan(on)
  for (const roomId of rooms) if (!equal(raw.plan[roomId], expected[roomId])) reject('CANONICAL', `副表必须使用原生导出的完整房间片段：${roomId}`)
  return [off, on, rooms]
}

const entries = (workspace: RosterWorkspace) => Object.values(workspace.mainPlan.facilities).filter(room => room.level > 0)
  .flatMap(room => room.slots.map((value, index) => ({ roomId: room.roomId, index, value })))
const slotActors = (value: MowerSlot) => [
  ...(value.occupant.kind === 'operator' ? [value.occupant.operatorId] : []), ...value.replacements,
  ...(value.groupBindings ?? []).flatMap(entry => entry.replacements),
].filter(name => name !== 'Free').map(id)
const slotGroups = (value: MowerSlot) => [value.groupId, ...(value.groupBindings ?? []).map(entry => entry.groupId)]
  .flatMap(group => group?.trim() ? [group.trim()] : [])

/** An overlay must not alter its own observation through shared actors or shift groups. */
function validateObservers(off: RosterWorkspace, on: RosterWorkspace, rooms: readonly string[], generated: GeneratedBackupDescriptor) {
  const all = [...entries(off), ...entries(on)], actors = new Set<string>(), groups = new Set<string>()
  const include = (value: MowerSlot) => { slotActors(value).forEach(actor => actors.add(actor)); slotGroups(value).forEach(group => groups.add(group)) }
  all.filter(entry => rooms.includes(entry.roomId)).forEach(entry => include(entry.value))
  let changed = true
  while (changed) {
    const size = actors.size + groups.size
    for (const entry of all) if (slotActors(entry.value).some(actor => actors.has(actor)) || slotGroups(entry.value).some(group => groups.has(group))) include(entry.value)
    changed = size !== actors.size + groups.size
  }
  for (const observer of generated.trigger.observers) {
    const observerId = id(observer.operatorId)
    if (actors.has(observerId)) reject('OBSERVER_DEPENDENCY', '观察者位于副表影响的主替或绑组闭包内')
    const primary = (workspace: RosterWorkspace) => entries(workspace).filter(entry => entry.value.occupant.kind === 'operator' && id(entry.value.occupant.operatorId) === observerId)
    const before = primary(off), after = primary(on)
    if (before.length !== 1 || after.length !== 1 || before[0]!.roomId !== observer.roomId || after[0]!.roomId !== observer.roomId ||
      before[0]!.index !== after[0]!.index || !equal(before[0]!.value, after[0]!.value)) reject('OBSERVER_POSITION', '观察者必须在两个模式中保持相同外部主班岗位')
  }
}

/** Admission for the finite generated family, not a proof that every native transition succeeds. */
export function validateGeneratedBackupCandidate(job: AdmissionJob): { valid: boolean; diagnostics: string[] } {
  try {
    const generated = descriptor(job.generatedBackup)
    const [off, on, rooms] = effectiveModes(job, generated)
    validateObservers(off, on, rooms, generated)
    if (!Array.isArray(job.options?.operatorInventory)) reject('INVENTORY_REQUIRED', '生成副表候选必须提供实际干员库')
    const inventory = compileOperatorInventory(job.options.operatorInventory)
    const diagnostics = inventory.diagnostics.map(issue => diagnostic('INVENTORY_INVALID', issue.message))
    const participants = new Set(backupParticipants(job.workspace))
    for (const [mode, workspace] of [['main', off], ['backup', on]] as const) {
      const validation = validateRosterWorkspace(workspace)
      diagnostics.push(...validation.criticalErrors.map(issue => diagnostic(issue.code, `${mode}：${issue.message}`)))
      diagnostics.push(...recoveryGroupCapacityIssues(workspace).map(issue => diagnostic(issue.code, `${mode}：${issue.message}`)))
      const schedule = compileRosterSchedule(workspace, job.assumptions)
      diagnostics.push(...schedule.diagnostics.filter(issue => issue.severity === 'error' || ['UNKNOWN_OPERATOR', 'UNKNOWN_POLICY'].includes(issue.code))
        .map(issue => diagnostic(issue.code, `${mode}：${issue.message}`)))
      const admission = validateScheduleInventory(schedule, inventory, job.options.efficiencyResources)
      diagnostics.push(...admission.diagnostics.map(issue => diagnostic(issue.code, issue.message)))
      entries(workspace).flatMap(entry => slotActors(entry.value)).forEach(actor => participants.add(actor))
      for (const field of MOWER_OPERATOR_LIST_FIELDS) readMowerOperatorList(field, workspace.mainPlan.conf[field]).forEach(actor => participants.add(id(actor)))
    }
    const owned = new Set(inventory.operators.map(operator => operator.charId))
    for (const participant of participants) if (!owned.has(participant)) diagnostics.push(diagnostic('INVENTORY_OPERATOR_NOT_OWNED', `${OPERATOR_MAP.get(participant)?.name ?? participant}：参与主表、副表或条件，但未录入干员库`))
    const unique = [...new Set(diagnostics)]
    return { valid: inventory.valid && unique.length === 0, diagnostics: unique }
  } catch (error) {
    return { valid: false, diagnostics: [error instanceof Error ? error.message : String(error)] }
  }
}
