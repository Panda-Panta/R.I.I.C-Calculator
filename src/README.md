# 源码职责与依赖约定

| 目录 | 职责 |
| --- | --- |
| `domain/` | 与界面无关的业务类型、干员档案、排班模型、标识解析、产出权重与通用计分 |
| `rules/` | 订单概率和订单价值规则 |
| `engine/` | 静态效率、心情和基础收益计算 |
| `scheduler/` | 排班编译、运行状态、任务队列、策略和排班参与者校验 |
| `simulator/` | 事件时间线、生产与资源记录、动态仿真，以及仿真报告的计分适配 |
| `optimizer/` | 初始排班构造、完整队伍域、条件周期估值、约束分配与完整仿真比较 |
| `workbench/` | 工作台状态、配置、导入导出、计算桥接与报告展示模型 |
| `workbench/composables/` | Vue 工作台的持久化、收益计算任务与自动排班任务控制 |
| `components/workbench/` | 页面、编辑器与弹窗；`WorkbenchShell.vue` 负责界面组装与交互路由 |
| `test/helpers/` | 仅由回归测试使用的时间线等辅助函数 |

`workbench/session.ts` 创建每个工作台实例共享的响应式状态。收益计算和自动排班各自管理 Worker、进度、取消和卸载清理；持久化模块负责原有存储键、旧版迁移和干员库交换。界面样式位于 `components/workbench/WorkbenchShell.css`，由原页面以 scoped 样式加载。

共享产出计分由 `domain/productionScore.ts` 唯一实现；`simulator/productionScore.ts` 将已完成生产的仿真报告转换为通用计分输入。排班模型位于 `domain/roster.ts`，干员名称、代号和 ID 解析位于 `domain/operatorIdentifiers.ts`。底层模块直接引用这些位置。

`workbench/model.ts`、`optimizer/productionObjective.ts` 以及 Mower JSON 模块的原标识解析导出保留为兼容入口，供既有脚本或集成使用，不重复实现规则。

自动排班由 `optimizer/molecularSynthesis.ts` 构造一份合法初始表，`computedManufacturingRoster.ts` 编排完整队伍域、周期估值、联合指派与事务解码。`smartRoster.ts` 默认只把初始表和至多一个不同的计算结果送入同条件完整仿真，按日均加权产出保留较优方案，并直接返回该方案同次仿真的报告。默认不再调用 `automaticRosterCandidates.ts` 生成 6+2 排班，也不追加后置换人或第三阶段搜索；用户显式开启的额外比较保留。

新计算分为以下职责：

- `manufacturingCrewDomain.ts` 从原始用户表、初始表、实际库和锁集提取受支持制造组，流式枚举完整主替队伍，保留确定座次并事务解码；多绑定、固定外部引用等复杂块保持原样。用户原有核心与固定跨站锚为必留，内部生成的核心可完整弃选。
- `manufacturingCrewFeasibility.ts` 在估值前按组、房、角色及完整核心标签进行前向可达和反向可完成检查，仅删除已证明不可能组成完整分配的类别；预算中断返回原库，不进行部分剪枝。
- `manufacturingCrewValuation.ts` 在有限预热和采样窗口内，以实际技能、暖机与休息策略生成条件周期系数。固定外部环境和参考恢复条件是模型假设，不等于完整调度时序；未量化或预算中止明确记录，只有完整系数进入指派。
- `crewAssignmentKernel.ts` 用动态规划处理组、房、角色和必留核心覆盖；`crewAssignmentSearch.ts` 对重复人员冲突分支，返回可行性、模型上界及预算状态。它们不修改排班、不调用完整仿真，上界与最优性只适用于传入的量化系数模型。

`computedManufacturingRoster.ts` 分别记录队伍库、量化和搜索是否完整。预算中断可以保留当前已量化子域中的可行结果；没有可接受结果时保留初始排班，不能据此宣称完整域最优。最终完整仿真仍负责确认收益。整合主线89070时钟修复后，同输入整体流程已观察到收益提高0.60%、等待减少67.63%、CPU减少79.63%；数学分配在该案例中未增加初始表的F。单次固定输入记录及模型边界见 [自动排班搜索说明](../docs/automatic-roster-search.md)。

`generatedWarmupPolicy.ts` 共用实际设施与已解锁技能的显式暖机判定，在构造、估值和正式仿真前配置主班耗尽策略，拒绝不能表达该策略的普通暖机替班；没有明示数值曲线的裁缝/线索倾向沿用满效率默认，不自动增加耗尽标记。`combinationEvaluation.ts` 的技能档案复用仅在单次同步评分内生效，不跨库存或练度变化缓存。正式模拟器、物理约束和共享产出权重保持独立。

`optimizer/candidateExecutionOrder.ts` 用实际主替初始耗速估计事件密集程度，仅决定并行派发顺序；入口将回调与结果恢复到原候选索引。该估值不筛掉候选、不改变正式模拟输入、不作为收益或最优性上界。

领域、收益引擎和排班模块不依赖 Vue、Pinia、界面或优化器。仿真模块不依赖优化器；专用 Worker 可以调用工作台桥接以接收界面请求。`test/architecture.spec.ts` 检查这些依赖约定，包括类型引用，并确保所有 Vue 组件都有应用入口。

跑单仅使用理想收益模型。`scheduler/mowerDroneOperations.ts` 负责仍在使用的普通贸易站和制造站无人机操作，其接口接收明确的资源保留和重复加速策略；原有葛朗台任务选项及未被当前功能使用的旧面板、Worker 和算法已经清理。普通无人机分配、理想跑单、当前自动排班和诊断脚本继续使用各自的业务模块。

公式、随机种子、配置结构、存储键、Mower 往返保留字段及任务执行语义属于行为契约。调整文件位置时，应保留实现，并通过界面交互回归、静态/动态计算和固定输入前后对比验证。

长期排班测试通过 `test/evidence.ts` 将新报告写入 `artifacts/test-evidence/`。设置 `RIIC_TEST_EVIDENCE_DIRECTORY` 可以选择 `artifacts/` 下的独立输出目录。`validation/` 中的原始排班、截图和历史审计记录继续作为输入保存。
