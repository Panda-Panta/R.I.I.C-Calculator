# 方法10：周期报酬与恢复队列诊断

实现位于 `../methods/m10_renewal.py`，核测试位于 `../tests/test_m10_renewal.py`。入口为 `solve(problem, *, seed=42, budget=16)`；仅用标准库，不改业务算法或共享依赖。

## 理论与适用边界

来源为 [Gallager，MIT 6.262 第4章，§4.4、§4.5.4](https://ocw.mit.edu/courses/6-262-discrete-stochastic-processes-spring-2011/931ffa0940899c27f34b71ad64fd2bb0_MIT6_262S11_chap04.pdf)，以及仓库 `artifacts/roster-theory-research-20261028/REPORT.md` 第10节。已核对原课程文档中的更新条件、更新报酬定理和 Little 定律。

更新报酬的长期解释需要有效更新点、适当独立同分布条件与有限期望；队伍回满不能证明订单、无人机、全局加成和恢复队列也回到相同分布。完整周期的总报酬除以总时长是样本统计量，不能仅凭该统计量宣称收敛。

Little 定律描述一致口径下的平均人数、到达率和停留时间。本文的有限同窗实现计算给定完整停留记录的面积恒等式，不以小样本恒等式宣称长期稳态成立。窗口外到达或离开会涉及边界项，当前核明确拒绝这类记录。

## 实际实现

1. `renewal_reward_summary`：完整周期 `(length_hours, reward)` 的 `sum(reward)/sum(length_hours)`，同时保留周期数、总时长与均值。不会把各周期报酬率算术平均。
2. `recovery_load`：对声明的工休模式，令 `T=work+rest+wait`、`u=bed_units`，计算到达率 `sum(u/T)`、恢复床位平均占用 `sum(u*rest/T)` 与等待人数 `sum(u*wait/T)`；恢复时间按到达人数加权，核对 `lambda*W_service=mean_beds`。无相位时峰值检查返回 `None`。
3. `window_occupancy`：对同窗完整到达、开始恢复、离开时间计算系统/等待/床位占用面积；对恢复区间 `[service_start, departure)` 做事件扫描得到峰值。同一时刻离床与入床不算瞬间冲突。通过也只证明提供的区间和总床位数，不证明床位资格、日志完整性或窗外情况。
4. `solve`：从公开周期数据构造有界前缀 beam，分别使用 `周期报酬率之和 - penalty*max(0, mean_beds-beds)^2` 排序。采用五档惩罚、宽度 `min(128,max(8,4*budget))`，在各档排名间轮流提案。候选先经公共结构和声明排程检查，再调用完整 F；初始方案首评也占预算。返回的最佳方案仅来自本次实际查询的 `valid/full` 记录。

各队周期报酬率之和始终标为 `cycle_proxy`。`shared_state_regenerates=true` 仅记录调用者的声明，不能替代更新条件证明。平均负载只是声明周期模型的必要条件；不会据此硬拒绝完整 F 有效的方案。缺失或错误周期字段时状态为 `unsupported_cycle_metadata`，仅评估合法初始方案；缺失数据和无有效 F 的最佳分数均不会写成零。

## 公共元数据

`problem.metadata['renewal']` 与公共 `spec.metadata` 一致：

```python
{
    'beds': 1,
    'source': 'declared_cycle_estimates',
    'shared_state_regenerates': False,
    'options': [  # 每变量一行、每选项一个记录
        [
            {'work_hours': 12, 'rest_hours': 4, 'reward': 100,
             'wait_hours': 0, 'bed_units': 1},
            {'work_hours': 10, 'rest_hours': 5, 'reward': 105},
        ],
    ],
    # 以下为可选观测；不从F分数反推或补造：
    'observed_cycles': [{'length_hours': 16, 'reward': 100}],
    'observation_window_hours': 16,
    'stays': [{'arrival_hours': 12, 'service_start_hours': 12,
               'departure_hours': 16, 'bed_units': 1}],
}
```

时间为小时；`reward` 需由调用者声明同一产出/评分单位。允许有限负报酬。`wait_hours` 缺省0，表示当前周期估值明确采用无等待近似，不是测得等待为0。`bed_units` 缺省1，表示一次周期入住宿舍的人数，不能把整组三人恢复当一人。可选观测只在真实提供时输出统计量，未知阶段、加成或恢复速度不会自动填充。当前原生完整周期、恢复排队和入住日志采集是否提供，由公共适配器单独说明。

## 核测试和实际命令

```powershell
python -X utf8 -m unittest discover -s scripts/experiments/roster_methods/tests -p test_m10_renewal.py -v
```

2026-10-28 执行结果：14项通过。首先运行测试时因方法模块尚未创建而 ImportError；实现后复跑通过。覆盖内容包括：不同长度周期的总量比值、人数加权 Little 恒等、带等待的同窗面积、相接区间、跨窗拒绝、无效数值、完整 F 与代理排序不同、F 无效候选排除、查询预算、缺失字段、声明排程拒绝、惩罚引导低负载提案及不把调用者更新声明当证明。

可手算峰值反例：4人同时工作6小时、恢复2小时；8小时窗内平均占床 `4*2/8=1`，一个床位的平均条件通过，但 `[6,8)` 峰值为4，明确不满足床位容量。测试检查 `average_capacity_condition=True`、`peak_capacity_condition=False`。

同日公共 `common.make_toy_problem(budget=16)` 对接：seed42、16次完整实验 oracle 查询、330次周期模型beam扩展、26个结构与声明排程有效的候选；返回 `[1,1,1,1]`、分数 `130.19519751784102`。另用独立 toy 实例穷举有限合法域，最高分与该结果相同。复现核心如下；穷举只用于独立小域参照，不在方法内部执行：

```python
from common import make_toy_problem
from methods.m10_renewal import solve
p = make_toy_problem(budget=16)
result = solve(p, seed=42, budget=16)
reference = make_toy_problem(budget=128)
for vector in reference.vectors():
    if reference.schedule_feasible(vector):
        reference.evaluate(vector, fidelity='full', seed=42)
assert result['best_score'] == reference.best()['score']
```

该 toy 最优点的声明周期平均负载为 `1.0850533195734435` 床、大于声明1床，但其有限排程与 toy F 均有效。这些周期元数据是模型对照，**与 F 不是同源过程数据**；因此该现象不证明真实恢复瓶颈，也不能据其否决 F。它直接展示为什么本实现保留代理与最终 F 的证据边界。

本工作包证明诊断核、提案操作、预算接口和给定有限 toy 的对接结果；未证明真实游戏产出提升、原生长期稳态、所有队伍独立更新或任意排班峰值可行。原生场景对比由主 agent 统一运行和记录。

## 独立审查后的迭代

审查发现公共有限排程器达到节点上限时会抛出 `RuntimeError('Finite scheduler budget exhausted; this is not an infeasibility proof')`。原实现会在提案阶段提前退出，无法返回仍能合法评估的初始方案。这是 UNKNOWN 状态传播缺陷，而非排程不可行。

现将提案筛选和 F 前检查统一到缓存的三态排程判定：FEASIBLE 可继续，INFEASIBLE 不提案，UNKNOWN 单独写入 `diagnostics.unknown_schedule_candidates`，包含向量、原始原因和 `score=None`，同时令 `schedule_checks_complete=False`。同一候选在多个惩罚beam中只检查一次；跳过未知候选后继续保留有效 F 最佳方案。仅捕获公共排程预算异常，其他实现异常继续暴露，避免把程序错误伪装成 UNKNOWN。

新增回归先复现2项 UNKNOWN 异常失败，再修复通过；当前同一命令共17项通过。回归包括直接让 `common.finite_schedule` 返回 UNKNOWN、初始方案未知而其他候选可行，以及无关 RuntimeError 不被隐藏。

原生96联合域新增宿舍恢复提供者变量时，周期参数必须反映它对工作组的影响，不能为宿舍变量编造一个独立工休周期。当前核实的 `native_adapter.mjs` 未提供 `renewal` 元数据，只有固定主替占比的静态 G 和总床位容量，尚不足以推出真实 work/rest/wait 周期；此时本方法诚实返回 `unsupported_cycle_metadata` 并仅测合法基线。已向适配器负责人请求有来源的静态心情/恢复参数和完整周期观测；适配器由其负责人修改，不在本工作包内补造参数。

## 原生上下文参考周期增强

适配器负责人随后按真实静态解释器补齐了4场景共112条整配置周期参考，其中联合域96条均支持；本方法未修改适配器。固定适配器 SHA256 为 `2a6aea29921ab261a0de9350dc02e0fe26ac0d07087465dbc223ad180b52659e`。

新增公开 schema 优先于独立选项周期，允许宿舍、联动提供者等变量共同改变工作组周期：

```python
renewal = {
    'beds': 8,
    'shared_state_regenerates': False,
    'sources': [...], 'assumptions': [...], 'reward_units': '...',
    'vector_cycles': {
        '0,0,0,0,0,0': {
            'supported': True,
            'groups': [
                {'group_id': 'joint-gold-and-power', 'work_hours': 9,
                 'rest_hours': 2.769230769230769, 'reward': 6602.307692307692,
                 'bed_units': 4, 'wait_hours': 0},
                # 其他工作组；此处不为宿舍变量构造周期
            ],
            'issues': [],
        },
    },
}
```

参考周期读取 `currentMoraleRates` 的已解锁静态消耗、`evaluateDormitoryRecovery` 的实际宿舍等级/氛围上限/提供者及合法单回目标、compiled runtime 的实际上下心情阈值，以及本组主/替真实静态生产投影。周期报酬为 `主班时薪*work + 本组替班时薪*rest`，不使用固定77.5%占比，也不读取 F 标签。联合基线各组参考工作9小时，宿舍闪灵改为调香师时经验/贸易组参考恢复时间从2.4升为3.0小时，配置依赖已经进入估值。

这些是**其他组固定主班、冻结消耗与入宿恢复速率、隔离参考空床、主班回满到上限**的参考周期。等待为0是该模型假设，不是测得无排队；没有复原实际原生换班事件、替班自身完整恢复竞争、床位资格争用或共享状态更新点。平均负载只限这些已建模的恢复记录，不能作为真实完整系统的必要/充分可行性判定。

上下文模式直接按各公开配置的参考周期汇总值与五档平均超载惩罚排序，轮流提案并以预算内完整 F 决胜。它没有再把宿舍的影响拆成独立周期，也不把公开静态表当 F 表。缺失配置、`supported=False` 或缺参数记录进入 `unsupported_cycle_contexts`（分数为 `None`）；诊断另记录未提供的笛卡尔配置数量。所有上下文都缺失时只评基线，不回退到不适用的独立周期表。

该增强先添加4项回归并观察失败，再实现通过；当前核测试共21项通过，涵盖配置联动、缺数据不填0、不作独立表回退及 UNKNOWN 保留其他候选。原生迭代独占证据目录为 `artifacts/roster-method-validation-20261028/iterations/m10/`；只使用自身付费查询 history 和公开参考周期分析，不用共享 SQL 全标签或留出分数调参。

第一轮原生自身付费查询显示多组配置具有完全相同的参考周期，而前16提案中成对重复出现。第二版因此仅将相同完整周期 profile 的配置延后，优先覆盖新的周期/恢复结构。不会删除这些配置，也不会推断其 F 等价；新增测试专门让同周期配置的 F 不同，确认预算足够时仍会查到并选出更好者。两项回归先观察1项排序失败，再实现通过；当前测试共23项通过。

公开周期模型诊断：联合96配置有72类周期profile、24个模型别名，声明平均占床范围 `1.3622291021671824–1.441176470588235`，容量8床，全部低于平均容量。三个小场景也没有参考平均超载。因此下述提升不能归因于解除恢复瓶颈，床位超载惩罚在这些场景没有触发；它们检验的是周期报酬提案与原生 F 的对应关系，尚未提供真实恢复队列的 Little/峰值观测。

原生迭代使用独占新输出目录，保留每轮源码manifest、公开场景、输入/报告哈希、实际完整F history及查询/缓存计账。缓存命中仍占每次方法查询预算，缓存耗时不作为算法加速证据：

| 轮次 | 联合场景完整查询 | 初始搜索分 | 最佳搜索分 | 说明 |
| --- | ---: | ---: | ---: | --- |
| `native-budget16-context-v1` | 16 | 26566.6666666667 | 29033.33333333345 | 首版上下文周期排序 |
| `native-budget48-context-v2` | 48 | 26566.6666666667 | 29033.33333333345 | 周期别名延后；前16查询覆盖16类周期 |
| `native-budget128-context-v2` | 96 | 26566.6666666667 | 29033.33333333345 | 96种声明配置全部完整查询 |
| `native-budget128-context-v2-final` | 96 | 26566.6666666667 | 29033.33333333345 | 最终源码候选重放，证据范围文案与实际两种提案模式一致 |

各轮均 `source_unchanged=true`。三个小域每轮分别用4、6、6次完整查询覆盖全部配置；自动化联动、金条主替、贸易经验场景最佳搜索分分别为 `15066.666666666704`、`10800.000000000015`、`13433.333333333374`。同轮初始值分别为 `12266.666666666682`、`10133.333333333343`、`13100.000000000038`。

以上仅使用本方法的实际搜索 history，分析文件显式排除留出字段。调用器自动生成的留出复验仍保存在原始结果中，由最终独立报告评估；本方法未据此调整提案。

最终证据为同目录 `final-finite-search-certificate.json`。逐场景重新从公开结构/排程约束枚举配置集合，核对它与本方法已付费完整查询集合完全相等，4/6/6/96条均有效，所选分数等于各自已查询最大值；没有未查配置。四场景均在第2次完整查询时，于 `1e-6` 容差内达到最终有限域最高值。联合场景所选为 `[1,1,0,0,0,1]`；另3个近似同分配置仅有浮点级差异。该有限域已无更高未查候选，因此本轮停止增加算法复杂度。

该结论严格限于 seed42、24小时预热＋72小时采样、当前明示最大练度的构造库存和固定原生计算器输入域，不提供期望收益、长期收敛、其他库存、实际游戏或真实队列的全局最优保证。最终重放来自缓存的136次响应含112次方法搜索与24次调用器独立复验，没有新物理 F 调用；全部方法搜索仍按次计账，也没有提前查看缓存标签。

最终方法文件 SHA256 为 `7274234c61a70bc1b1a252a87d513b1ee1123fb431079ed665ee8fe54ec9b742`，与最终轮次源码manifest相符。最终重放后未改搜索源码。实际原生命令格式如下，`--out` 必须指定新的目录；16、48、128各轮分别执行，不覆盖已有证据：

```powershell
& 'artifacts/roster-method-validation-20261028/venv/Scripts/python.exe' -B -X utf8 `
  'scripts/experiments/roster_methods/run_suite.py' --mode native --method 10 `
  --budget 128 --workers 1 `
  --node-modules 'C:/Users/Panda-Panta/.codex/worktrees/roster-method-validation-20261028/R.I.I.C-Calculator - Codex/node_modules' `
  --cache 'artifacts/roster-method-validation-20261028/native-cache.sqlite' `
  --out 'artifacts/roster-method-validation-20261028/iterations/m10/NEW_RUN'
```
