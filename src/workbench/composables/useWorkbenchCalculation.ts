import { mowerAdvancedAssumptions } from '../../scheduler/mowerAdvancedSettings'
import { computed, onBeforeUnmount, ref, toRaw, watch, type ComputedRef } from 'vue'
import { parseOperatorInventory, type OwnedOperatorInput } from '../../domain/operatorInventory'
import { normalizeProductionWeights } from '../../domain/productionWeights'
import { normalizeSimulationInventory } from '../../domain/simulationInventory'
import { workspaceUsesInventoryConditions } from '../../scheduler/backupInventory'
import type { CalculationWorkerMessage, CalculationProgress } from '../calculationWorker'
import type { CalculationConfig } from '../settings'
import type { WorkbenchSession } from '../session'
import type { useRosterWorkbenchStore } from '../store'
import type { ValidationResult } from '../validate'
import { createCalculationBottleneckTracker, type CalculationBottleneckSummary, type CalculationOutcome } from '../calculationBottlenecks'
import type { SimulationActivity } from '../../simulator/simulationActivity'
import { createCalculationResultReceiver } from '../calculationResultTransport'

export interface CalculationSilence {
  seconds: number
  lastProgressSeconds: number | null
  observation?: { activity: SimulationActivity; receivedSeconds: number }
}

/** Owns independent income calculation, cancellation and stale worker messages. */
export function useWorkbenchCalculation(store: ReturnType<typeof useRosterWorkbenchStore>, session: WorkbenchSession, validationResult: ComputedRef<ValidationResult>) {
  const { simSettings, operatorInventory, isCalculating, isGeneratingRoster, calculationReport, calculationError, calculationStatus, simulationReport, timelineData } = session
  const calculationConfigOpen = ref(false)
  const calculationProgress = ref<CalculationProgress | null>(null)
  const calculationElapsed = ref(0)
  const calculationSilence = ref<CalculationSilence | null>(null)
  const calculationBottleneckSummary = ref<CalculationBottleneckSummary | null>(null)
  let bottleneckTracker: ReturnType<typeof createCalculationBottleneckTracker> | undefined
  let calculationStarted = 0
  let calculationWorker: Worker | null = null
  let calculationTimer: ReturnType<typeof setInterval> | undefined
  const calculationTiming = computed(() => {
    const seconds = Math.floor(calculationElapsed.value)
    const elapsed = seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
    if (calculationSilence.value || calculationProgress.value?.activity?.status === 'slow') return `已用 ${elapsed} · 暂无法估算剩余时间`
    const fraction = calculationProgress.value?.fraction ?? 0
    if (fraction >= .99) return `已用 ${elapsed} · 即将完成`
    if (seconds < 3 || fraction < .01) return `已用 ${elapsed} · 剩余时间估算中`
    const remaining = Math.max(1, Math.ceil(seconds * (1 - fraction) / fraction))
    return `已用 ${elapsed} · 约剩余 ${remaining < 60 ? `${remaining} 秒` : `${Math.ceil(remaining / 60)} 分钟`}`
  })

  function stopCalculation(outcome?: CalculationOutcome): void {
    if (outcome && bottleneckTracker) {
      calculationBottleneckSummary.value = bottleneckTracker.finish({
        outcome, elapsedSeconds: (performance.now() - calculationStarted) / 1000,
        error: calculationError.value ?? undefined, diagnostics: simulationReport.value?.diagnostics,
      })
    }
    bottleneckTracker = undefined
    const worker = calculationWorker
    calculationWorker = null
    if (worker) {
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
    }
    worker?.terminate()
    clearInterval(calculationTimer)
    calculationTimer = undefined
    isCalculating.value = false
    calculationProgress.value = null
    calculationSilence.value = null
  }
  function handleAbortCalculation(): void {
    stopCalculation('cancelled')
    calculationStatus.value = '已中止产出计算，可重新开始。'
  }
  watch(() => store.workspace, () => {
    if (isCalculating.value) {
      stopCalculation('changed')
      calculationStatus.value = '排班已变更，本次产出计算已中止，请重新计算。'
    } else if (calculationReport.value || simulationReport.value || timelineData.value) {
      calculationStatus.value = '排班已变更，原产出报告已失效，请重新计算。'
    }
    calculationReport.value = null
    simulationReport.value = null
    timelineData.value = null
  }, { deep: true, flush: 'sync' })
  onBeforeUnmount(stopCalculation)

  function handleCalculate(): void {
    if (isCalculating.value || isGeneratingRoster.value) return
    calculationError.value = null
    if (!validationResult.value.isValid) {
      calculationError.value = '排班存在阻断错误，请根据下方诊断信息修复后再计算。'
      return
    }
    calculationConfigOpen.value = true
  }

  function handleConfirmCalculation(config: CalculationConfig): void {
    if (isCalculating.value || isGeneratingRoster.value) return
    let initialInventory
    try { initialInventory = normalizeSimulationInventory(config.initialInventory === undefined && workspaceUsesInventoryConditions(store.workspace) ? {} : config.initialInventory) }
    catch (error) { calculationError.value = error instanceof Error ? error.message : String(error); return }
    calculationConfigOpen.value = false
    simSettings.value = { ...simSettings.value, ...config, initialInventory }
    executeCalculation()
  }

  function executeCalculation(): void {
    if (isCalculating.value) return
    calculationError.value = null
    calculationStatus.value = null
    if (!validationResult.value.isValid) {
      calculationError.value = '排班存在阻断错误，请根据下方诊断信息修复后再计算。'
      return
    }
    calculationReport.value = null
    simulationReport.value = null
    timelineData.value = null
    isCalculating.value = true
    calculationElapsed.value = 0
    calculationSilence.value = null
    calculationProgress.value = { label: '正在准备计算…', fraction: 0 }
    calculationBottleneckSummary.value = null
    bottleneckTracker = createCalculationBottleneckTracker()
    const started = performance.now()
    calculationStarted = started
    let lastProgressAt = started
    let receivedProgress = false
    let lastObservation: CalculationSilence['observation']
    calculationTimer = setInterval(() => {
      const now = performance.now()
      calculationElapsed.value = (now - started) / 1000
      const silentSeconds = Math.floor((now - lastProgressAt) / 1000)
      calculationSilence.value = silentSeconds >= 15
        ? { seconds: silentSeconds, lastProgressSeconds: receivedProgress ? Math.floor((lastProgressAt - started) / 1000) : null, observation: lastObservation }
        : null
    }, 1000)
    try {
      const initialInventory = normalizeSimulationInventory(simSettings.value.initialInventory === undefined && workspaceUsesInventoryConditions(store.workspace) ? {} : simSettings.value.initialInventory)
      let inventoryEntries: OwnedOperatorInput[] | undefined
      if (simSettings.value.useOperatorInventory !== false) {
        let inventory = operatorInventory.value
        const saved = localStorage.getItem('arcinc-operator-inventory-v1')
        if (saved) {
          const parsed = JSON.parse(saved)
          const compiled = parseOperatorInventory(parsed.text ?? '')
          inventory = { enabled: parsed.enabled ?? true, valid: compiled.valid, entries: compiled.entries }
        }
        if (inventory.enabled) {
          if (!inventory.valid) throw new Error('当前干员库配置无效，请修正或取消使用干员库配置。')
          inventoryEntries = JSON.parse(JSON.stringify(toRaw(inventory.entries)))
        }
      }
      if (simSettings.value.jayeElite0 && inventoryEntries) {
        const jIdx = inventoryEntries.findIndex(e => e.operator === '孑' || e.operator === 'char_272_strong')
        if (jIdx >= 0) {
          inventoryEntries[jIdx] = { ...inventoryEntries[jIdx]!, elitePhase: 0, level: 1 }
        }
      }

      let productionSeed = simSettings.value.seed
      if (productionSeed < 0) {
        if (typeof process !== 'undefined' && Boolean(process.env?.VITEST)) productionSeed = 42
        else {
          const browserCrypto = globalThis.crypto
          if (!browserCrypto || typeof browserCrypto.getRandomValues !== 'function') throw new Error('当前环境无法提供安全随机数，请在支持浏览器随机数的环境重新计算。')
          productionSeed = browserCrypto.getRandomValues(new Uint32Array(1))[0]!
        }
      }

      const options = {
        engine: 'simulation' as const,
        jayeElite0: simSettings.value.jayeElite0 ?? false,
        simulationAssumptions: {
          fiammettaFool: simSettings.value.fiammettaFool ?? true,
          fiammettaThreshold: simSettings.value.fiammettaThreshold ?? .9,
          restingThreshold: simSettings.value.restingThreshold ?? .65,
          rescueThreshold: simSettings.value.rescueThreshold ?? .75,
          freeRoom: simSettings.value.freeRoom ?? false,
          ...mowerAdvancedAssumptions(store.workspace),
        },
        simulationOptions: {
          productionWeights: normalizeProductionWeights(simSettings.value.productionWeights),
          warmupHours: simSettings.value.warmupDays * 24,
          sampleHours: simSettings.value.sampleDays * 24,
          maxStepHours: simSettings.value.step,
          warmupModel: 'hourly' as const,
          recordSegments: true,
          jayeElite0: simSettings.value.jayeElite0 ?? false,
          operatorInventory: inventoryEntries,
          production: {
            ...(initialInventory === undefined ? { outputMode: 'potential' as const } : {
              outputMode: 'settled' as const,
              inventoryMode: 'finite' as const,
              initialResources: initialInventory,
            }),
            runOrderMode: 'ideal' as const,
            seed: productionSeed,
            droneTarget: simSettings.value.droneTarget,
            droneRoomId: simSettings.value.droneRoomId || undefined,
            droneTradingRoomId: simSettings.value.droneTradingRoomId || undefined,
          },
        },
      }

      const worker = new Worker(new URL('../calculationWorker.ts', import.meta.url), { type: 'module' })
      calculationWorker = worker
      const receiver = createCalculationResultReceiver()
      const fail = (message: string) => {
        if (calculationWorker !== worker) return
        calculationError.value = message
        stopCalculation('failed')
      }
      worker.onmessage = (event: MessageEvent<CalculationWorkerMessage>) => {
        if (calculationWorker !== worker) return
        const message = event.data
        if (message.type === 'progress') {
          lastProgressAt = performance.now()
          receivedProgress = true
          bottleneckTracker?.observe(message.progress, (lastProgressAt - started) / 1000)
          if (message.progress.activity) lastObservation = { activity: message.progress.activity, receivedSeconds: Math.floor((lastProgressAt - started) / 1000) }
          calculationSilence.value = null
          calculationProgress.value = message.progress
        } else if (message.type === 'error') {
          fail(message.error)
        } else {
          try {
            const received = receiver.accept(message)
            lastProgressAt = performance.now()
            receivedProgress = true
            calculationSilence.value = null
            if (received.acknowledge !== undefined) worker.postMessage({ type: 'result-ack', sequence: received.acknowledge })
            if (!received.complete) {
              const progress = { label: '正在整理计算结果…', fraction: .99 }
              bottleneckTracker?.observe(progress, (lastProgressAt - started) / 1000)
              calculationProgress.value = progress
              return
            }
            const { result, timelineData: timeline } = received.complete
            simulationReport.value = result.simulationReport ?? null
            timelineData.value = timeline
            if (result.success && result.report) calculationReport.value = result.report
            else calculationError.value = result.error ?? '收益计算未成功完成'
            stopCalculation(result.success && result.report ? 'completed' : 'failed')
          } catch (error) { fail(error instanceof Error ? error.message : String(error)) }
        }
      }
      worker.onerror = event => fail(`产出计算失败：${event.message || '后台任务执行失败'}`)
      worker.onmessageerror = () => fail('产出计算报告传输失败，请重试。')
      worker.postMessage(JSON.parse(JSON.stringify({ workspace: toRaw(store.workspace), options })))
    } catch (error) {
      calculationError.value = `无法启动后台计算：${error instanceof Error ? error.message : String(error)}`
      stopCalculation('failed')
    }
  }

  return { calculationBottleneckSummary, calculationConfigOpen, calculationProgress, calculationTiming, calculationSilence, handleCalculate, handleConfirmCalculation, handleAbortCalculation }
}
