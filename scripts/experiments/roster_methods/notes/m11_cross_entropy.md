# 方法11：离散交叉熵 CE 原型与四轮迭代

入口：`methods/m11_cross_entropy.py::solve(problem, *, seed=42, budget=16)`。仅使用公共契约，不依赖第三方包、不修改业务源码。开发、验证日期：2026-10-28；Python 3.11.4。

## 理论与实现对应

已直接读取 [de Boer 等，A Tutorial on the Cross-Entropy Method，2005 作者全文](https://people.smp.uq.edu.au/DirkKroese/ps/aortut.pdf)：Algorithm 1.2 / 2.3 根据已采样收益选精英，式(8)/(36)按精英频数更新离散概率，Remark 2.3 式(35)平滑更新，Remark 3.1 允许多类别分布。本文仅把这些机制迁移为有限向量搜索，不迁移论文算例的收益或收敛结论。

每个变量代表契约已声明的完整结构选项（例如队伍模式、恢复方案或策略），维护一行类别概率；初始化为均匀分布。每轮最多评价4个新候选，精英数为有效完整F样本数的25%向上取整；同分按向量稳定排序。精英仅来自**本轮实际查询、`valid=True`、`fidelity='full'`、有限数值score**的记录。初始合法向量先作为独立基线评价，不注入采样轮精英；本原型不读 `cheap`、`vectors()`、oracle内部表或未查询F。

设精英类别频率为 `q[j,v]`，采用：

```text
p_next[j,v] = 0.95 * (0.1 * p_old[j,v] + 0.9 * q[j,v]) + 0.05 / |D_j|
```

当前选用 `0.9` 精英更新系数；额外的5%均匀混合是本原型的探索设计，给每个类别 `0.05/|D_j|` 的下界。无有效精英则保留原分布。二元分布 `[0.5,0.5]`、单精英类别1时，手算得到 `[0.0725,0.9275]`。测试也保留旧参数 `.7/.1` 对应 `[0.185,0.815]` 的独立核对。

## 合法性、预算与可重放记录

真正按累积类别概率随机采样，每次先查公共结构与有限排程约束。若不合法，随机次序把改变的决策恢复到已知合法锚点，遇到合法向量即停止；没有锚点则拒绝。锚点优先采用已验证最佳向量；F不支持的候选即使结构合法，也不会作为收益精英。修复不调用F，不推断未查询收益。

用trie仅保存已提案或已评价向量，递归求每个类别分支尚未屏蔽的产品概率质量，再按这些权重条件采样。它保留CE类别概率的偏好，并且无需枚举未查询F即可消除原始提案重复；直接累加未屏蔽质量，避免近似相等大数相减。修复仍可能落回已评价锚点，此类重复记录后跳过。每轮最多128次提案，生成停滞时返回已验证结果；所有声明向量已评价时明确记录 `declared_domain_exhausted`。每次真实 `evaluate` 都计入本地预算，并同时遵守 `problem.remaining`；外部缓存不免计数。无效、非完整或NaN/inf分数在返回记录中为 `None`，不会当作0超过负收益方案。

`diagnostics.distribution_history` 保留每轮更新前后概率、精英频数、阈值及精英/样本查询序号；`diagnostics.evaluations` 保留实际评价向量、原始提案、采样/修复来源及有效性。proposal/repair/reject/duplicate计数可检查合法解码的实际成本。固定seed控制采样、修复次序和评价seed。

## 已执行验证

```powershell
& 'artifacts/roster-method-validation-20261028/venv/Scripts/python.exe' -B -X utf8 -m unittest discover -s scripts/experiments/roster_methods/tests -p test_m11_cross_entropy.py -v
```

首次运行在方法文件尚未创建时按预期导入失败；新增条件采样测试先复现缺少该机制，再实现。最终实际结果：**Ran 16 tests in 0.021s / OK，退出码0**。覆盖实际类别采样、两套参数的独立手算更新、均匀及非均匀条件概率、极小剩余概率质量、有限域零重复覆盖、精英与已查询F逐项对应、完整trace的seed复现、预算及remaining、稀疏可行域修复、全无效/无候选返回未知、负收益、NaN/inf、500次同精英更新后的概率下界。

独立可手算检查包括二元更新、排除一个向量后的条件产品权重，以及6向量全域零重复覆盖。稀疏场景采用10个二元变量，结构要求 `sum(x)<=1`，排程另要求 `x0=0`，核对只有合法候选交给F、无效收益不作0。此类检查只证明算法核，不能作为一般最优保证。

公共 `common.make_toy_problem(budget=16)` 已实际冒烟，核心命令如下，以 `python -X utf8 -` 执行，退出码0：

```python
import json
from scripts.experiments.roster_methods.common import make_toy_problem
from scripts.experiments.roster_methods.methods.m11_cross_entropy import solve
problem = make_toy_problem(budget=16)
result = solve(problem, seed=42, budget=16)
json.dumps(result, allow_nan=False)
assert result['diagnostics']['queries_used'] == len(problem.history) <= 16
assert result['best_vector'] == problem.best()['vector']
assert result['best_score'] == problem.best()['score']
assert all(row['fidelity'] == 'full' for row in problem.history)
assert all(problem.feasible(row['vector']) and problem.schedule_feasible(row['vector']) for row in problem.history)
```

最终配置实际 `toy-0`：16次查询均有效full，4轮更新，5次修复、3次修复后重复，最佳F=`130.19519751784102`，终止原因为预算耗尽。三toy的seed42/预算16最高已观察F依次为 `130.19519751784102 / 131.19519751784102 / 129.19519751784102`；24组有限参数配置、每次查询及分布曲线存入独占证据目录。该值是toy oracle证据，未据此宣称真实场景收益或全域最优。

## 原生有限场景迭代与停止依据

完整记录和可重跑命令见 [四轮迭代报告](../../../../artifacts/roster-method-validation-20261028/iterations/m11/ITERATION_REPORT.md)，搜索曲线为同目录 `search-only-curves.json`，最终断言为 `final-verification.json`。未读取SQL全标签，未根据suite自动生成的留出seed结果调参。

初始独立提案在joint预算128时仅评价92/96个向量、产生1718次重复。放宽精英/降低更新系数的第二轮在预算16损失joint搜索质量，未保留。第三轮增加条件去重，joint第7次查询达到当前有限域峰值，但toy-0预算16回归。最终第四轮保留条件去重，选择 `rho=.25 / alpha=.9 / epsilon=.05`，在四个native预算16场景都保持完整域峰值（`1e-6`容差），并恢复三toy质量；它并非joint首次发现峰值最快的参数。

最终native预算16/48/128全部实际运行。128档四个声明域分别4、6、96、6个向量，均已逐一full有效评价、零重复；因此固定search seed42的这些有限域F峰值已核实。joint峰值为 `29033.33333333345`，最终16档在第12次达到其 `1e-6` 范围。继续查询同一个完整有限域无法提高其已穷尽的峰值；这不说明对更大排班域或其他seed已达到最佳。

迭代中native adapter哈希发生变化，历史与当前不混作单一源码候选。最终三档共享方法SHA-256 `a3d8a6b31f2668e0f5297b731922c0d790bc0e8a180b515cd3c4f1ce774a74c5` 与adapter `2a6aea29921ab261a0de9350dc02e0fe26ac0d07087465dbc223ad180b52659e`；旧、新adapter间仅核对本方法已观察的4/6/92/6个交集标签，最大差值为0。最终有限域最优核验仅使用最终adapter的完整记录。

## 适用条件与边界

适合已有完整结构选项、廉价可行性判断和昂贵F的全局搜索基线。约束修复和去重会改变原始独立提案的实际接受分布，本实现是带合法解码的CE启发式，不能援引无约束独立采样的理论保证。逐变量边际分布不能表达全部跨变量相关性；严重稀疏或互斥的可行域可能持续回退同一锚点，128次无新评价即停止，不宣称已穷尽。

4个样本/轮服务于16次预算的可运行演示，不能可靠估计高维分布。固定评价seed便于复放，不能证明随机F的排序稳定性；实际产出结论仍须独立留出seed及足够窗口验证。已完成上述四个原生有限场景；未验证真实游戏、任意完整排班域或软件发布/同步。配置选择来自有限开发场景，不是跨场景泛化或任意参数空间最优证明。
