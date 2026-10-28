# 方法 05：逻辑型 Benders 可行性分解

## 实现及来源

- 入口：[`../methods/m05_benders.py`](../methods/m05_benders.py) 的 `solve(problem, *, seed=42, budget=16)`。
- 独立有限排程接口：`schedule_subproblem(problem, vector, *, node_limit=200000)`。
- 测试：[`../tests/test_m05_benders.py`](../tests/test_m05_benders.py)；公共契约见 [`../CONTRACT.md`](../CONTRACT.md)。
- 理论入口：本仓库 [REPORT 第 5 节](../../../../artifacts/roster-theory-research-20261028/REPORT.md)；实际读取的原始来源为 [Hooker, *Planning and Scheduling by Logic-Based Benders Decomposition*, July 2004](https://johnhooker.tepper.cmu.edu/planning.pdf)，第 5–6 节，特别是式 (13) 的可行性反馈。

Hooker 将分配与累计资源排程分解，要求根据子问题证明构造有效反馈。本实验只实现有限模型的可行性 cut；没有复现该论文的 MILP/CP 实现、优化性 cut、性能结论或真实基建排程模型。

## 实际算法

1. 主问题枚举**公共结构域**并计算公开的 `G = problem.cheap(vector)`，即 unary 加 factors。没有读取隐藏 F、oracle 内部数据或留出标签。
2. initial 经同一个子问题检查；可排程时先调用一次公共 `evaluate(..., fidelity='full', seed=seed)`，计入 F 预算。
3. 主问题在当前约束下重新最大化 G，确定一个完整分配。此处使用真实的有限域穷举优化，未声称使用 CP-SAT。
4. 固定分配后，独立子问题对全部激活恢复任务的整数 start 做迭代 DFS。仅用已经超过床位容量的前缀剪枝；成功给出完整 start/end/demand 见证，完整搜索耗尽才给 `INFEASIBLE`。
5. 仅 `INFEASIBLE` 且 `search_exhausted=true` 时构造冲突核心。逐项尝试删去恢复任务；只有缩减后的子问题也被完整证明 `INFEASIBLE` 才保留这次缩减，UNKNOWN 不删任务。证书保留核心模型、SHA-256、任务顺序、start 域大小、完整笛卡尔域大小、访问节点及容量剪枝数。
6. 按核心任务的激活条件构造 `sum(x_i not in retained_values_i) >= 1`。同一变量的多个任务取激活 values 的交集；与核心无关的变量不进入 cut。所有 demand 非负、床位容量固定，因此保留不可行核心、再加入其他任务仍不可行。恒激活任务构成不可行核心时，空条件 cut 可正确排除整个域。记录受该 cut 覆盖的主问题向量数量及核心缩减的每次状态。
7. 可排程候选进入公共 F。为查询多个不同候选，已访问候选会有单独的 **visitation exclusion**；它不是 Benders cut，不证明不可行。`UNKNOWN` 候选单独记录 `deferred`，同样不加 cut。随后继续重新优化主问题。
8. 每个 G 分值层的第一个候选保持确定性的字典序；之后仅在 G 严格同分的候选中，优先扩大与最近访问候选的 Hamming 距离。最多使用最近 16 个参考、同分层均匀取样不超过 512 个候选；所有被取样候选都具有相同的最大 G，不改变主问题 G 最优性。这是覆盖顺序，不是 F 学习模型。
9. 返回 F 已查询且 `valid/full` 结果中的最好向量；另报 G 的模型目标、查询覆盖和证明状态。

这是真正的“主问题 → 子问题证明 → 核心条件 cut → 重新优化”循环。没有把一次不成功的启发式恢复排程扩展成整个分配的不可行性。第一轮的完整向量 cut 保留在独占证据目录的源码快照中，用于直接对照核心条件 cut 的效果。

## 有限床位模型与公共 API

主 agent 已确认并在 `common.finite_schedule` / `Problem.schedule_feasible` 中提供独立实现：

```json
{
  "scheduling": {
    "horizon": 4,
    "beds": 1,
    "jobs": [
      {
        "id": "recovery-a",
        "var": 0,
        "values": [1, 2],
        "duration": 2,
        "release": 0,
        "deadline": 4,
        "demand": 1
      }
    ]
  }
}
```

- 时间、duration、demand、床位数均为非负整数。任务非抢占，占用半开时槽 `[start, start + duration)`。
- `start` 必须从 `[release, deadline - duration]` 的全部整数中选取；本方法要求窗口位于 `[0, horizon]`。不在该受支持范围返回 `UNKNOWN`，不作不可行证明。
- `vector[var] in values` 时激活任务；省略 `values` 表示该变量全部选择。省略 `var` 或 `var=null` 表示恒激活。每个 job 的 id 必须唯一；省略 id 时生成稳定名称。
- 省略 release、deadline、demand 分别取 `0`、`horizon`、`1`。duration 为 0 的任务不占时槽；不能仅因其 demand 大于 beds 就判不可行。
- 每个时槽的全部激活任务 demand 总和不得超过 beds；床位同质，没有单独床位资格、前置关系、任务间互斥或连续心情状态。
- 无 scheduling 声明时子问题平凡可行；存在未识别的 scheduling/job 约束字段则返回 `UNKNOWN`，避免静默忽略约束。
- 输出见证的任务键为 `job`，对应输入 `id`；其余字段为 `start/end/demand`。公共 scheduler 自己的见证键为 `id`；两者分别检查，未依赖该内部字段。

目前没有将真实 RIIC 的恢复队列、床位资格、替班策略或连续心情映射成这个有限模型。四个原生场景均无 scheduling 声明；此时输出 `scheduling_feedback=no_declared_scheduling; candidate_search_only` 和 `scheduling_declared=false`。原生 F 的成功或失败也不补齐这项证明。

## 预算及证明边界

- `budget` 只限制公共 F 查询；initial 首评、抛异常的评价尝试都计数，并检查 `problem.remaining`。所有 full 查询都用传入 seed；这不证明满足共同随机数的统计条件。
- 主问题默认最多检查 200000 个完整向量；每次子问题默认最多尝试 200000 次 start 放置；主/子循环默认最多 1024 次。每个已证明不可行子问题最多做 32 次核心缩减证明尝试，这些额外节点工作不算 F 查询。公开 `metadata.m05` 可配置 `master_vector_limit/subproblem_node_limit/iteration_limit/core_reduction_limit`。
- 主问题截断时只报告已枚举池的最好 G，不给全域最优性。子问题耗尽节点预算时返回 `UNKNOWN`。未知候选仍保留在全域 G 上界中；不能因访问完其他候选就宣称全域不可行。
- 仅当主问题完整枚举，并且已排程见证的最高 G 达到所有未被证明 cut 排除候选的 G 上界时，`finite_G_optimality=true`。
- 仅当完整结构域全部被证明不可排程（或结构域本就为空）时，`finite_model_infeasible=true`。日志 `MASTER_EXHAUSTED` 本身不是该证明。
- `finite_model_covered_by_proofs_or_full_queries` 表示每个结构分配都有不可行证明或 valid/full 评价；`all_finite_candidates_valid_full_queried` 更严格，表示所有结构分配都实际获得 valid/full 评价。两者不混用。
- 低 F、无效 F、仿真未完成、仿真异常、预算耗尽以及排程 UNKNOWN 均不生成 cut。该实现不生成基于 F 的最优性 cut；`F_global_optimality` 始终为 false。
- 本方法的有限穷举适合小域算法核和明确声明的模型参照，不是大型实际排班的可扩展性证据，也没有真实游戏或长期增产证明。

## 已执行验证（2026-10-28）

命令：

```powershell
python -X utf8 -m unittest discover -s scripts/experiments/roster_methods/tests -p test_m05_benders.py -v
```

结果：**19 项通过**。覆盖以下关键命题：

- 24 个固定种子生成小模型 × 8 个分配 = **192 个子问题**，与不调用方法 helper、不用 DFS 剪枝的独立 start 笛卡尔枚举逐一比对；可行结果逐项核对见证与每个时槽容量。
- 手算域有 2 个三值分配变量、1 张床、4 个时槽。G 主问题依次选择 `19, 15, 15, 11, 10, 9`；前三个分配完整证明不可排程，生成 **3 条 cut**。独立枚举全部 9 个分配，逐条确认 cut 没有排除任何可排程分配。
- 同一 cut 示例也通过公共 `common.Problem.evaluate`：initial 加三个可排程候选，共 **4 次 full 查询**；公共 scheduler 独立确认每条 cut 的被排除分配不可排程。
- 手算例 G 最优为 `[1,1]`，值 11；设定的实验 F 最优查询结果是 `[0,2]`，值 11。用于验证 G 和 F 分开维护，二者数值相同并非同一目标。
- 节点上限、主问题截断、额外未支持约束、全域有限不可行、零 duration、多床位、恒激活任务、公开 factors/forbidden、无效/低 F、评价异常、零预算及外部剩余预算均有针对性检查。
- 另有 16 个随机激活条件模型，各枚举全部 12 个分配，逐条检查广义核心 cut 不排除任何独立确认可排程的分配；含 UNKNOWN 核心缩减尝试保留原任务、恒激活不可行核心和同 G 覆盖顺序。
- `json.dumps(result, allow_nan=False)` / JSON 回读通过。

公共 `make_toy_problem(budget=16)` 冒烟结果：16 次 full 查询，history 长度 16；best `[1,1,1,1]`，单种子 F `130.19519751784102`；有限模型 G 最优为 15；15 次主问题迭代后 F 预算耗尽。该公共 toy 的本次搜索没有触发排程 cut（0 条）；cut 循环的证据来自上述独立冲突例及公共 Problem 复核，不能把 0 条 cut 的冒烟单独称为 Benders 反馈验证。

## 继续优化与原生预算比较

独占证据在 [`iterations/m05`](../../../../artifacts/roster-method-validation-20261028/iterations/m05/)。`analyze_search.py` 只访问自己的查询 history、公开场景、方法结果及错误字段；不读取 SQLite 全 F，不访问留出分数字段，不把跨轮冠军写进算法。runner 自带留出结果保留在原始输出中，但未用于算法选择或本次优化。

第一轮 r01 固定原来的完整向量 cut 和 G 字典序，第二轮 r02 增强核心条件 cut 及同 G 覆盖。各执行预算 16、48、128；最后的覆盖字段语义澄清候选另外固定为 r03-final 并完整复验。每轮单场景实际 full 查询数为：

| 场景 | 有限域大小 | 预算 16 | 预算 48 | 预算 128 | 单 seed 最好已查询 F |
| --- | ---: | ---: | ---: | ---: | ---: |
| native-gold-relief | 6 | 6 | 6 | 6 | 10800.000000000015 |
| native-automation-provider | 4 | 4 | 4 | 4 | 15066.666666666704 |
| native-trading-exp | 6 | 6 | 6 | 6 | 13433.333333333374 |
| native-joint-base | 96 | 16 | 48 | 96 | 29033.33333333345 |

各轮的最好分数一致，均首次出现在第 2 个查询；第 128 预算覆盖了全部 96 个联合域分配，没找到更高 F。当前 G 已足以在这四个固定域的搜索 seed 42 下尽早选中最高已观察结果；未声称核心 cut 在没有 scheduling 的原生场景提高了 F。

核心机制的直接对照另用**显式声明的有限恢复模型**，共 18 个分配、12 个可排程分配。r01 需生成 6 个完整向量 cut，r02/最终候选只需 1 个核心条件 cut，一次覆盖 6 个相同恢复冲突的分配；两者都进行 12 次有效 full 查询。每条 cut 均通过独立整数 start 笛卡尔参考确认不删可排程分配。详见 `core-comparison.json`；这是有限排程核改进，不是真实 RIIC 恢复证明，也不是运行耗时提升结论。

本轮停止条件是：查询预算曲线已经达到这四个固定有限域、搜索 seed 42 的全域已观察最高 F；cut 强化已有独立证明并减少该恢复核的重复不可行主问题。更广场景、其他随机 seed 的期望最优、未建模恢复机制、真实游戏长期产出均未达到最优性证明。未修改业务源码、共享依赖、Git 或 Tools 安装。
