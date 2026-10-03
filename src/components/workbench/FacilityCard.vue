<template>
  <div
    :class="[
      'facility-card',
      `facility-${cardVariant}`,
      `size-${cardVariant}`,
      `variant-${cardVariant}`,
      cardVariant === 'output' ? 'facility-3' : cardVariant === 'center' ? 'facility-5' : 'facility-2',
      colorClass,
      {
        true: isSelected,
        'is-selected': isSelected,
        waiting: isWaiting,
        draggable: isOutputRoom && !isWaiting,
      },
    ]"
    :data-room-id="facility.roomId"
    :data-variant="cardVariant"
    :draggable="isOutputRoom && !isWaiting ? 'true' : 'false'"
    role="button"
    tabindex="0"
    :aria-label="ariaLabel"
    :aria-selected="isSelected ? 'true' : 'false'"
    @click="onClick"
    @keydown="onKeyDown"
    @dragstart="onDragStart"
    @dragover="onDragOver"
    @dragenter="onDragEnter"
    @drop="onDrop"
  >
    <!-- Product Watermark (manufacture & trading) -->
    <div
      v-if="productUrl"
      class="product-bg"
      :style="{ backgroundImage: `url(${productUrl})` }"
    ></div>

    <!-- Facility Content -->
    <div v-if="!isWaiting" class="card-content">
      <div v-if="facility.roomId === 'train'" class="facility-name facility-name-train">
        <div>协助位</div>
        <div>训练位</div>
      </div>
      <div v-else class="facility-name">
        {{ facilityDisplayName }}
      </div>

      <div class="avatars">
        <div
          v-for="(slot, idx) in displayedSlots"
          :key="getSlotKey(slot.occupant, idx)"
          class="avatar-wrapper"
        >
          <img
            v-if="!imageErrors[getSlotKey(slot.occupant, idx)]"
            :src="getAvatarSrc(slot.occupant)"
            :alt="getAvatarAlt(slot.occupant)"
            width="45"
            height="45"
            :style="{ 'border-bottom': getGroupBorder(slot.groupId) }"
            draggable="false"
            @error="onImageError(getSlotKey(slot.occupant, idx))"
          />
          <div
            v-else
            class="avatar-fallback"
            :style="{ 'border-bottom': getGroupBorder(slot.groupId) }"
            :title="getAvatarAlt(slot.occupant)"
          >
            {{ getAvatarAlt(slot.occupant) }}
          </div>
        </div>
      </div>
    </div>

    <!-- Unbuilt State -->
    <div v-else class="waiting-box">
      <div>待建造</div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Derivative work based on arknights-mower (PlanEditor.vue)
 * Original work Copyright (c) 2021 Nano
 * Licensed under the MIT License
 */

import { computed, ref } from 'vue'
import { OPERATOR_MAP } from '../../domain/operators'
import { getOperatorAvatarUrl, resolveAssetUrl } from '../../workbench/operatorHelpers'
import {
  MOWER_OUTPUT_ROOM_IDS,
  type MowerFacility,
  type MowerOccupant,
  type MowerOutputRoomId,
  type MowerRoomId,
} from '../../workbench/model'

const props = withDefaults(
  defineProps<{
    facility: MowerFacility
    isSelected?: boolean
    variant?: 'output' | 'center' | 'support'
    size?: 'output' | 'center' | 'support'
  }>(),
  {
    isSelected: false,
  },
)

const emit = defineEmits<{
  (e: 'select', roomId: MowerRoomId): void
  (e: 'swap', fromRoomId: MowerOutputRoomId, toRoomId: MowerOutputRoomId): void
}>()

const imageErrors = ref<Record<string, boolean>>({})

const isOutputRoom = computed(() => {
  return (MOWER_OUTPUT_ROOM_IDS as readonly string[]).includes(props.facility.roomId)
})

const cardVariant = computed<'output' | 'center' | 'support'>(() => {
  if (props.variant) return props.variant
  if (props.size) return props.size
  if (props.facility.roomId.startsWith('room_')) return 'output'
  if (props.facility.roomId === 'central' || props.facility.roomId.startsWith('dormitory_')) return 'center'
  return 'support'
})

const isWaiting = computed(() => {
  if (props.facility.level === 0) return true
  if (!isOutputRoom.value) return false
  return !props.facility.type
})

const colorClass = computed(() => {
  if (!isOutputRoom.value) return ''
  const t: string = props.facility.type
  if (t === 'trading' || t === '贸易站') return 'info'
  if (t === 'manufacture' || t === '制造站') return 'warning'
  if (t === 'power' || t === '发电站') return 'primary'
  return ''
})

const facilityDisplayName = computed(() => {
  const id = props.facility.roomId
  if (id === 'central') return '控制中枢'
  if (id === 'dormitory_1') return '宿舍1'
  if (id === 'dormitory_2') return '宿舍2'
  if (id === 'dormitory_3') return '宿舍3'
  if (id === 'dormitory_4') return '宿舍4'
  if (id === 'meeting') return '会客室'
  if (id === 'factory') return '加工站'
  if (id === 'contact') return '办公室'
  if (id === 'train') return '训练室'

  const t: string = props.facility.type
  if (t === 'manufacture' || t === '制造站') return '制造站'
  if (t === 'trading' || t === '贸易站') return '贸易站'
  if (t === 'power' || t === '发电站') return '发电站'
  return ''
})

const ariaLabel = computed(() => {
  const name = facilityDisplayName.value || (isWaiting.value ? '待建造' : props.facility.roomId)
  return `${name} (${props.facility.roomId})`
})

const productUrl = computed(() => {
  const t: string = props.facility.type
  if (t !== 'manufacture' && t !== '制造站' && t !== 'trading' && t !== '贸易站') {
    return ''
  }
  const p = props.facility.product as string | undefined
  if (!p) return ''
  let filename = p
  if (p === 'gold') filename = 'gold'
  else if (p === 'exp' || p === 'exp3') filename = 'exp3'
  else if (p === 'fragment' || p === 'orirock') filename = 'orirock'
  else if (p === 'money' || p === 'lmd') filename = 'lmd'
  else if (p === 'orundum') filename = 'orundum'
  return resolveAssetUrl(`product/${filename}.png`)
})

const displayedSlots = computed(() => {
  if (!props.facility.slots) return []
  return props.facility.slots.filter((slot) => slot.occupant && slot.occupant.kind !== 'empty')
})

function getAvatarSrc(occupant: MowerOccupant): string {
  if (occupant.kind === 'free') return getOperatorAvatarUrl('Free')
  if (occupant.kind === 'current') return getOperatorAvatarUrl('Current')
  if (occupant.kind === 'operator') {
    return getOperatorAvatarUrl(occupant.operatorId)
  }
  return ''
}

function getAvatarAlt(occupant: MowerOccupant): string {
  if (occupant.kind === 'free') return 'Free'
  if (occupant.kind === 'current') return 'Current'
  if (occupant.kind === 'operator') {
    const rawId = occupant.operatorId
    const op = OPERATOR_MAP.get(rawId)
    return op ? op.name : rawId
  }
  return ''
}

function getGroupBorder(groupId?: string | null): string {
  if (!groupId) return 'none'
  let hash = 0
  for (let i = 0; i < groupId.length; i++) {
    hash = (hash << 5) - hash + groupId.charCodeAt(i)
    hash |= 0
  }
  const hue = Math.abs(hash) % 360
  return `5px solid hsl(${hue}, 80%, 45%)`
}

function getSlotKey(occupant: MowerOccupant, idx: number): string {
  const id = occupant.kind === 'operator' ? occupant.operatorId : occupant.kind
  return `${props.facility.roomId}:${idx}:${id}`
}

function onImageError(key: string) {
  imageErrors.value[key] = true
}

function onClick() {
  emit('select', props.facility.roomId)
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key === 'Enter' || event.key === ' ' || event.code === 'Space') {
    event.preventDefault()
    emit('select', props.facility.roomId)
  }
}

function onDragStart(event: DragEvent) {
  if (!isOutputRoom.value || isWaiting.value) {
    return
  }
  if (event.dataTransfer) {
    event.dataTransfer.setData('text/plain', props.facility.roomId)
    event.dataTransfer.dropEffect = 'move'
  }
}

function onDragOver(event: DragEvent) {
  if (!isOutputRoom.value || isWaiting.value) return
  event.preventDefault()
}

function onDragEnter(event: DragEvent) {
  if (!isOutputRoom.value || isWaiting.value) return
  event.preventDefault()
}

function onDrop(event: DragEvent) {
  if (!isOutputRoom.value || isWaiting.value) return
  event.preventDefault()
  if (!event.dataTransfer) return
  const sourceRoom = event.dataTransfer.getData('text/plain')
  if (
    sourceRoom &&
    sourceRoom !== props.facility.roomId &&
    (MOWER_OUTPUT_ROOM_IDS as readonly string[]).includes(sourceRoom as MowerOutputRoomId)
  ) {
    emit('swap', sourceRoom as MowerOutputRoomId, props.facility.roomId as MowerOutputRoomId)
  }
}
</script>
