# 15方法实验公共契约

工作根为本仓库，Python代码入口在本目录；这是独立实验，不修改 `src/`。每个方法独占 `methods/mXX_*.py`、`tests/test_mXX_*.py`、`notes/mXX_*.md`。主agent独占 `common.py`、场景、原生仿真适配和运行器。禁止子agent Git操作、递归派工或改共享依赖。

每个模块提供 `solve(problem, *, seed=42, budget=16) -> dict`。返回至少 `best_vector`（整数list或None）、`diagnostics`、`proof_scope`；可附算法专属记录、Pareto集及模型目标。任何证明须限定域，预算耗尽保留已验证结果。

主agent提供common.Problem（方法可以duck typing），公共API固定：

- `problem.spec`: dict，包含id、domains（各变量选项数量）、initial（整数list）、unary（每变量每值的已知便宜收益）、factors（`{vars:[i,j,...], table:{"0,1":score,...}}`）、forbidden（`{vars:[i,j,...], values:[v_i,v_j,...]}`）、resources（`{name,capacity,usage:[[每变量每值用量],...]}`）；可有scheduling和metadata。
- `problem.domains`: `list[range]`；`problem.initial`: tuple；`problem.scene_id`: str。
- `problem.vectors(feasible_only=True)`: 枚举声明的有限域；只作模型/小域参照，不能枚举真实F冒充新算法。
- `problem.feasible(vector) -> bool`：公共结构约束；`problem.schedule_feasible(vector) -> bool`：声明的有限排程证据，若无排程即True。它与原生F不是同一命题。
- `problem.cheap(vector) -> float`：unary+factors；`problem.vector_features(vector) -> list[float]`：one-hot及已知便宜特征，不含隐藏F。
- `problem.evaluate(vector, fidelity='full', seed=None) -> dict`：真实或明确标注的实验oracle，返回vector、valid、score（无效为None）、metrics、fidelity、seed、elapsed_ms。每次计入声明预算；外部缓存也不免除算法的查询计数。
- `problem.remaining`: 剩余查询数；`problem.history`: 实际评价列表；`problem.best() -> dict | None`：只从valid/full记录返回最高score。
- `problem.metadata`: 公共元数据；算法禁止读取oracle内部数据、未查询真实分数或留出结果。
- `common.make_toy_problem(budget=16)` 可用于小域算法测试；这种测试只证明算法核，不证明游戏模型或产出。

所有方法至少做一个独立可手算/穷举参照或自身关键机制检查，记录实际算法操作；不可把排序/随机选择改名为CP-SAT、定价、树DP或GNN-RL。主agent另统一运行原生RIIC场景，代理G与最终F独立记录。输出不得把未完成/不支持强制当成0。

资源：已有REPORT在 `artifacts/roster-theory-research-20261028/REPORT.md`；实际持有/技能、锁、组合及完整F入口按领域skill和源码核验。允许重新设计，未要求保留现有两阶段路线。
