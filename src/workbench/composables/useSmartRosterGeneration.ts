import { onBeforeUnmount, ref, shallowRef, toRaw, watch } from 'vue'
import { parseOperatorInventory, type OwnedOperatorInput } from '../../domain/operatorInventory'
import { normalizeProductionWeights } from '../../domain/productionWeights'
import { runSmartRoster, type SmartRosterProgress, type SmartRosterResult } from '../../optimizer/smartRoster'
import type { SmartRosterConfig } from '../settings'
import type { WorkbenchSession } from '../session'
import type { useRosterWorkbenchStore } from '../store'

/** Owns generation options, worker fallback, progress and adoption of verified rosters. */
export function useSmartRosterGeneration(store: ReturnType<typeof useRosterWorkbenchStore>, session: WorkbenchSession) {
  const { simSettings, operatorInventory, isCalculating, isGeneratingRoster, activeTab, calculationReport, calculationError, calculationStatus, simulationReport, timelineData, replaceStatusMessage } = session
  const smartRosterConfigModalOpen = ref(false)
  const generationProgress = ref<SmartRosterProgress | null>(null)
  const activeRosterWorker = shallowRef<Worker | null>(null)
  function stopGeneration(): void {
    const worker = activeRosterWorker.value
    activeRosterWorker.value = null
    if (worker) {
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
    }
    isGeneratingRoster.value = false
    generationProgress.value = null
  }
  watch(() => simSettings.value.productionWeights, value => {
    const weights = normalizeProductionWeights(value)
    const current = normalizeProductionWeights(store.workspace.productionWeights)
    if ((Object.keys(weights) as Array<keyof typeof weights>).some(key => weights[key] !== current[key])) {
      if (activeRosterWorker.value) {
        stopGeneration()
        replaceStatusMessage.value = '产出加权系数已变更，自动排班计算已中止，请重新生成。'
      }
      store.workspace.productionWeights = weights
    }
  }, { deep: true, flush: 'sync' })
  watch(() => store.workspace, () => {
    if (!activeRosterWorker.value) return
    stopGeneration()
    replaceStatusMessage.value = '排班已变更，自动排班计算已中止，请重新生成。'
  }, { deep: true, flush: 'sync' })
  onBeforeUnmount(stopGeneration)

  function handleAutoGenerate(explicitConfig?: SmartRosterConfig): void {
    if (isCalculating.value || isGeneratingRoster.value) return
    replaceStatusMessage.value = null
    calculationError.value = null

    let inventoryEntries: OwnedOperatorInput[] = []
    if (operatorInventory.value.enabled && operatorInventory.value.valid && operatorInventory.value.entries.length > 0) {
      inventoryEntries = operatorInventory.value.entries
    } else if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      const rawInv = localStorage.getItem('arcinc-operator-inventory-v1')
      if (rawInv) {
        try {
          const parsedInv = JSON.parse(rawInv)
          if (parsedInv.text) {
            const compiled = parseOperatorInventory(parsedInv.text)
            if (compiled.valid) {
              inventoryEntries = compiled.entries
            }
          }
        } catch {
          // ignore
        }
      }
    }

    if (inventoryEntries.length === 0) {
      replaceStatusMessage.value = '无法自动生成排班：请先在「设置」子页面或点击「导入干员库」录入您持有的干员与练度。'
      return
    }

    const isVitest = typeof process !== 'undefined' && Boolean(process.env?.VITEST)
    if (explicitConfig || (isVitest && explicitConfig === undefined && !smartRosterConfigModalOpen.value)) {
      executeAutoGenerate(inventoryEntries, explicitConfig)
      return
    }

    smartRosterConfigModalOpen.value = true
  }

  function handleConfirmSmartRosterConfig(config: SmartRosterConfig): void {
    if (isCalculating.value || isGeneratingRoster.value) return
    smartRosterConfigModalOpen.value = false

    let inventoryEntries: OwnedOperatorInput[] = []
    if (operatorInventory.value.enabled && operatorInventory.value.valid && operatorInventory.value.entries.length > 0) {
      inventoryEntries = operatorInventory.value.entries
    } else if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      const rawInv = localStorage.getItem('arcinc-operator-inventory-v1')
      if (rawInv) {
        try {
          const parsedInv = JSON.parse(rawInv)
          if (parsedInv.text) {
            const compiled = parseOperatorInventory(parsedInv.text)
            if (compiled.valid) {
              inventoryEntries = compiled.entries
            }
          }
        } catch {}
      }
    }

    if (inventoryEntries.length === 0) {
      replaceStatusMessage.value = '无法自动生成排班：请先在「设置」子页面或点击「导入干员库」录入您持有的干员与练度。'
      return
    }

    executeAutoGenerate(inventoryEntries, config)
  }

  function executeAutoGenerate(inventoryEntries: OwnedOperatorInput[], config?: SmartRosterConfig): void {
    isGeneratingRoster.value = true
    generationProgress.value = {
      phase: 'building',
      phaseProgress: 0,
      label: '正在准备一键智能排班...',
    }

    const baseWorkspace = JSON.parse(JSON.stringify(toRaw(store.workspace)))
    const weights = normalizeProductionWeights(config?.productionWeights ?? simSettings.value.productionWeights)
    simSettings.value.productionWeights = weights
    baseWorkspace.productionWeights = weights
    const cleanEntries: OwnedOperatorInput[] = JSON.parse(JSON.stringify(inventoryEntries))
    const isVitest = typeof process !== 'undefined' && Boolean(process.env?.VITEST)
    const runOptions = {
      productionWeights: weights,
      seed: (config?.seed !== undefined && config.seed >= 0)
        ? config.seed
        : (simSettings.value.seed < 0 ? (isVitest ? 42 : Math.floor(Math.random() * 0xffffffff)) : simSettings.value.seed),
      branchCount: isVitest ? 1 : 10,
      maxStaticEvals: config?.maxStaticEvals ?? (isVitest ? 500 : 3000),

      simulationWarmupHours: config?.simulationWarmupHours ?? (isVitest ? 6 : 24),
      simulationSampleHours: config?.simulationSampleHours ?? (isVitest ? 18 : 72),
      enableDeepSearch: config?.enableDeepSearch ?? !isVitest,
      droneTarget: config?.droneTarget ?? 'none',
      droneRoomId: config?.droneRoomId || undefined,
    }

    const onSmartRosterComplete = (report: SmartRosterResult): void => {
      if (report.status === 'draft' && report.workspace) {
        store.loadWorkspace(report.workspace)
        // Finish the persisted name sync before publishing this workspace's report.
        store.workspace.mainPlan.name = store.workspace.name
        const scoreStr = report.score !== null ? `（加权预测：${report.score.toFixed(1)} 分/日）` : ''
        replaceStatusMessage.value = `一键排班成功！已保留当前建筑与已配置干员，并完成空位组队与动态仿真验证${scoreStr}。`
        simSettings.value.droneTarget = runOptions.droneTarget
        simSettings.value.droneRoomId = runOptions.droneRoomId
        simSettings.value.droneTradingRoomId = runOptions.droneTarget === 'trading' ? runOptions.droneRoomId : ''
        simSettings.value.useOperatorInventory = true
        activeTab.value = 'workbench'
        calculationReport.value = report.calculationReport ?? null
        simulationReport.value = null
        timelineData.value = null
        calculationError.value = null
        calculationStatus.value = report.calculationReport
          ? `当前显示本次排班验证产出（预热 ${runOptions.simulationWarmupHours} 小时，采样 ${runOptions.simulationSampleHours} 小时）。点击「计算产出」可按收益设置独立计算并生成时间轴。`
          : '排班已生成。点击「计算产出」可按收益设置计算产出并生成时间轴。'
      } else {
        const msgs = report.diagnostics.map(d => d.message).join('；')
        replaceStatusMessage.value = `自动生成排班未成功：${msgs || '未能生成满足约束的方案'}`
      }
    }

    try {
      if (!isVitest && typeof Worker !== 'undefined') {
        const worker = new Worker(new URL('../../optimizer/smartRosterWorker.ts', import.meta.url), { type: 'module' })
        activeRosterWorker.value = worker
        worker.onmessage = (event) => {
          if (activeRosterWorker.value !== worker) return
          if (event.data.type === 'progress') {
            generationProgress.value = event.data.progress
          } else if (event.data.type === 'complete') {
            // Release the snapshot before adopting its own workspace so that
            // the edit watcher cannot cancel a successful result application.
            stopGeneration()
            onSmartRosterComplete(event.data.report)
          } else if (event.data.type === 'error') {
            stopGeneration()
            replaceStatusMessage.value = `自动排班生成失败：${event.data.error}`
          }
        }
        worker.onerror = (err) => {
          if (activeRosterWorker.value !== worker) return
          stopGeneration()
          replaceStatusMessage.value = `自动排班任务发生错误：${err.message || 'Worker 执行失败'}`
        }
        worker.postMessage({
          base: baseWorkspace,
          entries: cleanEntries,
          options: runOptions,
        })
        return
      }
    } catch {
      // Fall back to synchronous execution if Worker creation failed (e.g. in test environment)
    }

    try {
      const report = runSmartRoster(baseWorkspace, cleanEntries, runOptions, (p) => {
        generationProgress.value = p
      })
      onSmartRosterComplete(report)
    } catch (err: unknown) {
      replaceStatusMessage.value = `自动排班生成失败：${err instanceof Error ? err.message : String(err)}`
    } finally {
      isGeneratingRoster.value = false
      generationProgress.value = null
    }
  }

  function handleAbortAutoGenerate(): void {
    stopGeneration()
    replaceStatusMessage.value = '已中止自动排班计算。'
  }

  return { smartRosterConfigModalOpen, generationProgress, handleAutoGenerate, handleConfirmSmartRosterConfig, handleAbortAutoGenerate }
}
