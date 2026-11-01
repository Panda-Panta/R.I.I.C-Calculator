import type {RuntimeState,RuntimeRates,RuntimePosition,RuntimeBed} from './rosterRuntime'

/** Physical morale comparisons; native task ordering keeps its separate microsecond clock. */
export const MORALE_EPSILON = 1e-8
export const lower = (p: RuntimePosition) => p.shiftOffThreshold ?? (p.exhaustRequired ? 0 : (p.lowerLimit ?? 0))
export const upper = (p: RuntimePosition) => p.shiftOffThreshold !== undefined ? (p.upperLimit ?? 24) : p.restToFull ? 24 : (p.upperLimit ?? 24)
export function shiftThreshold(p: RuntimePosition, s: RuntimeState, rates?: RuntimeRates): number {
  if (!p.exhaustRequired || !s.config.mowerPolicy?.taskBuffers || !rates) return s.config.mowerPolicy && !p.exhaustRequired ? Math.min(lower(p),upper(p)-2) : lower(p)
  // base_schedule.py:1467–1497; first refresh at lower+2, fallback lower+.25 minus 30 minutes.
  return (p.lowerLimit ?? 0) + Math.min(2, .25 + rates.workRate(p.primary,p.roomId,s) * .5)
}

// Switching a backup changes the slot's planned role without moving its resident.
// Keep reading that actual dorm resident from either physical occupancy map.
const positionOccupant=(s:RuntimeState,p:RuntimePosition)=>s.occupants[p.id]??(p.dormitory?s.bedOccupants[p.id]:undefined)
const bedOccupant=(s:RuntimeState,bed:RuntimeBed)=>s.bedOccupants[bed.id]??s.occupants[bed.id]
function placedMoraleDerivative(s:RuntimeState,id:string,rates:RuntimeRates,p?:RuntimePosition,bed?:RuntimeBed,snapshot?:ReturnType<NonNullable<RuntimeRates['snapshotRates']>>):number {
  if (id === s.config.fiammetta?.operatorId && (p?.dormitory || bed)) return 2
  const recovery=(room:string)=>snapshot?(snapshot.recovery[id]??0):rates.recoveryRate(id,room,s)
  const work=(room:string)=>snapshot?(snapshot.work[id]??0):rates.workRate(id,room,s)
  const rate = bed ? recovery(bed.roomId) : p ? (p.dormitory ? recovery(p.roomId) : -work(p.roomId)) : 0
  if (!Number.isFinite(rate)) throw new Error(`Non-finite morale rate: ${id}`)
  return rate
}
export function moraleDerivative(s: RuntimeState, id: string, rates: RuntimeRates): number {
  const p = s.config.positions.find(p => positionOccupant(s,p) === id)
  const bed = s.config.beds.find(b => bedOccupant(s,b) === id)
  return placedMoraleDerivative(s,id,rates,p,bed)
}
/** Index the current physical roster once for a whole rate sweep. */
export function moraleRateSnapshot(s:RuntimeState,rates:RuntimeRates):{derivatives:Record<string,number>;primary:Map<string,RuntimePosition>} {
 const occupied=new Map<string,RuntimePosition>(),beds=new Map<string,RuntimeBed>(),primary=new Map<string,RuntimePosition>()
 for(const p of s.config.positions){
  const id=positionOccupant(s,p)
  if(id&&!occupied.has(id))occupied.set(id,p)
  if(!primary.has(p.primary))primary.set(p.primary,p)
 }
 for(const bed of s.config.beds){const id=bedOccupant(s,bed);if(id&&!beds.has(id))beds.set(id,bed)}
 const rateSnapshot=rates.snapshotRates?.()
 const derivatives:Record<string,number>={}
 for(const id of Object.keys(s.morale))derivatives[id]=placedMoraleDerivative(s,id,rates,occupied.get(id),beds.get(id),rateSnapshot)
 return {derivatives,primary}
}
export function currentMoraleDerivatives(s:RuntimeState,rates:RuntimeRates):Record<string,number>{return moraleRateSnapshot(s,rates).derivatives}

/** Physical morale and skill boundaries, independent of planner/task execution. */
export function nextRosterMoraleEventHours(s: RuntimeState, rates: RuntimeRates, next = Infinity, preparedDerivatives?:Readonly<Record<string,number>>): number {
  const primary=new Map<string,RuntimePosition>()
  if(preparedDerivatives)for(const p of s.config.positions)if(!primary.has(p.primary))primary.set(p.primary,p)
  const snapshot=preparedDerivatives?{derivatives:preparedDerivatives,primary}:moraleRateSnapshot(s,rates)
  for (const [id, m] of Object.entries(s.morale)) {
    const rate = snapshot.derivatives[id]!
    if (!rate) continue
    const p = snapshot.primary.get(id)
    const thresholds = [0, 24, ...(p ? [shiftThreshold(p,s,rates), upper(p)] : []), ...(rates.thresholds?.(id, s) ?? [])]
    if (s.config.fiammetta?.orderedTargets.includes(id)) thresholds.push(s.config.fiammetta.threshold ?? 21.6)
    for (const threshold of thresholds) {
      const t = (threshold - m) / rate
      if (t > MORALE_EPSILON && t < next) next = t
    }
  }
  return next
}
