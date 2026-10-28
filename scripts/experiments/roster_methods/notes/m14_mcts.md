# 方法14：MCTS / UCT 静态构造树原型

入口：`methods/m14_mcts.py` 的 `solve(problem, *, seed=42, budget=16)`。仅使用标准库，无共享依赖变更。

## 与原始理论的关系

已读取 [Kocsis、Szepesvári, Bandit based Monte-Carlo Planning, 2006](https://aima.cs.berkeley.edu/~russell/classes/cs294/s11/readings/Kocsis%2BSzepesvari%3A2006.pdf) 第2节的 rollout、UCB1/UCT 和访问/均值更新，以及第2.4节对有限时域、缩放奖励的前提。REPORT第14节提出的基建事件决策需要状态复制、事件推进及合法动作枚举；公共CONTRACT没有这些API。

本实现因此验证的是**静态排班向量的构造树搜索**。树状态是固定变量次序的赋值前缀，动作是给下一个变量选值；隐式树的终端叶为完整向量。只有同时通过公共 `feasible` 和 `schedule_feasible` 的完整叶才允许查询F。先在预算内首评合法initial保留incumbent，然后根做一次完整rollout，后续显式树每轮扩展一个节点再补全；不把部分赋值当成可计分排班。

没有实现或验证事件级动态策略，没有改变业务引擎，也不把小树验证称作真实游戏增产或无限期平均日产出的一致性证明。

## 实际算法操作

1. Selection：已扩展节点按 `mean_valid_score / fixed_public_scale + sqrt(2 ln(parent_visits) / child_visits)` 选择，随机打破并列；尚无有效观察的分支先探索。
2. Expansion：随机取一个未扩展值，建立前缀节点。公开forbidden条件与资源剩余用量下界提供便宜剪枝，不读取未查询F。
3. Rollout：DFS补全，默认按公开G对“当前前缀＋本次动作＋初始后缀”的完整试探向量排序，随机打破并列；可用 `rollout_greedy_probability` 调成概率混合或纯随机。此排序不读取未查询F，也不作为回传奖励。终端检查结构与声明的有限排程。单次节点限额默认5000，总树迭代限额默认 `max(64, budget*32)`，与F查询预算分别记录。截断补全不能证明子树不可行。
4. Backpropagation：所有路径节点增加遍历次数；仅有效、完整、有限F分数进入奖励样本数和奖励总和。保留原分数的均值，便于复核。每轮轨迹记录选择前缀、扩展前缀、完整叶和回传路径。

合法initial是统一首个计费F查询；若预算仅1且initial的F高于G冠军，也必须返回这个已验证基线。初始结构或声明排程不可行时跳过，不花F；调度UNKNOWN保留未知。initial和随后根rollout都实际调用F、扣同一预算，结果仅回传已经到访的根，不给未访问的子动作虚构访问或收益。之后仍执行真实UCT选择和逐节点扩展。默认对同一seed不重复查询完整叶；只跳过提案，不用缓存奖励虚增回传次数。`repeat_evaluated_leaves=True` 可显式研究重复采样，此时每次重复仍扣预算。

固定分数尺度默认 `max(1, abs(cheap(initial)))`，仅从公开便宜模型导出；初始向量不可行导致cheap非有限时回退为1，可在 `metadata.mcts.reward_scale` 明确设置。它对原F作线性缩放，不改变已查询候选的最终比较；未建立奖励有界等UCT原论文的假设，不声称理论保证。最终返回本次有效full评价中原始F最高的完整向量，而不是把根部某动作均值当作完整方案。

每次 `evaluate` 调用均扣算法查询数。`budget`与`problem.remaining`任一耗尽或可查合法叶已覆盖即停止。unsupported/invalid分数记为缺测（None），不进入均值、最佳值或零分标签；本轮排除已拒绝的完整向量，避免重复消耗在同一个未支持输入。该排除是本次搜索处理策略，不证明它在其他配置或运行中永久无效。公共有限调度器抛出的UNKNOWN记录为调度未知，不消耗F、不排除子树，也不回填奖励。

## 定向验证

命令（仓库根）：

```powershell
python -X utf8 -m unittest discover -s scripts/experiments/roster_methods/tests -p test_m14_mcts.py -v
```

测试使用独立TinyTreeProblem明确给定的奖励，算法只调用它的公共API；没有接触真实F内部数据。覆盖：手算UCT数值与低访问分支探索；实际树选择、扩展、rollout、回传；四叶非加性已知最优；同seed可重放；双重查询预算；资源/forbidden/排程合法性；负资源用量安全下界；未支持及全未支持分支不回填零；补全截断不花F预算、不声称不可行；初始cheap非有限；调度UNKNOWN保留未知；公共common契约和严格JSON（不允许NaN/Infinity）冒烟。

原始v0的128次查询二层二叉奖励树得到7个显式节点、248次selection、6次expansion、382次路径节点更新；高奖励根分支访问122次/均值1，低奖励分支访问6次/均值0。重复叶模式仍作为独立UCT机制测试；默认覆盖模式另检验四个叶只查询四次。

公共 `make_toy_problem(budget=16)`、seed42冒烟得到完整合法最优已观察向量 `[1,1,1,1]`，原分数 `130.19519751784102`，与公共 `problem.best()` 一致；实际16条full评价全部通过结构与声明排程，16个树节点、30次selection、15次expansion；1次补全失败未扣F查询。该场景为 `synthetic-kernel-only`，不代表原生RIIC产出。主agent统一执行原生RIIC场景时的F结果另列。

初版12/12通过，0.012秒。迭代版另外检查去重、公开G引导、baseline和根warm-start仅回传根、G误导后树搜索仍找到更好F、budget1保留更优initial、非法initial跳过；最终结果见下方迭代记录。

## 原生迭代与停止依据

独占证据在 `artifacts/roster-method-validation-20261028/iterations/m14/`，搜索记录分析入口为 `analyze_search_only.py` 和 `comparison-search-only.json`。未读取SQL全F，缓存只经公共点查询；未访问留出分数来选择配置。

1. 冻结v0，运行native预算16/48/128。四场景最佳F在16时已到v0在128内的最高观察；小域4/6个叶反复评价，joint在128次中仅80个不同叶。
2. v1改为同seed不重复，探索 `rollout_greedy_probability=0/0.5/1 × reward_scale_fraction=0.05/0.25/1` 共9配置、每场景预算16。历史记录在 `ablation-v1/`，尚不满足后续统一首评initial约定，不能当作正式公平比较。
3. v2先做根G引导rollout，曾报告第一查询达最佳。封版反例实际复现：`domains=[2], initial=[0], G=[0,1], F(0)=100, F(1)=0, budget=1` 只查询[1]而丢掉更好initial。因此**v2候选不合格，其“第1次”优势撤回**。复现记录保留在 `baseline-repro-before.json`，不删历史证据。
4. v3在预算内先查合法initial，再做G根rollout和UCT。相同反例在budget1/2均返回initial的100；首评及根rollout只更新根，不虚构子动作访问，非法initial跳过。修复记录为 `baseline-repro-after.json`。
5. 用v3重新运行相同9配置，统一包含首评initial，共288次计费点查询。指标只用搜索归一化incumbent曲线面积，不使用留出结果。G引导=1的面积约1.09249050，随机/标准尺度约1.08936261；G=1时三种UCT尺度完全持平，保留标准尺度1、自然变量序。正式配置证据在 `ablation-v3-baseline/`。

| native场景 | v0历史首次等价最佳查询 | v3首次等价最佳查询（含首评initial） | v3预算16实际F/不同叶 | v3预算48实际F/不同叶 | v3预算128实际F/不同叶 | 最佳F |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| gold-relief | 1 | 2 | 6/6 | 6/6 | 6/6 | 10800.000000000015 |
| automation-provider | 2 | 2 | 4/4 | 4/4 | 4/4 | 15066.666666666704 |
| trading-exp | 2 | 2 | 6/6 | 6/6 | 6/6 | 13433.333333333374 |
| joint-base | 14 | 2 | 16/16 | 48/48 | 96/96 | 29033.33333333345 |

最终v3三档共12个native运行均evaluated，运行期间 `source_unchanged=true`；每次实际查询均为valid/full，12次首评均为对应initial。joint预算128真实发生682次selection、168次expansion、1020次路径更新、169节点；96次F无重复，覆盖声明96个完整叶后停止。原始v0-b48的全实验源码清单在并行期变化，其方法文件与冻结v0哈希一致；该轮保留此限制，不冒称全局冻结。

这些结果说明在**这四个声明有限域、seed42**中，最佳F没有超越原v0；改进是joint计费查询位置14→2和减少重复查询。容差 `max(1e-8, abs(F)*1e-12)` 仅忽略约6e-11的浮点次序差异。每个声明叶已实际查询，而统一首评initial后第二计费查询已达同域最高观察；不能把跳过基线造成的“第1次”当成优势。它不能证明泛化后的最佳配置，也不能证明UCT比纯G增产：这些场景的G引导根rollout本身已命中最优，后续树搜索提供覆盖核验。用户真实大库存、事件动态决策与真实游戏仍未验证。

最终独立测试 **18/18通过，0.008秒**，日志为证据目录 `tests-v3-baseline.log`。正式方法SHA256为 `cbe80505d267b0002541590d206d4cae4bb300cd264fde22c5486ba039cbf9a9`，与v3冻结源码匹配。本次native查询使用公共点缓存，逻辑查询全部计费；不把缓存墙钟称作新仿真速度或重算证据。
