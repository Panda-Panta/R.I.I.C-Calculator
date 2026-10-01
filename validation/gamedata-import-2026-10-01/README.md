# 完整技能阶段导入修复验证

日期：2026-10-01。

## 修改范围

- `scripts/import-gamedata.mjs` 导出全部有效技能槽版本与解锁条件，同时保留最高阶段兼容快照、异格标记；缺失技能定义或无效解锁条件时，在写文件之前失败。
- `scripts/audit-riic-data.mjs` 对照原始 GameData 核对完整槽、全部解锁条件、技能定义、最高阶段快照及阶段总数。
- `src/domain/gamedataImport.spec.ts` 通过真实 CLI 导入临时夹具，再使用生产技能选择器验证低练度、等级解锁、升精后版本替换、独立槽、空占位、描述标签及审计拒绝损坏数据。

## 通过的验证

- `npm.cmd test -- src/domain/gamedataImport.spec.ts src/domain/operatorInventory.spec.ts src/domain/operators.spec.ts`：3 个测试文件、22 项测试通过，其中新增导入回归 11 项。
- 使用本地官方 GameData，在临时目录运行实际导入器和审计器：425 名干员、746 条最高阶段技能、913 条完整阶段，审计通过。所有官方档案的 `skillSlots`、`isAlter` 与当前数据中的对应档案完全一致。详情见 `real-data-verification.json`。
- `npm.cmd run build`：类型检查与 Vite 构建通过。首次构建清理旧 `dist` 时被沙箱拒绝，获准重新执行后通过。
- `node --check` 两个修改后的脚本通过；`git diff --check` 通过。

## 较大范围回归的限制

全量 `npm.cmd test -- --reporter=dot` 超过 15 分钟仍未结束，出现失败标记，已中止，未取得完整汇总。后续以 4 个 worker、逐项报告排除 `src/optimizer/**` 和 `src/scheduler/backupPlans.long.spec.ts` 重跑，观察到以下两项失败；该轮最终仍在界面的同步自动排班计算中长时间未结束，已中止。因此没有完整全量回归通过结论。

- `src/workbench/compat/mowerBackupAudit.spec.ts` 写入旧验证目录时出现 EPERM。获准在沙箱外单独重跑后该文件全部通过。
- `src/simulator/productionRunOrder.spec.ts` 的 `retains captured special costs while an unfunded queue fills and blocks acquisition` 超过默认 5 秒时限。单独使用 `--maxWorkers=1 --testTimeout=30000` 重跑，8 项测试全部通过，耗时 8.51 秒；没有修改断言或生产模拟代码。

当前发布的 429 名干员数据未被重新生成或覆盖，包含的补充档案保留。其 SHA256 在验证前后相同。用户已有的 `src/scheduler/mowerDormAssignment.ts` 修改未被本次修复改动。本次没有训练模型，也没有验证所有布局组合上的排班质量。
