# 神经网络自动排班实施计划书

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本文只授权范围内的规划；实施时采用本会话确认的执行方式，不自动派发其他聊天或子代理。

**Goal:** 用户输入游戏合法设施布局和真实干员库/练度，由随机初始化后训练的神经网络直接生成长期排班，再由软件计算当前页面口径的长期日均 82 收益。

**Architecture:** TypeScript 负责合法输入、实际技能、排班动作、调度与权威收益；Python/PyTorch 负责可变长度集合编码和逐步排班策略训练。模型输出受约束动作，编译为已有工作区；运行端提供单候选直接生成及多候选复核，不以传统搜索结果冒充模型输出。

**Tech Stack:** 现有 Vue/TypeScript、Node、Vitest；独立 Python/PyTorch 训练工程；ONNX Runtime Web 本地推理。具体依赖版本在导出与部署探针通过后锁定，不提前安装或改变当前运行环境。

**Spec:** [神经网络自动排班总体设计](../specs/2026-10-01-neural-roster-design.md)。本文将总体设计落实为任务、接口、资源测量和发布门槛。

日期：2026-10-01。交付状态：计划已编写；下列任务均未据此实施，所列性能和质量值是验收目标。

## 一、承诺的适配范围

最终目标是**固定 GameData 与游戏规则版本下的全部合法布局及全部合法练度**，包括尚未建满的基地、非主流布局、各级设施混配、空/极小库及缺关键干员。不得把“当前软件只支持的部分”永久当成最终范围。未实现的已知合法情况是任务缺口，必须补齐后才能宣称全范围交付。

区分三个层次：输入可表达、排班可合法生成、长期收益与质量可验证。任何一层只覆盖常见模板，都不能算完成适配。布局和练度不会被模型修改；用户给出的干员库不会被补成全员满技能。

“适应”不意味着每个组合都能达到数学全局最优。模型要稳定产生合法、经过模拟且接近强基线的方案；小问题用穷举验证最优差距，大问题用分层独立测试检验质量。未见过的新机制需要升级规则/模型，不能仅靠名称嵌入承诺自动支持。

完整生产、休息和收益相关机制是必做范围。加工、线索、招聘、专精等不属于 82 的资源，保留其岗位与约束，并报告“不计入 82”；不额外加入未获用户指定的资源价格。其他固定配方若没有 82 价值，保留物理产出并按并列规则选择排班，不能将未实现配方伪装成合法零收益。

## Global Constraints

- 唯一目标为 `mower-report-82-ideal-v1`；奖励直接调用 `mowerReportMetrics(report).mower82`，含当前页面特殊订单虚拟赤金。
- 旧评分合同撤销；旧数值标签、缓存和旧目标模型不兼容，只允许重新评价原始场景/排班。
- `potential`、理想跑单 `ideal`、材料无限、Party Time 关闭；复核和页面重算使用同一个执行 profile。
- 设施位置、类型、等级、配方及用户练度固定。干员库必填；明确空数组表示无干员，不能触发全库回退。
- 同技能槽只选当前已解锁最高版本；不同槽独立生效；没有后勤加成不等于不能占合法岗位。
- 休息阈值采用总体设计的显式约定：2 实体电站 0.65、3 电站 0.50、其他合法数量默认 0.65；这些是执行参数，不是收益折扣。
- 无人机首版仅加速制造；实际等级配方必须查证，不能把中级记录等价关系套到全部记录配方。
- 普通主表/候补/组合/已执行策略为首版动作空间；受限条件副表是否必要由质量对照决定，不直接生成任意脚本。
- 未覆盖、故障、窗口不全和未收敛状态不提供可信训练奖励；有效零产出允许为 0。
- 房间顺序、替补顺序、宿舍槽位可能有运行语义，必须保留。干员库输入顺序应不影响问题本身。
- 全部输出收益以最终导出排班重新计算；编辑、补员或改变执行参数后原验证状态失效。
- 开发前保存当前未提交文件与 Git 历史，在隔离工作区执行；不覆盖现有调度修复。

## Review Focus

1. 数据更新丢失低练度技能：任务 1 检验导入前后全部技能槽阶段及升级边界。
2. 非模板/未建满布局误判：任务 2 检验空房、各级混配、实际供电与配方解锁。
3. 极小库被强行补员或疲劳人员被假恢复：任务 3、4 检验空库、空岗、候补和床位不足。
4. 同布局候选或近重复库泄漏到测试集：任务 5 检验家族分组及排列增强只留在原分组。
5. 训练分数与页面不同、导出修改后仍显示旧收益：任务 3、10、11 检验同 profile、同排班和收益失效。

## 二、适配各种练度和布局的具体方法

### 练度覆盖

从 `character_table` 的各干员实际阶段上限和后勤技能槽生成练度域，不仅依靠按星级硬编码上限。所有有效 `(干员,精英阶段,等级)` 都能被输入层接受并解析；无效等级明确拒绝。

对每个合法等级做轻量技能选择校验；重模拟集中在能力改变的技能边界、技能状态组合和困难场景。这样避免对收益等价的每个等级重复跑昂贵模拟，同时保留所有等级输入的支持。

| 情况 | 必做行为 |
| --- | --- |
| 精零/低等级 | 只使用已解锁技能，允许无加成人员占岗 |
| 同槽 α→β→γ | 新版本替换旧版本，不能相加 |
| 低阶段技能在另一设施 | 保留真实适用设施，不能用最高技能覆盖 |
| 混合练度组合 | 按实际成员技能计算条件是否成立 |
| 无后勤技能的合法干员 | 作为已持有人员保留，技能为空；与“缺数据”区分 |
| 新增已知技能阶段 | 重新生成边界清单、特征、测试与训练场景 |

### 布局覆盖

使用实际房间节点及其类型/等级/配方，不把 `243/252` 代号当模型输入。合法性检查包括房间位置、数量上限、中枢解锁、工位、设施等级、实体供电、耗电和配方条件。

空房、未解锁房和已建但空岗分别编码。现有工作区若不能表达合法未建满状态，先扩展表示、编辑及编译，不把它硬填成满建设施。更改 schema 时保留旧存档迁移与无损导出。

设施数量类型的有限组合可系统枚举；等级、宿舍和功能设施组合采用边界覆盖、成对覆盖与随机分层。**不把成对覆盖称作全部组合已穷举。** 有运行语义的位置排列须保留并专项抽样，不能因设施相同就统一重排。

模型采用无固定干员库长度的集合编码、带实际位置语义的设施编码和干员—设施交叉注意力，输出候选干员指针。PAD/EMPTY/FREE/END_LIST 为不同符号，空库与空房必须可计算。

## 三、工程拆分与接口

所有下列文件为拟新增/修改路径，尚未存在的模块不是当前能力。保留模拟器，禁止在 Python 另写收益规则。

| 模块 | 路径 | 唯一职责 |
| --- | --- | --- |
| 数据域与覆盖 | `src/training/domain.ts`、`skillCoverage.ts`、`layoutAdmission.ts` | 可接受输入域、实际技能状态和覆盖报告 |
| 场景合同 | `src/training/contracts.ts`、`profile.ts` | 版本化输入、执行参数与结果 |
| 权威评价 | `src/training/evaluate.ts`、`protocol.ts` | 调用模拟桥接及当前82，批量通信 |
| 排班动作 | `src/training/actions.ts`、`constructiveEnv.ts` | 有限动作、掩码、状态推进与工作区编译 |
| 数据生产 | `src/training/scenarioGenerator.ts`、`datasetSplit.ts`、`teacher.ts` | 场景采样、分组、教师和可重放标签 |
| Python训练 | `training/riic/{client,features,model,train,evaluate,export}.py` | 模型、策略更新、断点与导出 |
| 本地推理 | `src/ai/{features,modelManifest,neuralRoster,neuralRosterWorker}.ts` | 模型包验证与本地逐步生成 |
| 验收 | `scripts/{audit-neural-domain,benchmark-training-evaluator,verify-neural-roster}.mjs` | 域覆盖、成本和发布门槛 |

跨任务接口由任务 3、4 定义并保持一致：

```typescript
type NeuralScenario = {
  schemaVersion: 1; scenarioId: string; familyId: string;
  base: RosterWorkspace; inventory: OwnedOperatorInput[];
  profile: NeuralProfile; constraints: NeuralConstraints;
};
type EvaluationRequest = {
  requestId: string; scenario: NeuralScenario;
  roster: RosterWorkspace; seeds: number[]; horizon: EvaluationHorizon;
};
type EvaluationResult =
  | { status: 'valid'; score82: number; metrics: ReportMetrics;
      integrity: IntegrityEvidence; provenance: EvaluationProvenance }
  | { status: FailureStatus; score82: null; diagnostics: Diagnostic[] };
function evaluateRoster(request: EvaluationRequest): EvaluationResult;
function createEpisode(scenario: NeuralScenario): EpisodeState;
function getLegalActions(state: EpisodeState): ActionSpace;
function applyAction(state: EpisodeState, action: RosterAction): EpisodeState;
function finishEpisode(state: EpisodeState): RosterWorkspace;
```

`ReportMetrics` 包含 EXP、物理/虚拟赤金价值、订单龙门币、82 与其他已支持物理产出。`EvaluationHorizon` 包含 warmupHours/sampleHours/maxEvents；`FailureStatus` 枚举输入错误、排班错误、未覆盖、模拟失败、窗口不全、未稳定、取消。profile、约束、状态和证据结构在任务 3/4 定义并导出 JSON schema，不能让后续任务自行猜字段。

多种子请求返回各次原始证据以及相同窗口下的分项/82算术平均；任何一次未完成不得悄悄丢弃该次后报成功。只有单窗口已完整评价才算 `valid`，不由这个状态声称长期已稳定；长期稳定性是任务9/11另附的证据。原始种子结果保留用于方差和排名检验。

逐步动作和收益评价均通过常驻 Node 批量协议；训练按多个 episode 合并请求，模型端不重复实现游戏约束。运行端直接调用同一 TypeScript 动作环境，消除训练/部署的掩码差异。

## 四、执行任务

各任务都按“先写行为回归→确认失败→最小实现→通过相应检查→保存证据和独立提交”执行。提交只包含该任务文件；文档目录当前被 Git 忽略，确需纳入提交时显式添加指定计划文件，不放开整个 artifacts 目录。

### 任务 0：冻结可复现基线与工作状态

**文件：**创建 `validation/neural-roster/baseline/manifest.json`；使用现有 `package.json` 的检查命令。接口输出规则文件/数据 SHA-256、Git 状态、源码版本和冻结场景。

- [ ] 保存当前未提交状态和 Git 历史，校验备份可恢复；在新隔离工作区开展实施。
- [ ] 执行现有全量测试、typecheck、build，记录失败是否已存在，不以忽略失败作为基线通过。
- [ ] 固定若干真实排班、低练度库、非模板布局和运行参数；记录当前页面82。
- [ ] 输出 `baseline/manifest.json` 和检查日志。**完成：原排班/原版本可复现，新改动不会污染原工作区。**

### 任务 1：完整干员域、技能阶段与导入回归

**文件：**修改 `scripts/import-gamedata.mjs`、`src/domain/operators.ts`、`operatorInventory.ts`；创建 `src/training/domain.ts`、`skillCoverage.ts`、对应 `*.spec.ts` 和小型原始数据夹具。

**接口：**`buildTrainingDomain(source: GameDataSource): TrainingDomain`；`enumerateSkillStates(domain: TrainingDomain): SkillStateCase[]`。提供每名干员阶段上限、全部技能槽、技能解锁边界和数据完整性。

- [ ] 写回归 `preservesAllSkillSlotsAfterImport`、`acceptsEveryLegalLevel`、`replacesVersionWithinSlot`、`keepsIndependentSlots`、`retainsKnownOperatorsWithoutBuffs`；期望来自原始数据夹具，不能用待测选择函数自造答案。
- [x] 修复当前导入脚本仅选 bestSkill 的风险；最高技能兼容快照与完整技能阶段分离。2026-10-01 已用 `src/domain/gamedataImport.spec.ts` 验证实际等级、精英阶段替换、独立槽和重新导入；本地官方 GameData 的 425 名干员、913 条阶段与当前对应档案一致，证据见 `validation/gamedata-import-2026-10-01/real-data-verification.json`。本项完成不代表全部合法等级覆盖清单或训练域已完成。
- [ ] 为全部合法等级生成技能校验清单；技能缺数据与真实无技能分开。未知原始字段/解锁歧义进入阻断报告。
- [ ] 运行 `npm.cmd test -- src/domain/operatorInventory.spec.ts src/training/skillCoverage.spec.ts`，并执行 `npm.cmd run audit:data` 与全目录技能校验。
- [ ] **完成：合法等级解析通过率100%，全部技能边界有独立期望，重新导入不会退化为满技能数据。**

### 任务 2：合法布局域及未建满状态

**文件：**创建 `src/training/layoutAdmission.ts`、`layoutAdmission.spec.ts`；按缺口修改 `src/workbench/model.ts`、`validate.ts`、`src/scheduler/compileRosterSchedule.ts` 与 `src/optimizer/rosterDraft.ts` 的适配。

**接口：**`admitLayout(base: RosterWorkspace, domain: TrainingDomain): LayoutAdmission`；输出合法性、可用工位、实体供/耗电、配方解锁和结构家族标识。

- [ ] 测试空房/未解锁房/已建空岗、1/2/3级产出设施、1–5级宿舍、不同电站数、供电恰好/超额、低级配方及非法设施数量。
- [ ] 枚举有限设施数量结构，生成合法边界布局；游戏规则依据与编译器的限制分别记录，不能把编译限制误说成游戏限制。
- [ ] 补表示和编译缺口，测试旧存档迁移、保留元数据及导出往返；缺设施等级时提示补充，不从排班人数暗推真实等级用于新训练。
- [ ] 运行 `npm.cmd test -- src/training/layoutAdmission.spec.ts src/workbench` 和 typecheck。
- [ ] **完成：输入层不要求243/252模板；所有声明合法结构可表达，电力/配方边界与规则一致。**

### 任务 3：新82权威评价与版本合同

**文件：**创建 `src/training/contracts.ts`、`profile.ts`、`evaluate.ts`、`protocol.ts` 及对应测试；创建 `scripts/evaluate-neural-rosters.mjs`。复用 `scheduleSimulationBridge.ts`、`mowerReportMetrics.ts`。

**接口：**实现上文 `NeuralScenario`、`EvaluationRequest/Result`、`evaluateRoster`；JSONL操作 `evaluate`，请求编号独立，stdout仅协议，日志走stderr。

- [ ] 写特殊订单溢价、实际练度、虚拟赤金不入库存、空库、零产出、旧目标拒绝、超时与不完整报告的回归。
- [ ] 同一完整排班调用当前报表入口；包含全部分项、profile与源数据指纹。固定一份报告测试分项到82的手算结果，另有真实模拟的端到端对照。
- [ ] 手算夹具：24小时内EXP=1000、物理赤金=5、完成一张需求2赤金/报酬1500的非合成玉订单，虚拟赤金价值=500；当前82应为 `1000+0.8×(2500+500)+0.2×1500=3700`。该夹具验证计分，不替代真实排班的机制验证。
- [ ] 建立实际窗口、排班状态、生产状态、规则诊断和非有限数的准入；有原因的空岗也需完整跑完，合法空库返回真实零产出，不报成全库场景。
- [ ] 缓存键含规则/目标/实际技能/全部执行参数/种子/窗口与语义顺序。旧数据重新评分；失败返回 `score82:null`。
- [ ] 运行 `npm.cmd test -- src/training/evaluate.spec.ts src/training/protocol.spec.ts src/workbench/mowerReportMetrics.spec.ts`，并以CLI重放冻结排班。
- [ ] **完成：训练入口与页面同输入同profile结果一致；所有异常与有效0分明确分离。**

### 任务 4：完整主表动作语言与合法解码环境

**文件：**创建 `src/training/actions.ts`、`constructiveEnv.ts`、对应测试；依赖任务1–3。

**接口：**实现 `createEpisode/getLegalActions/applyAction/finishEpisode`；协议追加批量 `reset/observe/step/finish`。动作描述包括目标岗位、动作种类、干员/组/候选列表指针及结束符。

- [ ] 先测试池外人、重复实际占岗、缺技能但可上岗、空库、少床、共享候补竞争、跨站组、菲亚引用主力、跑单候选及有序列表。
- [ ] 开放主班、普通候补、组、宿管/Free、支持工位、跑单与菲亚目标、已执行主配置。每个动作建立“字段→编译读取→事件执行→用例”映射。
- [ ] 掩码只禁止真正违法动作；收益低的合法选择保留供模型探索。剩余资源检查、有限回溯和重采样上限均记录；无有效结果不声称无解。
- [ ] 最终生成 `RosterWorkspace`，完整校验后调用任务3评价；并列时采用确定性策略，不随列表乱序改变目标。
- [ ] 运行 `npm.cmd test -- src/training/constructiveEnv.spec.ts` 与相关现有调度回归。
- [ ] **完成：随机合法动作也能构造可执行主表；全字段具备执行证据，缺人时不补人。**

### 任务 5：分层场景、去重和无泄漏数据划分

**文件：**创建 `src/training/scenarioGenerator.ts`、`datasetSplit.ts`、对应测试和 `scripts/generate-neural-scenarios.mjs`。

**接口：**`generateScenarios(options: ScenarioGenerationOptions): NeuralScenario[]`；`splitScenarios(scenarios: NeuralScenario[], seed: number): DatasetManifest`。

- [ ] 测试同种子重放、重试有上限、所有技能状态可被覆盖、合法布局不是固定模板、输入库重排同组、候补/房间语义顺序不被抹除。
- [ ] 干员库规模采用0、1–10、11–30、31–80、81–160、161至全目录六层；按低练度、混合练度、满技能再分层。每个技能边界有定向覆盖，不仅按比例随机。
- [ ] 数据构成起点：40%广域合法随机、25%技能/供电/缺人边界、20%联动完整/缺失/竞争、15%真实脱敏或当前模型困难场景；无真实数据时最后一类使用合成困难场景。
- [ ] 先按结构/库家族划分再生成排班；基础分组80/10/10，另锁定未见布局结构和未见组合外推集。同场景候选、排列增强、近重复库不得跨组；泛化集受控标签只用于验收。
- [ ] 输出场景、分布、版本、哈希、分组及拒绝原因。**完成：能查出每个布局/练度层覆盖多少，泄漏检测为0。**

### 任务 6：模拟吞吐测量、教师与小问题最优基准

**文件：**创建 `src/training/teacher.ts`、`tinyOracle.ts`、`benchmark-training-evaluator.mjs`、`build-neural-dataset.mjs` 与测试。

**接口：**`buildTeacherCandidates(scenario: NeuralScenario, budget: TeacherBudget): RosterWorkspace[]`；`solveTinyCase(scenario: NeuralScenario, domain: TinySearchDomain): OracleResult`。最优证书注明枚举字段，预算耗尽没有证书。

- [ ] 从100个廉价代表场景开始测速，再扩到1,000个；比较1/2/4个评价进程，记录有效率、p50/p95耗时、事件数、CPU与内存，避免并行过量。
- [ ] 同一场景生成合法随机、按实际技能贪心、现有智能排班和多起点候选，全部用新82评价。冻结执行条件；不给教师无解病例虚构最优标签。
- [ ] 对小库/少岗位的受限空间做穷举，保留所有收益接近的有效答案；只需缓存完整结果摘要，异常高分保留轨迹审计。
- [ ] 预算不足时减每场景候选数或按需重评，不能删掉低练度/非模板层。**完成：有成本表、真实教师数据和独立小问题最优集。**

### 任务 7：随机权重的首个生成模型与部署探针

**文件：**创建 `training/pyproject.toml`、依赖锁、`riic/client.py`、`features.py`、`model.py`、`train.py`、`export.py` 和Python测试。

**接口：**`RosterPolicy.encode(batch: ScenarioTensorBatch) -> EncodedBatch`、`step(encoded, state, legal_actions) -> masked_logits`；`client.evaluate(request) -> EvaluationResult`。解码动作映射来自Node，特征及掩码版本来自统一schema。

- [ ] 先测试变长库、空库、PAD与EMPTY区别、掩码全无可选、输入重排等变、动作指针回映射及技能边界特征；Python不实现收益公式。
- [ ] 首个模型用128维、4层集合/设施编码、4注意力头和指针解码；无干员列表绝对位置嵌入，设施保留真实位置。身份特征仅辅助，主要信息为真实技能和关系。
- [ ] 从随机权重做辅助模仿，取得独立小问题验证表现。只含身份/模板基线作消融，证明读取布局和练度；每次抽样保持有效动作的正探索概率。
- [ ] 立即试导ONNX：编码一次，逐步解码在TS动作环境中运行，避免导出Python控制循环。Python、ONNX的logits/动作/最终收益一致性在此阶段就验证。
- [ ] 运行 `python -m pytest training/tests`；小集训练命令设计为 `python -m riic.train --config training/configs/tiny.yaml`。**完成：网络真实直接生成，可在未见小场景优于合法随机，导出路径可行。**

### 任务 8：广域策略训练与机制缺口清零

**文件：**创建 `training/riic/evaluate.py`、配置 `broad.yaml`、`src/training/ruleCoverage.ts`、`scripts/audit-neural-domain.mjs`；按证据修复涉及的独立机制文件及回归。

**接口：**`trainPolicy(config: TrainConfig) -> CheckpointManifest`；`evaluatePolicy(checkpoint, manifest, budget) -> QualityReport`。checkpoint包含优化器、所有随机状态、动作/特征/目标版本及数据清单。

- [ ] 先完成约10,000个不同场景的初始数据，必要时扩到50,000个；只是预算档位，扩容由分层验证决定，不保证这个数量足够。
- [ ] 用带贪心基线的策略梯度在线优化完整排班。终局奖励来自任务3，按同场景优势更新；不使用“初期静态效率”替代长期目标。失败批次跳过收益更新。
- [ ] 保留辅助模仿，按验证增加困难场景；至少3个独立训练种子。每约2,000次更新或每2小时保存检查点并验证，先到者触发；30轮验证无改善且尾部不升时停止该配置试验。
- [ ] 审计已知技能/设施/配方覆盖。未量化机制作为具名缺口修复，不删除干员，也不永久缩小合法输入范围。当前主表策略不达标时，用小规模对照决定是否需新增受限策略语言。
- [ ] **完成：各布局/练度层分别有直接模型成绩；已知合法发布域不存在被掩盖的规则缺口。**

### 任务 9：多候选、长窗复核与精修

**文件：**创建 `src/ai/neuralRoster.ts`、对应测试；复用现有候选并行池/搜索，对参与新流程的排名入口改用任务3。

**接口：**`generateNeuralRoster(scenario: NeuralScenario, options: NeuralGenerationOptions): Promise<NeuralRosterResult>`；模式 `direct/quality`，包含生成源、最终排班、评价证据和耗时。

- [ ] `direct`只解码一张并复核；`quality`比较8/16/32个模型候选，限制模拟预算，可选精修。与相同调用数/墙钟预算的基线比较，来源不能混淆。
- [ ] 候选使用共同种子集合比较，选中后用独立种子复验。先3天暖机/7天采样，再分开扩大暖机与采样；达到预算仍不稳定则明确标记。
- [ ] 普通候补、宿舍、跨站组、菲亚/跑单及主配置的联合优化按真实事件验收；近并列以长窗重新排序，未能区分时保留并列。
- [ ] 测试取消返回已验证最佳、模型全失败的明确回退、最终导出无事后改写。**完成：模型能力与精修收益可分别归因。**

### 任务 10：模型包、Worker与本地推理

**文件：**创建 `src/ai/features.ts`、`modelManifest.ts`、`neuralRosterWorker.ts`、对应测试，模型清单与权重放 `public/models/riic/`；改 `package.json`仅加入经过探针验证的运行依赖。

**接口：**`loadRosterModel(manifest: ModelManifest): Promise<RosterModelSession>`；manifest含数据/规则/特征/动作/目标版本、权重校验和、支持域与评估摘要。

- [ ] 测版本不兼容、损坏权重、无WebGPU、空库、最大库、取消和Worker故障；WASM为必需兼容路径，WebGPU为已验证加速选项。
- [ ] 固定100组输入逐层比较Python/ONNX；再比较动作及最终82。贪心近并列差异记录；量化模型另验收，不以数值接近自动认定排班等价。
- [ ] 基准设备清单至少包含一台无独显CPU路径设备和当前Windows桌面宿主。**完成：普通用户不安装Python/训练工具即可生成。**

### 任务 11：用户流程、独立发布验收与更新

**文件：**修改 `src/components/workbench/WorkbenchShell.vue`、`OperatorInventoryPanel.vue` 等实际流程；创建UI回归和 `scripts/verify-neural-roster.mjs`；证据放 `validation/neural-roster/release/`。

**接口：**页面调用任务9；编辑事件清除旧评价证据；导出与再次计算读取同一workspace/profile。

- [ ] 实际运行验证布局/库输入、生成按钮、进度、取消、错误、收益分项、编辑重算和Mower导出；不只检查组件源码。
- [ ] 锁定独立测试集，执行下节全部分层门槛及长窗复核；低练度或稀有布局不达标返回任务8，模拟异常返回对应机制任务。
- [ ] 实施结束执行相关回归、全量 `npm.cmd test`、`npm.cmd run typecheck`、`npm.cmd run build` 和Python检查；保存命令/环境/结果，不把旧日志算新验证。
- [ ] 新GameData先跑导入与覆盖审计，再重评价旧模型；新增机制需要解释器、特征和再训练。版本不兼容时提示更新，回退结果明确来源。
- [ ] **完成：真实用户流程通过，独立发布报告满足门槛；不把训练完成等同于产品完成。**

## 五、验收矩阵与发布门槛

基础矩阵按“库规模6层×练度3层×布局家族×关键干员有/无×休息资源充足/紧张”组织；每个可行基础层至少100个独立场景。不能只测几个预设；最终测试规模由实际合法家族数计算，不能提前固定一个很小总数。每个技能边界和设施边界另有定向用例。

| 检查 | 硬性要求或质量目标 |
| --- | --- |
| 输入域 | 全部已知合法等级解析通过；合法布局不依赖模板名字，未建满状态可表达 |
| 人员/技能/布局 | 所有已发布有效结果中，池外人员、虚构技能、修改布局/练度、超工位、实际重复占岗均为0 |
| 缺人及空库 | 不补人；空库给真实零产出；人员不足返回可解释空岗，动态状态完整可验证 |
| 模拟完整性 | 计分可追溯；任何未覆盖/停滞/窗口不足不产生可信成功；已知规则缺口列出并修复 |
| 合法输出率 | 在已知存在有效方案的每个基础分层，工程目标≥99.9%；失败需真实可见，不以总体均值掩盖某层 |
| 小问题质量 | 明确枚举空间内，平均最优差距≤1%、第95百分位≤3%；最优为0用绝对差距 |
| 直接模型质量 | 各主要分层相对强基线收益比中位数≥98%、第5百分位≥90%；作为目标未达到则继续训练 |
| 增强模式质量 | 同预算分别报告收益比、变差率、最差案例与调用数；运行基线后逐例择优才能承诺不低于该基线 |
| 泛化 | 同分布、留出布局、留出干员组合、大库、低练度、缺关键干员分别报告；未来未知机制另列 |
| 长期性 | 连续两次扩窗的分数变化≤0.5%作工程稳定目标；排名/独立种子也需检查，不称数学收敛证明 |
| 部署 | WASM路径与Windows宿主通过，模型加载/编码/解码/模拟耗时及内存分开报告 |

强基线的分数必须也来自新82合同。如果基线无法处理合法极小库，先建立合法部分排班基线，不用缺失基线的分母计算收益比。空库、无82产出等退化场景只验合法/正确性，不计入收益比平均值。

硬性规则可用有限数据域和确定性校验覆盖；有限测试不能证明所有干员子集都近最优。质量承诺来自分层统计与用户输入上的实际复核，发布报告写明样本数、区间和最差案例。

每层100例主要用于发现分层退化，并不证明真实失败概率低于0.1%；在这一样本量下99.9%的经验门槛实际上要求零失败。如需对某个具名关键层声称“95%单侧置信下成功率至少99.9%”，约需3,000个独立零失败样本，且还要处理多层同时检验问题。预算先用于边界全覆盖与质量分层，统计可靠性试验单独立项，不能用100例包装高置信承诺。

## 六、周期、资源与停止条件

以下为**单名熟悉现有代码的工程人员全职投入的工作量估计**，不含未测量的后台模拟时间，也不含重大新机制研究。实际以任务6测速和机制覆盖结果更新。

| 工作段 | 估计 | 里程碑 |
| --- | --- | --- |
| 任务0–3：数据、布局、统一评价 | 2–3周 | 所有输入层边界和当前页面82对齐 |
| 任务4–6：动作、数据、教师及测量 | 2–3周 | 能批量产生完整可重放训练样本 |
| 任务7：首个真实模型/导出探针 | 1–2周 | 模型在小问题直接生成且可部署 |
| 任务8：广域训练与机制补齐 | 3–5周起 | 各布局/练度层达到质量目标 |
| 任务9–10：质量增强与本地部署 | 2–3周 | 可用本地模型产品路径 |
| 任务11：UI、独立集与发布 | 1–2周 | 真实流程与发布门槛通过 |

合计约11–18个工程周起；若未量化机制、合法布局表达或收益正确性缺口较多，先给具名补齐清单并增加工期，不能压缩范围后声称原目标完成。

训练先使用已有机器。CPU适合验证流程；是否使用GPU、batch大小、模型扩大到256维，必须由任务6/7测量决定。当前机器硬件与实际吞吐尚未核实，不据此承诺训练耗时或采购配置。

建立三档评价预算：1,000个场景用于成本/缺口诊断；10,000个场景用于初始学习；50,000个场景作为扩容档。每档开始前估算：`场景数×候选数×种子数×窗口单次成本÷实测并行效率`，再加模型更新与复核成本。数据缓存/磁盘预算按实际文件大小乘数量并留20%空间；超预算先停止保存完整轨迹，不能丢弃版本与有效分数证据。

必须保存异常高分、机制失败与最终候选的完整轨迹；普通候选只保存摘要和可重放输入。短窗标签单独标精度，不与长窗真值混写；最终质量门槛用长窗。

发生以下情况停止扩规模并回到对应任务：已知合法输入被系统拒绝、失败标签进入奖励、训练分与页面不一致、某个布局/练度层持续退化、异常高分违反状态不变量、ONNX无法保持动作语义。不能用增加GPU时间替代规则修复。

## 七、首个实施批次与交付目录

第一批只做任务0–3，交付“真实练度/布局域＋当前页面82权威评价”。这批可以独立验收，其后再做动作环境、训练和集成。每批结束提供文件变更、可运行命令、测试结果、成本和剩余覆盖缺口；模型权重仅从任务7开始成为交付物。

训练数据、权重及缓存独立于源码保存，目录按目标/规则版本区分，失败样本隔离。计划书本身不启动训练、不采购资源、不部署服务，也没有宣称已有模型满足全范围。

实施前阅读总体设计和本文即可获得当前目标。已撤销旧标准的两份历史文档只作入口，不再成为评分或实施依据。
