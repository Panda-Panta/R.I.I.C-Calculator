# 辅助对照 m16：G 初解＋ALNS＋CP-SAT＋统一完整评价

本文件是15方法实验的辅助混合对照，不新增第16个开发分工，也不改写原有数学模型的单独基线。入口为 `methods/m16_hybrid.py` 的 `solve(problem, *, seed=42, budget=16)`。

## 实际组合与预算

- 调用现有 `m01_pool.build_pools`，在公开 G 和合法有限域中保留数学冠军；先对合法 initial，再对尚未评价的 G 冠军做 full 验证。它没有在候选生成阶段查询 F。
- 调用冻结 m02 的真实随机/关联 destroy、全释放 restart、已知 G 回溯 repair、历史表现权重和退火接受。
- CP 修复实际调用 m03 的 `_build_model` 与 OR-Tools `CpSolver.solve`；固定未释放变量，只优化已声明的缩放 G、禁止元组和资源容量。完整排程另经公共检查；排程失败只禁止该具体向量，不推广为未经证明的 cut。
- 初解阶段后，剩余成功提案名额交替分给 CP-SAT repair 与 ALNS repair。修复失败可将该名额转交有日志的 ALNS fallback；全程共用一个查询入口、一个 `query_ledger`、同一 `problem.remaining` 与总 budget。没有分别给三个完整 solve 各自预算；外部缓存命中仍算一次完整查询。
- 每次 CP repair 最多1秒，累计求解器时间8秒；ALNS保留4096回溯节点上限。实际 solver 状态、调用数、权重、接受决策和阶段查询数保存在 diagnostics。`actual_composition_verified` 只在确实调用了G冠军排名接口、ALNS destroy/repair及真实 CP 求解后为 true；2次等过小预算不冒充完整组合。
- 本轮没有加入统计 racing，也没有使用留出种子选参。返回结果只从有效 full 记录取最好；不支持、无效或未完成结果保持 None。

这些是实验组件接口，特别是复用了 m02/m03 的私有 helper；组件文件哈希固定在对照证据中，后续修改接口须重验。

## 核检查

使用主 agent 提供的隔离环境：

```powershell
& 'artifacts/roster-method-validation-20261028/venv/Scripts/python.exe' -B -X utf8 -m unittest scripts.experiments.roster_methods.tests.test_m16_hybrid -v
```

覆盖真实组件调用、4次总预算的统一账本、64域中总预算16而非48、缓存命中计账、局部固定决策、独立排程拒绝后的真实 CP 再求解、固定种子提案重放、无效 F 的 None 和零预算。

独立可手算反例：G=两比特之和，G冠军11；F(00)=0、F(10)=5、F(01)=9、F(11)=2。混合在4次总完整查询内返回01、F=9，超过数学代理冠军F=2。它说明代理模型与F不一致时存在超过G冠军的可能，不是原生场景或游戏增产证据。

## 同预算原生对照

独占证据：[hybrid/round1](../../../../artifacts/roster-method-validation-20261028/hybrid/round1/)。运行器在上一级的 `benchmark_hybrid.py`，直接使用公共 `NativeOracle.evaluate` API，不访问SQL标签、不查询留出种子。一个冻结oracle进程比较简单 G 冠军、m01、m02、m03与混合，四场景、4/8/16/48总预算，共80个比较单元。

另单列 m02 budget128 付费覆盖参照，4/6/6/96域共112次 full 查询，不计入任何对照方法的预算。80个对照单元均在1e-6数值容差内命中相应有限域 F 上限；简单 G 冠军只需 initial＋冠军共2次 full 查询就已命中。混合在全部16个场景×预算单元均真实调用三种组件并统一计账，没有观察到比 G 冠军或上述单法更高的产出。

本次共有688次逻辑查询，全部由已有来源键匹配的原生缓存返回，新增物理仿真调用0；仍逐一收取查询预算。因此这是对冻结原生仿真结果的源匹配重放和算法对照，不是688次重新执行引擎或游戏操作。所有候选仅用search seed42；墙钟包括缓存、排队及不同模型预处理，不作稳定速度排名。

“简单 G 冠军”指本实验公开 unary＋factor 的冠军，不能代替用户询问的原产品两阶段数学优化器；原产品基线由主 agent 的独立 discovery 基准核验。

当前证据支持：混合可以在代理/F反转的独立核例中超过G冠军；在这四个已受限的原生域里，G冠军已达有限F上限，无法再宣称混合增产。是否在更广人员、策略、恢复和技能耦合域中受益，需要新场景及公平评价；当前结果不证明混合对所有排班更好。

补充审查：build_pools(problem, 1)仅用于G冠军初始化；没有将多解或结构多样性池作为本混合方案的初始化。本轮组合结论仅限该版本与seed42，未测试任意组合。
