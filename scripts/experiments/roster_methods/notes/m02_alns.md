# 方法 02：自适应大邻域搜索 ALNS

入口：`methods/m02_alns.py` 的 `solve(problem, *, seed=42, budget=16)`；只依赖 Python 标准库和公共 Problem 契约。业务接入与真实 RIIC oracle 由公共运行器负责。

## 原论文与实现关系

- Ropke、Pisinger，[原期刊记录，2006](https://pubsonline.informs.org/doi/10.1287/trsc.1050.0135)。期刊 PDF 跳转到摘要；哥本哈根预印本下载超时，CiteSeer 副本 403。
- 实际读取了作者 Stefan Ropke 上传的 [2005-08-08 原稿正文](https://www.researchgate.net/publication/220413334_An_Adaptive_Large_Neighborhood_Search_Heuristic_for_the_Pickup_and_Delivery_Problem_with_Time_Windows)，重点为 §§3.1–3.6。其算子轮盘、历史奖励更新和退火接受构成本实验依据；并未迁移运输问题的实验结果。

本原型将运输请求改为声明的离散决策，采用随机释放、按因子/冲突/资源关联释放及独立全释放 restart 三类 destroy。相关释放保留所选因子的完整变量块，避免只能单变量走动。当前保留 V2，以相关块贪心修复暖启动，再让三类算子按实际奖励竞争。

## 可运行机制

1. 合法初始向量先进行一次 full 查询。结构或排程不合法的初始向量先修复，不把它送入正式比较。
2. destroy 与 repair 分别维护权重，各先探索一次，之后按权重轮盘抽取。destroy 的暖启动顺序为 related、random、restart；repair 包括便宜模型最佳与按便宜排名随机采样两种。
3. repair 固定未释放的变量，仅对释放块做有界回溯；公共 forbidden 与资源容量下界先剪枝，完整向量再通过 `feasible` 和 `schedule_feasible`。最多 4096 个回溯节点；到达上限只保留已经完成的合法候选。这是启发式修复，不是 CP-SAT，也不声明精确求解大块。
4. 仅给最终选中的未查询候选调用 `evaluate(..., fidelity='full', seed=seed)`；每次查询同时受方法 budget 和 `problem.remaining` 限制。无效、不支持、非 full、缺分数或非有限分数始终为 None，不进入 best、当前收益或零分训练样本。
5. full 收益提升则接受；变差按 `exp((new-current)/T)` 接受。初温为已验证初始分数绝对值的 10%，初始不可用时仅用 cheap 标度；cheap 若为非有限值则标度回退为 1，且标度至少为 1。这只设置温度，不伪造 F。温度按已用查询占预算比例衰减至初温的 5%。
6. 每 4 次尝试按实际观测更新算子权重；全局最好奖励 8，当前改善奖励 4，接受新候选奖励 1，其余 0。反应率 0.25，未使用算子保持原权重，权重最低 0.05。末段也更新。最多 `max(16, 12*budget)` 次提案；当全变量 repair 未截断且已付费查询覆盖全部合法完成向量时立即停止，避免已证域耗尽后空转。
7. 完整覆盖 witness 记录合法域大小、唯一付费查询数和有效 full 数。仅当每个合法向量在本次 search seed 都有一次有效 full 观测，才声明该冻结域的一次观测最大值；有任何未支持/无效观测则不生成这个最大值证明。没有覆盖 witness 时仍是预算内启发式。

诊断记录每次选择、释放变量、回溯节点/截断、完整观测、接受概率、奖励、前后权重及停止原因。固定种子可重放算法操作；oracle 自身的重放仍依赖其契约。

## 定向核验与证据边界

运行：`python -X utf8 -m unittest scripts.experiments.roster_methods.tests.test_m02_alns -v`。

独立小域可手算：二元变量 00→5、01→0、10→0、11→10，00 是单变量翻转的严格局部峰值。相关 destroy 同时释放两个变量，修复可到达 11；测试将结果与四点穷举比较。其他检查覆盖冻结变量、资源/禁止元组/排程过滤、真实权重变化、固定种子完整日志重放、查询预算、不支持 None、cheap/F 排名反转、热/冷退火及无效初始修复。

2026-10-28 V1 实测：最初 11 项核检查通过，seed=42、budget=4 的完整搜索查询 4 次，返回 `[1,1]`、F=10；操作日志为随机单变量低分候选拒绝、相关双变量低分候选拒绝、随机双变量候选 F=10 接受。末段 destroy 权重由 `{random:1, related:1}` 变为 `{random:1.75, related:0.75}`；额外直接核验相关 destroy 的贪心联合 repair 也得到 `[1,1]`。节点上限 3 的测试确认未探索子树如实标记截断。

公共契约冒烟：在本实验目录以 `python -B -X utf8` 导入 `common.make_toy_problem(budget=16)` 并 `solve(...,seed=42,budget=16)`，得到 `[1,1,1,1]`、F=130.19519751784102；查询数和 history 均为 16，best 等于公共 `best()`，结构和有限排程检查通过，`json.dumps(...,allow_nan=False)` 可序列化。追加无效初始向量时发现公共 cheap 返回 -inf 导致温度 inf；已限于本方法修正标度回退并补回归。公共 toy 同样只属于合成核证据，原生 RIIC 由主 agent 统一验证。

## 原生迭代与保留版本

用户随后要求持续优化到有限域内无可证改进。独占证据：[m02 迭代目录](../../../../artifacts/roster-method-validation-20261028/iterations/m02/)，包含 V1/V2 源码快照、16/48/128 三档预算的6次原生运行及来源变化后的2次复核、最佳配置、逐查询数值及可视曲线。总结脚本只提取本方法已付费的 search history，不读取 SQLite，也不提取留出分数作改进。

V1 在128预算下已付费覆盖4/6/6/96个原始有限域向量，收益有明确完成参照；但耗尽后仍运行1536次提案，且 joint 首次最好在第6次查询。V2 用相关块贪心暖启动，将 joint 首次最好提前至第2次查询；trading 从第4次提前至第2次。独立 restart 保留全释放跳出断连合法分量的能力，完整 repair 覆盖 witness 则避免域已耗尽后继续削弱权重。

V2 核验：上述 unittest 命令共14项通过，新增覆盖声明域结束、已查询但不支持时不作最优证明、无已知因子的断连分量通过 restart 联合修复等检查。收益证明只限本次实际付费覆盖的、固定 seed=42、full 仿真与声明域；最终停止记录以迭代目录的 `summary.json` 和 `ITERATIONS.md` 为准。

这些检查只证明算法核在声明小域中的行为。合法修复只等同公共结构和有限排程检查；最佳结果只属于本次实际 valid/full 记录，不证明未查询方案、全局最优、期望收益或游戏实测增产。真实 RIIC 场景结果须由公共运行器另列，不能以小域结果替代。
