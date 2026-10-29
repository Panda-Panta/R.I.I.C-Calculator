# 主班多方法组合验证

研究入口，与默认自动排班隔离。复用现有十五种方法，比较完整主班构造、工休策略与菲亚梅塔目标策略的联合有限域；目标策略可从实际可充能工作主班合法重选最多三人，再比较顺序，保护原始用户明确名单及锁。原始用户约束与生成初解分别保存，避免把内部生成的组误当作用户硬锁。

`src/optimizer/mainRosterHybridDomain.ts` 生成真实排班及其公开 G 模型；`mainRosterHybridRecovery.ts` 提供有条件的策略变体。方法只取得公开模型和已申请的计分结果，不取得候选的未查询 F。CP-SAT、因子 DP 的证明范围限于编码的有限 G 模型，不证明全部合法排班的长期最优值。

`method_registry.py` 适配原始方法及两个真实混合方法；`strategies/` 在同一个 `common.Problem` 查询账本上执行池、关联块扰动和精确修复。`run_suite.py` 通过 `native_evaluator.mjs` 调用冻结的原生引擎，`native_cache.py` 只复用完整作业和引擎来源一致的结果。

每次查询均消耗逻辑预算，包含初解、重复、缓存命中和短窗。物理仿真、缓存复用、算法 CPU、构造和完整运行时间分别记录。短窗结果不能成为完整计分胜者；未知和失败保留为 null。完成仿真、严格收益资格、普通疲劳和窗口末尾未恢复事件分别报告。

运行时用 `RIIC_ROSTER_METHODS_ROOT` 或入口的 `--legacy-root` 指向原始 `scripts/experiments/roster_methods`，并使用 `python -B`、`PYTHONDONTWRITEBYTECODE=1`，保持原方法目录只读。复用已安装实验环境，不新增产品依赖。原生仿真须显式调度，测试和模块导入不启动 F。

本轮约定训练窗口为预热 24h + 采样 72h、seed 42、无人机 none、maxStep .25，原权重且无副表。预算 2/4 均包含初解。先冻结选中排班，再以 seed 73、预热 24h + 采样 168h 比较选中表和相同基线，保留窗口末尾的未确认恢复情况。实际命令与版本绑定随该轮输出保存于 `artifacts/main-roster-hybrid-validation-20261029/`。

这批实验不会修改默认生成器、游戏技能公式、计分器或用户配置。默认快速路径继续作为基线；只有实际可复现的质量和速度证据支持时才考虑集成。

## 命令行入口

从仓库根目录运行，`$study` 为带有输入和冻结域的实验输出目录，`$nativeFreeze` 为已有原生引擎的冻结目录，`$legacy` 为原十五法目录。默认只生成计划，物理 F 为 0：

```powershell
python -B -m scripts.experiments.main_roster_hybrids.run_suite `
  --case "$study/inputs/full342/case.json" `
  --domain "$study/harness/domain-freeze-v1/full342/domain.json" `
  --engine-binding "$nativeFreeze/binding.json" `
  --legacy-root "$legacy" --out "$study/new-run" --budgets 2,4
```

`--case` 与 `--domain` 可对应重复。默认注册 15 个旧方法、2 个实际混合和单列 G 基线；`--methods g_baseline,alns_cp,alns_factor_dp` 可选择子集。加 `--execute --max-physical-f 0` 仅允许已有同输入记录的缓存协议验证；执行新原生仿真需显式加 `--execute --allow-native --max-physical-f N`。每次输出目录必须全新，不覆盖旧证据。

查询状态、真实执行组件和退出原因逐 arm 保存。固定 seed42 协议下 m09 的多种子比较、缺周期数据时 m10 的更新过程均不受支持；低预算下未实际训练或展开的组件标为 reduced。它们不被统计成完整机制已验证。

新模块的 0F 检查：

```powershell
python -B -m unittest discover -s scripts/experiments/main_roster_hybrids/tests -p 'test_*.py'
node --test scripts/experiments/main_roster_hybrids/tests/native_evaluator.test.mjs
```

Python 检查应使用带有原实验依赖的解释器并设置 `RIIC_ROSTER_METHODS_ROOT`；缺此显式只读来源时，相关契约测试会标跳过。域构造、方法求解、原生仿真和产物导出都需绑定各自来源；正式数据不以 toy 检查代替。
