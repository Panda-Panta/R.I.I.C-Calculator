# 项目更新流程

维护者约定保存在 [AGENTS.md](AGENTS.md)，所有会话先按该文件执行。当前更新的目标、分工和完成状态保存在 [UPDATE_PLAN.md](UPDATE_PLAN.md)，实际源码路径见 [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md)。

## 开始前

1. 核对工作目录、分支、远程和 Git 状态，识别既有修改及真实干员库、主副排班和安装配置；不以重置或清空方式整理工作区。
2. 创建源码备份并校验 SHA-256；涉及安装时另备份安装目录。记录备份位置和还原范围。
3. 在 UPDATE_PLAN.md 写清来源、目标、模块边界、影响矩阵、验证输入及交付标准。多步骤工作按独立路径分给 subagent，主 agent 汇总审查和最终验证。

## 工具入口与输出归属

以下命令从项目根目录执行。源码和长期工具按现有目录维护；每次任务的构建、报告及备份放入独立的 `artifacts/<任务>/`。历史验证输入与记录继续保留在原位置，不作为新任务的默认输出目录。

| 用途 | 入口与输入 | 输出及执行边界 |
| --- | --- | --- |
| Windows 源码启动 | 根目录 `一键启动.bat`；Node.js、pnpm 或 Corepack | 首次运行安装项目依赖，随后在 `127.0.0.1:4173` 启动 Vite 并打开浏览器；适用普通分支、detached 检出和源码归档，无需 Git |
| 启动环境检查 | `一键启动.bat --check` | 检查依赖，缺失时仍会执行首次安装；不启动服务或打开浏览器 |
| 启动器回归 | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-launcher.ps1` | 在 `artifacts/launcher-tests/<随机ID>/` 用独立 PATH 与 stub 验证分支/无 Git、依赖、端口和退出码；只替换测试副本的浏览器执行入口，不启动真实浏览器、服务或安装 |
| 源码结构索引 | `pnpm structure:update` / `pnpm structure:check` | 前者重建根索引，后者只读核对；目录归属与依赖说明见 `src/README.md` |
| 固定合成库存诊断 | `pnpm diagnose:roster`；先用 `--help` 查看入口 | 向终端输出短场景观察；`--help` 不启动仿真，完整诊断会运行优化器和生产模拟 |
| 正式排班基准 | `node scripts/benchmark-auto-roster.mjs --request <JSON> --out <新目录>` | 显式输入及全新输出目录，保存源码/输入哈希、完整结果和计时；支持 `--source-root` 与 `--concurrency`，会运行完整仿真 |
| 保存报告的工休校准 | `node scripts/benchmark-duty-model.mjs --cases <清单JSON> --out <新目录>` | 读取已保存的配对报告并写入独立结果，不启动新 H 或 F；输入契约见 [自动排班说明](docs/automatic-roster-search.md#工休理论预测与离线校准开发分支) |
| 技能查询与审计 | `pnpm check:skills` / `pnpm audit:data <GameData excel目录>` | 前者只打印脚本指定角色的技能；后者与固定 GameData 核对完整槽位和阶段，以退出码判定；两者职责不同 |
| 数据生成与来源合并 | `scripts/import-gamedata.mjs` / `scripts/sync-riic-catalog.mjs` | 导入器写当前工作目录下的 `src/data/operators.generated.json`；跨来源同步接受明确暂存目录。先暂存和审计，再按下节应用 |
| 发布与安装 | `scripts/pack-release.ps1` / `scripts/sync-tools.ps1` | 涉及构建、程序备份或安装写入；按本文后续交付流程执行，先使用对应 `-ValidateOnly` |

历史诊断工具保留其原输入和参数，以便重放原记录；使用前核对以下固定路径，准备独立副本或正式基准请求，避免把旧证据当成本次结果。

| 历史入口 | 固定输入/输出与副作用 |
| --- | --- |
| `benchmark-cpu.mjs`、`profile-candidate-generation.mjs` | 向 `artifacts/cpu-optimization/` 写请求、引擎、报告或 CPU profile；重复运行可覆盖同名结果，前者会运行完整仿真 |
| `benchmark-neighborhood.mjs`、`profile-neighborhood.mjs` | 读取固定邻域请求或既有基线，向 `validation/neighborhood-performance-2026-10-01/` 写引擎、结果或 profile；保持原日期归属，重复运行可覆盖旧证据 |
| `prepare-cpu-browser-check.mjs`、`prepare-neighborhood-browser-check.mjs` | 依赖已构建的 `dist/assets` 及上述历史输入，直接向 `dist/` 注入诊断页面、请求与 Worker；后者还运行生成器准备基线。使用独立诊断构建，完成后重新构建正式产物再打包 |
| `dump_sheet1.py`、`test-audit.spec.ts` | 由 `scratch/mower.xlsx` 生成 `scratch/sheet1_dump.json`，外部布局审计还需原 JSON 输入；`RUN_MOWER_LAYOUT_AUDIT=1` 才运行审计测试，并写 `scratch/2026-09-09-mower-layout-efficiency-audit.md` |
| `trace-252-shiftrun.ts` | 固定合成 252 场景的命令行追踪，运行排班/计算并向终端输出；属于专项诊断，不作为用户库存的通用验收入口 |


## 实现与联动验证

新机制应拥有独立规则或时间线模块和数值回归，界面调用业务模块。共享类型、计分和技能条件各保留一个实现。保持 WorkbenchShell、calculate 与通用组件的职责范围。

验证新内容时同时覆盖同站、全局在岗、设施等级与数量、阵营与技能类别、精英阶段、心情、候补、主副表及长期产出。没有新内容的旧输入应保持原数值；来源版本或新增但未建造的设施结构差异应单独解释。数据收录、算法量化、静态测试、动态模拟及真实游戏运行分别记录。

常规检查使用项目本地工具；需要独立构建时显式指定产物目录，避免覆盖仍被使用的安装或旧构建：

```powershell
node node_modules/vue-tsc/bin/vue-tsc.js -b
node node_modules/vitest/vitest.mjs run
node node_modules/vite/bin/vite.js build --outDir artifacts/<本次更新>/dist
node scripts/update-project-structure.mjs
node scripts/update-project-structure.mjs --check
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-launcher.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-sync-tools.ps1
```

CI 或本机需要改变测试超时时间时记录原因及实际命令。全部必需检查通过后再交付；只有新修改、失败或未解决风险才扩大测试范围。源码结构发生变化时更新自动索引，与源码一同提交。

## 数据与独立 skill 发布

发布或导入前检查 GameData、PRTS、明日方舟工具箱和适用 Mower 分支的最新状态，将实际检查时间、提交或页面修订号、版本及 SHA-256 写入来源清单。若上游变化，先核对差异，重新生成数据并验证联动，再发布。

先将三方核对过的固定输入生成到本次 artifacts 的临时目录，再应用至软件数据与 skill；完整保留技能槽、各阶段和等级条件。现有导入器只负责指定 GameData 档案，跨来源同步使用 scripts/sync-riic-catalog.mjs，并执行相应离线审计。不要将历史补充档案当作最新官方数据。

项目中的 skill 位于 `.codex/skills/arknights-riic-mechanics/`，独立发布目标为 [Panda-Panta/arknights-riic-mechanics](https://github.com/Panda-Panta/arknights-riic-mechanics)。发布包保持 `SKILL.md`、`references/` 和 `scripts/` 的相对结构。检查 YAML frontmatter 的 name/description、所有相对引用、可执行查询和文件哈希，确认离线运行不依赖计算器工作目录。实际发布后记录仓库提交和可安装包的哈希。各 agent 的安装入口可按其目录约定适配；通用格式检查不能代替对所有平台的实际导入测试。

应用经过三方核对的生成结果及规则说明后，运行 `npm run skill:manifest` 重建包清单，再运行 `npm run skill:validate` 和 `node --use-system-ca .codex/skills/arknights-riic-mechanics/scripts/check-freshness.mjs`。重建清单只记录当前文件字节，不代替来源检查或数值回归。主仓库与独立仓库通过 `.gitattributes` 保留 skill 字节，避免 Git 的平台换行转换破坏清单哈希。CI 会检查源码结构、skill 包完整性和回归结果。

## 源码远程同步

源码修复只提交到我们自己的 [Panda-Panta/R.I.I.C-Calculator](https://github.com/Panda-Panta/R.I.I.C-Calculator) 的 `codex/` 工作分支。保留外部 PR 的原始贡献；不向外部贡献者仓库或源分支推送、追加修复、改写历史或删除分支，即使 `maintainer_can_modify=true`。

1. 固定原 PR 的 head、当前主线提交及实际远程地址，确认不会覆盖既有工作。无需修复的 PR，完成正常审查和必要验证后直接合并，无需另开集成 PR。
2. 需要修复时，从当前主线建立自有仓库工作分支，集成原 PR 贡献和修复，保留已有主线更新。提交本次源码、测试、结构索引、约定及适用来源清单，记录最终候选 head；普通推送，不强推、自动重置或覆盖无关工作。
3. 对已提交的最终候选完成审查和必要验证，记录测试与构建对应的提交及输入。候选 head 变化后，补充审查并重验受影响范围；先前结论不能直接作为新候选已通过的证据。
4. 审查和验证通过后，通过普通 PR 流程合并主线，遵守平台检查与分支保护。需要修复的原 PR 及修复通过自有集成 PR 一并合入；不得先合入已知有问题的原 PR、再补修复以绕过审查，也不使用管理员绕过。记录原 PR、集成 PR、最终候选及实际合并提交的对应关系。
5. 合并后拉取实际主线，采用快进方式更新本地；核对实际提交、代码树与已测候选、构建输入的一致性。出现实际相关变化时重新验证并构建，确认后才进入 Tools 安装同步。

在 UPDATE_PLAN.md 分别记录修复分支、审查、合并和安装状态；中断时写清已完成项与具体待办，推送成功不等于交付完成。保存远程接收与安装证据，CI、GitHub Release 和页面部署结果另行确认。个人配置、真实干员库、主副排班和浏览器档案保留在本地，不提交远程。按既有授权执行，不增加例行人工确认。

## D:\Tools 安装同步

仅在上述源码流程完成、审查通过且已合并，并确认实际主线与验证和构建对应后，才同步安装。安装目标固定为 `D:\Tools\R.I.I.C-Calculator`。安全同步入口是 `scripts/sync-tools.ps1`；它不会结束正在运行的程序，遇到运行实例会停止并提示先关闭。默认先在 artifacts 中构建前端，也可复用已经通过检查且输入一致的构建：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sync-tools.ps1 `
  -SourceDist "<已验证前端目录>" -ValidateOnly

powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sync-tools.ps1 `
  -SourceDist "<已验证前端目录>"
```

修改了 Windows 外壳时，可提供 `-DesktopPublish "<已发布外壳目录>"`，或加 `-PublishDesktop` 在 artifacts 下执行 dotnet publish。前端仅同步至目标 dist；原生文件仅接受外壳、明确依赖及说明文件。配置、干员库、主副排班、`干员练度` 等用户文件保留。WebView2 的实际数据位于 `%LOCALAPPDATA%\R.I.I.C-Calculator\WebView2Data`，同步工具不会写入该位置。

同步前校验绝对路径、拒绝链接跳转，生成待写文件的哈希清单，并备份安装目录中所有现有文件及校验副本。同步后逐文件核对管理文件，同时核对其他原有文件未改变。旧产物仅在上次管理清单中登记、且当前哈希仍与该清单一致时清理；首次同步不会盲删旧文件。发生错误时尝试恢复已改动文件，并保存失败与还原证据。清单、备份和结果位于 `artifacts/install-sync/` 或显式指定的 artifacts 报告目录。

`scripts/pack-release.ps1` 默认将 ZIP 和 SHA256SUMS.txt 输出到项目 artifacts，也接受显式 `-OutputDir`（相对路径按项目根目录解释）。打包前端使用独立产物目录；替换已有 release 暂存包前检查绝对路径、工作区边界和链接，归档并校验旧包而不直接递归删除。ZIP 内每个文件核对大小和 SHA-256，已有输出包也先备份。打包不会结束任何应用；本地打包完成后，将绝对包内 dist 和外壳目录传给同一安全同步入口，CI 只生成包、不写 D:\Tools。`-ValidateOnly` 只展示路径与交付计划，不构建、不打包、不写安装目录。

实际同步需要文件系统允许写入 D:\Tools；权限限制或外部服务故障不能视为交付成功。最终报告列出具体未完成项及原因，保留已完成工作及验证结果，不反复请求已经授权的操作。

## 收尾报告

报告包含最终改动、联动影响矩阵、固定场景比较、测试和构建结果、备份、skill 格式与来源检查、源码提交及远程接收证据、安装同步哈希。说明尚未进行的实际游戏或 agent 导入验证。更新结构索引并校验，维护当前计划状态；安装文件一致不等同于应用已经实际启动。
