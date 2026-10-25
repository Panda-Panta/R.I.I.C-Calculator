# 项目更新流程

维护者约定保存在 [AGENTS.md](AGENTS.md)，所有会话先按该文件执行。当前更新的目标、分工和完成状态保存在 [UPDATE_PLAN.md](UPDATE_PLAN.md)，实际源码路径见 [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md)。

## 开始前

1. 核对工作目录、分支、远程和 Git 状态，识别既有修改及真实干员库、主副排班和安装配置；不以重置或清空方式整理工作区。
2. 创建源码备份并校验 SHA-256；涉及安装时另备份安装目录。记录备份位置和还原范围。
3. 在 UPDATE_PLAN.md 写清来源、目标、模块边界、影响矩阵、验证输入及交付标准。多步骤工作按独立路径分给 subagent，主 agent 汇总审查和最终验证。

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
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-sync-tools.ps1
```

CI 或本机需要改变测试超时时间时记录原因及实际命令。全部必需检查通过后再交付；只有新修改、失败或未解决风险才扩大测试范围。源码结构发生变化时更新自动索引，与源码一同提交。

## 数据与独立 skill 发布

发布或导入前检查 GameData、PRTS、明日方舟工具箱和适用 Mower 分支的最新状态，将实际检查时间、提交或页面修订号、版本及 SHA-256 写入来源清单。若上游变化，先核对差异，重新生成数据并验证联动，再发布。

先将三方核对过的固定输入生成到本次 artifacts 的临时目录，再应用至软件数据与 skill；完整保留技能槽、各阶段和等级条件。现有导入器只负责指定 GameData 档案，跨来源同步使用 scripts/sync-riic-catalog.mjs，并执行相应离线审计。不要将历史补充档案当作最新官方数据。

使用本机 ArknightsUnpacker 时，先按领域 skill 的 [本机数据更新说明](.codex/skills/arknights-riic-mechanics/references/unpacker-data.md) 只读提取到独立目录，并保留原始 AB、解码/归一化收据及哈希。用 `scripts/unpacker-riic-evidence.mjs` 核对本机已解码的干员、完整技能阶段和相关字段；PC 未命名根字段仍由同版本固定 GameData 补足。将导出根作为 `sync-riic-catalog.mjs` 的第三个位置参数会在生成前再次核对并输出独立来源清单。版本或已知字段不一致时停止生成，先审查差异；原始游戏文件与机器路径不纳入公开发布。

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
