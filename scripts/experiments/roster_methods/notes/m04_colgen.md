# 方法 04：列生成 + 受限整数主问题

入口：`methods/m04_colgen.py::solve(problem, *, seed=42, budget=16)`。
本方法不使用 SCIP 运行时；实际 LP 与整数主问题分别由 SciPy 1.17.1 的
`linprog(method="highs")`、`milp` 求解。

## 模型与实际操作

按 `factors`、`forbidden` 超边的连通分量划分模式块。一个模式给出一个块中
所有变量的完整选择；块内禁配直接剔除，unary 与全部块内因子计入模式收益。
资源消耗跨块相加，在主问题用容量行约束。这样已声明的因子不会被错误拆成
互相独立的收益；若所有变量由因子连通，模式块会退化为整个有限域。

```text
max sum(q_c * y_c)
每个块 sum(y_c) = 1
每项资源 sum(a_rc * y_c) <= capacity_r
y_c >= 0
```

每块起始仅放入 initial 对应模式；initial 局部禁配时用该块第一个合法模式。
主问题先运行 Phase I：资源行增加非负违反量 z，最小化 sum(z)，并仍满足块
凸组合等式。Phase I 也实际取 LP 对偶定价；因此不会把缺列造成的初始 RMP
不可行误报为全模型不可行。完整定价后的 Phase I 最优值仍为正，才报告声明
模型不可行。人工变量不带入 Phase II。

Phase II 最小化负收益。SciPy 返回等式对偶 pi 和容量对偶 mu；每列的约化成本为
`-q_c - pi_block - mu·a_c`，容量稀缺价格为 `-mu`。每轮逐块添加一个约化成本
小于 `-1e-8` 的缺失模式，重新求 LP。最终所有模式约化成本均不为负时，只证明
这份声明模型的 LP 最优。诊断完整保留每轮目标、等式/容量对偶、稀缺价格、
逐块最小约化成本、扫描模式数、新增列与终止定价状态。

本原型**预枚举并逐轮全扫描**局部合法模式，原始模式空间之和上限为 50,000；
超限返回 `unsupported_model`，同时保留已查询的合法 initial；没有有效查询才返回 None。
这用于小域核验对偶与定价，没有证明
节省枚举。它不调用真实 F 为列估值，也不读取 oracle 内部数据。

任何模型候选之前，合法 initial 先作一次完整 F 查询并计预算，之后去重。
这防止预算为 1 时代理冠军遮蔽更好的真实 incumbent；即使代理模型超限也保留
这条已验证记录。零预算不会查询 initial。

完整 LP 定价之后增加两个明确标记的整数/候选补列步骤：

1. 求当前受限 IP incumbent，扫描资源可行且提升 G 的缺失单块替换，每块加入
   一个最好替换并重新求 IP，最多 8 轮。诊断保留单块增量和 LP 约化成本，
   允许增加**正** LP 约化成本的列；这属于整数局部搜索，不是负成本定价或 B&P。
2. 每块把候选列补到 `min(128,max(8,budget*2))`：一半选择低约化成本模式，
   一半按与已有模式的最近 Hamming 距离作多样补充。使用其他块逐资源最小用量
   做必要条件筛选；它不证明某个完整整数组合一定存在。补列原因和扫描数单独记录。

最后使用补充后的列求受限整数主问题，并用 no-good 行寻找后续整数候选。
每次整数求解有 5 秒上限；候选尝试上限为 `min(128,max(16,budget*4))`。
通过公共 `feasible` 和 `schedule_feasible` 的候选才交给 `evaluate(full)`，查询数
同时受方法 budget 与 problem.remaining 限制。
最终 best_vector 只来自已查询、有效、完整保真的记录，未得到候选则返回 None。

## 证明边界

- 这是 CG + restricted-IP，**不是完整 Branch-and-Price**；整数树节点没有重新
  定价，受限 IP 无整数解或最优都不能转成完整整数模型的结论。
- LP 与整数主问题的收益都是声明的便宜代理 G；真实 F 仅在候选查询后产生。
  G 的 LP 上界不是 F 的上界。
- 排程额外条件只作候选过滤，没有编码进 LP；没有给出完整排班/游戏长期产出证明。
- 资源只覆盖 spec.resources 明确声明的消耗；未编码的全局联动不因对偶价而自动成立。

## 定向验证

命令（仓库根目录）：

```powershell
python -m unittest discover -s scripts/experiments/roster_methods/tests -p test_m04_colgen.py -v
```

独立参照不查询真实 F：全选项 LP 由测试重新构造，整数参照穷举有限域。
关键证据：

| 场景 | 实际结果与意义 |
| --- | --- |
| 三变量三角资源竞争 | 完整 LP = 1.5，6 个分数列；三个人员容量稀缺价均为 0.5；受限整数解和全整数穷举均为 1。终轮扫描全部 6 个模式，没有负约化成本。 |
| 初始两块都占用同一个人 | 不带 Phase I 的初始 RMP 实际不可行；Phase I 从违反量 1 通过新增列降到 0；最终 LP = 4，合法候选为 [1,0]。 |
| 全部模式都需要一个不存在的人 | 完整 Phase I 最优违反量 = 1；报告声明模型不可行；没有调用 F。 |
| 因子与禁配跨变量 | 超边合并为一个三变量块，8 个原始模式剔除为 6 个合法模式；LP 与整数穷举吻合。 |
| 整数收尾迭代 | 完整定价 LP = 23.125，原受限整数解 = 13。加入正 LP 约化成本的单块改善列后提升到 15，与完整整数穷举 [2,2,0,0] 一致。 |
| 整数邻域仍有边界 | 另一实例单块补列停止于 28，联合替换的完整整数穷举为 29；单块补列状态只写邻域耗尽，不能写全局最优。 |
| 代理与真实 F 不同 | 预算 2 只查 initial=[0] 和代理冠军=[1]，从已查记录选 F=5 的 [0]；预算 3 经多样补列查询代理稍低的 [2] 后得到 F=100。 |
| 审查 P2 回归 | 公共 Problem 的 domains=[2]、initial=[0]、G=[0,1]、F(0)=100/F(1)=0，在 budget=1 必须先查询并返回 [0]。修改前测试确实失败，修改后通过。 |

另外验证零查询预算、外部剩余预算、排程过滤、显式模式上限。
排程检查返回未知/预算耗尽时单独记录 `schedule_guard_unknown`，不写成不可行，
也不消耗真实 F 查询。LP 结论采用 HiGHS 数值容差，定价阈值明确记录为 `1e-8`。
这些是实验算法核验证，不是原生 RIIC 游戏/安装运行证据。

2026-10-28 首版 11 项通过；优化后系统 Python **14 项通过，1.206 秒**，
指定实验 venv 的 `python.exe -B -X utf8 -m unittest ...` 再验 **14 项通过，1.724 秒**。公共
`make_toy_problem(budget=16)` 的合法结果、真实查询计数、initial 先评、严格 JSON
均由回归检查；LP 为 15，最终逐块最小约化成本为 `[0,0]`。
首次严格 JSON 检查发现分数列计数为 NumPy int64，已在生成处转成 Python int，
并保留公共契约 JSON 回归。

## 原生计算器多预算迭代

只使用本方法计入预算的 seed=42 search history 决定是否改进，没有读取其他方法
或外部穷举 F 标签，也没有用 runner 的留出 seed 结果调参。通过公共
`run_suite.py --mode native --method 04 --workers 1` 和 NativeOracle 访问缓存；
没有直接读取缓存数据库。完整命令及来源清单随以下独占目录保存：

`artifacts/roster-method-validation-20261028/iterations/m04/`

当前轮实际命令之一（预算 48、128 两轮分别替换 budget 和输出目录后缀；输出目录
必须全新，runner 会拒绝覆盖已有结果）：

```powershell
& 'artifacts/roster-method-validation-20261028/venv/Scripts/python.exe' -B -X utf8 `
  'scripts/experiments/roster_methods/run_suite.py' --mode native --method 04 `
  --budget 16 --workers 1 `
  --node-modules 'C:/Users/Panda-Panta/.codex/worktrees/roster-method-validation-20261028/R.I.I.C-Calculator - Codex/node_modules' `
  --cache 'artifacts/roster-method-validation-20261028/native-cache.sqlite' `
  --out 'artifacts/roster-method-validation-20261028/iterations/m04/r03-diverse-b16'
```

- `r02-incumbent-b16`：修 initial 后、补多样列前，每场景实际只评价 2 个候选。
- `r03-diverse-b16`、`r03-diverse-b48`、`r03-diverse-b128`：当前实现预算 16、48、128。
- `curves-and-selected-config.json`：每次真实查询的最好分数曲线、实际查询数、
  所选通用配置与方法文件 SHA-256。baseline、查询和来源来自各自 results 文件。

| 场景 | 预算 16 / 48 / 128 实际查询数 | 本方法 search history 最好 F |
| --- | --- | --- |
| 单席金条 | 6 / 6 / 6 | 10800.000000000015 |
| 制造组与发电站提供者 | 4 / 4 / 4 | 15066.666666666704 |
| 经验与订单 | 6 / 6 / 6 | 13433.333333333374 |
| 联合基地 96 模式 | 16 / 48 / 96 | 29033.33333333345 |

联合基地所选向量为 `[1,1,0,0,0,1]`。各曲线均在第二次查询达到上述最好值，
更高预算未提高本次分数；当前配置主要修复独立反例、扩大验证覆盖，没有原生
分数提升声明。联合基地 LP 列生成实际从 1 列增加到 2 列；后处理分别扩充到
32、96、96 列。多样补列明确增加了候选覆盖与查询成本，不宣称枚举节省。

对 budget=128 的本方法 history 独立核对了向量集合：4、6、6、96 个有效 full
查询分别恰好覆盖各自声明合法域，没有重复候选。因此上述四个分数也是这些
有限域在本次 search seed=42 的最大已查询分数；这项结论来自逐点 F 查询，
没有由 G 的 LP 或整数主问题推导。三个 r03 轮次源码清单中的方法 SHA-256
均与当前实现一致，核对结果逐行保存在曲线 JSON。

这些原生结果只说明构造的最大阶段干员库和声明有限域上的计算器仿真，
不等于用户干员库、实际游戏、设备运行或域外/其他随机 seed 的最优证明。
runner 的共享缓存与队列也不支持把墙钟时间当作独立算法速度提升。

## 原始资料

- 项目调研：`artifacts/roster-theory-research-20261028/REPORT.md` 第 4 节。
- [SCIP Binpacking 示例](https://www.scipopt.org/doc/html/BINPACKING_MAIN.php)：
  展示定价、分支规则及处理分支决定的约束插件之间的关系。
- [SCIP 9.2.1 定价说明](https://www.scipopt.org/doc-9.2.1/html/BINPACKING_PRICER.php)：
  由主问题对偶寻找负约化成本变量，并区分可行/不可行 RMP 的对偶与 Farkas
  信息，要求定价尊重节点局部固定和分支决定。本实现选择显式人工变量 Phase I，
  没有声称调用 SCIP Farkas 接口或实现其节点定价。

以上官方页面于 2026-10-28 实际读取；这是数学机制参照，不是 SCIP 运行证明。
