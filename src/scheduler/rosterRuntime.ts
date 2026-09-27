import type { BackupTiming } from './backupPlans'
import { mowerReturnDelay, mowerRescueDelay } from './mowerTiming'
import { applyFiammetta, type FiammettaPolicy } from './fiammettaPolicy'
import type { RunOrderPolicy } from './types'

export { compiledScheduleToRuntimeConfig, scheduleToRuntimeConfig, isShiftRunOperator } from './scheduleAdapter'

export const MORALE_EPSILON = 1e-8
export interface RuntimePosition {
  id: string; roomId: string; primary: string; candidates: string[]; group?: string
  shiftOffThreshold?: number; lowerLimit?: number; upperLimit?: number; exhaustRequired?: boolean; restToFull?: boolean
  permanent?: boolean; dormitory?: boolean; restingPriority?: 'high' | 'low'
}
export interface RuntimeBed { id: string; roomId: string; vip: boolean }
export interface RuntimeConfig {
  positions: RuntimePosition[]; beds: RuntimeBed[]; initialMorale?: Record<string, number>
  fiammetta?: FiammettaPolicy; excludedCandidates?: string[]
  idleOperators?: string[]
  freeBlacklist?: string[]
  mowerPolicy?: { taskBuffers?: boolean; rescueThreshold?: number; restingThreshold: number; powerPlantCount: number; opeRestingPriority: string[] }
  runOrderPolicies?: RunOrderPolicy[]
}
export interface RuntimeEvent {
  time: number; type: 'shift-off' | 'shift-on' | 'fiammetta' | 'backup-plan' | 'backup-task'; operators: string[]
  backupIndex?: number; backupName?: string; active?: boolean; timing?: BackupTiming
  beds?: string[]; moraleBefore?: number[]; moraleAfter?: number[]
}
export interface RuntimeState {
  config: RuntimeConfig; time: number; occupants: Record<string, string>; morale: Record<string, number>
  bedOccupants: Record<string, string>; events: RuntimeEvent[]
  backupBedOccupants?: Set<string>
  pendingRest?: string[]
  nextPlanningTime?: number
  nextFiammettaCheckTime?: number
  returnDeadlines?: Record<string, number>; timingSignature?: string
  diagnostics: { code: string; message: string }[]; lastFiammettaTime: number
}
export interface RuntimeRates {
  workRate: (operatorId: string, roomId: string, state: RuntimeState) => number
  recoveryRate: (operatorId: string, roomId: string, state: RuntimeState) => number
  /** Additional skill morale boundaries; callers can split intervals at non-roster events too. */
  thresholds?: (operatorId: string, state: RuntimeState) => number[]
}
export function createRosterRuntime(config: RuntimeConfig): RuntimeState {
  const s: RuntimeState = { config: structuredClone(config), time: 0, occupants: {}, morale: {}, bedOccupants: {}, events: [], diagnostics: [], lastFiammettaTime: -Infinity }
  const ids = new Set<string>()
  for (const p of config.positions) {
    if (s.occupants[p.id] || Object.values(s.occupants).includes(p.primary)) throw new Error('Duplicate roster occupancy')
    s.occupants[p.id] = p.primary
    ids.add(p.primary); p.candidates.forEach(id => ids.add(id))
  }
  if (new Set(config.beds.map(b => b.id)).size !== config.beds.length) throw new Error('Duplicate bed')
  if (config.fiammetta) { ids.add(config.fiammetta.operatorId); config.fiammetta.orderedTargets.forEach(id => ids.add(id)) }
  config.idleOperators?.forEach(id => ids.add(id))
  config.runOrderPolicies?.forEach(policy => policy.orderedOperatorIds.forEach(id => ids.add(id)))
  for (const id of ids) {
    const m = config.initialMorale?.[id] ?? 24
    if (!Number.isFinite(m) || m < 0 || m > 24) throw new Error(`Invalid morale: ${id}`)
    s.morale[id] = m
  }
  if (config.mowerPolicy && config.beds.length && config.idleOperators === undefined) rosterDiagnostic(s,'idle-roster-unspecified','Mower fills Free beds from its owned idle roster; no idle roster supplied, so dorm population is conditional')
  return s
}
const lower = (p: RuntimePosition) => p.shiftOffThreshold ?? (p.exhaustRequired ? 0 : (p.lowerLimit ?? 0))
const upper = (p: RuntimePosition) => p.shiftOffThreshold !== undefined ? (p.upperLimit ?? 24) : p.restToFull ? 24 : (p.upperLimit ?? 24)
export function rosterDiagnostic(s: RuntimeState, code: string, message: string) {
  if (!s.diagnostics.some(d => d.code === code && d.message === message)) s.diagnostics.push({ code, message })
}
function freeBed(s: RuntimeState, p: RuntimePosition, occupied: Record<string, string>) {
  const ordered=[...s.config.beds].sort((a, b) => p.restingPriority === 'low' ? Number(a.vip) - Number(b.vip) : Number(b.vip) - Number(a.vip))
  return ordered.find(b => !occupied[b.id]) ?? (s.config.mowerPolicy ? ordered.find(b => !s.config.positions.some(p => p.primary === occupied[b.id])) : undefined)
}
/** Mower's ordinary replacement pass is ordered greedy reservation, without backtracking. */
export function nextCandidate(p: RuntimePosition, s: RuntimeState, reserved = new Set<string>(), activeBeds: Record<string, string> = s.bedOccupants) {
  return p.candidates.find(id => !s.config.excludedCandidates?.includes(id) && !reserved.has(id)
    && !Object.values(s.occupants).includes(id)
    && (s.config.mowerPolicy ? !s.config.positions.some(pos => pos.primary === id) : !Object.values(activeBeds).includes(id) && (s.morale[id] ?? 0) > lower(p) + MORALE_EPSILON))
}
function releaseRecoveredSubstitutes(s: RuntimeState): void {
  // Rested substitutes become available without occupying a work slot.
  for (const [bed, id] of Object.entries(s.bedOccupants)) {
    if (s.backupBedOccupants?.has(id)) continue
    if ((s.morale[id] ?? 0) >= 24 - MORALE_EPSILON && !s.config.positions.some(p => p.primary === id && s.occupants[p.id] !== id)) delete s.bedOccupants[bed]
  }
}
function shiftThreshold(p: RuntimePosition, s: RuntimeState, rates?: RuntimeRates): number {
  if (!p.exhaustRequired || !s.config.mowerPolicy?.taskBuffers || !rates) return s.config.mowerPolicy && !p.exhaustRequired ? Math.min(lower(p),upper(p)-2) : lower(p)
  // base_schedule.py:1467–1497; first refresh at lower+2, fallback lower+.25 minus 30 minutes.
  return (p.lowerLimit ?? 0) + Math.min(2, .25 + rates.workRate(p.primary,p.roomId,s) * .5)
}
/** Guard against empty recovery cycles using the operator's mood floor.
 * The planning threshold is not a minimum return mood: Mower returns groups
 * according to their high-priority rest deadlines, including low-priority peers.
 */
function minimumReturnMorale(p: RuntimePosition, s: RuntimeState, rates: RuntimeRates): number {
  if (p.restToFull) return upper(p)
  if ((p.roomId === 'factory' || p.roomId === 'train') && rates.workRate(p.primary, p.roomId, s) <= 0) return 0
  return Math.min(upper(p), (p.lowerLimit ?? 0) + 2)
}
export function settleRoster(s: RuntimeState, rates?: RuntimeRates, retryDepth = 0, onPhase?: (phase: BackupTiming) => boolean): void {
  if (retryDepth > 64) throw new Error('副表同刻调度无法稳定')
  if (s.config.mowerPolicy) s.nextPlanningTime = s.time + 2.5
  if (s.pendingRest?.length) {
    s.pendingRest = s.pendingRest.filter(id => {
      if (Object.values(s.occupants).includes(id) || Object.values(s.bedOccupants).includes(id)) return false
      const p = s.config.positions.find(p => p.primary === id)
      if (!p) return false
      const bed = freeBed(s, p, s.bedOccupants)
      if (!bed) return true
      s.bedOccupants[bed.id] = id
      return false
    })
  }
  const swapped = applyFiammetta(s)
  const fiaTarget = swapped ? s.events[s.events.length - 1]?.operators[1] : undefined
  // Resolve completed rest before testing candidate availability at this timestamp.
  releaseRecoveredSubstitutes(s)
  const groups = new Map<string, RuntimePosition[]>()
  for (const p of s.config.positions.filter(p => !p.dormitory && !p.permanent)) {
    const key = p.group ? `group:${p.group}` : `slot:${p.id}`
    groups.set(key, [...(groups.get(key) ?? []), p])
  }
  if (rates && s.config.mowerPolicy) updateMowerReturnDeadlines(s,rates)
  const orderedGroups = [...groups].sort((a, b) => s.config.mowerPolicy ? Number(b[1].every(p => s.occupants[p.id] !== p.primary))-Number(a[1].every(p => s.occupants[p.id] !== p.primary)) || Math.min(...a[1].map(p => s.morale[p.primary]! - (p.lowerLimit ?? 0))) - Math.min(...b[1].map(p => s.morale[p.primary]! - (p.lowerLimit ?? 0))) : 0)
  // Each group is evaluated once per timestamp: return cannot immediately trigger another shift.
  for (const [key, original] of orderedGroups) {
    const ps = s.config.mowerPolicy ? [...original].sort((a,b) => Number(!s.config.fiammetta?.orderedTargets.includes(a.primary)) - Number(!s.config.fiammetta?.orderedTargets.includes(b.primary)) || (s.morale[a.primary]! - (a.lowerLimit ?? 0)) - (s.morale[b.primary]! - (b.lowerLimit ?? 0))) : original
    const resting = ps.every(p => s.occupants[p.id] !== p.primary)
    const high = ps.filter(p => p.restingPriority !== 'low')
    const returnMembers = high.length ? high : ps
    const fullMembers = returnMembers.filter(p => p.restToFull)
    const recovered = (p: RuntimePosition) => (s.morale[p.primary] ?? 0) >= upper(p) - MORALE_EPSILON
    const fiaReturn = Boolean(s.config.mowerPolicy && fiaTarget && ps.some(p => p.primary === fiaTarget))
    const deadline = s.returnDeadlines?.[key]
    const usefulRecovery = !s.config.mowerPolicy || !rates || ps.every(p => (s.morale[p.primary] ?? 0) >= minimumReturnMorale(p, s, rates) - MORALE_EPSILON)
    const ready = usefulRecovery && (fiaReturn || (s.config.mowerPolicy && deadline !== undefined ? s.time >= deadline - MORALE_EPSILON : s.config.mowerPolicy ? (fullMembers.length ? fullMembers.every(recovered) : returnMembers.some(recovered)) : ps.every(recovered)))
    if (resting && ready) {
      const covers = ps.map(p => s.occupants[p.id]!)
      for (const p of ps) {
        for (const [bed, id] of Object.entries(s.bedOccupants)) if (id === p.primary) delete s.bedOccupants[bed]
        for (const [slot, id] of Object.entries(s.occupants)) if (id === p.primary && slot !== p.id) delete s.occupants[slot]
        s.occupants[p.id] = p.primary
      }
      covers.forEach((id, i) => {
        if (id && (s.morale[id] ?? 24) < 24 - MORALE_EPSILON) {
          const bed = freeBed(s, { ...ps[i]!, restingPriority: 'low' }, s.bedOccupants)
          if (bed) s.bedOccupants[bed.id] = id
        }
      })
      if (s.returnDeadlines) delete s.returnDeadlines[key]
      s.events.push({ time: s.time, type: 'shift-on', operators: ps.map(p => p.primary) })
      if (onPhase?.('AFTER_PLANNING')) { settleRoster(s, rates, retryDepth + 1, onPhase); return }
      continue
    }
    if (s.config.mowerPolicy && s.events.some(e => e.time === s.time && e.type === 'shift-on' && e.operators.some(id => ps.some(p => p.primary === id)))) continue
    if (resting || !ps.some(p => (s.morale[p.primary] ?? 0) <= shiftThreshold(p,s,rates) + MORALE_EPSILON && (p.exhaustRequired || !s.config.mowerPolicy || upper(p)-(s.morale[p.primary] ?? 0) >= 2-MORALE_EPSILON))) continue
    if (s.config.mowerPolicy && !ps.some(p => p.exhaustRequired)) {
      const workers=s.config.positions.filter(p => !p.dormitory && !p.permanent && s.occupants[p.id] === p.primary)
      const total=workers.reduce((n,p)=>n+upper(p)-(p.lowerLimit ?? 0),0)
      const average=total ? workers.reduce((n,p)=>n+s.morale[p.primary]!-(p.lowerLimit ?? 0),0)/total : 0
      const ideal=average>s.config.mowerPolicy.restingThreshold*(s.config.mowerPolicy.rescueThreshold ?? .75) ? 4 : s.config.beds.length
      const primaryResting=Object.values(s.bedOccupants).filter(id=>s.config.positions.some(p=>p.primary===id))
      const highCount=primaryResting.filter(id=>s.config.positions.some(p=>p.primary===id && p.restingPriority !== 'low')).length
      if (primaryResting.length >= ideal && highCount >= s.config.beds.filter(b=>b.vip).length) continue
    }
    const reserved = new Set<string>(); const beds = { ...s.bedOccupants }; const swaps: { p: RuntimePosition; candidate: string; bed: string }[] = []
    for (const p of ps) {
      const existingBed = s.config.beds.find(b => beds[b.id] === p.primary)
      const current = s.occupants[p.id]
      const candidate = existingBed && current && p.candidates.includes(current) && !reserved.has(current) ? current : nextCandidate(p, s, reserved, beds)
      if (candidate && s.config.mowerPolicy) for (const [bedId, occupant] of Object.entries(beds)) if (occupant === candidate) delete beds[bedId]
      const bed = existingBed ?? freeBed(s, p, beds)
      const allowEmpty = p.candidates.length === 0 && (p.exhaustRequired || !p.group)
      if ((!candidate && !allowEmpty) || !bed) break
      if (candidate) reserved.add(candidate)
      beds[bed.id] = p.primary; swaps.push({ p, candidate: candidate ?? '', bed: bed.id })
    }
    if (swaps.length !== ps.length && s.config.mowerPolicy && ps.some(p => p.exhaustRequired) && retryDepth < s.config.positions.length && preemptMowerRest(s,ps.length,rates)) { settleRoster(s,rates,retryDepth+1,onPhase); return }
    if (swaps.length !== ps.length) { rosterDiagnostic(s, 'group-blocked', `${key}: insufficient available candidates or beds; original occupants retained`); continue }
    s.bedOccupants = beds
    for (const { p, candidate } of swaps) s.occupants[p.id] = candidate
    s.events.push({ time: s.time, type: 'shift-off', operators: ps.map(p => p.primary), beds: swaps.map(x => x.bed) })
    if (onPhase?.('BEFORE_PLANNING')) { settleRoster(s, rates, retryDepth + 1, onPhase); return }
  }
  releaseRecoveredSubstitutes(s)
  if (s.config.mowerPolicy) {
    fillIdleBeds(s)
    reorderMowerBeds(s)
    if (rates) updateMowerReturnDeadlines(s, rates)
  }
}

/** Exhaustion fallback: return highest-morale resting groups, except exhausted/full protected groups. */
function preemptMowerRest(s: RuntimeState, required: number, rates?: RuntimeRates): boolean {
  const free = () => s.config.beds.filter(b => !s.bedOccupants[b.id] || !s.config.positions.some(p => p.primary === s.bedOccupants[b.id])).length
  if (free() >= required) return false
  const selected: RuntimePosition[][]=[]; const seen=new Set<string>()
  let available=free()
  const occupants=Object.values(s.bedOccupants).sort((a,b) => s.morale[b]!-s.morale[a]!)
  for (const id of occupants) {
    const p=s.config.positions.find(p => p.primary === id && s.occupants[p.id] !== id)
    if (!p) continue
    const key=p.group ?? p.id
    if (seen.has(key)) continue
    seen.add(key)
    const group=s.config.positions.filter(q => !q.permanent && !q.dormitory && (p.group ? q.group===p.group : q.id===p.id))
    if (group.some(q=>q.exhaustRequired) && group.some(q=>q.restToFull)) continue
    // Emergency bed release is also a return-to-work action. It cannot bypass recovery.
    if (group.some(q => s.occupants[q.id] === q.primary ||
      (s.morale[q.primary] ?? 0) < (rates ? minimumReturnMorale(q,s,rates) : upper(q)) - MORALE_EPSILON)) continue
    selected.push(group);available+=group.filter(q=>Object.values(s.bedOccupants).includes(q.primary)).length
    if (available>=required) break
  }
  if (available<required) return false
  for (const group of selected) {
    for (const p of group) {
      for (const [bed,id] of Object.entries(s.bedOccupants)) if (id===p.primary) delete s.bedOccupants[bed]
      s.occupants[p.id]=p.primary
      if (s.returnDeadlines) delete s.returnDeadlines[p.group ? `group:${p.group}` : `slot:${p.id}`]
    }
    s.events.push({time:s.time,type:'shift-on',operators:group.map(p=>p.primary)})
  }
  return true
}
function fillIdleBeds(s: RuntimeState): void {
  const pool = [...new Set([...s.config.positions.flatMap(p=>p.candidates),...(s.config.runOrderPolicies?.flatMap(p=>p.orderedOperatorIds) ?? []),...(s.config.idleOperators ?? [])])]
  const available = pool.filter(id => !s.config.freeBlacklist?.includes(id) && !s.config.positions.some(p => p.primary === id) && !Object.values(s.occupants).includes(id) && !Object.values(s.bedOccupants).includes(id) && (s.morale[id] ?? 24) < 24 - MORALE_EPSILON).sort((a,b) => s.morale[a]! - s.morale[b]!)
  for (const bed of s.config.beds) if (!s.bedOccupants[bed.id] && available.length) s.bedOccupants[bed.id] = available.shift()!
}
/** Mower try_reorder: explicit list, then high/normal primaries, then substitutes. */
function reorderMowerBeds(s: RuntimeState): void {
  const policy = s.config.mowerPolicy!
  const beds = [...s.config.beds].sort((a,b) => Number(b.vip)-Number(a.vip))
  const rank = (id: string) => {
    const explicit = policy.opeRestingPriority.indexOf(id)
    if (explicit >= 0) return explicit
    const p = s.config.positions.find(p => p.primary === id)
    return policy.opeRestingPriority.length + (p ? p.restingPriority === 'low' ? 1 : 0 : 2)
  }
  const occupants = beds.map(b => s.bedOccupants[b.id]).filter((id): id is string => Boolean(id)).sort((a,b) => rank(a)-rank(b))
  s.bedOccupants = Object.fromEntries(occupants.map((id,i) => [beds[i]!.id,id]))
}
function updateMowerReturnDeadlines(s: RuntimeState, rates: RuntimeRates): void {
  const signature = JSON.stringify([s.occupants,s.bedOccupants,Object.keys(s.morale).map(id => moraleDerivative(s,id,rates))])
  if (signature === s.timingSignature) return
  s.timingSignature = signature
  const workers = s.config.positions.filter(p => !p.dormitory && s.occupants[p.id] === p.primary)
  const rescue = mowerRescueDelay(workers.map(p => ({ morale:s.morale[p.primary]!, lower:p.lowerLimit ?? 0, rate:rates.workRate(p.primary,p.roomId,s), ignore:p.permanent || p.exhaustRequired || p.roomId === 'factory' || p.roomId === 'train' })))
  const grouped = new Map<string, RuntimePosition[]>()
  // Stable bed order reproduces grouped_dorms insertion order.
  for (const bed of [...s.config.beds].sort((a,b) => Number(b.vip)-Number(a.vip))) {
    const id = s.bedOccupants[bed.id]
    const p = s.config.positions.find(p => !p.dormitory && !p.permanent && p.primary === id && s.occupants[p.id] !== id)
    if (p) { const key=p.group ? `group:${p.group}` : `slot:${p.id}`; grouped.set(key,[...(grouped.get(key) ?? []),p]) }
  }
  const deadlines: Record<string,number> = {}
  for (const [key,bedMembers] of grouped) {
    const firstMember = bedMembers[0]!
    const ps = s.config.positions.filter(p => !p.dormitory && !p.permanent && (firstMember.group ? p.group === firstMember.group : p.id === firstMember.id))
    // Partial groups can occur after explicit backup tasks. Replan them normally;
    // a return deadline is valid only when the entire group is off its main posts.
    if (ps.some(p => s.occupants[p.id] === p.primary)) continue
    // scheduler_task.py retains grouped_dorms order when selecting high_dorms.
    // Main-plan order changes which member controls the mismatch deadline.
    const high=bedMembers.filter(p => p.restingPriority !== 'low'); const members=high.length ? high : bedMembers
    const values=members.map(p => { const rate=moraleDerivative(s,p.primary,rates); return {hours:rate>0 ? Math.max(0,(upper(p)-s.morale[p.primary]!)/rate) : Infinity,full:p.restToFull} })
    let delay=mowerReturnDelay(values,s.config.mowerPolicy!.powerPlantCount,rescue)
    if (s.config.mowerPolicy!.taskBuffers) {
      const first=members[0]!
      const full=members.some(p => p.restToFull)
      const mismatch=members.length>1 && values.some(v => values[0]!.hours-v.hours > (s.config.mowerPolicy!.powerPlantCount === 2 ? 1.5 : 1))
      if (first.group && (full || mismatch) && !first.exhaustRequired) delay -= .4*members.length/60
      if (full && !members.some(p => p.exhaustRequired)) delay -= 8/60
    }
    // A full-morale passive pendant must not send exhausted peers straight back to work.
    // Apply after operation buffers, which otherwise repeatedly schedule returns before recovery.
    const usefulRecoveryDelay = Math.max(0, ...ps.map(p => {
      const deficit = minimumReturnMorale(p, s, rates) - (s.morale[p.primary] ?? 0)
      if (deficit <= MORALE_EPSILON) return 0
      const rate = moraleDerivative(s, p.primary, rates)
      return rate > 0 ? deficit / rate : Infinity
    }))
    deadlines[key]=s.time+Math.max(0,delay,usefulRecoveryDelay)
  }
  s.returnDeadlines=deadlines
}

export function moraleDerivative(s: RuntimeState, id: string, rates: RuntimeRates): number {
  const p = s.config.positions.find(p => s.occupants[p.id] === id)
  const bed = s.config.beds.find(b => s.bedOccupants[b.id] === id)
  if (id === s.config.fiammetta?.operatorId && (p?.dormitory || bed)) return 2
  const rate = bed ? rates.recoveryRate(id, bed.roomId, s) : p ? (p.dormitory ? rates.recoveryRate(id, p.roomId, s) : -rates.workRate(id, p.roomId, s)) : 0
  if (!Number.isFinite(rate)) throw new Error(`Non-finite morale rate: ${id}`)
  return rate
}
/** Planning events only. Skill boundaries and a substitute reaching 24 do not run Mower's planner. */
export function nextRosterActionHours(s: RuntimeState, rates: RuntimeRates): number {
  if (!s.config.mowerPolicy) return nextRosterEventHours(s,rates)
  updateMowerReturnDeadlines(s,rates)
  const deadlines=[s.nextPlanningTime ?? Infinity,s.nextFiammettaCheckTime ?? Infinity,...Object.values(s.returnDeadlines ?? {})]
  if (deadlines.some(t=>Number.isFinite(t) && t<=s.time+MORALE_EPSILON)) return 0
  let next=Math.min(Infinity,...deadlines.map(t=>t-s.time))
  for (const p of s.config.positions) {
    if (p.dormitory || p.permanent || s.occupants[p.id]!==p.primary) continue
    const rate=moraleDerivative(s,p.primary,rates)
    if (rate>=0) continue
    const t=(shiftThreshold(p,s,rates)-s.morale[p.primary]!)/rate
    if (t>MORALE_EPSILON) next=Math.min(next,t)
  }
  const fia=s.config.fiammetta?.operatorId
  if (fia) { const rate=moraleDerivative(s,fia,rates);const t=(24-(s.morale[fia] ?? 24))/rate;if (rate>0 && t>MORALE_EPSILON) next=Math.min(next,t) }
  return next
}
export function nextRosterEventHours(s: RuntimeState, rates: RuntimeRates, includePlanning = true): number {
  if (includePlanning && s.config.mowerPolicy) updateMowerReturnDeadlines(s,rates)
  let next = includePlanning ? Math.min(s.config.mowerPolicy ? nextRosterActionHours(s,rates) : Infinity,...[s.nextPlanningTime ?? Infinity,s.nextFiammettaCheckTime ?? Infinity,...Object.values(s.returnDeadlines ?? {})].map(t => t-s.time).filter(t => t > MORALE_EPSILON)) : Infinity
  for (const [id, m] of Object.entries(s.morale)) {
    const rate = moraleDerivative(s, id, rates)
    if (!rate) continue
    const p = s.config.positions.find(p => p.primary === id)
    const thresholds = [0, 24, ...(p ? [shiftThreshold(p,s,rates), upper(p)] : []), ...(rates.thresholds?.(id, s) ?? [])]
    if (s.config.fiammetta?.orderedTargets.includes(id)) thresholds.push(s.config.fiammetta.threshold ?? 21.6)
    for (const threshold of thresholds) {
      const t = (threshold - m) / rate
      if (t > MORALE_EPSILON && t < next) next = t
    }
  }
  return next
}
export function advanceRoster(s: RuntimeState, hours: number, rates: RuntimeRates): void {
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('Roster advance must be finite and positive')
  const derivatives = Object.fromEntries(Object.keys(s.morale).map(id => [id, moraleDerivative(s, id, rates)]))
  for (const id of Object.keys(s.morale)) {
    const value = Math.max(0, Math.min(24, s.morale[id]! + derivatives[id]! * hours))
    // Canonical physical endpoints prevent roundoff from changing full-rest pools
    // and same-time return ordering. Do not snap internal skill thresholds.
    s.morale[id] = value <= MORALE_EPSILON ? 0 : value >= 24 - MORALE_EPSILON ? 24 : value
  }
  s.time += hours
}
