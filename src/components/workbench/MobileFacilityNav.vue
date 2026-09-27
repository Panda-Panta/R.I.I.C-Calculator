<template>
  <div class="mobile-facility-nav" data-test="mobile-facility-nav">
    <div class="nav-header">
      <div class="header-left">
        <span class="nav-icon">📍</span>
        <span class="nav-title">设施快速切换</span>
        <span class="current-selected-label">当前: {{ currentRoomLabel }}</span>
      </div>
      <div class="category-tabs" role="tablist">
        <button
          v-for="cat in categories"
          :key="cat.key"
          type="button"
          class="cat-tab-btn"
          :class="{ active: activeCategory === cat.key }"
          :data-test="`cat-tab-${cat.key}`"
          @click="activeCategory = cat.key"
        >
          {{ cat.label }}
        </button>
      </div>
    </div>

    <!-- Facility Chips Carousel / Grid -->
    <div class="chips-scroll-container">
      <div class="chips-list">
        <button
          v-for="item in currentCategoryFacilities"
          :key="item.roomId"
          type="button"
          class="facility-chip"
          :class="[
            `type-${item.type}`,
            { active: store.selectedRoomId === item.roomId }
          ]"
          :data-test="`facility-chip-${item.roomId}`"
          @click="handleSelectRoom(item.roomId)"
        >
          <div class="chip-top">
            <span class="chip-code">{{ item.shortCode }}</span>
            <span class="chip-staff">{{ item.staffCount }}/{{ item.capacity }}</span>
          </div>
          <div class="chip-bottom">
            <span class="chip-name">{{ item.name }}</span>
            <span v-if="item.productLabel" class="chip-product">{{ item.productLabel }}</span>
          </div>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRosterWorkbenchStore } from '../../workbench/store'
import type { MowerRoomId, MowerFacility } from '../../workbench/model'

const store = useRosterWorkbenchStore()

const emit = defineEmits<{
  (e: 'select-room', roomId: MowerRoomId): void
}>()

const activeCategory = ref<'output' | 'central_dorm' | 'support'>('output')

const categories = [
  { key: 'output' as const, label: '产出 (B101~B303)' },
  { key: 'central_dorm' as const, label: '中枢与宿舍' },
  { key: 'support' as const, label: '副设施 (4间)' },
]

interface FacilityChipData {
  roomId: MowerRoomId
  shortCode: string
  name: string
  type: string
  productLabel?: string
  staffCount: number
  capacity: number
}

const OUTPUT_ROOM_CODES: Record<string, string> = {
  room_1_1: 'B101',
  room_1_2: 'B102',
  room_1_3: 'B103',
  room_2_1: 'B201',
  room_2_2: 'B202',
  room_2_3: 'B203',
  room_3_1: 'B301',
  room_3_2: 'B302',
  room_3_3: 'B303',
}

function getFacilityInfo(roomId: MowerRoomId, fac?: MowerFacility): FacilityChipData {
  if (!fac) {
    return {
      roomId,
      shortCode: OUTPUT_ROOM_CODES[roomId] || roomId,
      name: roomId,
      type: 'unknown',
      staffCount: 0,
      capacity: 0,
    }
  }

  const staffCount = fac.slots.filter(s => s.occupant.kind === 'operator').length
  const capacity = fac.slots.length

  if (OUTPUT_ROOM_CODES[roomId]) {
    const code = OUTPUT_ROOM_CODES[roomId]!
    let name = '制造站'
    let productLabel = ''
    if (fac.type === 'trading') {
      name = '贸易站'
      productLabel = fac.product === 'fragment' ? '合成玉' : '赤金'
    } else if (fac.type === 'power') {
      name = '发电站'
      productLabel = '电力'
    } else {
      if (fac.product === 'exp') productLabel = '作战记录'
      else if (fac.product === 'fragment') productLabel = '源石碎片'
      else productLabel = '赤金'
    }
    return {
      roomId,
      shortCode: code,
      name,
      type: fac.type,
      productLabel,
      staffCount,
      capacity,
    }
  }

  if (roomId === 'central') {
    return {
      roomId,
      shortCode: '中枢',
      name: '控制中枢',
      type: 'central',
      staffCount,
      capacity,
    }
  }

  if (roomId.startsWith('dormitory_')) {
    const num = roomId.replace('dormitory_', '')
    return {
      roomId,
      shortCode: `宿${num}`,
      name: `宿舍 ${num}`,
      type: 'dormitory',
      staffCount,
      capacity,
    }
  }

  const rightNames: Record<string, string> = {
    meeting: '会客室',
    factory: '加工站',
    contact: '办公室',
    train: '训练室',
  }
  const rightCodes: Record<string, string> = {
    meeting: '会客',
    factory: '加工',
    contact: '公招',
    train: '训练',
  }

  return {
    roomId,
    shortCode: rightCodes[roomId] || roomId,
    name: rightNames[roomId] || roomId,
    type: fac.type || 'support',
    staffCount,
    capacity,
  }
}

const currentRoomLabel = computed(() => {
  const currentId = store.selectedRoomId
  if (!currentId) return '未选择'
  const fac = store.workspace.mainPlan.facilities[currentId]
  const info = getFacilityInfo(currentId, fac)
  return `${info.shortCode} ${info.name}`
})

const outputFacilities = computed(() => {
  const ids: MowerRoomId[] = [
    'room_1_1', 'room_1_2', 'room_1_3',
    'room_2_1', 'room_2_2', 'room_2_3',
    'room_3_1', 'room_3_2', 'room_3_3',
  ]
  return ids.map(id => getFacilityInfo(id, store.workspace.mainPlan.facilities[id]))
})

const centralDormFacilities = computed(() => {
  const ids: MowerRoomId[] = ['central', 'dormitory_1', 'dormitory_2', 'dormitory_3', 'dormitory_4']
  return ids.map(id => getFacilityInfo(id, store.workspace.mainPlan.facilities[id]))
})

const supportFacilities = computed(() => {
  const ids: MowerRoomId[] = ['meeting', 'factory', 'contact', 'train']
  return ids.map(id => getFacilityInfo(id, store.workspace.mainPlan.facilities[id]))
})

const currentCategoryFacilities = computed(() => {
  if (activeCategory.value === 'output') return outputFacilities.value
  if (activeCategory.value === 'central_dorm') return centralDormFacilities.value
  return supportFacilities.value
})

function handleSelectRoom(roomId: MowerRoomId) {
  store.selectRoom(roomId)
  emit('select-room', roomId)
}
</script>

<style scoped>
.mobile-facility-nav {
  width: 100%;
  max-width: 980px;
  margin: 0 auto 12px;
  padding: 10px 14px;
  background: rgba(20, 25, 34, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.nav-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.nav-icon {
  font-size: 14px;
}

.nav-title {
  font-size: 13px;
  font-weight: 600;
  color: #e2e8f0;
}

.current-selected-label {
  font-size: 11px;
  color: #42d6c7;
  background: rgba(66, 214, 199, 0.12);
  padding: 2px 6px;
  border-radius: 3px;
  margin-left: 4px;
}

.category-tabs {
  display: flex;
  gap: 4px;
  background: rgba(0, 0, 0, 0.3);
  padding: 2px;
  border-radius: 4px;
}

.cat-tab-btn {
  background: transparent;
  border: none;
  color: #8da5ac;
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 3px;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.cat-tab-btn:hover {
  color: #ffffff;
  background: rgba(255, 255, 255, 0.05);
}

.cat-tab-btn.active {
  color: #071015;
  background: #42d6c7;
  font-weight: 600;
}

.chips-scroll-container {
  width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  padding-bottom: 2px;
}

.chips-list {
  display: flex;
  gap: 8px;
  min-width: min-content;
}

.facility-chip {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  width: 92px;
  min-height: 52px;
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
  text-align: left;
}

.facility-chip:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.2);
}

.facility-chip.active {
  border-color: #42d6c7;
  background: rgba(66, 214, 199, 0.15);
  box-shadow: 0 0 8px rgba(66, 214, 199, 0.3);
}

.chip-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.chip-code {
  font-size: 13px;
  font-weight: 700;
  font-family: Consolas, monospace;
  color: #ffffff;
}

.chip-staff {
  font-size: 10px;
  color: #94a3b8;
}

.chip-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  margin-top: 4px;
}

.chip-name {
  font-size: 11px;
  color: #cbd5e1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chip-product {
  font-size: 9px;
  color: #4ade80;
  background: rgba(74, 222, 128, 0.1);
  padding: 1px 3px;
  border-radius: 2px;
  white-space: nowrap;
}

/* Facility color accents */
.facility-chip.type-manufacture {
  border-left: 3px solid #f0a020;
}
.facility-chip.type-trading {
  border-left: 3px solid #38bdf8;
}
.facility-chip.type-power {
  border-left: 3px solid #eab308;
}
.facility-chip.type-central {
  border-left: 3px solid #ec4899;
}
.facility-chip.type-dormitory {
  border-left: 3px solid #a855f7;
}
.facility-chip.type-support {
  border-left: 3px solid #64748b;
}

@media (min-width: 1024px) {
  /* On wide desktop, keep it compact */
  .facility-chip {
    width: 96px;
  }
}
</style>
