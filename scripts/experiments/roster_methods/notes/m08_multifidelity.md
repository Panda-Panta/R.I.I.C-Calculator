# 方法 08：多保真与逐轮减半原型

实现入口：`methods/m08_multifidelity.py::solve(problem, *, seed=42, budget=16)`。依据本实验 `CONTRACT.md` 与调研报告第 8 节。只读公共域、合法性、便宜特征和实际查询记录；不改产品源码或依赖。

## 实际操作与预算

这是带探索和淘汰审计的一个 Successive Halving bracket；未实现 Hyperband 的多 bracket 调度，也没有 BOHB 的概率模型，不能以这两个完整算法的名称报告。

1. 初始方案先通过公共结构约束及声明排程检查，再以 `fidelity='full'` 查询，保存完整基线。公开无效的初始方案记录 `initial_validation.reason`，不消耗查询，也不进入后续 full 复验。
2. 完整 Cartesian 域不超过 4096 时只枚举公共域、结构/声明排程合法性及 `problem.cheap`；大域混合初始方案单变量变化和随机完整向量，保留有界提案池。这样不会在只有 96 个公开候选时，因随机提案 18 个而漏掉已经可知的 G 前列。该层绝不读取隐藏 F，也不标成短窗原生仿真。
3. 预算允许时，以实际 `problem.evaluate(..., fidelity='short')` 查询入围者。若 cheap 排名筛掉了候选，额外保留一个低于 cutoff 的随机探索名额。
4. 按有效 short 分数保留约一半，全部调用 `fidelity='full'`。另随机抽一个 short 被淘汰者作 full 审计，允许慢热候选重新获胜。无效或未完成 short 保持未排名；不替换成 0。
5. 若剩余总预算足够检查全部已公开扫描的合法向量，预先为它们保留 full 槽位，再分配 short 查询。晋级和首个审计完成后，余量优先 full 查询其他 short 淘汰者，再查询 cheap 淘汰者；避免反复复验已有方案，却让仍未知的候选永远没有 full 机会。
6. 已生成候选都得到过 full 查询后，才将剩余查询循环分配给公开合法的初始方案和 full 入围者，用新 seed 作 full 复验。最终选择本轮有效 full 观测均值最高者；未获得有效 full 的向量不能成为结果。

`budget` 及 `problem.remaining` 共同限制每次 `evaluate` 调用总数，外部缓存不免除计数。便宜调用数另记，不能把查询数减少直接解释成墙钟加速。扣除合法初始 full 后少于 3 个查询时，只做 full 查询；初始公开无效而被跳过时，3 个查询已可运行 2 short→1 full。无查询预算返回 `best_vector=None`。

预算 16 的真实 96 域计划为：初始 full 1；cheap 95 个非初始候选 → short 9 → 排名晋级 full 5 + 淘汰审计 full 1，总计 short 9 + full 7 = 16 次 oracle 查询，另有全域 96 次便宜估值。预算 48 为 short 30 + full 18。预算 128 可同时保留 short 32、全部 96 个候选 full；这一资源分配在独立 96 域机制测试中已验证。小有限域在预算足够时先完整 full 覆盖，再使用新 seed 复验。

`finite_full_coverage` 仅在公共有限域完整扫描、其中每个公开合法向量都取得主 seed 的有效 full 结果时，报告 `fixed_seed_maximum_certified=true`。这是明确标注的小域穷举 full 审计，不把枚举证书的最优性归功于 Successive Halving 的淘汰规则。它要求 full oracle 对 vector/fidelity/seed 是确定函数，证明范围只到这个声明域和固定 seed；任一个 full 无效都会阻止证书。最终多 seed 均值选优与固定 seed 最大值分开报告，不把固定 seed 证书当成期望产出或真实游戏最优。

## 排序风险与证据边界

`diagnostics.rounds` 保留候选数、晋级/淘汰向量、探索和审计向量及查询记录。`rank_diagnostics` 在主 seed 的实际 full 交集内报告 cheap/full、short/full 的 Spearman 相关及成对排序反转。该交集经过筛选，不能视为全域相关或无偏估计。不同窗口可能改变随机事件序列；相同 seed 也不自动构成共同随机数方差缩减保证。

`elimination_audit.confirmed_false_eliminations` 仅记录已经 full 审计、且超过所有按 short 排名晋级者的 cheap/short 淘汰案例，分别标注发生层。探索/部分审计只降低遗漏风险；未审计者的真实结果未知，`global_false_elimination_rate` 保持 `None`。`full_coverage_curve` 逐次记录查询消耗、不同 full 候选数及主 seed 有效 full 覆盖；晋级曲线在 `rounds` 中。

手算反例是：初始 full=0；快热 A 的 short=10、full=5；慢热 B 的 short=1、full=100。按 short 淘汰 B 会错失实际更好者。预算 5 时查询初始 full、A/B short、A 晋级 full、B 审计 full，原型选出 B，记录一对排序反转及一个已证实的相对误淘汰。这个例子同时说明去掉审计后没有正确性保证。

经典逐轮资源分配通常要求低资源观测对高资源表现有足够的预测性，才能在有限资源下有效筛选。基建的暖机、长恢复、共享床位、不同周期和全局联动可能破坏这种排序关系。未完整 full 覆盖时没有有限域最大值证明；完整覆盖时也没有无约束全局、期望产出、正确选择概率、长期平均产出或游戏适用性的证明。新的 full seed 复验不是已校准的序贯统计程序。

## 验证

命令：`python -m unittest discover -s scripts/experiments/roster_methods/tests -p test_m08_multifidelity.py -v`。

当前 15 个机制测试覆盖：实际 24→9→5 晋级及独立 full 审计、慢热反超、预算 0–3、外部剩余预算更小、公开无效初始方案、96 域完整 cheap 覆盖与大域有界采样、short 无效、错误 fidelity 不可成为最终赢家、先补审计再重复、128 查询完成 short32/full96、无效 full 不可出具固定 seed 证书、新 seed full 复验及固定 seed 可重放。测试使用明确标注的 toy oracle，不能宣称实际增产。

初版历史结果：上述命令通过 8/8 测试；修正零预算时不应生成未估值候选的日志后重跑，仍为 8/8。公共 `common.make_toy_problem(budget=16)`、seed 42 冒烟也通过：返回 `[1,1,0,1]`，full 分数 `128.19519751784102`，实际 history 16 条，short 9、full 7、剩余 0，完整返回值通过 `json.dumps(..., allow_nan=False)`。观察到 cheap/full 交集 7 个中的 2 对排序反转，short/full 交集 6 个中没有观察到反转；仍有 3 个 short 淘汰者未经 full 查询，这些结果不能推出没有漏掉更好的方案。

第二轮独立审查复现了 P2：公共 `Problem` 域 `[2]`、初始 `[0]` 被禁止、唯一合法 `[1]` 的 F=-3 时，旧实现 budget=1 无结果；budget=16 重复查询无效初始方案 8 次。先添加结构禁止、声明排程不可行两类 budget=1/16 回归，修前 4 个 subtest 失败。加入初始公共检查并从复验 contenders 中移除公开无效初始方案后，10/10 测试通过；两个预算均返回 `[1]`、分数 -3，history 不再包含无效初始方案。该修复不依赖 F 的正负或 oracle 内部数据。

G 覆盖版完成后，12/12 测试通过。原生 round-02 以预算 16、48、128 各运行四个构造场景。在搜索 history 中发现 `native-trading-exp` 的 `[0,1]` 被 short 淘汰，但 full 审计分数 `13433.333333333374` 高于所有 short 晋级者的最高 full `13066.6666666667`，记录已证实的相对误淘汰。96 域预算 16 的 short/full 交集 6 个中有 2 对反转；预算 48 的交集 16 个中有 76 对反转。这些都是实际计算器 oracle 查询，并非 toy 反例。

round-02 同时暴露预算分配缺口：预算 48 的 96 域只有 17 个不同 full 候选，小 6 域仍有 1 个 short 淘汰者未查 full，却持续重复已知候选。为此增加完整 full 预算保留和余量审计，先添加 3 个机制回归，旧版本失败，修后及最终 fresh 回归均为 15/15 通过。

最终候选原生 round-03-b16 / b48 / b128 共 12 个场景运行全部完成，均为 `evaluated`，查询计数与各自预算相等；三个预算运行的完整源码清单均保持不变。m08 源码 SHA-256 为 `a92e8d3eca5746982eb6b6e8e3357e00869c85ef92622c978bd9bbec80d5e590`，与三个最终运行的清单一致；六轮对照使用同一份原生源码快照。

96 域 `native-joint-base` 的最终覆盖曲线：

| 查询预算 | short / full 查询 | 主 seed 不同有效 full 候选 | 有限域证书 | short/full 观察反转对数 |
| --- | --- | --- | --- | --- |
| 16 | 9 / 7 | 7 / 96 | 否 | 2 |
| 48 | 30 / 18 | 18 / 96 | 否 | 76 |
| 128 | 32 / 96 | 96 / 96 | 是，仅固定 seed | 172 |

三个预算都选择 `[1,1,0,0,0,1]`，其主 seed full 分数均为 `29033.33333333345`。只有预算 128 的完整审计，才确认这个已选方案达到声明 96 域、seed 42 的 full oracle 最大值；预算 16/48 的算法返回依然诚实保留证书 false。三个更小的原生域在预算 16 已完整 full 覆盖。这个停止条件关闭了当前声明域的固定 seed 选择缺口，不代表期望分数、其他库存/域或真实游戏产出最优。

完整对照、源码哈希、每轮晋级及逐查询 full 覆盖坐标、观察到的排序反转与淘汰审计保存在 `artifacts/roster-method-validation-20261028/iterations/m08/search-evidence.json`，共 24 个对照结果；各运行原始 history 仍保留在对应 `results/08-*.json`。这份汇总只使用公共 G 与本方法搜索 history，不包含留出结果作为调优证据。不直接读取 SQLite 全标签，也不使用留出 seed 调参或硬编码冠军。

实际原生命令（仓库根目录，预算 48/128 同时替换 `--budget` 及输出目录后缀）：

```powershell
& 'artifacts/roster-method-validation-20261028/venv/Scripts/python.exe' -B -X utf8 scripts/experiments/roster_methods/run_suite.py --mode native --method 08 --budget 16 --workers 1 --node-modules 'C:/Users/Panda-Panta/.codex/worktrees/roster-method-validation-20261028/R.I.I.C-Calculator - Codex/node_modules' --cache artifacts/roster-method-validation-20261028/native-cache.sqlite --out artifacts/roster-method-validation-20261028/iterations/m08/round-03-b16
```
