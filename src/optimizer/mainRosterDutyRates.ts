import { hasOperatorSkill, inventoryOperatorRecords, runOrderSkillRank } from '../domain/operatorContext'
import type { OperatorInventory } from '../domain/operatorInventory'
import { resolveOperatorCharId as id } from '../domain/operatorIdentifiers'
import { isTradeRunOrderOperator } from '../domain/shiftRunPolicy'
import type { AppConfig, OutputRoom } from '../domain/types'
import { buildRiicGlobalContext } from '../engine/globalContext'
import { evaluateOperators } from '../engine/operatorRules'
import { captureOrder, getOrderDistribution, type OrderMode, type SpecialCapture } from '../rules/orderRules'
import { virtualGoldEquivalent } from '../rules/orderValue'
import { MANUFACTURING_FORMULAS } from '../simulator/manufacturingTimeline'
import { projectControlOutput } from './controlImpact'
import { DUTY_RESOURCE_KEYS, type DutyResourceKey, type DutyResourceRates, type MainRosterDutyRateInput, type MainRosterDutyRateResult } from './mainRosterDutyTypes'

const assumptions = [
  'Continuous potential resource units per hour, with infinite materials, timely collection, no capacity stoppage and no drones; not net inventory income.',
  'Manufacturing uses the caller joint-state actual efficiency, including session warmup. A missing TimeContext is never replaced by a theoretical-cap efficiency.',
  'Trading is current-team renewal expectation E[reward]/E[duration], not E[reward/duration]. It omits unfinished-order memory across phases / 跨阶段未完成订单记忆.',
  'Configured ideal references use actual owned skills: Pepe/Closure lock acquisition mode; U-Official, Proviso and level-three Tequila convert ordinary completions without moving physical occupants.',
  'Continuous renewal output is not a single-seed random completed-order result; exact scheduling, phase boundaries and order snapshots need separate validation.',
  'Resource rates are unweighted; shared production weights apply once after integrating joint phases. Virtual gold is report-only and separate from physical gold.',
]
const freshRates = (value: number | null): DutyResourceRates => ({ exp: value, gold: value, orderLmd: value, virtualGold: value, fragments: value, orundum: value })
const outputs = (room: OutputRoom): DutyResourceKey[] => room.type === 'manufacture'
  ? room.product === 'exp' ? ['exp'] : room.product === 'fragment' ? ['fragments'] : ['gold']
  : room.strategy === 'orundum' ? ['orundum'] : ['orderLmd', 'virtualGold']
const actors = (config: AppConfig) => [...new Set([
  ...config.rooms.flatMap(room => room.operatorIds), ...config.controlOperatorIds,
  ...config.facilityOperatorIds.dormitories.flat(), ...config.facilityOperatorIds.reception, ...config.facilityOperatorIds.workshop,
  ...config.facilityOperatorIds.office, ...config.facilityOperatorIds.training, ...(config.facilityOperatorIds.recycle ?? []),
  ...config.efficiencyResources.extraWorkplaceOperatorIds, ...config.efficiencyResources.trainingOperatorIds,
].map(id))]

type DutyRateState = Omit<MainRosterDutyRateInput, 'inventory'>
interface RateInventory { inventory: OperatorInventory; records: ReturnType<typeof inventoryOperatorRecords>; owned: ReadonlySet<string> }

/** Policies are virtual references, independent of physical ownership/occupancy checks. */
function idealPolicies(input: DutyRateState, context: RateInventory): { byRoom: Map<string, string[]>; issue?: string } {
  const byRoom = new Map<string, string[]>()
  const invalid = (issue: string) => ({ byRoom, issue: 'Invalid ideal order policy / 策略: ' + issue })
  if (input.runOrderPolicies !== undefined && !Array.isArray(input.runOrderPolicies)) return invalid('policy list is not an array')
  for (const policy of input.runOrderPolicies ?? []) {
    if (!policy || typeof policy.roomId !== 'string' || !input.config.rooms.some(room => room.id === policy.roomId && room.type === 'trading')) return invalid('referenced trading room is absent')
    if (byRoom.has(policy.roomId)) return invalid('duplicate trading-room policy')
    if (!Array.isArray(policy.orderedOperatorIds) || policy.orderedOperatorIds.some((operator: unknown) => typeof operator !== 'string' || !operator.trim())) return invalid('ordered references are not an operator list')
    const references: string[] = policy.orderedOperatorIds.map((operator: string) => id(operator))
    if (new Set(references).size !== references.length) return invalid('duplicate ideal reference')
    if (references.some(operator => !context.owned.has(operator) || !isTradeRunOrderOperator(operator))) return invalid('unknown, unowned or unsupported ideal operator')
    byRoom.set(policy.roomId, references)
  }
  return { byRoom }
}

function physicalCapture(config: AppConfig, room: OutputRoom, active: ReadonlySet<string>): SpecialCapture {
  const rank = (kind: 'proviso' | 'tequila'): 0 | 1 | 2 => {
    let maximum: 0 | 1 | 2 = 0
    for (const operator of room.operatorIds) if (active.has(operator)) {
      const value = runOrderSkillRank(config, operator, kind)
      if (value > maximum) maximum = value
    }
    return maximum
  }
  const skill = (buff: string) => room.operatorIds.some(operator => active.has(operator) && hasOperatorSkill(config, operator, buff))
  const capture: SpecialCapture = { proviso: rank('proviso'), tequila: room.level === 3 ? rank('tequila') : 0,
    uOfficial: skill('trade_ord_spd&wt[000]'), closure: skill('trade_ord_closure[000]'), pepe: skill('trade_ord_pepe[000]') }
  // Preserve explicit standalone AppConfig defaults only when no physical
  // special skill applies. Native trace configs use specialOrder='none'.
  if (!capture.proviso && !capture.tequila && !capture.uOfficial && !capture.closure && !capture.pepe) {
    switch (room.specialOrder) {
      case 'provisoAlpha': capture.proviso = 1; break
      case 'provisoBeta': capture.proviso = 2; break
      case 'tequilaAlpha': capture.tequila = room.level === 3 ? 1 : 0; break
      case 'tequilaBeta': capture.tequila = room.level === 3 ? 2 : 0; break
      case 'uofficial': capture.uOfficial = true; break
      case 'closure': capture.closure = true; break
      case 'pepe': capture.pepe = true; break
    }
  }
  return capture
}

/** Same-state renewal quote, not an order calendar or a sampled completed-order label. */
function tradeRates(config: AppConfig, room: OutputRoom, efficiency: number, references: readonly string[], input: DutyRateState): Record<'orderLmd' | 'virtualGold' | 'orundum', number> {
  const present = actors(config), active = new Set(present.filter(operator => !config.zeroMoraleOperatorIds.includes(operator) && (config.operatorMorale[operator] ?? 24) > 0))
  const morale = new Map(present.map(operator => [operator, config.zeroMoraleOperatorIds.includes(operator) ? 0 : config.operatorMorale[operator] ?? 24]))
  const context = buildRiicGlobalContext(config, active, morale)
  const evaluation = evaluateOperators(room, config, active, morale, context, input.timeContext)
  const capture = physicalCapture(config, room, active)
  if (room.strategy !== 'orundum') for (const operator of references) {
    // Native acquisition reads these actual skills even though the policy
    // operator is only a reference and is not inserted into this room.
    if (hasOperatorSkill(config, operator, 'trade_ord_pepe[000]')) capture.pepe = true
    if (hasOperatorSkill(config, operator, 'trade_ord_closure[000]')) capture.closure = true
  }
  const mode: OrderMode = room.strategy === 'orundum' ? 'orundum' : capture.pepe ? 'pepe' : capture.closure ? 'closure' : 'gold'
  if (mode === 'gold') for (const operator of references) {
    const name = config.operatorRecords![operator]!.name
    if (name !== '但书' && !(room.level === 3 && name === '龙舌兰') && name !== 'U-Official') continue
    capture.uOfficial ||= hasOperatorSkill(config, operator, 'trade_ord_spd&wt[000]')
    const proviso = runOrderSkillRank(config, operator, 'proviso'), tequila = runOrderSkillRank(config, operator, 'tequila')
    if (proviso > (capture.proviso ?? 0)) capture.proviso = proviso
    if (tequila > (capture.tequila ?? 0)) capture.tequila = tequila
  }
  // Completion keeps the acquisition mode. A single specialOrder enum would
  // incorrectly drop Tequila's four-gold branch when Proviso is also available.
  capture.pepe = mode === 'pepe'; capture.closure = mode === 'closure'
  const distribution = getOrderDistribution(room.level, evaluation.quality, mode)
  let minutes = 0, reward = 0, premium = 0, orundum = 0
  for (const base of distribution) {
    const order = captureOrder(base, capture, 0)
    minutes += base.probability * base.baseMinutes / (base.efficiencyAffected ? efficiency / 100 : 1)
    reward += base.probability * order.lmdReward
    premium += base.probability * virtualGoldEquivalent(order)
    orundum += base.probability * order.orundumReward
  }
  return { orderLmd: minutes === Infinity ? 0 : 60 * reward / minutes,
    virtualGold: minutes === Infinity ? 0 : 60 * premium / minutes,
    orundum: minutes === Infinity ? 0 : 60 * orundum / minutes }
}

function projectRates(input: DutyRateState, context: RateInventory): MainRosterDutyRateResult {
  const rates = freshRates(0), diagnostics: string[] = []
  const unknown = (keys: readonly DutyResourceKey[], code: string, message: string) => {
    keys.forEach(key => { rates[key] = null }); diagnostics.push(`[${code}] ${message}`)
  }
  const finish = (): MainRosterDutyRateResult => ({ status: DUTY_RESOURCE_KEYS.every(key => rates[key] !== null) ? 'quantified' : 'unquantified',
    rates, diagnostics: [...new Set(diagnostics)], assumptions: [...assumptions] })
  const add = (key: DutyResourceKey, value: number) => {
    if (!Number.isFinite(value) || value < 0) unknown([key], 'DUTY_RATE_NONFINITE', `Cannot quantify ${key} resource rate.`)
    else if (rates[key] !== null) {
      const total = rates[key] + value
      if (!Number.isFinite(total)) unknown([key], 'DUTY_RATE_NONFINITE', `Cannot quantify the ${key} resource sum.`)
      else rates[key] = total
    }
  }
  if (input.outputMode !== 'potential' || input.inventoryMode !== 'infinite' || input.droneTarget !== 'none') {
    unknown(DUTY_RESOURCE_KEYS, 'DUTY_RATE_UNSUPPORTED_MODE', 'v1 requires potential output, infinite materials and no drones.'); return finish()
  }
  if (!context.inventory.valid) {
    unknown(DUTY_RESOURCE_KEYS, 'DUTY_RATE_INVALID_INVENTORY', context.inventory.diagnostics.map(issue => issue.message).join('; ') || 'Actual inventory is invalid.'); return finish()
  }
  const missing = actors(input.config).filter(operator => !context.owned.has(operator))
  if (missing.length) {
    unknown(DUTY_RESOURCE_KEYS, 'DUTY_RATE_UNOWNED_PRESENCE', `Actual joint-state presence has no owned skill record: ${missing.join(', ')}`); return finish()
  }
  try {
    // Old per-config records may contain all 432 catalog entries. They are not
    // part of the changing physical frame and must not be deep-cloned per phase.
    const config: AppConfig = structuredClone({ ...input.config, operatorRecords: undefined })
    config.operatorRecords = context.records
    // The shared projector also calculates a score; neutralize that unused field,
    // so these raw units never depend on scoring weights or overflow their score.
    config.productionWeights = { exp: 0, gold: 0, orders: 0, fragments: 0, orundum: 0 }
    const rooms = config.rooms.filter(room => room.type === 'manufacture' || room.type === 'trading')
    const policies = idealPolicies(input, context)
    if (policies.issue) unknown(['orderLmd', 'virtualGold', 'orundum'], 'DUTY_RATE_IDEAL_POLICY_INVALID', policies.issue)
    const projection = projectControlOutput(config, { timeContext: input.timeContext, selectedRoomIds: rooms.map(room => room.id) })
    const attributed = new Set(projection.rooms.flatMap(room => room.diagnostics))
    const globalIssues = projection.diagnostics.filter(issue => !attributed.has(issue))
    if (globalIssues.length) unknown(DUTY_RESOURCE_KEYS, 'DUTY_RATE_GLOBAL_UNQUANTIFIED', globalIssues.join('; '))
    for (const room of rooms) {
      const keys = outputs(room), snapshot = projection.rooms.find(value => value.roomId === room.id)
      if (!snapshot || snapshot.diagnostics.length) {
        unknown(keys, 'DUTY_RATE_ROOM_UNQUANTIFIED', `${room.id}: ${snapshot?.diagnostics.join('; ') ?? 'shared projection is absent'}`); continue
      }
      const efficiency = input.efficiencyPercentByRoom[room.id]
      if (typeof efficiency !== 'number' || !Number.isFinite(efficiency) || efficiency < 0) {
        unknown(keys, 'DUTY_RATE_ACTUAL_EFFICIENCY_REQUIRED', `${room.id}: actual efficiency / 效率 is absent or invalid.`); continue
      }
      if (room.type === 'manufacture') {
        const formula = MANUFACTURING_FORMULAS[room.product === 'exp' ? 'exp-medium' : room.product === 'fragment' ? 'fragment-orirock' : 'gold']
        // Shared recipe constants give exact continuous items per base work-hour.
        // Actual total efficiency is authoritative even if the snapshot used a cap
        // or had zero efficiency. No warmup age or worker occupancy is invented.
        const items = 60 * (efficiency / 100) / formula.baseMinutes * formula.batchSize
        add(room.product === 'exp' ? 'exp' : room.product === 'fragment' ? 'fragments' : 'gold', room.product === 'exp' ? items * 1000 : items)
      } else {
        if (policies.issue) continue
        if (!Number.isFinite(snapshot.efficiencyPercent) || Math.abs(efficiency - snapshot.efficiencyPercent) > 1e-7) {
          unknown(keys, 'DUTY_RATE_TRADE_EFFICIENCY_MISMATCH', `${room.id}: actual efficiency ${efficiency} differs from shared renewal efficiency ${snapshot.efficiencyPercent}; no blanket multiplier is applied.`); continue
        }
        const quote = tradeRates(config, room, efficiency, policies.byRoom.get(room.id) ?? [], input)
        add('orderLmd', quote.orderLmd); add('virtualGold', quote.virtualGold); add('orundum', quote.orundum)
      }
    }
  } catch (error) {
    unknown(DUTY_RESOURCE_KEYS, 'DUTY_RATE_PROJECTION_UNSUPPORTED', error instanceof Error ? error.message : String(error))
  }
  return finish()
}

/** Capture one trajectory's inventory once; never cache across mutable caller inputs. */
export function createMainRosterDutyRateProjector(inventory: OperatorInventory): (input: DutyRateState) => MainRosterDutyRateResult {
  const snapshot = structuredClone(inventory)
  const context: RateInventory = { inventory: snapshot, records: inventoryOperatorRecords(snapshot), owned: new Set(snapshot.operators.map(operator => operator.charId)) }
  return input => projectRates(input, context)
}

/** Fresh standalone projection of one joint state; no schedule or order is advanced. */
export function projectMainRosterDutyRates(input: MainRosterDutyRateInput): MainRosterDutyRateResult {
  return createMainRosterDutyRateProjector(input.inventory)(input)
}
