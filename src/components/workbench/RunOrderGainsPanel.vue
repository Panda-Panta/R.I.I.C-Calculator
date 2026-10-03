<script setup lang="ts">
import { computed, ref } from 'vue'
import type { QualityRule } from '../../domain/types'
import type { ProductionWeights } from '../../domain/productionWeights'
import type { OperatorContext } from '../../domain/operatorContext'
import type { RosterWorkspace } from '../../workbench/model'
import { createDefaultConfig } from '../../domain/defaults'
import { OPERATOR_MAP } from '../../domain/operators'
import { compileMainPlanToAppConfig } from '../../workbench/adapter'
import { evaluateOperators } from '../../engine/operatorRules'
import { calculateRunOrderGains, type RunOrderGain } from '../../optimizer/runOrderGains'

const props = defineProps<{
  weights?: ProductionWeights
  workspace?: RosterWorkspace
  operatorContext?: OperatorContext
}>()

const manualLevel = ref(3)
const manualQuality = ref<QualityRule>('normal')
const manualEfficiency = ref(200)
const efficiencyDraft = ref('200')
const efficiencyError = ref(false)
const qualityLabels: Record<QualityRule, string> = { normal: '普通', alpha: 'α', beta: 'β' }

const stationSnapshots = computed(() => {
  if (!props.workspace) return []
  const config = compileMainPlanToAppConfig(props.workspace.mainPlan, props.workspace, createDefaultConfig())
  config.operatorRecords = props.operatorContext?.operatorRecords
  return config.rooms
    .filter(room => room.type === 'trading' && room.strategy === 'gold' && room.operatorIds.length > 0)
    .map(room => {
      const evaluated = evaluateOperators(room, config)
      return {
        id: room.id,
        level: room.level,
        quality: evaluated.quality,
        efficiency: evaluated.efficiencyPercent,
        names: room.operatorIds.map(id => OPERATOR_MAP.get(id)?.name ?? id),
        unquantified: evaluated.unquantifiedSkills,
      }
    })
})

const previews = computed(() => {
  const stations = stationSnapshots.value.length > 0
    ? stationSnapshots.value
    : [{ id: 'manual', level: manualLevel.value, quality: manualQuality.value, efficiency: manualEfficiency.value, names: [] as string[], unquantified: [] as string[] }]
  return stations.map(station => {
    let rows: RunOrderGain[] = []
    let error = ''
    try {
      rows = calculateRunOrderGains(station.level, station.quality, station.efficiency / 100, props.weights)
    } catch (cause) {
      error = `暂无法计算加权收益：${cause instanceof Error ? cause.message : String(cause)}`
    }
    return { ...station, rows, error }
  })
})

function updateEfficiency(event: Event): void {
  const value = (event.target as HTMLInputElement).value
  efficiencyDraft.value = value
  const numeric = Number(value)
  efficiencyError.value = value.trim() === '' || !Number.isFinite(numeric) || numeric <= 0
  if (!efficiencyError.value) manualEfficiency.value = numeric
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`
}

function gainLabel(row: RunOrderGain): string {
  if (!row.allowed) return '仅三级站'
  if (row.gainPercent === null) return `${signed(row.delta)} 分/日`
  return `${signed(row.gainPercent)}%`
}
</script>

<template>
  <div class="run-order-gains-panel" data-test="run-order-gains-panel">
    <p class="preview-description">以相同主班、固定品质分布和总接单效率，对比无跑单的常规订单；按期望报酬 ÷ 期望用时折算日加权分，不含无人机与轮班波动。</p>

    <div v-if="stationSnapshots.length === 0" class="manual-controls" data-test="manual-run-order-preview">
      <p class="manual-note">当前没有已配置主班的贵金属贸易站，可手动预览：</p>
      <label class="preview-control">
        <span>贸易站等级</span>
        <select v-model.number="manualLevel" data-test="preview-level">
          <option :value="1">1 级</option><option :value="2">2 级</option><option :value="3">3 级</option>
        </select>
      </label>
      <label class="preview-control">
        <span>订单品质</span>
        <select v-model="manualQuality" data-test="preview-quality">
          <option value="normal">普通</option><option value="alpha">α</option><option value="beta">β</option>
        </select>
      </label>
      <label class="preview-control">
        <span>总接单效率 E（%）</span>
        <input type="number" min="0.01" step="any" data-test="preview-efficiency" :value="efficiencyDraft" :aria-invalid="efficiencyError ? 'true' : 'false'" @input="updateEfficiency" />
      </label>
      <span v-if="efficiencyError" class="preview-error" data-test="preview-efficiency-error" role="alert">总接单效率须为大于 0 的有限数；预览保留上次有效值。</span>
      <span class="manual-hint">E 包含基础 100%、进驻、中枢及主班技能加成。</span>
    </div>

    <section v-for="preview in previews" :key="preview.id" class="station-preview" :data-station="preview.id">
      <div class="station-heading">
        <strong>{{ preview.id === 'manual' ? '理论预览' : `${preview.id} 主班快照` }}</strong>
        <span>{{ preview.level }} 级 · {{ qualityLabels[preview.quality] }}品质 · E = {{ preview.efficiency.toFixed(1) }}%</span>
        <span v-if="preview.names.length" class="station-names">{{ preview.names.join(' / ') }}</span>
      </div>
      <p v-if="preview.error" class="preview-warning" role="status">{{ preview.error }}</p>
      <p v-else class="baseline-score">无跑单基础：{{ preview.rows[0]?.baselineScore.toFixed(2) }} 分/日</p>
      <p v-if="preview.level < 3 && preview.quality !== 'normal'" class="preview-warning" data-test="low-level-quality-model">一级、二级 α/β 品质采用固定模型：2 / 3 / 4 赤金订单概率，α 为 15% / 30% / 55%，β 为 5% / 10% / 85%。低等级分布未经游戏实测核验。</p>
      <div v-if="!preview.error" class="gain-table-scroll">
        <table class="gain-table">
          <thead><tr><th scope="col">跑单方案</th><th scope="col">加权分/日</th><th scope="col">相对常规订单</th></tr></thead>
          <tbody>
            <tr v-for="row in preview.rows" :key="row.key" data-test="run-order-gain-row" :data-choice="row.key" :aria-disabled="row.allowed ? 'false' : 'true'" :class="{ unavailable: !row.allowed }">
              <th scope="row">{{ row.label }}</th>
              <td>{{ row.allowed ? row.score.toFixed(2) : '—' }}</td>
              <td :class="{ positive: row.allowed && row.delta > 0, negative: row.allowed && row.delta < 0 }">{{ gainLabel(row) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="preview.rows[0]?.baselineScore === 0" class="zero-baseline-note">基础加权分为 0，无法计算相对百分比，改为显示绝对加权增益。</p>
      <p v-if="preview.unquantified.length" class="preview-warning">主班仍有未量化技能：{{ preview.unquantified.join('、') }}。预览使用当前可计算的效率。</p>
    </section>

    <div class="preview-notes">
      <p>00 / 02 / 20 / 22 依次表示龙舌兰 / 但书的精英阶段；1、2 级站禁用组合与龙舌兰，龙舌兰在低等级站无效果。表中精 0 / 精 2 是理论技能档位，不代表已持有或已解锁。</p>
      <p>佩佩仅在没有其他已解锁可用跑单干员时自动兜底；其订单固定 E = 100%。可露希尔的 +10% 接单效率不计入理想替补。</p>
      <p>百分比是该贸易站的加权跑单贡献，不是整个基建的增益；主班快照取当前排班的初始状态。</p>
    </div>
  </div>
</template>

<style scoped>
.preview-description, .preview-notes, .manual-note, .manual-hint, .baseline-score, .zero-baseline-note { color: #8da5ac; font-size: 12px; line-height: 1.6; }
.preview-description { margin: 0 0 14px; }
.manual-controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; padding: 12px; margin-bottom: 16px; background: rgba(255, 255, 255, .03); border-radius: 4px; }
.manual-note, .manual-hint { flex-basis: 100%; margin: 0; }
.preview-control { flex: 1; min-width: 150px; display: flex; flex-direction: column; gap: 6px; color: rgba(255, 255, 255, .75); font-size: 12px; }
.preview-control input, .preview-control select { height: 32px; padding: 0 10px; background: #242428; border: 1px solid rgba(255, 255, 255, .15); border-radius: 4px; color: #fff; font-size: 13px; outline: none; box-sizing: border-box; width: 100%; }
.preview-control input:focus, .preview-control select:focus { border-color: #42d6c7; }
.preview-control input[aria-invalid="true"] { border-color: #e29b80; }
.preview-error, .preview-warning { color: #e29b80; font-size: 12px; line-height: 1.6; }
.preview-error { flex-basis: 100%; }
.station-preview + .station-preview { margin-top: 20px; }
.station-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; font-size: 12px; color: #8da5ac; }
.station-heading strong { color: #fff; font-size: 13px; }
.station-names { color: rgba(255, 255, 255, .75); }
.baseline-score { margin: 6px 0 10px; }
.gain-table-scroll { overflow-x: auto; }
.gain-table { width: 100%; border-collapse: collapse; min-width: 410px; font-size: 12px; color: rgba(255, 255, 255, .85); font-variant-numeric: tabular-nums; }
.gain-table th, .gain-table td { padding: 8px 10px; border-bottom: 1px solid rgba(255, 255, 255, .07); text-align: right; white-space: nowrap; }
.gain-table th:first-child { text-align: left; }
.gain-table tbody th { font-weight: 400; }
.gain-table thead { background: rgba(255, 255, 255, .04); color: #8da5ac; }
.gain-table tr.unavailable { color: rgba(255, 255, 255, .3); }
.positive { color: #42d6c7; }
.negative { color: #e29b80; }
.zero-baseline-note { margin: 8px 0; }
.preview-notes { margin-top: 14px; }
.preview-notes p { margin: 6px 0; }
</style>
