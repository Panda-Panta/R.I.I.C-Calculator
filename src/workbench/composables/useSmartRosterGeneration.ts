import { onBeforeUnmount, ref, toRaw, watch } from 'vue'
import { parseOperatorInventory, type OwnedOperatorInput } from '../../domain/operatorInventory'
import { normalizeProductionWeights } from '../../domain/productionWeights'
import { runSmartRoster, type SmartRosterProgress, type SmartRosterResult } from '../../optimizer/smartRoster'
import { normalizeSmartRosterOptimizationOptions, type SmartRosterConfig } from '../settings'
import type { WorkbenchSession } from '../session'
import type { useRosterWorkbenchStore } from '../store'

type VerifiedRosterSnapshot = SmartRosterResult & { score: number }

function isVerifiedIncumbent(report: SmartRosterResult | null | undefined): report is VerifiedRosterSnapshot {
  return report?.status === 'draft' && !!report.workspace && typeof report.score === 'number' && Number.isFinite(report.score) &&
    !!report.calculationReport?.summary && Number.isFinite(report.calculationReport.summary.totalScore82)
}

/** Owns generation options, worker fallback, progress and adoption of verified rosters. */
export function useSmartRosterGeneration(store: ReturnType<typeof useRosterWorkbenchStore>, session: WorkbenchSession) {
  const { simSettings, operatorInventory, isCalculating, isGeneratingRoster, activeTab, calculationReport, calculationError, calculationStatus, simulationReport, timelineData, replaceStatusMessage } = session
  const smartRosterConfigModalOpen = ref(false)
  const generationProgress = ref<SmartRosterProgress | null>(null)
  const hasVerifiedIncumbent = ref(false)
  interface GenerationJob {
    worker: Worker | null
    incumbent: VerifiedRosterSnapshot | null
    adopt: (report: SmartRosterResult) => void
  }
  let activeJob: GenerationJob | null = null
  function releaseWorker(job: GenerationJob): void {
    const worker = job.worker
    job.worker = null
    if (worker) {
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
    }
  }
  function stopGeneration(): void {
    const job = activeJob
    activeJob = null
    if (job) releaseWorker(job)
    isGeneratingRoster.value = false
    generationProgress.value = null
    hasVerifiedIncumbent.value = false
  }
  watch(() => simSettings.value.productionWeights, value => {
    const weights = normalizeProductionWeights(value)
    const current = normalizeProductionWeights(store.workspace.productionWeights)
    if ((Object.keys(weights) as Array<keyof typeof weights>).some(key => weights[key] !== current[key])) {
      if (activeJob) {
        stopGeneration()
        replaceStatusMessage.value = '产出加权系数已变更，自动排班计算已中止，请重新生成。'
      }
      store.workspace.productionWeights = weights
    }
  }, { deep: true, flush: 'sync' })
  watch(() => store.workspace, () => {
    if (!activeJob) return
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
    const optimizationOptions = normalizeSmartRosterOptimizationOptions(config)
    const enableBackupGeneration = config?.enableBackupGeneration === true
    const runOptions = {
      productionWeights: weights,
      seed: (config?.seed !== undefined && config.seed >= 0)
        ? config.seed
        : (simSettings.value.seed < 0 ? (isVitest ? 42 : Math.floor(Math.random() * 0xffffffff)) : simSettings.value.seed),
      branchCount: 1,

      simulationWarmupHours: config?.simulationWarmupHours ?? (isVitest ? 6 : 24),
      simulationSampleHours: config?.simulationSampleHours ?? (isVitest ? 18 : 72),
      enableDeepSearch: config?.enableDeepSearch ?? false,
      enableBackupGeneration,
      ...optimizationOptions,
      optimizationMaxSimulations: Math.min(enableBackupGeneration ? 4 : 8, optimizationOptions.optimizationMaxSimulations),
      droneTarget: config?.droneTarget ?? 'none',
      droneRoomId: config?.droneRoomId || undefined,
    }

    const onSmartRosterComplete = (report: SmartRosterResult): void => {
      if (report.status === 'draft' && report.workspace) {
        store.loadWorkspace(report.workspace)
        // Finish the persisted name sync before publishing this workspace's report.
        store.workspace.mainPlan.name = store.workspace.name
        const scoreStr = report.score !== null ? `（加权预测：${report.score.toFixed(1)} 分/日）` : ''
        const calculation = report.phases.calculation
        let optimizationNote = ''
        if (calculation?.status === 'limited') {
          const budgetReached = !calculation.libraryComplete || calculation.valuation?.stopReason === 'timeLimit' ||
            calculation.valuation?.stopReason === 'workLimit' || calculation.assignment && calculation.assignment.termination !== 'complete'
          optimizationNote = `${budgetReached ? '已到计算预算' : '分配计算受当前支持范围限制'}，采用完整仿真验证后的较优方案。`
        } else if (calculation?.status === 'invalid') {
          optimizationNote = runOptions.enableDeepSearch || runOptions.enableBackupGeneration || runOptions.enableMainOptimization
            ? '分配优化未完成，已采用完整仿真验证的方案。'
            : '分配优化未完成，已验证并保留初始方案。'
        } else if (calculation?.status === 'unsupported') {
          optimizationNote = '当前配置未进入制造组优化。'
        }
        const jointBackup = report.phases.jointBackup
        const comparison = jointBackup ?? report.phases.mainOptimization
        const comparisonLabel = jointBackup ? '联合主副表比较' : '持续优化'
        const comparisonWarning = report.diagnostics.filter(d =>
          d.code === 'MAIN_OPTIMIZATION_NO_QUALIFIED_RESULT' || d.code === 'MAIN_OPTIMIZATION_FAILED' ||
          d.code.startsWith('JOINT_BACKUP_')).map(d => d.message).join('；')
        let comparisonNote = ''
        if (comparison?.qualityRepaired) {
          comparisonNote = `${comparisonLabel}已采用工休完整性合格的方案。`
        } else if (comparison?.improved) {
          comparisonNote = `本次${comparisonLabel}额外提高 ${comparison.gain.toFixed(1)} 分/日。`
        } else if (comparison && comparison.termination !== 'invalid-budget') {
          comparisonNote = jointBackup ? '本次联合主副表比较未发现更高产出。' : '本次额外比较未发现更高产出。'
        }
        replaceStatusMessage.value = comparisonWarning
          ? `${comparisonWarning} 当前保留排班${scoreStr}。`
          : `一键排班成功！已保留当前建筑与已配置干员，并采用完整仿真确认的排班${scoreStr}。${optimizationNote}${comparisonNote}`
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

    const job: GenerationJob = { worker: null, incumbent: null, adopt: onSmartRosterComplete }
    activeJob = job
    function rememberIncumbent(report: SmartRosterResult): void {
      if (activeJob !== job || !isVerifiedIncumbent(report)) return
      if (!job.incumbent || report.score >= job.incumbent.score) {
        job.incumbent = report
        hasVerifiedIncumbent.value = true
      }
    }
    function receiveProgress({ incumbent, ...progress }: SmartRosterProgress): void {
      if (activeJob !== job) return
      if (incumbent) rememberIncumbent(incumbent)
      generationProgress.value = progress
    }

    try {
      if (!isVitest && typeof Worker !== 'undefined') {
        const worker = new Worker(new URL('../../optimizer/smartRosterWorker.ts', import.meta.url), { type: 'module' })
        job.worker = worker
        worker.onmessage = (event) => {
          if (activeJob !== job) return
          if (event.data.type === 'progress') {
            receiveProgress(event.data.progress)
          } else if (event.data.type === 'incumbent') {
            rememberIncumbent(event.data.report)
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
          if (activeJob !== job) return
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
      releaseWorker(job)
      // Fall back to synchronous execution if Worker creation failed (e.g. in test environment)
    }

    try {
      const report = runSmartRoster(baseWorkspace, cleanEntries, runOptions, receiveProgress)
      if (activeJob !== job) return
      stopGeneration()
      onSmartRosterComplete(report)
    } catch (err: unknown) {
      if (activeJob !== job) return
      stopGeneration()
      replaceStatusMessage.value = `自动排班生成失败：${err instanceof Error ? err.message : String(err)}`
    } finally {
      if (activeJob === job) stopGeneration()
    }
  }

  function handleAbortAutoGenerate(): void {
    const job = activeJob
    const incumbent = job?.incumbent
    stopGeneration()
    if (job && incumbent) {
      job.adopt(incumbent)
      replaceStatusMessage.value = `已结束优化，保留本次完整仿真确认的较优排班（加权预测：${incumbent.score.toFixed(1)} 分/日）。`
    } else {
      replaceStatusMessage.value = '已中止自动排班计算。'
    }
  }

  return { smartRosterConfigModalOpen, generationProgress, hasVerifiedIncumbent, handleAutoGenerate, handleConfirmSmartRosterConfig, handleAbortAutoGenerate }
}
