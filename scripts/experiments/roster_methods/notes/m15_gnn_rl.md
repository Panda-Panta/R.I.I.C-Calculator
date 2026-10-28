# 方法15：因素图 GNN 与 REINFORCE 静态构造原型

## 实现和公开入口

`methods/m15_gnn_rl.py` 提供契约入口 `solve(problem, *, seed=42, budget=16)`，以及明确分离的 `train_policy(training_problems, *, seed=42, budget=16)`、`evaluate_frozen_policy(policy, problem, *, seed=42, budget=1)`。最终 `solve` 是显式混合部署：学习策略、公开 G 候选池和初始方案分别记账与报告；`train_policy` / `evaluate_frozen_policy` 保留纯学习策略入口。

图包含变量节点、便宜收益因素节点、禁止组合节点和共享资源节点。变量与相关因素之间建立双向边；两轮可训练 sum message passing 后，变量表示和全图平均表示进入共享动作 MLP。动作是按声明顺序为一个变量选值；动态特征包含已赋值状态。动作使用场景内归一化 unary 和当前前缀下公开因素表的条件期望，包含未列出的隐式零表项；避免上万分数值被饱和变换压成几乎相同的特征。G 特征的直接 logit 权重从零开始，由 F 回报训练。不是把排序或随机搜索重新命名成 GNN。

动作 mask 剔除已能确定的禁止组合、资源下界超限，以及完整向量不满足 `feasible` / `schedule_feasible` 的动作。资源下界使用未赋值变量的最小用量，保留负用量补偿。mask 不穷举可延伸性；后续无合法值的前缀会有限次重试，不调用 F。它不证明任意可行输入都能在有限重试中构造成功。

每个完整候选调用 `evaluate(..., fidelity='full')`，无论外部是否命中缓存都计入本方法查询预算。每个场景先用一次查询验证公开 initial，初始化各自的 baseline；该固定方案不作采样策略梯度更新。随后有效、有限、完整 F 分数直接作 terminal reward；REINFORCE 用此前本场景回报的 EMA 作 baseline，按此前方差和尺度下限缩放 advantage，附小量 entropy regularization。动作按策略与均匀合法探索的混合分布采样，log-probability 使用实际混合分布；探索率从 0.25 降至 0.10。训练使用固定 seed 的 common random numbers 降低动作比较噪声，未用新 seed 结果调参。无效、不支持、未完成和异常结果消耗调用但不被填零，也不进入训练。诊断记录实际 reward、梯度、encoder 梯度、参数变化、逐次权重哈希、调用和 mask 次数。

## 训练与留出边界

固定 `solve` 在同一问题上在线适配，预留一次调用给训练结束后的冻结策略，以及最多四次给公开 G 最大值并列候选。G 候选生成在声明域不超过 100000 时完整枚举公开便宜 G，并做结构/排程校验，完全不读取 F；超过上限时明确省略此保护。只保留最多四个并列最大 G，不能由此声称最大 F。G 候选随后每项独立调用完整 F，包含重复/缓存命中也照常收费；其余预算交给训练。

`frozen_policy_vector/score` 始终独立报告策略结果；`best_vector/score` 在冻结结果、已计费验证的 initial 和 G 候选之间选取，部署收益不标成 RL 净增益。训练中记住的最高分只作诊断，不用于这个选择；这不是跨场景泛化实验。训练、initial 与部署候选统一使用 search seed，形成可比较的 common random numbers；外部 runner 的 unused seeds 才是种子留出。预算为零时没有 F 结果；模型未更新或构造失败也明确反映在诊断中。

只要 initial 合法且有正预算，它必须成为第一次完整 F 评价。预算 1 只验证/保护 initial；预算 2 验证 initial 后最多检查一个显式 G 候选，`rl_training_status=not_trained_insufficient_budget`，`frozen_policy_vector/score=None`，不把未经训练的网络输出标作 RL 结果。预算至少 3 时先保留 initial、至少一次采样更新和一次冻结评价，再给 G 池分配余量。initial 的 F 无效/不完整时仍不制造零分或有效 incumbent。

独立迁移实验先把训练问题集合传给 `train_policy`，再把从未参与训练的问题传给 `evaluate_frozen_policy`。后者没有 optimizer、使用 `no_grad`、所有参数 `requires_grad=False`，并核对前后 checkpoint SHA-256。不同 id 但声明输入相同也会标成复用训练输入。不同声明输入仍不保证库存族独立，需要主实验按真实库存、练度、规则版本和近重复排班分组；少数 toy 或两小场景不构成统计泛化证据。

训练总预算和留出预算分别收费。留出默认第一次 greedy 构造；若无可行完成才在同一冻结策略下采样，次数有界；传入大于一的评价预算表示多个冻结候选的 F 验收，不表示训练更新。

## 与论文的关系

[Learning to Dispatch for Job Shop Scheduling via Deep Reinforcement Learning，NeurIPS 2020，§4](https://papers.neurips.cc/paper/2020/file/11958dfee29b6709f48a9ba0387a2431-Paper.pdf) 使用作业车间析取图、GIN 编码和 PPO actor-critic，训练时采样、测试时 greedy。这里借鉴图编码与学习构造策略这个切口，采用因素/变量二部图和更小的 REINFORCE；不声称复现该论文。当前契约没有事件推进 API，状态转移只有静态向量赋值；不等价于心情、暖机、等待和换班事件的动态 RL。

## 核测试与证据

命令：`python -X utf8 -m unittest discover -s scripts/experiments/roster_methods/tests -p test_m15_gnn_rl.py -v`。

核测试检查邻接改变影响 embedding、message encoder 实际反传、禁止/资源/排程 mask、负资源下界、完整 F 奖励、参数和 encoder 确实更新、同 seed 正负奖励反转策略更新、精确查询预算、冻结留出不更新、相同输入改名不算留出、无效结果不填零、不可行/零预算不调用 F，以及固定 seed 复现。使用 CPU、单 torch 线程；未安装新依赖、未使用 GPU。

初版证据（以下历史数值属于改版前）：2026-10-28 实际执行 Python 3.11、torch `2.13.0+cpu`，上述命令退出 0，11 项测试通过，测试本体耗时 4.926 秒（不含 Python / torch 导入）。

另以测试夹具 `TinyProblem`、seed 42、训练预算 5 运行，完整 F 奖励为 `[5,12,5,5,5]`，5 次调用 / 5 次 optimizer 更新：

| 证据 | 实测值 |
| --- | ---: |
| 最大全参数 gradient L2 | 0.7926233691 |
| 最大 encoder gradient L2 | 0.0312296513 |
| 全参数 delta L2 | 0.8666246533 |
| encoder 参数 delta L2 | 0.6874678135 |
| torch CPU 线程 | 1 |

把不同 id 的留出夹具 unary 改成 `[[-20,-10],[-8,-6]]`，seed 43、预算 1：冻结策略构造 `[1,1]`，留出 F = `-7`，调用 1 / 更新 0。训练和留出参数 SHA-256 前后均为 `3df5f97a48dd531e46c065241acb1129afcfb57c66cce0c6681e75ac1235e7ef`。负分照实保留；没有拿训练最大值 12 冒充留出成绩。

## 有界持续优化记录

独占产物在 `artifacts/roster-method-validation-20261028/iterations/m15/`。`original-source/` 保存初版三个文件和 SHA-256；`r00-original-b16/`、`r00-original-b48/` 是初版原生运行。初版上万分数特征饱和，零 baseline 让 16 次预算的全部 15 个策略 advantage 都为正，冻结策略没有学到训练最佳值。已中止不必要的初版 128 次重复轮，未将部分产物记为完成。

`r01-centered-b16/` 是按上述原因修正后的运行；48/128 次预算分别存于同名前缀目录。`summarize_training.py` 只提取本方法训练调用与预算内同场景冻结调用，不读取 runner 的 unused-seed holdout，也不读取冻结跨场景留出结果。每轮 `*-training-curves.json` 保留每次训练 F、历史最佳、baseline、advantage 和权重哈希。

改版核测试实际通过 12 项，8.292 秒，退出 0（`r01-tests-final.log`）；新增大数收益差异和前缀因素条件化测试，已有正负 F 奖励反转策略更新、冻结不更新及预算测试继续通过。初次加入标量 proxy 权重暴露哈希 helper 对零维 tensor 的错误，已改为先 flatten 再按字节 hash 并重测。

16 次预算内同场景冻结策略 F（原版 → r01）：金条 `10133.3333 → 10800`，自动化 `15066.6667 → 15066.6667`，贸易 `13133.3333 → 13466.6667`，联合 `26433.3333 → 28900`。联合训练中见过的最佳 F 是 `29033.3333`，仍与冻结策略的 `28900` 分开记录。训练随机 seed 口径从逐次改变改成固定 common random numbers，跨 seed 的收益结论须由未参与优化的 runner 验证另行判断。

## 冻结的 r02 结果

r02 候选在 `DECISION_LOCK.json` 锁定，算法源码 SHA-256 为 `a81e29ac456c021f61685a049eb4b98f79ee308c9ee760e0a0f08c83435a82f5`；锁后才读取 unused-seed 与跨场景 transfer 结果，不再调参。`r01-centered-*` 保留纯策略消融，`r02-hybrid-*` 为该轮方案。13 项核测试通过，4.223 秒（`r02-hybrid-tests.log`），新增 G 候选池的公开模型最大值、域上限和零 F 查询检查。后续 r03 只修复共享基线协议，未调整训练超参数，证据见下节。

实际使用隔离 Python 执行主运行器，参数为 `--mode native --method 15 --workers 1 --budget 16`，再分别取 48、128；`--node-modules` 和 `--cache` 沿用主实验固定路径，`--out` 分别为 `r02-hybrid-b16/`、`r02-hybrid-b48/`、`r02-hybrid-b128/`。全部退出 0，四场景各自精确使用对应的 16 / 48 / 128 次完整 F；G 候选 F、initial F 和重复 F 均计入该预算。缓存只经标准 oracle 请求访问，没有直接读取 SQL 中未查询的 F。

| 场景 | 预算 16 纯 policy F | 预算 48 / 128 纯 policy F | 三档部署 F | 三个 unused seeds 平均增益 |
| --- | ---: | ---: | ---: | ---: |
| 金条替班 | 10800 | 10800 | 10800 | +666.6667 |
| 自动化提供者 | 15066.6667 | 15066.6667 | 15066.6667 | +2800 |
| 贸易与经验 | 13433.3333 | 13433.3333 | 13433.3333 | +333.3333 |
| 联合基建 | 28633.3333 | 29033.3333 | 29033.3333 | +2466.6667 |

表中 F 是 search seed 42 的完整结果；三档 unused-seed 增益在数值舍入范围内一致。预算 16 的联合场景按 `11 训练 + 1 policy + 4 G 池 = 16` 分配，G 池补齐 policy 的约 400 分差距，因此这部分不能归功于 RL。预算 48 / 128 时策略本身已达到训练里见过的最高 F，但未完整覆盖联合 96 域，不由此声称 F 全局最优；主 agent 的独立 oracle 可提供有限域外部最大值参照。

被冻结跨场景 transfer 单独训练金条/自动化/贸易，测试联合：预算 16 的 policy F 为 `28666.6667`，48 / 128 为 `29000`，每次留出 F 调用 1 次，权重前后哈希一致。联合场景曾作为独立同场景适配任务参与特征诊断，因此它只对这次 checkpoint 参数训练构成留出，不是架构/超参数选择完全未见的外部数据族；不作为统计泛化证据。

三档最终候选、逐次训练曲线、权重哈希与冻结验证全部已保留。更大预算没有带来新的部署收益，停止继续追加训练。所有合成核测试只证明原型算法机制；原生 RIIC F 只证明计算器离线模型，不等于实际游戏增产。未做无限训练、数据族划分或统计泛化评估。

## r03：任何正预算先验证合法 initial

封版共享协议测试实际复现 r02 的小预算缺陷：`domains=[2]`、`initial=[0]`、`G=[0,1]`、完整 `F(0)=100/F(1)=0`、预算 1 时，旧分配把全部预算交给未训练网络，可能返回 `[1]`。现按上述预算规则修复，并直接使用 `common.Problem` 添加 budget 1/2 回归。当前算法源码 SHA-256 为 `4323886ce3283f3f946a739b2f4eebd93826e0cd0b2adb22377954f9dcaf705f`。

实际验证：本方法 15 项测试通过，3.331 秒（`r03-incumbent-tests.log`）；共享 `test_runner.py` 的 3 项通过，7.702 秒（`r03-shared-runner-tests.log`），包含所有现有方法的预算 1 incumbent 协议。

16/48/128 的原生分配不变，经标准运行器仅缓存重放：三档 `physical_native_calls=0`，对应缓存请求 105/265/665 次（含运行器验证与 transfer；方法自身仍按各自预算计数）。12 个场景运行的训练 checkpoint 哈希、纯 policy 向量/F、部署向量/F 和查询数逐项与 r02 相同；冻结 transfer 亦保持相同。见 `r03-replay-comparison.json`、`r03-incumbent-b16/`、`r03-incumbent-b48/`、`r03-incumbent-b128/`。本次没有新增全域 F 枚举、物理仿真调用或长训练。
