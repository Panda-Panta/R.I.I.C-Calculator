# 方法13：类别 NSGA-II 与观测 Pareto 前沿

入口：`methods/m13_pareto.py::solve(problem, *, seed=42, budget=16)`。独立实验模块，无第三方依赖，不修改产品计分权重或正式优化器。

## 来源与本轮核读

REPORT 第13节此前仅核对发表信息；本实现于2026-10-28补读 Deb、Pratap、Agarwal、Meyarivan，*A Fast and Elitist Multiobjective Genetic Algorithm: NSGA-II*，IEEE TEC 6(2), 182–197, 2002，DOI [10.1109/4235.996017](https://doi.org/10.1109/4235.996017)。已读取[完整期刊原文镜像](https://dynamics.org/~altenber/UH_ICS/EC_REFS/MULTI_OBJ/DebPratapAgarwalMeyarivan.pdf)中 III.A/B/C（印刷页184–186）与 V.A（192）；另取得[作者托管技术报告](https://homes.cs.washington.edu/~sagarwal/nsga2j.pdf)，后者PDF文本乱码，算法依据以前一份2002期刊正文为准。

正文核对的机制是支配计数和支配集、归一化邻点距离、rank与距离比较、父子合并后逐层保留。本原型将这些用于离散类别；论文中的连续测试性能不能迁移为RIIC收益结论。论文 V.A 还给出约束支配；本原型采用下述修复与拒绝，没有实现其违反量排序。

## 实现与字段

- `nondominated_sort` 维护每点被支配数及其支配对象，逐层释放，确实执行多目标排序。
- `crowding_distance` 按每一目标排序，将归一化两侧邻点间隔相加，非恒定轴的边界为无穷。恒定轴明确贡献0；等距用稳定索引破平局。输出JSON用`boundary=true, crowding_distance=null`表示无穷，避免非标准Infinity。
- 锦标赛先比较rank，再比较crowding；每轮对父代与实际评价得到的子代合并，填满完整前沿后按crowding截最后一层。`generation_trace`保留父、子、层大小及入选向量，供检查实际操作。
- 类别均匀交叉，每基因以`1/n`概率换成不同合法类别；零次变异时强制一个可变基因变异。这是明确的离散小预算适配，不使用连续插值。每第五次提案可随机重启，已查询向量去重；不会枚举真实F。
- 修复先核查`feasible`及`schedule_feasible`，以禁配、资源超量和公开可行性引导有限类别邻域修复，失败时仅回退至已核查合法的父代。全部候选评价前再次通过合法性；实际F仍可能拒绝，拒绝或不完整结果不会变成0分。

唯一新可选元数据是：

```json
{"pareto_objectives": [{"name": "exp", "direction": "max"}, {"name": "change_cost", "direction": "min"}], "pareto_population_size": 4}
```

未显式声明时，第一次有效完整评价固定目标schema，取实际有限数值中的`exp/max`、`order_lmd/max`、`gold/max`、`change_cost/min`；至少需要两个真实字段。显式字段缺失的记录不进入多目标种群，但其有效`score`仍可成为综合best。自动发现不足两个字段会明确返回`unsupported_objectives`。未制造额外指标，未把缺失值填0。目标schema在返回`objectives`中完整列明。

原生迭代后默认初始化为`pareto_initialization="balanced"`：仅统计本轮已查询向量，优先覆盖较少出现的类别；可设`"random"`。默认种群还受类别域大小一半约束，避免4/6点域在初始化时填满而没有父子选择。默认`pareto_score_mating_probability=0.35`，即交配时公开保留35%机会选择本轮既有score最高记录；其余仍为rank/crowding锦标赛。这是明确的混合交配策略，使综合score incumbent即使被多目标截断也能继续繁殖；没有新增目标、混合分数或改变环境选择。设为0即关闭此适配。参数、实际精英交配次数、各类别覆盖数及原score发现曲线均保留在diagnostics。

公共适配器确认`change_cost`是当前向量与initial的Hamming配置差异数，**不是实际换班次数**。`gold`只表达适配器提供的分项数值，本方法没有自行解释为库存平衡或净收益；真实库存语义须由适配器另行提供并显式声明目标。

`best_vector`始终取本轮已查询、有效、full记录的最大既有`score`；Pareto选择不改这个计分口径。另返回全部已观测完整多目标记录中的`pareto_front`，而非只输出最后种群。`budget`与`problem.remaining`双重限制每次调用，外部缓存答复也计查询。提案耗尽表示`search_stalled`，不冒称已遍历域或无可行解。

## 验证命令与范围

从仓库根运行：

```powershell
python -X utf8 -m unittest discover -s scripts/experiments/roster_methods/tests -p test_m13_pareto.py -v
```

测试包括手算前沿及重复点、3×3网格逐层独立筛选、手算crowding与边界、父子精英保留、类别变异、完整已知6点Pareto oracle、原score最优保持、最小化方向、禁配/资源/排程修复、预算与外部剩余额、缺字段、无效/未完成结果和seed重放；另接入主agent提供的`common.make_toy_problem`，用独立成对筛选复算观测前沿并核对`problem.best()`。测试oracle明确为人工有限问题；仅证明算法核和公共接口行为。真实RIIC场景、仿真来源、分项物理语义和实际收益由主agent统一验证，不能从这些单测推断。

初版2026-10-28实际执行：15项测试通过。公共toy、`seed=42,budget=16`冒烟得到`best_vector=[1,1,0,1]`、原始`score=128.19519751784102`，16次查询、3轮父子选择、7个观测前沿候选；已用`json.dumps(..., allow_nan=False)`核对标准JSON，并核对best与`problem.best()`一致。该toy的综合score包含未作为Pareto目标的非局部项，综合best可以不在分项前沿中；两种结果分别保留，不能互相冒充。

## 原生迭代与停止边界

独占证据在`artifacts/roster-method-validation-20261028/iterations/m13/`。`r01-baseline-b16/b48/b128`保存初版，`r02-balanced-score-b16/b48/b128`保存类别覆盖及score精英交配的候选；两个源码快照和每轮runner清单绑定具体实现。`summarize_search.py`只提取自身search history与solver diagnostics，生成`search-comparison.json`和`search-curves.csv`；不读取共享SQL全量标签，不用留出seed调参。

| joint域搜索预算 | 初版原score最好 | 冻结候选原score最好 | 首次达到该轮最好查询（初版→冻结） |
| --- | --- | --- | --- |
| 16 | 28500.00000000009 | 28700.000000000135 | 14→8 |
| 48 | 29033.33333333345 | 29033.33333333345 | 23→19 |
| 128 | 29033.33333333345 | 29033.33333333345 | 23→19 |

其余3个原生小域两版最高score相同：gold-relief为10800.000000000015、automation-provider为15066.666666666704、trading-exp为13433.333333333374。候选在这些小域实际执行父子环境选择；未用更高预算虚构额外查询。

joint 128档初版实际查94个向量，冻结候选查92个；两版自身记录联合出现96个向量且重叠分数无冲突。不过两轮adapter SHA不同，公开spec差异为`metadata.renewal`，尽管底层计算源码SHA相同，也不把跨adapter合并记录直接宣称为单一冻结域的全局最优证明。本法能证实的是：两轮48/128预算均达到29033.33333333345的已观测最高score，冻结候选低预算改善且较早发现高分，因此停止无证据的额外复杂化。冻结候选尚无单次全域Pareto完备性或真实游戏增产证明；留出评价由主agent统一独立处理。

冻结时18项测试通过，新增类别覆盖、微小域实际父子选择、score精英交配可关闭且不改变目标，以及原score发现曲线检查。`search-comparison.json`另对全部24条原生搜索结果独立核对预算、查询计数、原score最佳及成对参照Pareto前沿。
