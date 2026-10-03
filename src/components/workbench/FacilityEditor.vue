<template>
  <div v-if="selectedRoom" class="mower-facility-editor-wrapper plan-scroll-wrapper">
    <div class="mower-facility-editor plan-container">
      <!-- First row: Facility header controls -->
      <n-space justify="center" class="header-space">
        <table>
          <tbody>
            <tr>
              <td>设施类别：</td>
              <td>
                <n-select
                  v-if="isOutputRoom"
                  :value="selectedRoom.type"
                  :options="facilityTypeOptions"
                  class="type-select"
                  size="small"
                  @update:value="onTypeChange"
                />
                <span v-else class="type-select text-facility-name">{{ rightSideFacilityName }}</span>
              </td>
              <td>设施等级：</td>
              <td>
                <n-select
                  :value="selectedRoom.level"
                  :options="facilityLevelOptions"
                  class="level-select"
                  size="small"
                  @update:value="onLevelChange"
                />
              </td>
              <template v-if="['manufacture', 'trading'].includes(selectedRoom.type)">
                <td>产物</td>
                <td>
                  <n-select
                    :value="selectedRoom.product"
                    :options="productOptions"
                    class="product-select"
                    size="small"
                    :render-label="renderProductLabel"
                    @update:value="onProductChange"
                  />
                </td>
              </template>
              <td>
                <n-button
                  v-if="selectedRoom.roomId.startsWith('dorm') && selectedRoom.level > 0"
                  ghost
                  type="primary"
                  size="small"
                  class="fill-free-btn"
                  @click="fillWithFree"
                >
                  此宿舍内空位填充Free
                </n-button>
              </td>
              <td>
                <n-button
                  ghost
                  type="error"
                  size="small"
                  class="clear-btn"
                  :disabled="isFacilityEmpty"
                  @click="clearFacility"
                >
                  清空此设施内干员
                </n-button>
              </td>
            </tr>
          </tbody>
        </table>
      </n-space>

      <!-- Second row: Slots table -->
      <n-space justify="center" class="slots-space">
        <table class="slots-table">
          <tbody>
            <SlotRow
              v-for="(slot, idx) in selectedRoom.slots"
              :key="idx"
              :room-id="selectedRoom.roomId"
              :slot-index="idx"
              :slot="slot"
              @request-picker="onRequestPicker"
            />
          </tbody>
        </table>
      </n-space>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Derivative work based on arknights-mower (PlanEditor.vue)
 * Original work Copyright (c) 2021 Nano
 * Licensed under the MIT License
 */

import { computed, h, toRaw, type VNode } from 'vue'
import { NAvatar, NButton, NSelect, NSpace, type SelectOption } from 'naive-ui'
import SlotRow from './SlotRow.vue'
import { resolveAssetUrl } from '../../workbench/operatorHelpers'
import { useRosterWorkbenchStore } from '../../workbench/store'
import {
  MOWER_OUTPUT_ROOM_IDS,
  type MowerFacilityType,
  type MowerProduct,
  type MowerRoomId,
  type MowerSlot,
} from '../../workbench/model'

const emit = defineEmits<{
  (
    e: 'request-picker',
    payload: { roomId: MowerRoomId; slotIndex: number; mode: 'main' | 'replacement' },
  ): void
}>()

const store = useRosterWorkbenchStore()

const selectedRoom = computed(() => store.selectedRoom)

const isOutputRoom = computed<boolean>(() => {
  if (!selectedRoom.value) return false
  return (MOWER_OUTPUT_ROOM_IDS as readonly string[]).includes(selectedRoom.value.roomId)
})

const facilityTypeOptions = [
  { label: '制造站', value: 'manufacture' },
  { label: '贸易站', value: 'trading' },
  { label: '发电站', value: 'power' },
]

const rightSideFacilityName = computed<string>(() => {
  if (!selectedRoom.value) return ''
  const id = selectedRoom.value.roomId
  if (id === 'central') return '控制中枢'
  if (id.startsWith('dormitory') || id.startsWith('dorm')) return '宿舍'
  if (id === 'meeting') return '会客室'
  if (id === 'factory') return '加工站'
  if (id === 'contact') return '办公室'
  if (id === 'train') return '训练室'
  if (id.startsWith('gaming')) return '活动室'
  return '未知'
})

function getFacilityCapacity(type: MowerFacilityType, level: number): number {
  if (level === 0) return 0
  if (type === 'power') return 1
  if (type === 'manufacture' || type === 'trading') return Math.max(1, level)
  if (type === 'central' || type === 'dormitory') return 5
  if (type === 'meeting') return 2
  if (type === 'factory' || type === 'contact') return 1
  if (type === 'train') return 2
  if (type === 'gaming') return 1
  return 1
}

function createEmptySlots(count: number): MowerSlot[] {
  return Array.from({ length: count }, () => ({
    occupant: { kind: 'empty' as const },
    groupId: null,
    replacements: [],
  }))
}

function toRawDeep<T>(val: T): T {
  const raw = toRaw(val)
  if (Array.isArray(raw)) {
    return raw.map((item) => toRawDeep(item)) as unknown as T
  }
  if (raw !== null && typeof raw === 'object') {
    const res: Record<string, unknown> = {}
    for (const key of Reflect.ownKeys(raw as Record<string, unknown>)) {
      if (typeof key === 'string') {
        res[key] = toRawDeep((raw as Record<string, unknown>)[key])
      }
    }
    return res as T
  }
  return raw
}

function safeClone<T>(val: T): T {
  return structuredClone(toRawDeep(val))
}

function adjustSlots(slots: MowerSlot[], targetCap: number): MowerSlot[] {
  const plainSlots: MowerSlot[] = safeClone(slots)
  if (plainSlots.length === targetCap) return plainSlots
  if (plainSlots.length > targetCap) {
    return plainSlots.slice(0, targetCap)
  }
  return [...plainSlots, ...createEmptySlots(targetCap - plainSlots.length)]
}

const facilityLevelOptions = computed(() => {
  if (!selectedRoom.value) return []
  const id = selectedRoom.value.roomId
  const type = selectedRoom.value.type

  let maxLevel = 3
  if (id === 'central' || id.startsWith('dorm') || type === 'central' || type === 'dormitory') {
    maxLevel = 5
  } else if (id.startsWith('gaming') || type === 'gaming') {
    maxLevel = 1
  } else {
    maxLevel = 3
  }

  return [{ label: '未建造', value: 0 }, ...Array.from({ length: maxLevel }, (_, i) => ({
    label: `${i + 1}级`,
    value: i + 1,
  }))]
})

const productOptions = computed(() => {
  if (!selectedRoom.value) return []
  if (selectedRoom.value.type === 'manufacture') {
    return [
      { label: '赤金', value: 'gold', icon: resolveAssetUrl('product/gold.png') },
      { label: '中级作战记录', value: 'exp', icon: resolveAssetUrl('product/exp3.png') },
      { label: '源石碎片', value: 'fragment', icon: resolveAssetUrl('product/orirock.png') },
    ]
  }
  if (selectedRoom.value.type === 'trading') {
    return [
      { label: '赤金订单', value: 'money', icon: resolveAssetUrl('product/lmd.png') },
      { label: '合成玉订单', value: 'orundum', icon: resolveAssetUrl('product/orundum.png') },
    ]
  }
  return []
})

function renderProductLabel(option: SelectOption): VNode {
  let iconSrc = typeof option.icon === 'string' ? option.icon : undefined
  if (!iconSrc) {
    if (option.value === 'gold') iconSrc = resolveAssetUrl('product/gold.png')
    else if (option.value === 'exp') iconSrc = resolveAssetUrl('product/exp3.png')
    else if (option.value === 'fragment') iconSrc = resolveAssetUrl('product/orirock.png')
    else if (option.value === 'money') iconSrc = resolveAssetUrl('product/lmd.png')
    else if (option.value === 'orundum') iconSrc = resolveAssetUrl('product/orundum.png')
  }

  return h(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      },
    },
    [
      iconSrc
        ? h(NAvatar, {
            src: iconSrc,
            round: true,
            size: 'small',
          })
        : null,
      String(option.label ?? ''),
    ],
  )
}

function onTypeChange(newType: MowerFacilityType): void {
  if (!selectedRoom.value) return
  const currentLevel = selectedRoom.value.level
  const targetCap = getFacilityCapacity(newType, currentLevel)
  const newSlots = adjustSlots(selectedRoom.value.slots, targetCap)

  let product: MowerProduct | undefined = selectedRoom.value.product
  if (newType === 'manufacture') {
    if (product !== 'gold' && product !== 'exp' && product !== 'fragment') {
      product = 'gold'
    }
  } else if (newType === 'trading') {
    if (product !== 'money' && product !== 'orundum') {
      product = 'money'
    }
  } else {
    product = undefined
  }

  store.updateFacility(selectedRoom.value.roomId, {
    type: newType,
    product,
    slots: newSlots,
  })
}

function onLevelChange(newLevel: number): void {
  if (!selectedRoom.value) return
  const currentType = selectedRoom.value.type
  const targetCap = getFacilityCapacity(currentType, newLevel)
  const newSlots = adjustSlots(selectedRoom.value.slots, targetCap)

  store.updateFacility(selectedRoom.value.roomId, {
    level: newLevel,
    slots: newSlots,
  })
}

function onProductChange(newProduct: MowerProduct): void {
  if (!selectedRoom.value) return
  store.updateFacility(selectedRoom.value.roomId, { product: newProduct })
}

function fillWithFree(): void {
  if (!selectedRoom.value) return
  const roomId = selectedRoom.value.roomId
  const slots = selectedRoom.value.slots
  slots.forEach((slot, idx) => {
    if (slot.occupant.kind === 'empty') {
      store.updateSlotOccupant(roomId, idx, { kind: 'free' })
    }
  })
}

function clearFacility(): void {
  if (!selectedRoom.value) return
  const roomId = selectedRoom.value.roomId
  const slots = selectedRoom.value.slots
  slots.forEach((slot, idx) => {
    const rawMetadata = slot.metadata
      ? (safeClone(slot.metadata) as Record<string, unknown>)
      : undefined
    store.updateSlot(roomId, idx, {
      occupant: { kind: 'empty' },
      groupId: null,
      replacements: [],
      ...(rawMetadata ? { metadata: rawMetadata } : {}),
    })
  })
}

const isFacilityEmpty = computed<boolean>(() => {
  if (!selectedRoom.value) return true
  return selectedRoom.value.slots.every((slot) => slot.occupant.kind === 'empty')
})

function onRequestPicker(payload: {
  roomId: MowerRoomId
  slotIndex: number
  mode: 'main' | 'replacement'
}): void {
  emit('request-picker', payload)
}
</script>
