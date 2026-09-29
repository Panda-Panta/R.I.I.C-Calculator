import { toRaw } from 'vue'
import { EDITION } from '../domain/edition'
import {
  MOWER_ROOM_IDS,
  type MowerFacilityType,
  type MowerProduct,
  type MowerRoomId,
  type MowerSlot,
  type RosterWorkspace,
} from './model'

export const LAYOUT_PRESETS_STORAGE_KEY = `arc-income-calculator-layout-presets-v1-${EDITION.storageNamespace}`

export interface FacilityLayout {
  type: MowerFacilityType
  level: number
  product?: MowerProduct
}

export interface LayoutPreset {
  id: string
  name: string
  facilities: Record<MowerRoomId, FacilityLayout>
}

const outputTypes: MowerFacilityType[] = ['manufacture', 'trading', 'power']
const productByType: Record<string, readonly MowerProduct[]> = {
  manufacture: ['gold', 'exp', 'fragment'],
  trading: ['money', 'orundum'],
}

function capacity(type: MowerFacilityType, level: number): number {
  if (type === 'manufacture' || type === 'trading') return level
  if (type === 'central' || type === 'dormitory') return 5
  if (type === 'meeting' || type === 'train') return 2
  return 1
}

function emptySlot(): MowerSlot {
  return { occupant: { kind: 'empty' }, groupId: null, replacements: [] }
}

export function captureFacilityLayout(workspace: RosterWorkspace): Record<MowerRoomId, FacilityLayout> {
  const layout = {} as Record<MowerRoomId, FacilityLayout>
  for (const roomId of MOWER_ROOM_IDS) {
    const { type, level, product } = workspace.mainPlan.facilities[roomId]
    layout[roomId] = product === undefined ? { type, level } : { type, level, product }
  }
  return layout
}

export function sameFacilityLayout(a: Record<MowerRoomId, FacilityLayout>, b: Record<MowerRoomId, FacilityLayout>): boolean {
  return MOWER_ROOM_IDS.every(roomId =>
    a[roomId]?.type === b[roomId]?.type &&
    a[roomId]?.level === b[roomId]?.level &&
    a[roomId]?.product === b[roomId]?.product,
  )
}

export function isValidFacilityLayout(value: unknown): value is Record<MowerRoomId, FacilityLayout> {
  if (!value || typeof value !== 'object') return false
  const rooms = value as Record<string, FacilityLayout>
  return MOWER_ROOM_IDS.every(roomId => {
    const room = rooms[roomId]
    if (!room || typeof room !== 'object') return false
    const expectedType = roomId === 'central' ? 'central'
      : roomId.startsWith('dormitory_') ? 'dormitory'
      : roomId.startsWith('gaming_') ? 'gaming'
      : roomId === 'meeting' ? 'meeting'
      : roomId === 'factory' ? 'factory'
      : roomId === 'contact' ? 'contact'
      : roomId === 'train' ? 'train' : null
    if (expectedType ? room.type !== expectedType : !outputTypes.includes(room.type)) return false
    const maxLevel = roomId === 'central' || roomId.startsWith('dormitory_') ? 5
      : roomId.startsWith('gaming_') ? 1 : 3
    if (!Number.isInteger(room.level) || room.level < 1 || room.level > maxLevel) return false
    if (room.type === 'manufacture' || room.type === 'trading') {
      return productByType[room.type]?.includes(room.product as MowerProduct) ?? false
    }
    return room.product === undefined
  })
}

export function readLayoutPresets(storage: Pick<Storage, 'getItem'>): LayoutPreset[] {
  const raw = storage.getItem(LAYOUT_PRESETS_STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const ids = new Set<string>()
    const names = new Set<string>()
    return parsed.filter((item): item is LayoutPreset => {
      if (!item || typeof item !== 'object') return false
      const candidate = item as LayoutPreset
      if (typeof candidate.id !== 'string' || !candidate.id || ids.has(candidate.id)) return false
      if (typeof candidate.name !== 'string' || !candidate.name.trim() || candidate.name.length > 32 || names.has(candidate.name)) return false
      if (!isValidFacilityLayout(candidate.facilities)) return false
      ids.add(candidate.id)
      names.add(candidate.name)
      return true
    })
  } catch {
    return []
  }
}

export function writeLayoutPresets(storage: Pick<Storage, 'setItem'>, presets: LayoutPreset[]): void {
  storage.setItem(LAYOUT_PRESETS_STORAGE_KEY, JSON.stringify(presets))
}

export function applyFacilityLayout(workspace: RosterWorkspace, layout: Record<MowerRoomId, FacilityLayout>): { workspace: RosterWorkspace; removedAssignments: number } {
  if (!isValidFacilityLayout(layout)) throw new Error('预设布局数据无效')
  const next = structuredClone(toRaw(workspace))
  let removedAssignments = 0
  for (const roomId of MOWER_ROOM_IDS) {
    const facility = next.mainPlan.facilities[roomId]
    const target = layout[roomId]
    const changed = facility.type !== target.type || facility.level !== target.level || facility.product !== target.product
    if (!changed) continue
    const slots = facility.slots
    const targetCapacity = capacity(target.type, target.level)
    for (const slot of slots.slice(targetCapacity)) {
      if (slot.occupant.kind !== 'empty' || slot.groupId || slot.replacements.length) removedAssignments++
    }
    facility.type = target.type
    facility.level = target.level
    if (target.product === undefined) delete facility.product
    else facility.product = target.product
    facility.slots = slots.slice(0, targetCapacity)
    while (facility.slots.length < targetCapacity) facility.slots.push(emptySlot())

    const metadata = next.compatibility.facilityMetadata?.[roomId]
    if (metadata) {
      if (facility.type !== workspace.mainPlan.facilities[roomId].type) delete metadata.rawName
      if (facility.product !== workspace.mainPlan.facilities[roomId].product) delete metadata.rawProduct
    }
    const present = next.compatibility.importedPresentRooms
    if (Array.isArray(present) && !present.includes(roomId)) present.push(roomId)
  }
  return { workspace: next, removedAssignments }
}
