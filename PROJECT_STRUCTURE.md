# 项目源码结构索引

此文件由 `node scripts/update-project-structure.mjs` 生成。新增、移动或删除源码、脚本、skill 文件后重新生成；交付前运行 `node scripts/update-project-structure.mjs --check`。索引只记录路径，不包含时间戳，因此相同结构产生相同结果。

开发约定见 [AGENTS.md](AGENTS.md)，当前实施与交付状态见 [UPDATE_PLAN.md](UPDATE_PLAN.md)，更新流程见 [DEVELOPMENT_WORKFLOW.md](DEVELOPMENT_WORKFLOW.md)。

## 模块职责与依赖

| 位置 | 职责与边界 |
| --- | --- |
| `src/domain/` | 与界面无关的业务类型、干员标识、排班模型和公共计分；共享定义优先放在这里 |
| `src/rules/` | 独立、可测试的订单规则；规则不引用界面状态 |
| `src/engine/` | 静态效率、心情及后勤技能条件；新增机制使用专项模块 |
| `src/scheduler/` | Mower 调度、主副表、策略、任务队列和原生兼容规则 |
| `src/simulator/` | 生产、资源和回收站事件时间线；不依赖优化器 |
| `src/optimizer/` | 候选枚举、配员搜索和方案比较；调用既有规则而不复制它们 |
| `src/workbench/` | 工作台状态、迁移、Mower JSON/二维码兼容及计算桥接 |
| `src/workbench/composables/` | 持久化、收益任务和自动排班任务生命周期 |
| `src/components/workbench/` | 页面、编辑器与弹窗；WorkbenchShell 只组装界面和路由交互 |
| `src/data/` | 固定版本数据、来源清单和生成结果，不手改自动生成数据 |
| `src/test/` | 架构契约、报告输出与测试辅助；相应业务测试通常与模块放在一起 |
| `scripts/` | 数据审计、结构生成、性能诊断、构建和安全安装同步 |
| `desktop/` | Windows WebView2 外壳；浏览器数据位于用户 LocalApplicationData 下 |
| `.codex/skills/arknights-riic-mechanics/` | 项目后勤 skill、来源证据和离线查询；同步发布到独立仓库 |
| `.github/workflows/` | 远程构建、发布与页面部署 |

领域、规则、效率引擎与调度层不依赖 Vue、Pinia、界面或优化器。`src/test/architecture.spec.ts` 校验这些约定。完整职责说明见 [src/README.md](src/README.md)。

## 新后勤机制的维护入口

- `src/domain/facilities.ts`：设施工位和等级的共享规则，由编辑、校验和配员共同使用。
- `src/engine/supportFacilitySkills.ts`：回收效率、加工副产品及新招聘/线索技能条件。
- `src/simulator/recycleTimeline.ts`：材料转化进度、满仓暂停、收取和采样计数。
- `src/data/support-facilities.generated.json`：GameData 设施等级、容量、提效与配方参数。
- `src/workbench/compat/mowerJson.ts`、`mowerQrCodec.ts`：导入导出协议及旧数据保留。
- `src/components/workbench/SupportFacilityPreview.vue`：专项预览，避免向通用组件堆积公式。
- `scripts/sync-riic-catalog.mjs`：固定版本输入校验与软件、skill 数据生成。

## 纳入范围

共 753 个索引文件，其中应用 TypeScript/Vue/CSS 文件 262 个，业务测试文件 338 个。纳入 Git 已登记和未忽略的源码路径，排除仅存本地的忽略文件，保证干净检出可重新生成相同索引。大批头像、技能图标等静态资源按目录汇总；`artifacts/`、`validation/`、`release/`、`dist/`、依赖目录、临时实验和 Git 内部文件不作为源码树展开。`validation/` 保存历史输入与核验记录，`artifacts/` 保存本次生成的证据和备份。

### 根目录管理入口

```text
./
├── .gitattributes
├── .gitignore
├── AGENTS.md
├── DEVELOPMENT_WORKFLOW.md
├── PROJECT_STRUCTURE.md
├── README.md
├── THIRD_PARTY_MOWER_LICENSE
├── THIRD_PARTY_NOTICES.md
├── UPDATE_PLAN.md
├── index.html
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.app.json
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
└── 一键启动.bat
```

### .github/workflows

```text
.github/workflows/
├── deploy-pages.yml
└── release.yml
```

### .codex/skills/arknights-riic-mechanics

```text
.codex/skills/arknights-riic-mechanics/
├── agents/
│   └── openai.yaml
├── references/
│   ├── arkntools-source-manifest.json
│   ├── catalog.decoded.json
│   ├── catalog.json
│   ├── coverage.md
│   ├── facilities.md
│   ├── freshness.md
│   ├── gamedata-source-manifest.json
│   ├── links.md
│   ├── logistics-update-manifest.json
│   ├── mower-plan-compatibility.md
│   ├── mower-plan-source-manifest.json
│   ├── new-operators-v078.md
│   ├── orders.md
│   ├── package-manifest.json
│   ├── riic_skills_browser.html
│   ├── simulation.md
│   ├── taxonomy.md
│   └── terms.json
├── scripts/
│   ├── check-freshness.mjs
│   ├── query.mjs
│   └── validate.mjs
└── SKILL.md
```

### desktop

```text
desktop/
├── MainForm.cs
├── Program.cs
├── R.I.I.C-Calculator.Desktop.csproj
├── README.txt
├── app.ico
└── 使用说明.txt
```

### docs

```text
docs/
├── UPDATE_2026-09-25.md
├── UPDATE_2026-10-12_GAMEDATA_RECYCLE.md
├── UPDATE_2026-10-13_MOWER_ALPHA.md
├── UPDATE_2026-10-14_MOWER_DRONE_ABYSSAL.md
├── UPDATE_2026-10-14_TRAINING_PLAN.md
├── UPDATE_2026-10-16_MOWER_REPORT.md
├── UPDATE_2026-10-24_MOWER_LATEST.md
├── UPDATE_v1.1.0.md
├── UPDATE_v1.1.1.md
├── UPDATE_v1.1.2.md
├── actual-level-roster-fallback.md
└── 用户说明书.md
```

### scripts

```text
scripts/
├── fixtures/
│   └── neighborhood-request.json
├── audit-riic-data.mjs
├── benchmark-cpu.mjs
├── benchmark-neighborhood.mjs
├── check_skills.mjs
├── diagnose_roster.ts
├── dump_sheet1.py
├── import-gamedata.mjs
├── pack-release.ps1
├── prepare-cpu-browser-check.mjs
├── prepare-neighborhood-browser-check.mjs
├── profile-candidate-generation.mjs
├── profile-neighborhood.mjs
├── riic-catalog-evidence.mjs
├── riic-catalog-evidence.spec.mjs
├── sync-riic-catalog.mjs
├── sync-tools.ps1
├── test-audit.spec.ts
├── test-sync-tools.ps1
├── tools-sync-core.psm1
├── trace-252-shiftrun.ts
└── update-project-structure.mjs
```

### src

```text
src/
├── components/
│   └── workbench/
│       ├── BackupGroupEditor.spec.ts
│       ├── BackupGroupEditor.vue
│       ├── BackupPlanEditor.spec.ts
│       ├── BackupPlanEditor.vue
│       ├── BaseMap.spec.ts
│       ├── BaseMap.vue
│       ├── CalculationActivityNotice.spec.ts
│       ├── CalculationActivityNotice.vue
│       ├── CalculationBottleneckSummary.spec.ts
│       ├── CalculationBottleneckSummary.vue
│       ├── CalculationConfigModal.spec.ts
│       ├── CalculationConfigModal.vue
│       ├── CalculationFlow.spec.ts
│       ├── DroneCapacityInput.spec.ts
│       ├── DroneCapacityInput.vue
│       ├── FacilityCard.vue
│       ├── FacilityEditor.spec.ts
│       ├── FacilityEditor.vue
│       ├── GlobalReplaceModal.spec.ts
│       ├── GlobalReplaceModal.vue
│       ├── GroupBindingsEditor.spec.ts
│       ├── GroupBindingsEditor.vue
│       ├── LayoutPresetBar.spec.ts
│       ├── LayoutPresetBar.vue
│       ├── MobileFacilityNav.spec.ts
│       ├── MobileFacilityNav.vue
│       ├── MoodLimitsEditor.vue
│       ├── OperatorImportModal.spec.ts
│       ├── OperatorImportModal.vue
│       ├── OperatorInventoryPanel.spec.ts
│       ├── OperatorInventoryPanel.vue
│       ├── OperatorSelectModal.spec.ts
│       ├── OperatorSelectModal.vue
│       ├── PlanAdvancedSettings.spec.ts
│       ├── PlanAdvancedSettings.vue
│       ├── PlanToolbar.spec.ts
│       ├── PlanToolbar.vue
│       ├── PolicyEditor.spec.ts
│       ├── PolicyEditor.vue
│       ├── ProductionWeightsEditor.spec.ts
│       ├── ProductionWeightsEditor.vue
│       ├── ReplacementList.vue
│       ├── RiicSkillsBrowser.spec.ts
│       ├── RiicSkillsBrowser.vue
│       ├── RosterPosterModal.spec.ts
│       ├── RosterPosterModal.vue
│       ├── ScheduleTimelineGantt.spec.ts
│       ├── ScheduleTimelineGantt.vue
│       ├── SettingsView.spec.ts
│       ├── SettingsView.vue
│       ├── SimulationInventoryEditor.vue
│       ├── SimulationLogView.spec.ts
│       ├── SimulationLogView.vue
│       ├── SlotRow.vue
│       ├── SmartRosterConfigModal.spec.ts
│       ├── SmartRosterConfigModal.vue
│       ├── SupportFacilityPreview.spec.ts
│       ├── SupportFacilityPreview.vue
│       ├── ValidationPanel.spec.ts
│       ├── ValidationPanel.vue
│       ├── WorkbenchShell.css
│       ├── WorkbenchShell.spec.ts
│       ├── WorkbenchShell.vue
│       └── policyFields.ts
├── data/
│   ├── arkntools-riic-overlay.json
│   ├── arkntools-riic-source-manifest.json
│   ├── mower-cross-room-runtime.json
│   ├── mower-cross-room-templates.json
│   ├── mower-learned-combinations.json
│   ├── operator-is-alter-v76.json
│   ├── operators.generated.baseline-v076.json
│   ├── operators.generated.json
│   ├── riic-catalog.baseline-v076.json
│   ├── riic-combinations.json
│   ├── riic-gamedata-source-manifest.json
│   ├── riic-skills-database.json
│   ├── riic-term-evidence.json
│   └── support-facilities.generated.json
├── domain/
│   ├── defaults.ts
│   ├── droneCapacity.ts
│   ├── edition.spec.ts
│   ├── edition.ts
│   ├── facilities.ts
│   ├── gamedataImport.spec.ts
│   ├── mowerBackupFacilities.ts
│   ├── mowerDormOrder.ts
│   ├── mowerProducts.ts
│   ├── mowerRosterRules.ts
│   ├── newLogisticsData.spec.ts
│   ├── operatorContext.ts
│   ├── operatorIdentifiers.ts
│   ├── operatorImport.spec.ts
│   ├── operatorImport.ts
│   ├── operatorInventory.spec.ts
│   ├── operatorInventory.ts
│   ├── operators.spec.ts
│   ├── operators.ts
│   ├── productionScore.ts
│   ├── productionWeights.ts
│   ├── riicIdentity.ts
│   ├── riicTags.ts
│   ├── roster.ts
│   ├── shiftRunPolicy.ts
│   ├── simulationInventory.spec.ts
│   ├── simulationInventory.ts
│   ├── types.ts
│   └── xlsxReader.ts
├── engine/
│   ├── fixtures/
│   │   └── workbook-efficiency-20260913.json
│   ├── supportFacilities/
│   │   ├── conditions.ts
│   │   ├── contactAndClue.ts
│   │   ├── receptionClueProviders.ts
│   │   ├── receptionClues.spec.ts
│   │   ├── receptionClues.ts
│   │   ├── recycle.ts
│   │   └── workshop.ts
│   ├── calculate.spec.ts
│   ├── calculate.ts
│   ├── controlMoraleScope.spec.ts
│   ├── currentRates.spec.ts
│   ├── dormitoryRecovery.spec.ts
│   ├── dormitoryRecovery.ts
│   ├── gladiiaFatigueCoverage.spec.ts
│   ├── globalContext.ts
│   ├── jayeCoverageAudit.spec.ts
│   ├── jayeRules.ts
│   ├── morale.spec.ts
│   ├── morale.ts
│   ├── moraleSui.spec.ts
│   ├── newLogisticsImpact.spec.ts
│   ├── newLogisticsRules.spec.ts
│   ├── operatorGroups.ts
│   ├── operatorRules.spec.ts
│   ├── operatorRules.ts
│   ├── orderCapacity.spec.ts
│   ├── orderCapacity.ts
│   ├── orderRegression.spec.ts
│   ├── shiftRoster.ts
│   ├── singleRecoveryEligibility.ts
│   ├── supportFacilitySkills.spec.ts
│   ├── supportFacilitySkills.ts
│   ├── supportRecovery.ts
│   ├── timeDependentSkills.spec.ts
│   ├── timeDependentSkills.ts
│   ├── tradeConditionalRules.ts
│   └── unquantifiedSkillsCoverage.spec.ts
├── optimizer/
│   ├── fixtures/
│   │   └── mixed-level-inventory.json
│   ├── automaticCombinationPreferences.spec.ts
│   ├── automaticCombinationPreferences.ts
│   ├── automaticPepeMain.spec.ts
│   ├── backupNeighborhood.spec.ts
│   ├── backupNeighborhood.ts
│   ├── backupSnapshot.ts
│   ├── candidateSimulation.ts
│   ├── candidateSimulationCache.spec.ts
│   ├── candidateSimulationCache.ts
│   ├── candidateSimulationPool.spec.ts
│   ├── candidateSimulationPool.ts
│   ├── candidateSimulationWorker.ts
│   ├── combinationAllocation.spec.ts
│   ├── combinationAllocation.ts
│   ├── combinationCandidates.spec.ts
│   ├── combinationCandidates.ts
│   ├── combinationCatalogAdditions.spec.ts
│   ├── combinationEfficiency.spec.ts
│   ├── combinationEnumeration.spec.ts
│   ├── combinationEnumeration.ts
│   ├── combinationEvaluation.spec.ts
│   ├── combinationEvaluation.ts
│   ├── combinationIntegrity.spec.ts
│   ├── combinationIntegrity.ts
│   ├── combinationMembership.spec.ts
│   ├── combinationModel.ts
│   ├── combinationSelection.spec.ts
│   ├── compositeObjective.spec.ts
│   ├── configureRunOrder.ts
│   ├── controlImpact.spec.ts
│   ├── controlImpact.ts
│   ├── controlNeighborhood.spec.ts
│   ├── controlNeighborhood.ts
│   ├── dailyTarget.spec.ts
│   ├── dailyTarget.ts
│   ├── dormKeepers.ts
│   ├── finalCombinationIntegrity.spec.ts
│   ├── fixedDuty.spec.ts
│   ├── fixedDuty.ts
│   ├── generatedRecoveryPolicy.ts
│   ├── globalPerCapitaReplacement.spec.ts
│   ├── globalPerCapitaReplacement.ts
│   ├── incomeComparison.spec.ts
│   ├── incomeComparison.ts
│   ├── inventoryAdmission.spec.ts
│   ├── inventoryAdmission.ts
│   ├── inventoryFallback.spec.ts
│   ├── inventorySearch.spec.ts
│   ├── mainPlanOnly.spec.ts
│   ├── mainPlanOnly.ts
│   ├── mixedLevelInventory.spec.ts
│   ├── molecularSynthesis.spec.ts
│   ├── molecularSynthesis.ts
│   ├── mowerLearnedCandidates.spec.ts
│   ├── multiStartSearch.spec.ts
│   ├── multiStartSearch.ts
│   ├── primaryBackupNeighborhood.spec.ts
│   ├── primaryBackupNeighborhood.ts
│   ├── primaryNeighborhood.spec.ts
│   ├── primaryNeighborhood.ts
│   ├── productionEfficiencyPriority.ts
│   ├── productionObjective.ts
│   ├── productionSingletons.spec.ts
│   ├── productionSingletons.ts
│   ├── productionWeights.spec.ts
│   ├── recoveryGroupCapacity.spec.ts
│   ├── recoveryGroupCapacity.ts
│   ├── recycleAutomaticStaffing.spec.ts
│   ├── recycleStaffing.spec.ts
│   ├── riicAtomicUnits.ts
│   ├── roster252.spec.ts
│   ├── rosterDraft.spec.ts
│   ├── rosterDraft.ts
│   ├── rosterHillClimb.spec.ts
│   ├── rosterIncomeSearch.spec.ts
│   ├── rosterIncomeSearch.ts
│   ├── rosterIncomeSearchParallel.spec.ts
│   ├── rosterProjection.ts
│   ├── rosterSearchRoutes.spec.ts
│   ├── runOrderGains.spec.ts
│   ├── runOrderGains.ts
│   ├── sequentialReplacement.spec.ts
│   ├── shiftRunContract.spec.ts
│   ├── singletonFallback.ts
│   ├── smartRoster.spec.ts
│   ├── smartRoster.ts
│   ├── smartRosterBranches.spec.ts
│   ├── smartRosterParallel.spec.ts
│   ├── smartRosterWorker.ts
│   ├── staffingQuality.ts
│   ├── weightedAutomaticSearch.spec.ts
│   └── weightedRunOrder.spec.ts
├── rules/
│   ├── orderRules.spec.ts
│   ├── orderRules.ts
│   └── orderValue.ts
├── scheduler/
│   ├── fixtures/
│   │   ├── mower-accept-order-alpha.json
│   │   ├── mower-alpha-control-fill-order-20261024.json
│   │   ├── mower-alpha-control-fill-order.json
│   │   ├── mower-alpha-correct-dorm.json
│   │   ├── mower-alpha-decisions-20261013.json
│   │   ├── mower-alpha-exhaust-support.json
│   │   ├── mower-alpha-full-preview-20261024.json
│   │   ├── mower-alpha-full-preview.json
│   │   ├── mower-alpha-idle-search.json
│   │   ├── mower-alpha-isolation-20261014.json
│   │   ├── mower-alpha-late-cycle-20261024.json
│   │   ├── mower-alpha-late-cycle.json
│   │   ├── mower-alpha-metadata.json
│   │   ├── mower-alpha-mood-limits.json
│   │   ├── mower-alpha-planning-entry.json
│   │   ├── mower-alpha-resting-boundaries.json
│   │   ├── mower-alpha-retry-lock.json
│   │   ├── mower-alpha-return-20261014.json
│   │   ├── mower-alpha-selection-20261013.json
│   │   ├── mower-alpha-shift-primitives.json
│   │   ├── mower-alpha-task-protection.json
│   │   ├── mower-bed-takeover-20261016.json
│   │   ├── mower-current-room-duplicate-cache-alpha.json
│   │   ├── mower-default-task-queue-alpha.json
│   │   ├── mower-dorm-assignment-alpha-cases.json
│   │   ├── mower-dorm-isolation-20261013.json
│   │   ├── mower-dorm-recovery-alpha.json
│   │   ├── mower-dorm-selection-alpha.json
│   │   ├── mower-dorm-selection-preserve-alpha.json
│   │   ├── mower-drone-interface-alpha.json
│   │   ├── mower-drone-operations-alpha.json
│   │   ├── mower-duplicate-recovery-retry-alpha.json
│   │   ├── mower-dynamic-priority-84e3926.json
│   │   ├── mower-fia-observation-alpha.json
│   │   ├── mower-fia-ready-cache-alpha.json
│   │   ├── mower-global-dorm-order-alpha.json
│   │   ├── mower-global-rest-policy-alpha.json
│   │   ├── mower-metadata-alpha-cases.json
│   │   ├── mower-notification-alpha.json
│   │   ├── mower-ordinary-planning-alpha-cases.json
│   │   ├── mower-plan-field-order-alpha.json
│   │   ├── mower-recovery-ae9fc322.json
│   │   ├── mower-return-two-groups-alpha.json
│   │   ├── mower-run-entry-alpha.json
│   │   ├── mower-run-order-refresh-alpha.json
│   │   ├── mower-shared-groups-20261013.json
│   │   ├── mower-task-scheduling-alpha.json
│   │   └── mower-todo-task-alpha.json
│   ├── backupExpression.ts
│   ├── backupFunctionExpression.spec.ts
│   ├── backupGroups.spec.ts
│   ├── backupGroups.ts
│   ├── backupInventory.spec.ts
│   ├── backupInventory.ts
│   ├── backupInventoryExpression.spec.ts
│   ├── backupInventoryWake.spec.ts
│   ├── backupPlans.long.spec.ts
│   ├── backupPlans.spec.ts
│   ├── backupPlans.ts
│   ├── backupSourceCompatibility.spec.ts
│   ├── compileRosterSchedule.spec.ts
│   ├── compileRosterSchedule.ts
│   ├── fiammettaPolicy.spec.ts
│   ├── fiammettaPolicy.ts
│   ├── inventoryValidation.ts
│   ├── moraleEndpoints.spec.ts
│   ├── mowerAcceptOrder.spec.ts
│   ├── mowerAcceptOrder.ts
│   ├── mowerAdvancedSettings.spec.ts
│   ├── mowerAdvancedSettings.ts
│   ├── mowerAlphaBackupExpression.spec.ts
│   ├── mowerAlphaBedTakeover.spec.ts
│   ├── mowerAlphaCandidates.spec.ts
│   ├── mowerAlphaCandidates.ts
│   ├── mowerAlphaContractEdges.spec.ts
│   ├── mowerAlphaCorrectDorm.spec.ts
│   ├── mowerAlphaDecisions.spec.ts
│   ├── mowerAlphaDorm.ts
│   ├── mowerAlphaDormOrder.spec.ts
│   ├── mowerAlphaDormPlanning.ts
│   ├── mowerAlphaExhaustSupport.spec.ts
│   ├── mowerAlphaExhaustSupport.ts
│   ├── mowerAlphaFullPreview.spec.ts
│   ├── mowerAlphaIdleSearch.spec.ts
│   ├── mowerAlphaIsolationOracle.spec.ts
│   ├── mowerAlphaMetadata.spec.ts
│   ├── mowerAlphaMetadata.ts
│   ├── mowerAlphaMoodLimits.spec.ts
│   ├── mowerAlphaPlanningEntry.spec.ts
│   ├── mowerAlphaResting.spec.ts
│   ├── mowerAlphaRetryLock.spec.ts
│   ├── mowerAlphaReturnOracle.spec.ts
│   ├── mowerAlphaSelection.spec.ts
│   ├── mowerAlphaShift.spec.ts
│   ├── mowerAlphaTaskProtection.spec.ts
│   ├── mowerAlphaTaskProtection.ts
│   ├── mowerArrangementError.ts
│   ├── mowerArrangementRetry.ts
│   ├── mowerBackupConfig.spec.ts
│   ├── mowerBackupConfig.ts
│   ├── mowerBackupConvergence.spec.ts
│   ├── mowerBackupDepartureRecovery.spec.ts
│   ├── mowerBackupDepartureRecovery.ts
│   ├── mowerBackupFacilities.spec.ts
│   ├── mowerBackupGroupReturn.spec.ts
│   ├── mowerBackupRefresh.spec.ts
│   ├── mowerBackupRefresh.ts
│   ├── mowerBackupReplacements.ts
│   ├── mowerBackupRestingJoin.spec.ts
│   ├── mowerBackupRestingJoin.ts
│   ├── mowerBackupTransitionConfig.spec.ts
│   ├── mowerBatchPlanning.spec.ts
│   ├── mowerBedPool.spec.ts
│   ├── mowerBedTakeover.spec.ts
│   ├── mowerClueLifecycle.spec.ts
│   ├── mowerClueLifecycle.ts
│   ├── mowerCompletedDeparture.spec.ts
│   ├── mowerCoordinationRunBoundary.spec.ts
│   ├── mowerCorrection.ts
│   ├── mowerDefaultIdlePool.spec.ts
│   ├── mowerDepartingReplacements.spec.ts
│   ├── mowerDormAdmissions.spec.ts
│   ├── mowerDormAssignment.spec.ts
│   ├── mowerDormAssignment.ts
│   ├── mowerDormIsolation.spec.ts
│   ├── mowerDormIsolation.ts
│   ├── mowerDormIsolationLatest.spec.ts
│   ├── mowerDormOrder.spec.ts
│   ├── mowerDormOrder.ts
│   ├── mowerDormRecovery.spec.ts
│   ├── mowerDormRecovery.ts
│   ├── mowerDormSelectionParity.spec.ts
│   ├── mowerDormTasks.spec.ts
│   ├── mowerDormTasks.ts
│   ├── mowerDroneInterface.spec.ts
│   ├── mowerDroneInterface.ts
│   ├── mowerDroneOperations.spec.ts
│   ├── mowerDroneOperations.ts
│   ├── mowerDynamicRecoveryPriority.spec.ts
│   ├── mowerExhaustInterlock.spec.ts
│   ├── mowerExhaustPlanning.ts
│   ├── mowerExhaustPolicy.ts
│   ├── mowerExhaustPreview.spec.ts
│   ├── mowerExhaustSupport.spec.ts
│   ├── mowerExhaustSupportDispatch.spec.ts
│   ├── mowerExplicitCorrectionCycle.spec.ts
│   ├── mowerExplicitSlots.spec.ts
│   ├── mowerFiammetta.spec.ts
│   ├── mowerFiammetta.ts
│   ├── mowerFiammettaRetainedObservation.spec.ts
│   ├── mowerGladiiaFatigue.spec.ts
│   ├── mowerGlobalDormOrder.ts
│   ├── mowerGlobalRestPolicy.spec.ts
│   ├── mowerGroupBedMatching.spec.ts
│   ├── mowerGroupConfirmation.spec.ts
│   ├── mowerGroupConfirmation.ts
│   ├── mowerGroupFullRecovery.spec.ts
│   ├── mowerGroupPredecessors.spec.ts
│   ├── mowerGroupPredecessors.ts
│   ├── mowerGroupRecovery.ts
│   ├── mowerGroupReturnStability.spec.ts
│   ├── mowerGroupTransitionLifecycle.spec.ts
│   ├── mowerIdealDormRecovery.spec.ts
│   ├── mowerIdealPlanningBoundaries.spec.ts
│   ├── mowerIdealRunEntry.spec.ts
│   ├── mowerIdealTaskExecution.spec.ts
│   ├── mowerIdealTaskScheduling.spec.ts
│   ├── mowerIndependentRest.spec.ts
│   ├── mowerIsolationReservations.spec.ts
│   ├── mowerLatestRecovery.spec.ts
│   ├── mowerLatestRecoveryOracle.spec.ts
│   ├── mowerLatestRestingMatching.spec.ts
│   ├── mowerLatestSchedulingWiring.spec.ts
│   ├── mowerLimitedRest.spec.ts
│   ├── mowerMaintenanceRunOrders.spec.ts
│   ├── mowerMaintenanceRunOrders.ts
│   ├── mowerMaintenanceScheduling.spec.ts
│   ├── mowerMaintenanceScheduling.ts
│   ├── mowerMetadata.spec.ts
│   ├── mowerMetadata.ts
│   ├── mowerMoodLimits.ts
│   ├── mowerNativeErrors.ts
│   ├── mowerNativeExpressionParity.spec.ts
│   ├── mowerNotification.spec.ts
│   ├── mowerNotification.ts
│   ├── mowerObservations.spec.ts
│   ├── mowerObservations.ts
│   ├── mowerObservedFullRelease.spec.ts
│   ├── mowerOffDutyRecovery.spec.ts
│   ├── mowerOperatorState.spec.ts
│   ├── mowerOperatorState.ts
│   ├── mowerOrdinaryMetadata.spec.ts
│   ├── mowerOrdinaryPlanning.spec.ts
│   ├── mowerOrdinaryPlanning.ts
│   ├── mowerPhaseFlags.spec.ts
│   ├── mowerPhaseRelease.spec.ts
│   ├── mowerPlanOrder.spec.ts
│   ├── mowerPlanOrder.ts
│   ├── mowerPlanningWake.ts
│   ├── mowerPolicyParity.spec.ts
│   ├── mowerPreviewRecovery.spec.ts
│   ├── mowerPreviewRecoveryWait.spec.ts
│   ├── mowerPreviewRecoveryWait.ts
│   ├── mowerReconciliation.spec.ts
│   ├── mowerRecoveryAllocation.spec.ts
│   ├── mowerRecoveryBeds.ts
│   ├── mowerRecoveryDependency.spec.ts
│   ├── mowerRecoveryDependency.ts
│   ├── mowerRecycleNotification.spec.ts
│   ├── mowerRelease.ts
│   ├── mowerReload.spec.ts
│   ├── mowerReload.ts
│   ├── mowerReplacementCheck.spec.ts
│   ├── mowerReplacementCheck.ts
│   ├── mowerReplacementCoordination.ts
│   ├── mowerReplacementCoordinationForecast.spec.ts
│   ├── mowerReplacementCoordinationRuntime.spec.ts
│   ├── mowerRetainedCorrection.spec.ts
│   ├── mowerRetainedRecovery.spec.ts
│   ├── mowerRetainedRecovery.ts
│   ├── mowerRosterDeterminism.spec.ts
│   ├── mowerRunLifecycle.spec.ts
│   ├── mowerRunLifecycle.ts
│   ├── mowerRunOrderBridge.spec.ts
│   ├── mowerRunOrderBridge.ts
│   ├── mowerRunOrderPlanning.spec.ts
│   ├── mowerRunOrderPlanning.ts
│   ├── mowerRunOrderRefresh.spec.ts
│   ├── mowerRunOrderRefresh.ts
│   ├── mowerRunOrderRuntime.spec.ts
│   ├── mowerSameGroupReplacementCoordination.spec.ts
│   ├── mowerSchedulingData.spec.ts
│   ├── mowerSchedulingData.ts
│   ├── mowerScreenshotParity.spec.ts
│   ├── mowerSelection.spec.ts
│   ├── mowerSelection.ts
│   ├── mowerSelectionOrder.spec.ts
│   ├── mowerServicesRuntime.spec.ts
│   ├── mowerSharedGroups.spec.ts
│   ├── mowerSharedGroups.ts
│   ├── mowerSharedRestingGroup.spec.ts
│   ├── mowerShiftCycle.ts
│   ├── mowerShiftProgress.spec.ts
│   ├── mowerShiftProtection.spec.ts
│   ├── mowerShiftProtection.ts
│   ├── mowerSimulationBoundaries.spec.ts
│   ├── mowerSingleRecoveryRouting.spec.ts
│   ├── mowerSkipFlags.spec.ts
│   ├── mowerSourceContract.spec.ts
│   ├── mowerSourceRuntime.spec.ts
│   ├── mowerSourceRuntime.ts
│   ├── mowerSupportRefresh.spec.ts
│   ├── mowerTaskDerivation.spec.ts
│   ├── mowerTaskDerivation.ts
│   ├── mowerTaskExecutor.spec.ts
│   ├── mowerTaskExecutor.ts
│   ├── mowerTaskFailure.spec.ts
│   ├── mowerTaskFailure.ts
│   ├── mowerTaskQueue.spec.ts
│   ├── mowerTaskQueue.ts
│   ├── mowerTaskScheduling.spec.ts
│   ├── mowerTaskScheduling.ts
│   ├── mowerTiming.spec.ts
│   ├── mowerTiming.ts
│   ├── mowerTodoTask.spec.ts
│   ├── mowerTodoTask.ts
│   ├── mowerUrgentRecovery.spec.ts
│   ├── mowerUrgentRecovery.ts
│   ├── mowerWorkaholicGroup.spec.ts
│   ├── rosterRuntime.spec.ts
│   ├── rosterRuntime.ts
│   ├── scheduleAdapter.spec.ts
│   ├── scheduleAdapter.ts
│   ├── smartDormitoryPolicy.spec.ts
│   ├── smartDormitoryPolicy.ts
│   └── types.ts
├── simulator/
│   ├── droneCapacity.spec.ts
│   ├── droneTimeline.spec.ts
│   ├── droneTimeline.ts
│   ├── idealRunOrder.spec.ts
│   ├── inventorySimulation.ts
│   ├── manufacturingTimeline.spec.ts
│   ├── manufacturingTimeline.ts
│   ├── mowerAlphaProductSimulation.spec.ts
│   ├── mowerCoordinationRates.spec.ts
│   ├── mowerCoordinationRates.ts
│   ├── mowerEfficiencyCache.spec.ts
│   ├── mowerGladiiaFatigue.long.spec.ts
│   ├── mowerInitialMorale.spec.ts
│   ├── mowerInventoryBackup.spec.ts
│   ├── mowerMaintenanceOrders.spec.ts
│   ├── mowerManufactureIO.spec.ts
│   ├── mowerNativeClueIO.ts
│   ├── mowerNativeProductionIO.spec.ts
│   ├── mowerNativeProductionIO.ts
│   ├── mowerProductSwitching.spec.ts
│   ├── mowerProductSwitching.ts
│   ├── mowerTaskFailureReport.spec.ts
│   ├── mowerWorkSession.spec.ts
│   ├── orderTimeline.spec.ts
│   ├── orderTimeline.ts
│   ├── potentialProduction.spec.ts
│   ├── productionDroneTargets.spec.ts
│   ├── productionEndpointPrecision.spec.ts
│   ├── productionNativeObservations.spec.ts
│   ├── productionResources.spec.ts
│   ├── productionRunOrder.spec.ts
│   ├── productionScore.ts
│   ├── productionTimeline.spec.ts
│   ├── productionTimeline.ts
│   ├── receptionClueTimeline.spec.ts
│   ├── receptionClueTimeline.ts
│   ├── recycleProduction.spec.ts
│   ├── recycleTimeline.spec.ts
│   ├── recycleTimeline.ts
│   ├── resourceLedger.spec.ts
│   ├── resourceLedger.ts
│   ├── scheduleAbyssalFatigue.spec.ts
│   ├── scheduleAdmission.spec.ts
│   ├── scheduleRateCache.spec.ts
│   ├── scheduleReceptionClues.spec.ts
│   ├── scheduleSimulation.spec.ts
│   ├── scheduleSimulation.ts
│   ├── shiftDeferrals.spec.ts
│   ├── shiftDeferrals.ts
│   ├── simulationActivity.spec.ts
│   ├── simulationActivity.ts
│   ├── simulationActivityFindings.ts
│   ├── singleRecoveryTargets.spec.ts
│   ├── skillStages.spec.ts
│   ├── specialOrders.spec.ts
│   ├── specialOrdersLaterIdeal.spec.ts
│   ├── specialOrdersLaterReplacement.spec.ts
│   └── specialOrdersSameRoster.spec.ts
├── test/
│   ├── helpers/
│   │   └── moraleTimeline.ts
│   ├── architecture.spec.ts
│   ├── evidence.ts
│   ├── goldenScenarios.spec.ts
│   ├── goldenScenarios.ts
│   └── mowerRosterFixture.ts
├── utils/
│   ├── assets.spec.ts
│   └── assets.ts
├── workbench/
│   ├── __tests__/
│   │   ├── engine-protection.spec.ts
│   │   └── visual-qa.spec.ts
│   ├── compat/
│   │   ├── fixtures/
│   │   │   ├── mower-252-2gold.expected.json
│   │   │   ├── mower-252-2gold.json
│   │   │   ├── mower-252-3gold.json
│   │   │   ├── mower-252-sample.jpg
│   │   │   ├── mower-342-orirock.json
│   │   │   └── mower-342-pure-lmd.json
│   │   ├── base45.spec.ts
│   │   ├── base45.ts
│   │   ├── mowerAlphaJson.spec.ts
│   │   ├── mowerAlphaMigration.ts
│   │   ├── mowerBackupAudit.spec.ts
│   │   ├── mowerFacilityLevels.spec.ts
│   │   ├── mowerJson.spec.ts
│   │   ├── mowerJson.ts
│   │   ├── mowerQrCodec.spec.ts
│   │   ├── mowerQrCodec.ts
│   │   ├── mowerQrConstants.ts
│   │   ├── mowerQrCurrent.spec.ts
│   │   └── mowerRecycle.spec.ts
│   ├── composables/
│   │   ├── useSmartRosterGeneration.ts
│   │   ├── useWorkbenchCalculation.spec.ts
│   │   ├── useWorkbenchCalculation.ts
│   │   └── useWorkbenchPersistence.ts
│   ├── timeline/
│   │   ├── timelineDisplay.spec.ts
│   │   ├── timelineDisplay.ts
│   │   ├── timelineModel.spec.ts
│   │   └── timelineModel.ts
│   ├── adapter.spec.ts
│   ├── adapter.ts
│   ├── backupGroupHelpers.spec.ts
│   ├── backupGroupHelpers.ts
│   ├── backupPlanHelpers.spec.ts
│   ├── backupPlanHelpers.ts
│   ├── calculationBottlenecks.spec.ts
│   ├── calculationBottlenecks.ts
│   ├── calculationBridge.spec.ts
│   ├── calculationBridge.ts
│   ├── calculationProgress.spec.ts
│   ├── calculationResultTransport.spec.ts
│   ├── calculationResultTransport.ts
│   ├── calculationWorker.spec.ts
│   ├── calculationWorker.ts
│   ├── defaults.spec.ts
│   ├── defaults.ts
│   ├── droneCapacity.spec.ts
│   ├── droneTargets.ts
│   ├── facilityState.ts
│   ├── fileHelpers.spec.ts
│   ├── fileHelpers.ts
│   ├── inventorySimulationBridge.spec.ts
│   ├── layoutPresets.ts
│   ├── levelInference.spec.ts
│   ├── levelInference.ts
│   ├── migrate.spec.ts
│   ├── migrate.ts
│   ├── migrateAlpha.spec.ts
│   ├── model.ts
│   ├── mowerAlphaBridge.spec.ts
│   ├── mowerReportMetrics.spec.ts
│   ├── mowerReportMetrics.ts
│   ├── operatorHelpers.spec.ts
│   ├── operatorHelpers.ts
│   ├── reportExport.spec.ts
│   ├── reportExport.ts
│   ├── riicSkillDescription.spec.ts
│   ├── riicSkillDescription.ts
│   ├── scheduleSimulationBridge.ts
│   ├── session.ts
│   ├── settings.ts
│   ├── specialOrderReporting.spec.ts
│   ├── store.spec.ts
│   ├── store.ts
│   ├── styles.css
│   ├── tailoringQuality.spec.ts
│   ├── unbuiltFacilities.spec.ts
│   ├── validate.spec.ts
│   ├── validate.ts
│   ├── validateBackupPlans.ts
│   └── weightedReporting.spec.ts
├── App.vue
├── README.md
├── env.d.ts
├── main.ts
├── styles.css
└── theme.ts
```

### 静态资源汇总

| 位置 | 文件数 |
| --- | ---: |
| `public/avatar/` | 435 |
| `public/building_skill/` | 557 |
| `public/product/` | 5 |
| `public/.nojekyll` | 1 |
| `public/app-icon.png` | 1 |
| `public/favicon.ico` | 1 |
