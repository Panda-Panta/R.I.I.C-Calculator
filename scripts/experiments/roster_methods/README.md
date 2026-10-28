# 排班优化方法验证实验

这里是独立实验工具，不进入前端运行路径，不改变排班存储格式或正式计算器。
任务及分支交付状态由根目录 `UPDATE_PLAN.md` 维护；逐方法机制、来源、命令和限制在 `notes/`。

## 入口与文件归属

- `CONTRACT.md`、`common.py`：公开模型、合法性、有限排程、预算与缺测契约。
- `methods/m01_*.py` 至 `m15_*.py`：15个独立方法；每个有对应测试和说明。
- `native_adapter.mjs`：冻结原始TypeScript引擎的JSONL适配器，构造有实际技能与练度的固定排班场景。
- `run_suite.py`：统一查询预算、私有缓存、冻结后的多seed复验和证据记录。
- `enumerate_oracle.py`：独立穷举声明有限域，提供外部参照；其全表不得作为算法输入。
- `compare_current_math.mjs`：直接调用原有 `computeManufacturingRoster` 的同输入、同F对照。
- `methods/m16_hybrid.py`：辅助混合方案对照，保留各组件和总预算归属；不计入最初15方法。
- `tests/`：算法核、有限域oracle、预算、缺测、JSON证据及公共契约检查。

## 准备

Node依赖使用本项目 `pnpm-lock.yaml`；Python实验依赖单独安装，不加入前端package。
本轮使用Python3.11、CPU PyTorch，版本见 `requirements-experiments.txt`。
已有这些库时可用 `python -m venv --system-site-packages <实验venv>`，再补缺少的依赖；独立环境也可按requirements准备。
Windows CPU版PyTorch按其官方安装入口选择CPU发行，不要求CUDA或GPU。

```powershell
python -m venv --system-site-packages artifacts/roster-methods/venv
artifacts/roster-methods/venv/Scripts/python.exe -m pip install -r scripts/experiments/roster_methods/requirements-experiments.txt
artifacts/roster-methods/venv/Scripts/python.exe -B -X utf8 -m pytest scripts/experiments/roster_methods/tests -q
```

## 运行

输出必须为不存在的新目录；工具拒绝覆盖已有证据。
`--method 01`至`15`可单独执行，缺省`all`；单方法分支必须显式选择自己的编号。

```powershell
<Python> -B -X utf8 scripts/experiments/roster_methods/run_suite.py --mode toy --method 01 --budget 16 --workers 1 --out artifacts/roster-methods/toy-01
<Python> -B -X utf8 scripts/experiments/roster_methods/run_suite.py --mode native --method 01 --budget 16 --workers 1 --node-modules <已安装node_modules绝对目录> --cache artifacts/roster-methods/native-cache.sqlite --out artifacts/roster-methods/native-01
<Python> -B -X utf8 scripts/experiments/roster_methods/enumerate_oracle.py --node-modules <已安装node_modules绝对目录> --cache artifacts/roster-methods/native-cache.sqlite --out artifacts/roster-methods/oracle
```

每法的配置参数通过该方法说明中声明的 `problem.metadata` 设置；不能把未查询的真实F或留出标签装入公开模型。
`common.make_toy_problem`只用于算法核，不是游戏收益模型。
原生评估默认short为6h预热＋18h采样，full为24h预热＋72h采样，沿用共享计分和理想跑单。

## 证据口径

1. 公开G/H、有限床位排程和原生F是不同命题。模型最优、固定seed有限域最高、期望收益及真实游戏最优不能互相替代。
2. 每一次方法调用evaluate都计预算，缓存命中及重复查询也计数；物理仿真调用另记。缓存包含明确源版本和场景指纹，不向方法公开全F表。
3. 各方法首先评价合法initial并计预算。初始表是可比较的安全基线，不限制最终必须沿用其人员安排。
4. 无效/不支持/未完成保持None，非有限证据记null和原因，不作为有效零分。
5. 搜索种子与最终复验种子分开。复验避开已用于搜索的seed；这些少量复验不构成统计置信或任意场景泛化保证。
6. 多方法并发时墙钟包含排队和缓存影响，不当作独立算法提速；优先比较同预算收益、首次命中、唯一候选数及明确算法操作。
7. NSGA-II保留原score和Pareto前沿两套输出。OCBA按样本均值决策，不挑单次幸运最大值。GNN的训练best、冻结policy和混合部署选择分别报告。
8. 128预算下的全域full审计明确归属独立穷举验证，不能当作减半、强化学习或其他启发式的理论保证。

本轮四个构造场景共有6/4/6/96个合法向量，独立oracle另以4个seed完整评价。
这是受限的计算器验证域；不能从这些场景的提升直接推断用户实际排班、原有数学模型或真实游戏收益提升。
最终比较及各轮原始记录位于任务 `artifacts/roster-method-validation-20261028/`，不随程序安装分发。
