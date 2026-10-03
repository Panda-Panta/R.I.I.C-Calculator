import { mainPlanOnly } from './mainPlanOnly'
import { ensureBuiltDormKeepers } from './dormKeepers'
import { configureRunOrder } from './configureRunOrder'
import type { MowerFacilityType, MowerRoomId, RosterWorkspace } from '../workbench/model'
import { resolveOperatorCharId as resolveId } from '../workbench/compat/mowerJson'
import { type OperatorInventory, type OwnedOperatorInput } from '../domain/operatorInventory'
import { isOrdinaryReplacementCandidate, isShiftRunOperator } from '../scheduler/scheduleAdapter'
import {
  ATOMIC_UNITS,
  AUXILIARY_FACILITY_CANDIDATES,
  type AtomicMember,
  type AtomicUnit,
  type AtomicUnitConfPolicy,
} from './riicAtomicUnits'
import { assignBackups, validatePhysicalRoster } from './rosterDraft'
import {
  applySmartDormitoryPolicy,
  findLowestRecoveryDormitorySlot,
} from '../scheduler/smartDormitoryPolicy'
import { runScheduleSimulationBridge } from '../workbench/scheduleSimulationBridge'
import { scoreProduction } from './productionObjective'
import { rankStaffingCandidates } from './staffingQuality'
import { buildSingletonFallback } from './singletonFallback'

export interface MolecularCandidate {
  id: string
  name: string
  workspace: RosterWorkspace
  appliedAtoms: string[]
  staticScore: number
  simScore: number | null
  diagnostics: string[]
  confPolicy: AtomicUnitConfPolicy
}

export interface SynthesisOptions {
  seed?: number
  branchCount?: number
  simulationWarmupHours?: number
  simulationSampleHours?: number
  droneTarget?: 'gold' | 'exp' | 'trading' | 'none'
  lockedPositions?: Set<string>
  lockedOperators?: Set<string>
}

function capacity(type: MowerFacilityType, level: number): number {
  if (level === 0) return 0
  if (type === 'manufacture' || type === 'trading') return level
  if (type === 'central' || type === 'dormitory') return 5
  if (type === 'meeting' || type === 'train') return 2
  return ['power', 'contact', 'factory'].includes(type) ? 1 : 0
}

function randomGenerator(seed: number) {
  let n = seed >>> 0
  return () => {
    n = (n + 0x6d2b79f5) >>> 0
    let t = n
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(items: readonly T[], next: () => number): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    const temp = result[i]!
    result[i] = result[j]!
    result[j] = temp
  }
  return result
}

/** Check if all core members and external requirements of an atomic unit are owned in inventory */
export function checkAtomicAvailability(
  atom: AtomicUnit,
  inventory: OperatorInventory,
  powerCount: number,
  product?: 'gold' | 'exp',
): { available: boolean; coreMembers: AtomicMember[]; thirdMemberWhitelist?: string[]; confPolicy?: AtomicUnitConfPolicy } {
  const ownedNames = new Set(
    inventory.operators.filter((o) => o.matchesMaximumSkills).map((o) => o.name),
  )

  let coreMembers = [...atom.coreMembers]
  let thirdWhitelist = atom.thirdMemberWhitelist ? [...atom.thirdMemberWhitelist] : undefined
  let confPolicy = atom.confPolicy ? { ...atom.confPolicy } : undefined

  if (atom.adaptToPowerCount) {
    const adapted = atom.adaptToPowerCount(powerCount, product)
    coreMembers = adapted.coreMembers
    if (adapted.thirdMemberWhitelist) thirdWhitelist = adapted.thirdMemberWhitelist
    if (adapted.confPolicy) confPolicy = { ...confPolicy, ...adapted.confPolicy }
  }

  // Verify all core members are owned
  for (const member of coreMembers) {
    if (!ownedNames.has(member.name)) {
      return { available: false, coreMembers: [] }
    }
  }

  // Verify external requirements (e.g. 4 Durins, 3 Rhine Lab members)
  if (atom.externalRequirements) {
    for (const req of atom.externalRequirements) {
      const ownedCount = req.pool.filter((name) => ownedNames.has(name)).length
      if (ownedCount < req.count) {
        return { available: false, coreMembers: [] }
      }
    }
  }

  return { available: true, coreMembers, thirdMemberWhitelist: thirdWhitelist, confPolicy }
}

/**
 * Generate stochastic multi-branch molecular candidate rosters from indivisible atomic units.
 */
export function generateMolecularCandidates(
  base: RosterWorkspace,
  _entries: readonly OwnedOperatorInput[],
  inventory: OperatorInventory,
  options: SynthesisOptions = {},
): MolecularCandidate[] {
 base = mainPlanOnly(base)
  if (!inventory.valid || inventory.operators.length === 0) return []
  const seed = options.seed ?? 42
  const branchCount = options.branchCount ?? 8
  const lockedPositions = options.lockedPositions ?? new Set<string>()
  const lockedOperators = options.lockedOperators ?? new Set<string>()

  const candidates: MolecularCandidate[] = []
  const seen = new Set<string>()
  const attemptedSkeletons = new Set<string>()
  const maxAttempts = Math.max(50, branchCount * 50)

  for (let branchIdx = 0; branchIdx < maxAttempts && candidates.length < branchCount; branchIdx++) {
    const branchSeed = (seed + branchIdx * 0x9e3779b9) >>> 0
    const nextRandom = randomGenerator(branchSeed)
    const ws = structuredClone(base)

    // Normalize slots to facility capacity
    for (const room of Object.values(ws.mainPlan.facilities)) {
      const cap = capacity(room.type, room.level)
      while (room.slots.length < cap) {
        room.slots.push({ occupant: { kind: 'empty' }, groupId: null, replacements: [] })
      }
      if (room.slots.length > cap) {
        room.slots.length = cap
      }
    }

    const powerRooms = Object.values(ws.mainPlan.facilities).filter((r) => r.type === 'power' && r.level > 0)
    const powerCount = powerRooms.length
    const tradingRooms = Object.values(ws.mainPlan.facilities).filter((r) => r.type === 'trading' && r.level > 0)
    const availableManufactureRooms = Object.values(ws.mainPlan.facilities).filter((r) => r.type === 'manufacture' && r.level > 0)
    const manufactureRooms = branchIdx === 0 ? availableManufactureRooms : shuffle(availableManufactureRooms, nextRandom)
    const centralRoom = ws.mainPlan.facilities.central
    const contactRoom = ws.mainPlan.facilities.contact

    const occupied = new Set<string>([...lockedOperators, ...Object.values(ws.mainPlan.facilities).flatMap(room =>
      room.slots.flatMap(slot => [...(slot.occupant.kind === 'operator' ? [resolveId(slot.occupant.operatorId)] : []), ...slot.replacements.map(resolveId)]))])
    const appliedAtoms: string[] = []
    const confExhaustRequire = new Set<string>()
    const confRestInFull = new Set<string>()
    const confRestingPriorityLow = new Set<string>()
    const confRestingPriorityHigh = new Set<string>()
    const confWorkaholic = new Set<string>()

    const addedPositions: { roomId: MowerRoomId; slotIndex: number; operatorId: string }[] = []

    const isAvailableSingleton = (name: string): boolean => {
      const charId = resolveId(name)
      if (occupied.has(charId)) return false
      if (inventory.operators.length > 0) {
        const op = inventory.operators.find((o) => o.charId === charId || o.name === name)
        return Boolean(op && op.matchesMaximumSkills)
      }
      return true
    }

    const bestSingleton = (roomId: MowerRoomId, slotIndex: number, metalcraftOnly = false): string | undefined => {
      const pool = inventory.operators.filter(o => !occupied.has(o.charId) && !isShiftRunOperator(o.charId) && o.name !== '菲亚梅塔' &&
        (!metalcraftOnly || o.skills.some(s => s.roomType === 'MANUFACTURE' && /^金属工艺·[αβγ]$/.test(s.name))))
      return rankStaffingCandidates(ws, inventory, { roomId, slotIndex }, pool.map(o => o.charId), 'main')[0]
    }

    const placeOperator = (
      roomId: MowerRoomId,
      slotIdx: number,
      opName: string,
      groupId: string | null = null,
      backupName?: string,
    ) => {
      const charId = resolveId(opName)
      if (occupied.has(charId)) return false
      if (inventory.operators.length > 0) {
        const op = inventory.operators.find((o) => o.charId === charId || o.name === opName)
        if (!op) {
          return false
        }
      }
      const room = ws.mainPlan.facilities[roomId]
      if (!room) return false
      if (room.type === 'trading' && isShiftRunOperator(charId)) return false
      const cap = capacity(room.type, room.level)
      if (slotIdx >= cap || slotIdx >= room.slots.length) return false
      const slot = room.slots[slotIdx]!
      if (lockedPositions.has(`${roomId}:${slotIdx}`) || slot.occupant.kind === 'operator') return false

      let validBackupId: string | undefined = undefined
      if (backupName) {
        const backupCharId = resolveId(backupName)
        if (inventory.operators.length > 0) {
          const bOp = inventory.operators.find((o) => o.charId === backupCharId || o.name === backupName)
          if (bOp) {
            validBackupId = backupCharId
          }
        } else {
          validBackupId = backupCharId
        }
      }

      if (backupName && !validBackupId) return false
      if (validBackupId && (validBackupId === charId || occupied.has(validBackupId) || !isOrdinaryReplacementCandidate(validBackupId,room.type))) return false
      slot.occupant = { kind: 'operator', operatorId: charId }
      slot.groupId = groupId
      if (room.type === 'manufacture' && charId === resolveId('机械师')) {
        slot.groupId = null
        confExhaustRequire.add('机械师')
      }
      occupied.add(charId)

      if (validBackupId) {
        slot.replacements = [validBackupId]
        occupied.add(validBackupId)
      }

      addedPositions.push({ roomId, slotIndex: slotIdx, operatorId: charId })
      return true
    }

    type Placement = { roomId: MowerRoomId; index: number; name: string; group: string; backup?: string }
    const placeTogether = (placements: Placement[]): boolean => {
      const before = structuredClone(ws.mainPlan.facilities)
      const reservedBefore = new Set(occupied), addedBefore = addedPositions.length
      for (const p of placements) {
        if (placeOperator(p.roomId, p.index, p.name, p.group, p.backup)) continue
        for (const room of Object.values(ws.mainPlan.facilities)) Object.assign(room, before[room.roomId])
        occupied.clear(); reservedBefore.forEach(id => occupied.add(id)); addedPositions.length = addedBefore
        return false
      }
      return true
    }
    const emptyIndices = (roomId: MowerRoomId) => ws.mainPlan.facilities[roomId].slots.flatMap((slot, index) =>
      slot.occupant.kind === 'empty' && !lockedPositions.has(`${roomId}:${index}`) ? [index] : [])

    const placePendantOperatorHelper = (opName: string, grpId: string): boolean => {
      const charId = resolveId(opName)
      if (occupied.has(charId)) return false

      // 1. Try factory (Workshop)
      const factory = ws.mainPlan.facilities.factory
      if (factory && emptyIndices('factory').includes(0)) {
        const slot = factory.slots[0]!
        slot.occupant = { kind: 'operator', operatorId: charId }
        slot.groupId = null
        occupied.add(charId)
        const backupOp = ['特克诺', '年', '锡兰'].find(isAvailableSingleton)
        if (backupOp) {
          const bId = resolveId(backupOp)
          slot.replacements = [bId]
          occupied.add(bId)
        }
        addedPositions.push({ roomId: 'factory', slotIndex: 0, operatorId: charId })
        return true
      }

      // 2. Try train (Training Room)
      const train = ws.mainPlan.facilities.train
      if (train && train.slots.length > 0) {
        const emptySlotIdx = emptyIndices('train')[0] ?? -1
        if (emptySlotIdx !== -1) {
          const slot = train.slots[emptySlotIdx]!
          slot.occupant = { kind: 'operator', operatorId: charId }
          slot.groupId = null
          occupied.add(charId)
          const backupOp = ['艾丽妮', '左乐', '达利尔'].find(isAvailableSingleton)
          if (backupOp) {
            const bId = resolveId(backupOp)
            slot.replacements = [bId]
            occupied.add(bId)
          }
          addedPositions.push({ roomId: 'train', slotIndex: emptySlotIdx, operatorId: charId })
          return true
        }
      }

      // 3. Dormitory slot with LOWEST recovery rate
      const lowest = findLowestRecoveryDormitorySlot(ws, true)
      if (lowest && !lockedPositions.has(`${lowest.roomId}:${lowest.slotIndex}`)) {
        const targetRoom = ws.mainPlan.facilities[lowest.roomId]!
        const targetSlot = targetRoom.slots[lowest.slotIndex]!
        targetSlot.occupant = { kind: 'operator', operatorId: charId }
        targetSlot.groupId = grpId
        targetSlot.replacements = []
        occupied.add(charId)
        addedPositions.push({ roomId: lowest.roomId, slotIndex: lowest.slotIndex, operatorId: charId })
        return true
      }

      return false
    }

    // ----------------------------------------------------
    // Step 1: Synthesis of Molecules across Trading & Central/Office
    // ----------------------------------------------------
    const tradeMolecules = shuffle(
      ['perception_pozemka', 'laterano_penguin', 'siracusa_karlan', 'perception_fireworks'],
      nextRandom,
    )
    const chosenTradeStrategy = tradeMolecules[0]

    let tradeRoomIndex = 0

    // Try Perception + Pozëmka molecule
    if (
      (chosenTradeStrategy === 'perception_pozemka' || chosenTradeStrategy === 'perception_fireworks') &&
      tradingRooms.length > 0
    ) {
      const pozemkaAtom = ATOMIC_UNITS.find((a) => a.id === 'pozemka_durin')!
      const pozemkaCheck = checkAtomicAvailability(pozemkaAtom, inventory, powerCount)
      const isFireworks = chosenTradeStrategy === 'perception_fireworks' && tradingRooms.length >= 2
      const perceptionAtom = ATOMIC_UNITS.find(
        (a) => a.id === (isFireworks ? 'perception_fireworks' : 'pure_perception'),
      )!
      const perceptionCheck = checkAtomicAvailability(perceptionAtom, inventory, powerCount)

      if (pozemkaCheck.available && perceptionCheck.available) {
        // Find a trading room with at least 2 slots
        const eligibleIdx = tradingRooms.findIndex((r, idx) => idx >= tradeRoomIndex && r.slots.length >= 2)
        if (eligibleIdx !== -1) {
          const tRoom = tradingRooms[eligibleIdx]!
          tradeRoomIndex = eligibleIdx + 1
          const groupId = '感知信息+鸿雪组'

          // 1. Pozemka + Tuyet in trade room
          placeOperator(tRoom.roomId, 0, '鸿雪', groupId)
          placeOperator(tRoom.roomId, 1, '图耶', groupId)

          // 3rd in trade room: Kirara (绮良) provides virtual gold line for Pozemka
          if (tRoom.slots.length >= 3) {
            placeOperator(tRoom.roomId, 2, '绮良', groupId)
          }

          // 2. Rosmontis (迷迭香) in 1st manufacture room
          if (manufactureRooms.length > 0) {
            const mRoom = manufactureRooms[0]!
            placeOperator(mRoom.roomId, 0, '迷迭香', groupId)
          }

          // 3. Whisperain (絮雨) in office
          if (contactRoom) {
            placeOperator('contact', 0, '絮雨', groupId)
          }

          // 4. Minimalist (至简):
          // Requirement 3: Strictly check powerCount. If 2 power stations (e.g. 252 layout),
          // Minimalist is prohibited from manufacture and placed as a pendant.
          if (powerCount >= 3) {
            if (manufactureRooms.length > 1 && manufactureRooms[1]!.slots.length > 0) {
              placeOperator(manufactureRooms[1]!.roomId, 0, '至简', groupId)
            }
          } else {
            // 2-power constraint: Minimalist is a pendant operator
            placePendantOperatorHelper('至简', groupId)
          }

          // 5. Durin race:
          // Requirement 4: Myrtle and Durin serve as dorm managers / keepers (handled by applySmartDormitoryPolicy)
          // Requirement 5: Chestnut as pendant operator (Workshop -> Training -> lowest recovery dorm slot)
          placePendantOperatorHelper('褐果', groupId)

          // 6. Trade room 2: Ebenholz (纯感知) or Wuyou (人间烟火)
          if (tradingRooms.length >= 2) {
            const tRoom2 = tradingRooms.find((r, idx) => idx >= tradeRoomIndex && r.slots.length >= 1)
            if (tRoom2) {
              tradeRoomIndex = tradingRooms.indexOf(tRoom2) + 1
              if (isFireworks) {
                placeOperator(tRoom2.roomId, 0, '乌有', groupId)
                if (centralRoom) {
                  placeOperator('central', 0, '夕', groupId)
                  placeOperator('central', 1, '令', groupId)
                }
              } else {
                placeOperator(tRoom2.roomId, 0, '黑键', groupId)
              }
            }
          }

          appliedAtoms.push('pozemka_durin', perceptionAtom.id)
        }
      }
    }

    // Trading Room Fallbacks / Alternative Molecules
    while (tradeRoomIndex < tradingRooms.length) {
      const tRoom = tradingRooms[tradeRoomIndex++]!

      // Try Laterano (requires at least 2 slots)
      const lateranoAtom = ATOMIC_UNITS.find((a) => a.id === 'laterano')!
      const lateranoCheck = checkAtomicAvailability(lateranoAtom, inventory, powerCount)
      if (
        tRoom.slots.length >= 2 &&
        lateranoCheck.available &&
        !occupied.has(resolveId('蕾缪安')) &&
        !occupied.has(resolveId('能天使'))
      ) {
        const groupId = '拉特兰商道'
        placeOperator(tRoom.roomId, 0, '蕾缪安', groupId)
        placeOperator(tRoom.roomId, 1, '能天使', groupId)
        appliedAtoms.push('laterano')
        continue
      }

      // Try Penguin Logistics (德克萨斯 + 拉普兰德, excluding Sora; requires at least 2 slots)
      const penguinAtom = ATOMIC_UNITS.find((a) => a.id === 'penguin_logistics')!
      const penguinCheck = checkAtomicAvailability(penguinAtom, inventory, powerCount)
      if (
        tRoom.slots.length >= 2 &&
        penguinCheck.available &&
        !occupied.has(resolveId('德克萨斯')) &&
        !occupied.has(resolveId('拉普兰德'))
      ) {
        const groupId = '企鹅物流'
        placeOperator(tRoom.roomId, 0, '德克萨斯', groupId)
        placeOperator(tRoom.roomId, 1, '拉普兰德', groupId)
        if (tRoom.slots.length >= 3) {
          // High-efficiency singleton: exclude Sora, exclude shift-run operators
          const singleton = bestSingleton(tRoom.roomId, 2)
          if (singleton) placeOperator(tRoom.roomId, 2, singleton, groupId)
        }
        appliedAtoms.push('penguin_logistics')
        continue
      }

      // Try Siracusa (伺夜 + 贝洛内; requires at least 2 slots)
      const siracusaAtom = ATOMIC_UNITS.find((a) => a.id === 'siracusa')!
      const siracusaCheck = checkAtomicAvailability(siracusaAtom, inventory, powerCount)
      if (
        tRoom.slots.length >= 2 &&
        siracusaCheck.available &&
        !occupied.has(resolveId('伺夜')) &&
        !occupied.has(resolveId('贝洛内'))
      ) {
        const groupId = '叙拉古组'
        placeOperator(tRoom.roomId, 0, '伺夜', groupId)
        placeOperator(tRoom.roomId, 1, '贝洛内', groupId)
        if (centralRoom && isAvailableSingleton('八幡海铃')) {
          const cSlot = centralRoom.slots.findIndex((s) => s.occupant.kind !== 'operator')
          if (cSlot !== -1) placeOperator('central', cSlot, '八幡海铃', groupId)
        }
        appliedAtoms.push('siracusa')
        continue
      }

      // Try Karlan (银灰 + 孑 + 灵知; requires at least 2 slots)
      const karlanAtom = ATOMIC_UNITS.find((a) => a.id === 'karlan')!
      const karlanCheck = checkAtomicAvailability(karlanAtom, inventory, powerCount)
      if (
        tRoom.slots.length >= 2 &&
        karlanCheck.available &&
        !occupied.has(resolveId('银灰')) &&
        !occupied.has(resolveId('孑')) &&
        !occupied.has(resolveId('灵知'))
      ) {
        const groupId = '喀兰贸易'
        placeOperator(tRoom.roomId, 0, '银灰', groupId)
        placeOperator(tRoom.roomId, 1, '孑', groupId)
        if (centralRoom) {
          placeOperator('central', centralRoom.slots.findIndex((s) => s.occupant.kind !== 'operator'), '灵知', groupId)
        }
        const tCap = capacity(tRoom.type, tRoom.level)
        if (tCap >= 3) {
          const validThirds = ['崖心', '琳琅诗怀雅', '雪雉', '古米', '月见夜']
          const third = validThirds.find(isAvailableSingleton)
          if (third) {
            placeOperator(tRoom.roomId, 2, third, groupId)
          }
        }
        appliedAtoms.push('karlan')
        continue
      }

      // Default high-efficiency trading singletons for this room
      const tCap = capacity(tRoom.type, tRoom.level)
      for (let sIdx = 0; sIdx < tCap; sIdx++) {
        if (tRoom.slots[sIdx]!.occupant.kind !== 'operator') {
          const singleton = bestSingleton(tRoom.roomId, sIdx)
          if (singleton) placeOperator(tRoom.roomId, sIdx, singleton)
        }
      }
    }

    // ----------------------------------------------------
    // Step 2: Synthesis of Manufacture & Central Molecules
    // ----------------------------------------------------

    // ----------------------------------------------------
    // Step 2: Synthesis of Manufacture & Central Molecules
    // Prioritized by per-capita output contribution
    // ----------------------------------------------------

    // Priority 1: High-Yield Gold Manufacture (Aroma+WaaiFu: 65%, Automation: 47.5%)
    for (const mRoom of manufactureRooms.filter((r) => r.product === 'gold')) {
      const freeSlots = mRoom.slots.filter((s) => s.occupant.kind !== 'operator').length
      if (freeSlots < 2) continue

      // 1.1 Aroma + Waai Fu (Per-capita 65%)
      const aromaAtom = ATOMIC_UNITS.find((a) => a.id === 'aroma_waaifu')!
      const aromaCheck = checkAtomicAvailability(aromaAtom, inventory, powerCount)
      if (aromaCheck.available && !occupied.has(resolveId('阿罗玛')) && !occupied.has(resolveId('槐琥'))) {
        const aromaGroupId = '阿罗玛槐琥组'
        let placed = 0
        for (let sIdx = 0; sIdx < mRoom.slots.length; sIdx++) {
          if (mRoom.slots[sIdx]!.occupant.kind !== 'operator') {
            if (placed === 0) {
              placeOperator(mRoom.roomId, sIdx, '阿罗玛', aromaGroupId)
              placed++
            } else if (placed === 1) {
              placeOperator(mRoom.roomId, sIdx, '槐琥', aromaGroupId)
              placed++
              break // Strictly 2 persons, NO third person!
            }
          }
        }
        confExhaustRequire.add('阿罗玛')
        confExhaustRequire.add('槐琥')
        confRestInFull.add('阿罗玛')
        confRestInFull.add('槐琥')
        appliedAtoms.push('aroma_waaifu')
        continue
      }
    }

    // 1.2 Place automation and its cross-room supports as one complete unit.
    const autoAtom = ATOMIC_UNITS.find((a) => a.id === 'automation')!
    const autoCheck = checkAtomicAvailability(autoAtom, inventory, powerCount, 'gold')
    if (autoCheck.available) {
      const group = '自动化组'
      const requiredGoldSlots = powerCount >= 3 ? 3 : 2
      const goldRoom = manufactureRooms.find(r => r.product === 'gold' && emptyIndices(r.roomId).length >= requiredGoldSlots)
      const freePower = powerRooms.filter(r => emptyIndices(r.roomId).includes(0))
      const centralIndex = emptyIndices('central')[0]
      if (goldRoom && freePower.length >= (powerCount >= 3 ? 1 : 2) && (powerCount >= 3 || centralIndex !== undefined)) {
        const indices = emptyIndices(goldRoom.roomId)
        const placements: Placement[] = [
          { roomId: goldRoom.roomId, index: indices[0]!, name: '温蒂', group },
          { roomId: goldRoom.roomId, index: indices[1]!, name: '清流', group },
          { roomId: powerCount >= 3 ? goldRoom.roomId : 'central', index: powerCount >= 3 ? indices[2]! : centralIndex!, name: '森蚺', group },
          { roomId: freePower[0]!.roomId, index: 0, name: '承曦格雷伊', group },
        ]
        if (powerCount < 3) placements.push({ roomId: freePower[1]!.roomId, index: 0, name: 'Lancet-2', group })
        if (placeTogether(placements)) {
          if (powerCount < 3) {
            confWorkaholic.add('Lancet-2')
            const third = autoCheck.thirdMemberWhitelist?.find(n => isAvailableSingleton(n) && n !== '清流')
            if (third && indices[2] !== undefined) placeOperator(goldRoom.roomId, indices[2], third, group)
          }
          appliedAtoms.push('automation')
        }
      }
    }

    // 1.3 Other Gold Combinations (Cantabile: 35%, Rhine Lab: 35%)
    for (const mRoom of manufactureRooms.filter((r) => r.product === 'gold')) {
      const freeSlots = mRoom.slots.filter((s) => s.occupant.kind !== 'operator').length
      if (freeSlots < 2) continue

      // Try Cantabile Metalcraft (苍苔 + 2 metalcraft singletons)
      const cantabileAtom = ATOMIC_UNITS.find((a) => a.id === 'cantabile_metalcraft')!
      const cantabileCheck = checkAtomicAvailability(cantabileAtom, inventory, powerCount)
      if (cantabileCheck.available && !occupied.has(resolveId('苍苔'))) {
        const cantabileGroupId = '苍苔金属组'
        const emptyIndices = mRoom.slots.flatMap((s, idx) => (s.occupant.kind !== 'operator' ? [idx] : []))
        if (emptyIndices.length >= 2) {
          placeOperator(mRoom.roomId, emptyIndices[0]!, '苍苔', cantabileGroupId)
          for (let i = 1; i < emptyIndices.length; i++) {
            const metal = bestSingleton(mRoom.roomId, emptyIndices[i]!, true)
            if (metal) placeOperator(mRoom.roomId, emptyIndices[i]!, metal, cantabileGroupId)
          }
          appliedAtoms.push('cantabile_metalcraft')
          continue
        }
      }

      // Try Rhine Lab (Dorothy + Silence + Nasty)
      const rhineAtom = ATOMIC_UNITS.find((a) => a.id === 'rhine_lab')!
      const rhineCheck = checkAtomicAvailability(rhineAtom, inventory, powerCount)
      if (rhineCheck.available && !occupied.has(resolveId('多萝西')) && !occupied.has(resolveId('淬羽赫默'))) {
        const rhineGroupId = '莱茵生命组'
        const emptyIndices = mRoom.slots.flatMap((s, idx) => (s.occupant.kind !== 'operator' ? [idx] : []))
        if (emptyIndices.length >= 2) {
          placeOperator(mRoom.roomId, emptyIndices[0]!, '多萝西', rhineGroupId)
          placeOperator(mRoom.roomId, emptyIndices[1]!, '淬羽赫默', rhineGroupId)
          if (emptyIndices.length >= 3 && !occupied.has(resolveId('娜斯提'))) {
            placeOperator(mRoom.roomId, emptyIndices[2]!, '娜斯提', rhineGroupId)
          }
          appliedAtoms.push('rhine_lab')
          continue
        }
      }
    }

    // Priority 2: High-Yield Exp Manufacture (Vermeil+Dionysus: 48%, Vermeil+Scene: 38%, Bubble: 38%)
    for (const mRoom of manufactureRooms.filter((r) => r.product === 'exp')) {
      const freeSlots = mRoom.slots.filter((s) => s.occupant.kind !== 'operator').length
      if (freeSlots < 2) continue

      // Try Vermeil + Dionysus + Miss.Christine (Mandatory 3-person bind, 48% per capita!)
      const vermeilDioAtom = ATOMIC_UNITS.find((a) => a.id === 'vermeil_dionysus')!
      const vermeilDioCheck = checkAtomicAvailability(vermeilDioAtom, inventory, powerCount)
      if (
        freeSlots >= 3 &&
        vermeilDioCheck.available &&
        !occupied.has(resolveId('红云')) &&
        !occupied.has(resolveId('酒神')) &&
        !occupied.has(resolveId('Miss.Christine'))
      ) {
        const groupId = '红云酒神猫猫组'
        const emptyIndices = mRoom.slots.flatMap((s, idx) => (s.occupant.kind !== 'operator' ? [idx] : []))
        placeOperator(mRoom.roomId, emptyIndices[0]!, '红云', groupId)
        placeOperator(mRoom.roomId, emptyIndices[1]!, '酒神', groupId)
        placeOperator(mRoom.roomId, emptyIndices[2]!, 'Miss.Christine', groupId)
        appliedAtoms.push('vermeil_dionysus')
        continue
      }

      // Try Vermeil + Scene (红云容量组, 38% per capita)
      const vermeilCapAtom = ATOMIC_UNITS.find((a) => a.id === 'vermeil_capacity')!
      const vermeilCapCheck = checkAtomicAvailability(vermeilCapAtom, inventory, powerCount)
      if (
        vermeilCapCheck.available &&
        !occupied.has(resolveId('红云')) &&
        !occupied.has(resolveId('稀音'))
      ) {
        const groupId = '红云容量组'
        const emptyIndices = mRoom.slots.flatMap((s, idx) => (s.occupant.kind !== 'operator' ? [idx] : []))
        placeOperator(mRoom.roomId, emptyIndices[0]!, '红云', groupId)
        placeOperator(mRoom.roomId, emptyIndices[1]!, '稀音', groupId)
        if (emptyIndices.length >= 3) {
          const candidates = ['刻俄柏', '结城理', '火神', '黑', '白雪']
          const third = candidates.find(isAvailableSingleton)
          if (third) placeOperator(mRoom.roomId, emptyIndices[2]!, third, groupId)
        }
        appliedAtoms.push('vermeil_capacity')
        continue
      }

      // Try Bubble + Vulcan (泡泡容量组, 38% per capita)
      const bubbleAtom = ATOMIC_UNITS.find((a) => a.id === 'bubble_capacity')!
      const bubbleCheck = checkAtomicAvailability(bubbleAtom, inventory, powerCount)
      if (bubbleCheck.available && !occupied.has(resolveId('泡泡')) && !occupied.has(resolveId('火神'))) {
        const groupId = '泡泡容量组'
        const emptyIndices = mRoom.slots.flatMap((s, idx) => (s.occupant.kind !== 'operator' ? [idx] : []))
        placeOperator(mRoom.roomId, emptyIndices[0]!, '泡泡', groupId)
        placeOperator(mRoom.roomId, emptyIndices[1]!, '火神', groupId)
        if (emptyIndices.length >= 3) {
          const candidates = ['贝娜', '刻俄柏', '断罪者', '霜叶']
          const third = candidates.find(isAvailableSingleton)
          if (third) placeOperator(mRoom.roomId, emptyIndices[2]!, third, groupId)
        }
        appliedAtoms.push('bubble_capacity')
        continue
      }
    }

    // Priority 3: Fallback Multipurpose / Large Combinations (Pinus Sylvestris: 28%, Abyssal: 26%, Blacksteel: 25%)
    const abyssalAtom = ATOMIC_UNITS.find((a) => a.id === 'abyssal_hunters')!
    const abyssalCheck = checkAtomicAvailability(abyssalAtom, inventory, powerCount)
    const knightAtom = ATOMIC_UNITS.find((a) => a.id === 'pinus_sylvestris')!
    const knightCheck = checkAtomicAvailability(knightAtom, inventory, powerCount)

    // Strict Rule for Abyssal Hunters:
    // 1. Gladiia single-station cap is 90%. 2 hunters = 80%, 3 hunters = 120% capped at 90% (wasteful +10% marginal gain).
    //    Therefore, AT MOST 2 Abyssal Hunters are allowed in ANY single manufacture room (<= 2 per room).
    // 2. All 4 hunters (斯卡蒂, 乌尔比安, 安哲拉, 幽灵鲨) must be placed simultaneously in manufacture rooms,
    //    and Gladiia must be placed in central. If fewer than 4 hunters can be accommodated under the <= 2 per room rule,
    //    do NOT form Abyssal Hunters in this branch!
    const canFitAllHuntersUnderCap = () => {
      if (!centralRoom || !centralRoom.slots.some((s) => s.occupant.kind !== 'operator')) return false
      const roomHunterCapacities = manufactureRooms.map((r) => {
        const freeSlots = r.slots.filter((s) => s.occupant.kind !== 'operator').length
        return Math.min(2, freeSlots)
      })
      const totalPossible = roomHunterCapacities.reduce((a, b) => a + b, 0)
      return totalPossible >= 4
    }

    let placedMirror = false
    if (abyssalCheck.available && knightCheck.available && canFitAllHuntersUnderCap() && emptyIndices('central').length >= 2) {
      const mirrorGroupId = '深海骑士替班组'
      const hunterPairs: [string, string][] = [
        ['斯卡蒂', '野鬃'],
        ['乌尔比安', '灰毫'],
        ['安哲拉', '远牙'],
        ['幽灵鲨', '砾'],
      ]
      const centralIndices = emptyIndices('central')
      const placements: Placement[] = [
        { roomId: 'central', index: centralIndices[0]!, name: '歌蕾蒂娅', group: mirrorGroupId, backup: '薇薇安娜' },
        { roomId: 'central', index: centralIndices[1]!, name: '玛恩纳', group: mirrorGroupId, backup: '焰尾' },
      ]
      let pairIdx = 0
      // The mirrored knights produce EXP; do not place their shift in a gold factory.
      for (const mRoom of manufactureRooms.filter(room => room.product === 'exp')) {
        if (pairIdx >= hunterPairs.length) break
        const cap = capacity(mRoom.type, mRoom.level)
        let placedInThisRoom = 0

        for (let sIdx = 0; sIdx < cap && placedInThisRoom < 2 && pairIdx < hunterPairs.length; sIdx++) {
          if (emptyIndices(mRoom.roomId).includes(sIdx)) {
            const [hunter, knight] = hunterPairs[pairIdx]!
            placements.push({ roomId: mRoom.roomId, index: sIdx, name: hunter, group: mirrorGroupId, backup: knight })
            pairIdx++
            placedInThisRoom++
          }
        }
      }

      if (pairIdx === 4 && placeTogether(placements)) {
        placedMirror = true
        confRestingPriorityHigh.add('歌蕾蒂娅')
        confRestingPriorityLow.add('乌尔比安')
        confRestingPriorityLow.add('斯卡蒂')
        confRestingPriorityLow.add('幽灵鲨')
        confRestingPriorityLow.add('安哲拉')
        appliedAtoms.push('abyssal_hunters', 'pinus_sylvestris')
      }
    }
    if (!placedMirror && knightCheck.available && !occupied.has(resolveId('薇薇安娜')) && !occupied.has(resolveId('焰尾'))) {
      const knightGroupId = '红松林骑士组'
      const centralIndices = emptyIndices('central')
      const expRoom = manufactureRooms.find(r => r.product === 'exp' && emptyIndices(r.roomId).length >= 3)
      if (centralIndices.length >= 2 && expRoom) {
        const slots = emptyIndices(expRoom.roomId)
        const placements: Placement[] = [
          { roomId: 'central', index: centralIndices[0]!, name: '薇薇安娜', group: knightGroupId },
          { roomId: 'central', index: centralIndices[1]!, name: '焰尾', group: knightGroupId },
          ...['野鬃', '灰毫', '远牙'].map((name, index) => ({ roomId: expRoom.roomId, index: slots[index]!, name, group: knightGroupId })),
        ]
        if (placeTogether(placements)) appliedAtoms.push('pinus_sylvestris')
      }
    }

    // Blacksteel (涤火杰西卡 + 水月 + 香草 + 杰西卡: 25%)
    const blacksteelAtom = ATOMIC_UNITS.find((a) => a.id === 'blacksteel')!
    const blacksteelCheck = checkAtomicAvailability(blacksteelAtom, inventory, powerCount)
    if (
      blacksteelCheck.available &&
      !occupied.has(resolveId('涤火杰西卡')) &&
      !occupied.has(resolveId('水月')) &&
      !occupied.has(resolveId('香草')) &&
      !occupied.has(resolveId('杰西卡'))
    ) {
      const bsGroupId = '黑钢国际'
      const centralSlot = emptyIndices('central')[0]
      const factory = manufactureRooms.find(room => emptyIndices(room.roomId).length >= 3)
      if (centralSlot !== undefined && factory) {
        const slots = emptyIndices(factory.roomId)
        if (placeTogether([
          { roomId: 'central', index: centralSlot, name: '涤火杰西卡', group: bsGroupId },
          ...['水月', '香草', '杰西卡'].map((name, index) => ({ roomId: factory.roomId, index: slots[index]!, name, group: bsGroupId })),
        ])) appliedAtoms.push('blacksteel')
      }
    }

    // ----------------------------------------------------
    // Step 3: Fill Remaining Empty Slots with High-Efficiency Singletons
    // ----------------------------------------------------
    // Repeated random draws must not redo deterministic staffing and backup ranking.
    const skeleton = JSON.stringify([ws.mainPlan.facilities, manufactureRooms.map(r => r.roomId),
      [...confExhaustRequire], [...confRestInFull], [...confRestingPriorityLow], [...confRestingPriorityHigh], [...confWorkaholic]])
    if (attemptedSkeletons.has(skeleton)) continue
    attemptedSkeletons.add(skeleton)
    // Production singletons use their theoretical skill efficiency under this layout.
    const roomSkills = { manufacture: 'MANUFACTURE', trading: 'TRADING', central: 'CONTROL', power: 'POWER' } as const
    for (const room of [...manufactureRooms, ...tradingRooms, centralRoom, ...powerRooms]) {
      if (!room || !(room.type in roomSkills)) continue
      const skillType = roomSkills[room.type as keyof typeof roomSkills]
      for (const index of emptyIndices(room.roomId)) {
        const pool = inventory.operators.filter(o => !occupied.has(o.charId) &&
          !isShiftRunOperator(o.charId) && o.name !== '菲亚梅塔' &&
          o.skills.some(s => s.roomType === skillType))
        const selected = rankStaffingCandidates(ws, inventory, { roomId: room.roomId, slotIndex: index }, pool.map(o => o.charId), 'main')[0]
        if (selected) placeOperator(room.roomId, index, selected)
      }
    }

    // Dormitory rooms: free beds for empty slots
    // A missing singleton must reject this skeleton, not become a half-filled candidate.
    if (Object.values(ws.mainPlan.facilities).some(room =>
      ['manufacture', 'trading', 'power', 'central'].includes(room.type) &&
      room.slots.some(slot => slot.occupant.kind !== 'operator'))) continue
    const dormRooms = Object.values(ws.mainPlan.facilities).filter((r) => r.type === 'dormitory' && r.level > 0)
    for (const dorm of dormRooms) {
      for (const slot of dorm.slots) {
        if (slot.occupant.kind === 'empty' && slot.replacements.length === 0) {
          slot.occupant = { kind: 'free' }
        }
      }
    }

    // ----------------------------------------------------
    // Step 3.5: Open Auxiliary Facilities (meeting, factory, train)
    // ----------------------------------------------------
    // Meeting room (2 slots)
    const meetingRoom = ws.mainPlan.facilities.meeting
    if (meetingRoom) {
      const cap = capacity(meetingRoom.type, meetingRoom.level)
      const candConfigs = AUXILIARY_FACILITY_CANDIDATES.meeting
      for (let sIdx = 0; sIdx < cap && sIdx < candConfigs.length; sIdx++) {
        if (meetingRoom.slots[sIdx]!.occupant.kind !== 'operator') {
          const cfg = candConfigs[sIdx]!
          const primaryName = isAvailableSingleton(cfg.primary)
            ? cfg.primary
            : (cfg.fallbackPrimary && isAvailableSingleton(cfg.fallbackPrimary) ? cfg.fallbackPrimary : undefined)
          if (primaryName) {
            const backupName = isAvailableSingleton(cfg.backup)
              ? cfg.backup
              : (cfg.fallbackBackup && isAvailableSingleton(cfg.fallbackBackup) ? cfg.fallbackBackup : undefined)
            placeOperator('meeting', sIdx, primaryName, '会客室主力', backupName)
          }
        }
      }
    }

    // Factory room (1 slot, if not already occupied by pendant)
    const factoryRoom = ws.mainPlan.facilities.factory
    if (factoryRoom && factoryRoom.slots.length > 0 && factoryRoom.slots[0]!.occupant.kind !== 'operator') {
      const cfg = AUXILIARY_FACILITY_CANDIDATES.factory[0]!
      const primaryName = isAvailableSingleton(cfg.primary)
        ? cfg.primary
        : (cfg.fallbackPrimary && isAvailableSingleton(cfg.fallbackPrimary) ? cfg.fallbackPrimary : undefined)
      if (primaryName) {
        const backupName = isAvailableSingleton(cfg.backup)
          ? cfg.backup
          : (cfg.fallbackBackup && isAvailableSingleton(cfg.fallbackBackup) ? cfg.fallbackBackup : undefined)
        placeOperator('factory', 0, primaryName, '加工站主力', backupName)
      }
    }

    // Train room (up to 2 slots)
    const trainRoom = ws.mainPlan.facilities.train
    if (trainRoom) {
      const cap = capacity(trainRoom.type, trainRoom.level)
      const candConfigs = AUXILIARY_FACILITY_CANDIDATES.train
      for (let sIdx = 0; sIdx < cap && sIdx < candConfigs.length; sIdx++) {
        if (trainRoom.slots[sIdx]!.occupant.kind !== 'operator') {
          const cfg = candConfigs[sIdx]!
          const primaryName = isAvailableSingleton(cfg.primary)
            ? cfg.primary
            : (cfg.fallbackPrimary && isAvailableSingleton(cfg.fallbackPrimary) ? cfg.fallbackPrimary : undefined)
          if (primaryName) {
            const backupName = isAvailableSingleton(cfg.backup)
              ? cfg.backup
              : (cfg.fallbackBackup && isAvailableSingleton(cfg.fallbackBackup) ? cfg.fallbackBackup : undefined)
            placeOperator('train', sIdx, primaryName, '训练室主力', backupName)
          }
        }
      }
    }

    // ----------------------------------------------------
    // Step 4: Complete Backups & Assemble Conf Policies
    // ----------------------------------------------------
    // Assemble conf
    const confPolicy: AtomicUnitConfPolicy = {
      exhaustRequire: [...confExhaustRequire],
      restInFull: [...confRestInFull],
      restingPriorityLow: [...confRestingPriorityLow],
      restingPriorityHigh: [...confRestingPriorityHigh],
      workaholic: [...confWorkaholic],
    }

    ws.mainPlan.conf.exhaust_require = [...new Set([...base.mainPlan.conf.exhaust_require, ...(confPolicy.exhaustRequire ?? [])].map(resolveId))]
    ws.mainPlan.conf.rest_in_full = [...new Set([...base.mainPlan.conf.rest_in_full, ...(confPolicy.restInFull ?? [])].map(resolveId))]
    ws.mainPlan.conf.resting_priority = [...new Set([...base.mainPlan.conf.resting_priority, ...(confPolicy.restingPriorityLow ?? [])].map(resolveId))]
    ws.mainPlan.conf.ope_resting_priority = [...new Set([...base.mainPlan.conf.ope_resting_priority, ...(confPolicy.restingPriorityHigh ?? [])].map(resolveId))]
    ws.mainPlan.conf.workaholic = [...new Set([...base.mainPlan.conf.workaholic, ...(confPolicy.workaholic ?? [])].map(resolveId))]

    // Assign backups for any added position that still lacks replacement
    const needBackups = addedPositions.filter((p) => {
      const room = ws.mainPlan.facilities[p.roomId]
      const slot = room?.slots[p.slotIndex]
      return room && room.type !== 'dormitory' && slot?.occupant.kind === 'operator' &&
        !ws.mainPlan.conf.workaholic.some(id => resolveId(id) === resolveId(p.operatorId)) &&
        !slot.replacements.some(id => isOrdinaryReplacementCandidate(id, room.type))
    })

    if (needBackups.length > 0) {
      assignBackups(ws, inventory, needBackups)
    }

    // Do not fill missing backups with unrelated operators just to make every slot nonempty.
    const missingBackup = needBackups.some(p => {
      const room = ws.mainPlan.facilities[p.roomId], slot = room.slots[p.slotIndex]!
      return !slot.replacements.some(id => isOrdinaryReplacementCandidate(id, room.type))
    })
    if (missingBackup) continue

    // Keep an unchanged copy if automatic dormitory placement touches a user lock.
    const beforeDormitoryPolicy = structuredClone(ws)
    applySmartDormitoryPolicy(ws, {
      entries: [..._entries],
      candidateOperatorIds: _entries.map((e) => e.operator),
    })
    const changedLock = [...lockedPositions].some(key => {
      const [roomId, index] = key.split(':')
      return JSON.stringify(ws.mainPlan.facilities[roomId as MowerRoomId]?.slots[Number(index)]) !==
        JSON.stringify(beforeDormitoryPolicy.mainPlan.facilities[roomId as MowerRoomId]?.slots[Number(index)])
    })
    if (changedLock) Object.assign(ws, beforeDormitoryPolicy)
    if (!ensureBuiltDormKeepers(ws, inventory, lockedPositions)) continue
    for (const room of Object.values(ws.mainPlan.facilities)) if (room.type === 'dormitory') {
      room.slots.forEach((slot, index) => {
        if (slot.occupant.kind === 'empty' && !lockedPositions.has(`${room.roomId}:${index}`)) slot.occupant = { kind: 'free' }
      })
    }

    // Dormitory support placement may remove an operator from an ordinary backup list.
    const missingAfterPolicy = Object.values(ws.mainPlan.facilities)
      .filter(room => ['manufacture', 'trading', 'power', 'central', 'meeting', 'contact'].includes(room.type))
      .flatMap(room => room.slots.flatMap((slot, slotIndex) => {
        if (slot.occupant.kind !== 'operator' || lockedPositions.has(`${room.roomId}:${slotIndex}`)) return []
        const operatorId = resolveId(slot.occupant.operatorId)
        if (slot.replacements.some(id => isOrdinaryReplacementCandidate(id, room.type)) || ws.mainPlan.conf.workaholic.some(id => resolveId(id) === operatorId)) return []
        return [{ roomId: room.roomId, slotIndex, operatorId }]
      }))
    if (missingAfterPolicy.length && assignBackups(ws, inventory, missingAfterPolicy).missingReplacementIds.length) continue
    if (!configureRunOrder(ws, inventory)) continue

    // Physical roster validation
    const physErrors = validatePhysicalRoster(ws)
    const fingerprint = JSON.stringify(Object.values(ws.mainPlan.facilities).map(r => [r.roomId, r.slots.map(s => [s.occupant, s.replacements])]))
    if (physErrors.length === 0 && !seen.has(fingerprint)) {
      seen.add(fingerprint)
      candidates.push({
        id: `branch_${branchIdx + 1}`,
        name: `分子分支 ${branchIdx + 1}: ${appliedAtoms.map((id) => ATOMIC_UNITS.find((a) => a.id === id)?.name ?? id).join(' + ')}`,
        workspace: ws,
        appliedAtoms,
        staticScore: 0,
        simScore: null,
        diagnostics: [],
        confPolicy,
      })
    }
  }

  if (!candidates.length) {
    const fallback = buildSingletonFallback(base, inventory, lockedPositions)
    if (fallback) candidates.push({ id: 'singleton_fallback', name: '实际练度散件排班', workspace: fallback,
      appliedAtoms: [], staticScore: 0, simScore: null, diagnostics: [], confPolicy: {} })
  }
  return candidates
}

/**
 * Evaluates molecular candidates using dynamic 24h warmup + 72h sample simulation (82 score formula)
 * and returns ranked candidates.
 */
export function evaluateMolecularCandidates(
  candidates: MolecularCandidate[],
  entries: readonly OwnedOperatorInput[],
  options: {
    warmupHours?: number
    sampleHours?: number
    droneTarget?: 'gold' | 'exp' | 'trading' | 'none'
    seed?: number
    onProgress?: (index: number, total: number, bestScore: number) => void
  } = {},
): MolecularCandidate[] {
  const warmupHours = options.warmupHours ?? 24
  const sampleHours = options.sampleHours ?? 72
  const droneTarget = options.droneTarget ?? 'gold'
  const seed = options.seed ?? 42

  let bestScore = 0

  for (let idx = 0; idx < candidates.length; idx++) {
    const candidate = candidates[idx]!
    const simResponse = runScheduleSimulationBridge(
      candidate.workspace,
      {
        warmupHours,
        sampleHours,
        maxStepHours: 0.25,
        production: {
          outputMode: 'potential',
          runOrderMode: 'ideal',
          droneTarget,
          seed,
        },
        operatorInventory: [...entries],
      },
      {
        restingThreshold: 0.65,
        operationDurationHours: 0,
      },
    )

    if (simResponse.report?.success && simResponse.report.production?.success) {
      const rep = simResponse.report
      if (rep.production?.sample.completed) {
        const prodScore = scoreProduction(rep.production.sample.completed, rep.observedHours)
        candidate.simScore = prodScore.total
      } else {
        candidate.simScore = 0
      }
    } else {
      candidate.simScore = 0
      if (simResponse.error) {
        candidate.diagnostics.push(simResponse.error)
      }
      if (simResponse.report?.diagnostics) {
        for (const d of simResponse.report.diagnostics) {
          candidate.diagnostics.push(`[${d.code}] ${d.message}`)
        }
      }
    }

    if ((candidate.simScore ?? 0) > bestScore) {
      bestScore = candidate.simScore ?? 0
    }

    options.onProgress?.(idx + 1, candidates.length, bestScore)
  }

  candidates.sort((a, b) => (b.simScore ?? 0) - (a.simScore ?? 0))
  return candidates
}
