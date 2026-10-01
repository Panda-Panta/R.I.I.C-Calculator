# 第三阶段邻域微调优化验证

已将每个候选的两个随机种子 × 两种步长的四个独立动态仿真并行执行。第二、三阶段共用一个最多四线程的池，避免逐候选重新加载引擎。候选顺序、父节点比较、搜索深度、候选预算、模拟时间窗口与评分规则保持一致；整份结果按串行顺序组装。

## 实测

设备：i7-12700H，20 个逻辑处理器。使用已保存的全干员生产排班，预热 24 小时、采样 72 小时，四个候选共十六个场景。

| 方式 | 耗时 |
| --- | ---: |
| 当前代码串行执行 | 495.164 秒 |
| 四线程并行并复用线程池 | 158.082 秒 |

加速 **3.13 倍**，耗时减少 **68.07%**。完整候选、搜索路径、收入证据 JSON 对比一致；十六个场景全部有效。只创建四个线程，并全部释放。该结果是一次四候选实测，默认生产预算仍为二十候选，其他排班和设备的加速比可能不同。

并行批次占优化后耗时的 99.74%。进一步优化应聚焦单场景动态仿真引擎；继续增加调度线程的收益已受四场景宽度限制。

同一基线场景的 CPU 采样（仍为 24 小时预热、72 小时采样）耗时 32.520 秒，收入证据与已保存基线完全相同。采样显示：

- 生产事件边界计算 `nextStep` 的主要调用路径占 29.07%，其中 `crosses` 占 24.01%；应减少探测期间重复准备状态的开销，保留原有边界精度。
- `frameAt` 的主要调用路径占 23.60%，需要进一步检查心情映射、活动干员集合、时间技能索引的重复构建。
- 制造仓库容量 `evaluateManufacturingCapacity` 的主要调用路径占 17.88%；其全局上下文构建占 16.13%。现有函数已有 `preparedContext` 参数，可优先验证同一帧内多个制造站共享上下文，严格保留心情与进驻变化的失效条件。

这些比例包含子调用并且相互重叠，不能相加为预期加速比。以上是下一批优化方向，尚未修改单场景引擎。原始 `neighborhood.cpuprofile` 和 `profile-summary.json` 可复核；运行 `node scripts/profile-neighborhood.mjs` 可重现采样。

当前串行基线与并行结果均在同一份最新机制代码上生成。历史 `before` 记录产生在单人组合排序更新之前，未用于上述对比。

## 验证

- 生产构建通过（包含 TypeScript 类型检查）。
- 搜索与线程池回归通过：逆序完成仍保持整份结果一致，保留多步路径和缓存，拒绝缺失或错误场景证据；深搜异常时保留已验证的第二阶段排班。
- 真实浏览器运行生产 Worker：结果与同步版本完全一致，四个邻域场景实际分发，四个线程全部释放。
- 取消运行：父 Worker 终止后四个子线程均停止，无后续心跳。
- 原有两个完整 168 小时物理任务回放的事件、干员状态与产出精确一致，649 秒通过。原来的 360 秒超时不足，已只将超时放宽至 1200 秒，保留全部原有窗口和断言。
- 全量回归初次运行：2145 项通过、1 项跳过，2 项长窗口测试超时；两项仅放宽超时后均复跑通过，合计 187 个有效测试文件、2147 项测试通过。原有跳过项保留。
- 金条无人机的原有 336 小时场景在单独复跑时用时 444 秒，通过全部原断言；其完整场景 JSON 与全量运行时生成的原始金条报告精确一致。测试超时从 600 秒放宽至 1200 秒，模拟窗口和断言保持原样。

## 复现与证据

```powershell
node scripts/benchmark-neighborhood.mjs current-before 1 4 current-before
node scripts/benchmark-neighborhood.mjs persistent 4 4 current-before
```

- `current-before-timing.json` / `current-before-result.json`：当前串行基线。
- `persistent-timing.json` / `persistent-result.json`：并行实测与完整结果。
- `browser-check.json` / `browser-parallel.png`：生产浏览器线程验证。
- `build.txt`、`full-tests.txt`、`long-replay-retry.txt`、`gold-replay-retry.txt`：构建和测试日志。
- `regression-summary.json` / `screenshot-gold-retry.json`：最终回归汇总与金条场景复跑证据。
- 本地另保留 `source-before.zip`：改动前相关源码备份。

此次修改覆盖自动排班第三阶段 hill-climb 路径。独立 multi-start 入口和全局人均替换沿用既有执行方式。基准输入已保存为 `scripts/fixtures/neighborhood-request.json`，与本次实测输入逐项一致，复现脚本可直接使用。

## 桌面同步

按用户要求重新构建 win-x64 单文件桌面程序，并同步到 `D:\Tools\R.I.I.C-Calculator`。安装后的 EXE、README 和全部 998 个前端资源与本次构建逐文件哈希一致；“干员练度”的五个文件保持原样。WebView2 本地存档目录未操作。

原程序、说明、构建记录和整个旧版 dist 保留在本地 `tools-backup` 目录中，可恢复。`deployment-build.txt`、`desktop-build.txt` 和 `desktop-sync.json` 记录构建及同步验证。桌面发布成功，沿用已有的 WindowsBase 引用冲突警告，没有修改桌面运行器逻辑。
