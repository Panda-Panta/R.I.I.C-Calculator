# 方法 06：因子图 / max-sum 变量消元 DP

实现入口：`methods/m06_factor_dp.py` 的 `solve(problem, *, seed=42, budget=16)`。只用 Python 标准库，不修改正式计算器，也不枚举 `problem.vectors()`。

## 原理与实际操作

依据 [Dechter, Bucket Elimination: A Unifying Framework for Reasoning, §8 / Fig.25](https://ics.uci.edu/~csp/r48b.pdf) 的局部函数消元及回溯结构，将最小化转换为收益最大化。本实现对待消变量 `x` 收集全部相关因子，计算 `M(separator) = max_x sum(bucket_factors)`，把 `M` 交给剩余变量，并为每行保存 `argmax_x`。消元结束后按反序恢复完整整数向量。min-fill 是启发式顺序，不宣称找到最小树宽；fill 并列时优先较少 separator 消息行，再比较当前 joint assignments，以减少混合域团的内存和后续工作。

因子覆盖 unary、任意已声明局部 reward table、forbidden tuple 和加性 resources 容量。稀疏 reward table 未列条目为 0；禁用组合与容量超限为负无穷。负收益、0 选项（可代表离岗）、负资源用量、常数因子均保持语义。域内单值变量先精确代入。资源因子包含全部非零用量行；可能使图变稠密，不假定房间独立。

诊断包含根问题的消元顺序、该顺序诱导宽度、每个 bucket 的输入因子数、separator、消息表行数、joint assignment 数和 argmax 行数，以及累计 DP 次数、局部 assignment 次数、因子查询次数、最大生成表。40 个二元变量的非零链状交互测试只做 158 次局部 joint assignment，最大消息表 2 行、诱导宽度 1；完整向量空间为 `2^40`。

多个候选由 Lawler 的不相交域分割生成：弹出一分区的 DP 最优解后，按“第一个不同变量”分成前缀固定且当前取值排除的子分区，每个子分区仍用同一完整因子集求解。没有先枚举完整候选再排序。完整 F 查询顺序为合法初始候选、其余按 G 优先的分区冠军；初始候选同样占用一次预算，并与全部 DP 提案共享去重。初始候选不满足结构或排程时不调用 F。`best_vector` 只从本次 valid/full 查询结果选出；`model_best_vector` 单独表示 G 的根问题冠军。

## 计算限制与证明范围

- `budget` 与 `problem.remaining` 共同限制完整 oracle 查询，每次调用均计数。
- 独立的模型工作上限为单消息表 100,000 行、累计局部 joint assignments 2,000,000、DP 求解 512 次。超过上限立即停止，保留已完成的 F 验收结果；绝不删除因子或使用 mini-bucket 近似冒充精确结果。
- 根 DP 完成只证明声明有限 G + forbidden/resources 模型的最优值（或不可行）。前列候选只在分区求解均成功的前缀范围内保持 G 排序；初始候选是明确的单独基线查询。
- `schedule_feasible` 仅检查提案，没有被转换为完整时序因子。有限查询可漏掉更好的可排程方案。
- 公共有限排程器报告 UNKNOWN 时会抛出 `RuntimeError`；方法据此停止候选验收、返回 `schedule_check_incomplete` 并保留已取得的有效 full 结果，不写成不可行或 0 分。
- 真实跨房技能因子的抽取、游戏机制真实性、连续心情、恢复队列与床位时序、随机订单、长期 F 最优性均不由本原型证明。隐藏 F 的得分不进入 DP。
- 任意资源全局因子或高阶组合可使宽度和表规模增长。触发限制表示本实现未完成该域的精确搜索，不能把缺失答案记作 0 分。

## 独立验证

命令：`python -m unittest discover -s scripts/experiments/roster_methods/tests -p test_m06_factor_dp.py -v`

测试用独立的直接求和、约束检查与小域穷举对照；测试对象的 `vectors()` 明确抛错，防止从公共枚举器获得候选。覆盖非零跨变量因子、反序 scope、高阶因子、负值、forbidden、资源容量、离岗选项、固定域、常数因子、不可行、Lawler 前列结果、G/F 排名反转、排程拒绝、oracle 预算及稠密表超限；另固定 seed 628 构造 30 个混合有限域，与独立穷举比较根最优值和前 7 次 G 分数。测试只证明算法核与公共有限模型接口；原生 RIIC F 场景使用主 agent 的统一适配器验证，见下方专项记录。

2026-10-28：最终 19 项测试通过（含 30 个固定随机小域子场景，venv unittest 运行 0.146s）。公共 `make_toy_problem(budget=16)`、seed 42 冒烟：16 次 full 查询、剩余预算 0，`best_vector=[1,1,1,1]`、F=`130.19519751784102`，与 `problem.best()` 一致；G 根最优值 15，22 次 DP、根诱导宽度 2、最大表 6 行。`json.dumps(..., allow_nan=False)` 通过。尚未声称原生游戏或长期收益增益。

### 独立审查 P2 修复与预算梯度准备

复现输入为 `domains=[2]`、`initial=[0]`、`unary=[[0,1]]`、`F(0)=100`、`F(1)=0`。原实现预算 1 只评 G 冠军而返回 `[1]` / 0；先加入回归并观察失败，再将合法初始候选移到所有 DP 候选之前。修复后预算 1 返回 `[0]` / 100，初始与 DP 冠军相同时仍只查询一次。原型的根模型最优证明不因 F 查询顺序变化。

新增 `3×2×2×2×2×2=96` 向量的独立机制场景，含完整六变量 reward 因子；预算 `1/2/8/16/32/64/96` 均通过。根诱导宽度 5、最大消息表 32 行，因子丢弃数始终 0；查询前缀随预算保持一致、不重复，完整 96 次预算覆盖该有限合成域并找到独立穷举 F 冠军。这是原生 96 域执行前的形状/预算机制检查，不是原生游戏证据。

公共 toy-0 的 seed 42 梯度：预算 `1/2/4/8/16/32` 分别实际查询 `1/2/4/8/16/26` 次；第 1 次均为初始 `[0,0,0,0]`。预算 1 的 F 为 `100.19519751784104`，预算 2 及以上为 `130.19519751784102`；预算 32 已耗尽该模型的可行且可排程提案。

## 原生多预算迭代：v2 → v3

证据独占目录为 `artifacts/roster-method-validation-20261028/iterations/m06/`。公开输入来自主 agent 的 `native-round-1/native-engine/public-scenarios.json`，只含 G；候选 F 标签仅通过自己的正式查询取得，未读 SQLite 标签或用留出结果调参。v2、v3 分别执行预算 `16/48/128`，每轮新输出目录，F 查询均计预算。命令形状如下（预算与 out 目录按轮替换）：

```powershell
& 'artifacts/roster-method-validation-20261028/venv/Scripts/python.exe' -B -X utf8 `
  'scripts/experiments/roster_methods/run_suite.py' --mode native --method 06 `
  --budget 16 --workers 1 `
  --node-modules 'C:/Users/Panda-Panta/.codex/worktrees/roster-method-validation-20261028/R.I.I.C-Calculator - Codex/node_modules' `
  --cache 'artifacts/roster-method-validation-20261028/native-cache.sqlite' `
  --out 'artifacts/roster-method-validation-20261028/iterations/m06/b16-v3'
```

v2 记录显示四个场景首次第 2 次 F 查询就达到随后有限全域查询得到的最高值，没有证据支持为这些域添加残差拟合或改变 F 候选政策。实际改进针对可复用的消息表工作：混合域团原先所有 joint 表规模相同，min-fill 的并列项无法识别大域变量；现优先较小 separator 表，已先加入失败回归再修复。

同一公开 G 的隔离对照见 `g-only-comparison-v2-v3.json`：联合场景消元顺序由 `[0,1,2,3,4,5]` 改为 `[2,0,1,3,4,5]`，根消息最大行数 `48 → 32`、局部 joint assignments `182 → 158`、factor lookups `461 → 413`，G 最优值仍为 `28976.017699115044`。六元密集因子完整保留、width 始终 5，不能声称该联合域具有稀疏图优势。预算 16 的全部候选生成工作由 432 降到 400 次局部 assignments；完整 96 候选生成由 640 降到 608。缓存与并行队列影响墙钟时间，因此不声称这些数值就是运行时间提升。

v3 的 `b16-v3`、`b48-v3`、`b128-v3` 全部完成；共同来源绑定和逐查询覆盖核验见 `search-summary-v3.json`：

| 场景 | 有限域大小 | 预算 128 实际 valid/full 查询 | 固定搜索 seed 的最好 F | 最好向量 |
| --- | ---: | ---: | ---: | --- |
| native-gold-relief | 6 | 6 | 10800.000000000015 | `[2,0]` |
| native-automation-provider | 4 | 4 | 15066.666666666704 | `[1,1]` |
| native-trading-exp | 6 | 6 | 13433.333333333374 | `[0,1]` |
| native-joint-base | 96 | 96 | 29033.33333333345 | `[1,1,0,0,0,1]` |

联合场景预算 `16/48/128` 实际查询 `16/48/96`，预算前缀一致、无重复且全部 valid/full；三档预算冠军相同。初始 F 为 `26566.6666666667`，有限域冠军相对初始增加 `2466.666666666748`。第 2 次查询已见该最好值；预算 128 对全部 96 个笛卡尔向量逐一正式查询，因而完成该固定模型、窗口与 seed 下的 F 有限域最优核验。这里的最优由完整查询覆盖证明，不能从 G 的 DP 最优性推出。

v2/v3 之间公共元数据新增了 renewal，同时适配器哈希发生变化；已核对 G 核心、计算器源码及 full/short 窗口一致。v3 三档预算的适配器和完整公开场景哈希一致：方法 SHA-256 `5928f8d9118778b794d387641f3fde256a22a25ae2cc69d224a721309c6d85e2`，适配器 `2a6aea29921ab261a0de9350dc02e0fe26ac0d07087465dbc223ad180b52659e`，计算器源码 `e6315b77e136f366e4601b450303174b39be2d82a28ddc1455a86b7e6bd7245f`。v2 源文件备份为 `v2-source/`；最终 v3 备份为 `v3-source/`。

证明范围仅为构造的实际干员/声明练度场景、warmup 24h / sample 72h、搜索 seed 42 和这些有限离散变量。不是用户真实干员库、游戏实测、随机期望最优或完整排班空间最优；留出复验由主 agent 独立汇总。达到上述有限域最高 F 后不再为这些已覆盖场景增加无证据的候选复杂度。
