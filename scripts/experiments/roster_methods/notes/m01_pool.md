# 方法01：代理目标多解池与结构多样性

模块：`methods/m01_pool.py`；入口：`solve(problem, *, seed=42, budget=16)`。仅用Python标准库，不调用Gurobi，不修改游戏规则。

## 实际操作

1. 合法initial若未出现在既往full记录中，先在预算内评价，保留可验证基线。
2. 枚举公共接口提供的有限模型，过滤结构/有限排程不合法、既往已查询、完全相同的向量；只调用`cheap`读取G。
3. 构造严格按G排序的前k池，以及G精英集合内的结构多样性池。后者先保留G冠军，再逐次选择与当前池最小Hamming距离最大的向量；距离相同时优先G较好者。精英集合默认取前8k。
4. 仅对选定池调用`evaluate(..., fidelity='full', seed=seed)`。initial、失败结果、外部缓存命中均占用一次查询额度。返回`problem.best()`中已真实查询且valid/full的最佳记录，不将失败写成0。

公共元数据可设置`metadata['m01_pool'] = {'mode': 'top-k'}`或`{'mode': 'diverse'}`；默认后者。两者遵守相同F预算。另可设置`candidate_limit`（默认100000个枚举接口产出，含重复）及`elite_multiplier`（默认8）。种子传给F；确定性代理排名及距离平局按向量字典序决定。

## 验证与证明范围

`build_pools`不调用F。定向测试使用F分数仅保存在`evaluate`闭包内、拒绝读取未声明属性的公共接口替身，独立穷举含交互项的三维二值模型，核对G前k、去重、结构差异、预算、排程过滤及无效F处理。还构造同预算下G排序与F排序反转的反例，确认返回的是已查询F冠军。

`model_complete=true`只说明已穷尽声明的模型域并取得有限G值，前k证明只适用于扣除既往full查询后的这个域。达到枚举上限或G含非有限值即明确报告不完整。枚举预算约束产出数量，不能限制公共生成器内部为找到一个合法向量所需时间。多样性是精英集合内的贪心覆盖，不是最大距离组合的精确最优证明。

Hamming距离只描述场景定义的分类决策。场景层必须规范化人员、队伍、角色、策略，避免将无行为影响的槽位置换编码成不同决策。未知解码语义无法由本方法推断。小域测试不证明实际游戏产出；原生RIIC场景、完整F窗口与多种子复验由统一运行器负责，未查询F及留出分数均不读取。

## 理论来源及差异

[Gurobi官方Solution Pool文档](https://docs.gurobi.com/projects/optimizer/en/current/features/solutionpool.html)区分“保留若干搜索中发现的解”和“系统搜索模型前n解”，并说明提前终止影响证明。本原型采用这个多解思想，以明确有限域穷举替代MIP求解器；结构多样性策略是本次工程实现。没有Gurobi性能、许可或完整F全局最优声明。

对应仓库调研：`artifacts/roster-theory-research-20261028/REPORT.md`第1节。当前目标G、完整仿真F、有限排程可行性是不同命题；输出分别保存代理池和F查询结果。

已执行：`python -B -X utf8 -m unittest discover -s scripts/experiments/roster_methods/tests -p test_m01_pool.py -v`。8项通过，测试用例耗时0.002秒；只覆盖方法核与公共API替身，不是原生RIIC或游戏产出证明。公共`common.py`在本次定向验证时尚未提供，由主agent统一集成。

## 原生迭代与保留策略（2026-10-28）

后续已经通过公共`run_suite.py --mode native --method 01`完成16、48、128三个预算，以及top-k同预算16的受控消融。搜索seed均为42；查询只经公共`Problem.evaluate`和公共缓存API。只查看自己的搜索history与训练分数，runner留出输出被过滤，未读取留出分数用于调参。

联合场景96个声明向量均在budget128轮逐个完成有效full评价；实际查询96次，不为填满预算重复查询。budget16/48/128三轮均选中`[1,1,0,0,0,1]`，F为29033.33333333345，初始为26566.6666666667；扩预算没有新增收益。这里的有限最大值只针对该固定源码、构造库存、窗口、目标、seed及96个声明方案，不是整个基建问题或游戏长期产出的最优性证明。

top-k消融同样用16次查询找到相同F冠军。diverse的查询向量平均两两Hamming距离为3.225，top-k为2.3583333333333334。因此保留默认diverse，不声称它在本轮提高了冠军产出。单元测试保留代理与F排序反转的独立反例，另补“大预算穷尽8向量并匹配独立F最大值”的检查。没有将本场冠军向量或原生F标签写进算法。

证据与精确命令：`artifacts/roster-method-validation-20261028/iterations/m01/RESULTS.md`；仅训练记录汇总：同目录`training-iterations.json`。共享缓存命中仍计入算法查询；各轮墙钟包含缓存/并发，不用于宣称单方法加速。

最终定向复跑：上述unittest命令9项通过，0.002秒；方法默认已恢复diverse，native_adapter固定为`2a6aea29921ab261a0de9350dc02e0fe26ac0d07087465dbc223ad180b52659e`。budget128轮的96条完整F查询全部命中同源公共缓存，未新增96次物理仿真；有效已完成F证据及算法预算均逐次保留。
