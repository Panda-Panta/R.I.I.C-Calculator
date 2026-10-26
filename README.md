# 明日方舟基建收益预测

## 当前版本：Mower 排班与长期仿真

2026-10-24 的 [Mower 机制更新](docs/UPDATE_2026-10-24_MOWER_LATEST.md) 导入嵌套副表函数、分组编辑、恢复观测、普通替班检查、绑组实际执行确认及换位暖机规则。固定来源为 alpha `84e3926c`；验证与交付状态见 [当前计划](UPDATE_PLAN.md)。

自动排班的挂件干员优先使用加工站、训练室和已建回收站的空闲工位，这三类设施同属辅助优先级；都无可用工位时再使用宿舍。回收站按实际等级提供 1／2／2 个工位，已占用或锁定的工位保留。

自动排班先构造一份合法初始表，再从受支持的制造组建立完整队伍域，按有限工休周期模型计算产出系数，用动态规划和人员冲突分支联合分配主替队伍。默认最多对初始表及计算改进表两份排班做完整仿真，保留日均加权产出较高的已验证结果；额外深度比较默认关闭，旧设置中显式开启的选择保留。

计算使用实际持有练度，保留用户锁定、已有完整组合和固定复杂块；当前重分配范围是受支持制造站的完整组。达到预算时只计算已完成量化的子域，模型最优不等于完整仿真或真实游戏的全局最优。固定243场景的完整流程观察到日均加权产出提高0.60%、等待减少67.63%，不保证所有排班都有相同改善；该场景的计算解与初始表收益持平。算法、暖机策略及验证边界见 [自动排班搜索说明](docs/automatic-roster-search.md)，源码与安装交付状态见 [当前计划](UPDATE_PLAN.md)。

2026-10-12 数据更新采用 GameData v078 固定提交 `17759cc8cdf37388414145d16262a3a06f3ab25e`，包含 432 份基建档案、929 条阶段技能版本。新增德·托莱多、旅骨、克莱门莎，并按实际技能解锁条件计算招聘、宿舍、会客、回收与指定加工配方的效果；数据与明日方舟工具箱、PRTS 对照，来源版本和哈希见 [GameData 清单](src/data/riic-gamedata-source-manifest.json)。

`main` 分支提供 Mower 排班导入、编辑、理想跑单与长期收益测算。跑单仅支持理想模式：新单开始时锁定已配置且技能已解锁的佩佩／可露希尔订单模式，在普通订单完成时应用 U-Official／但书／龙舌兰收益。保留 Mower 对订单任务的读取、排序与唤醒，不执行临时跑单换人、等待或恢复；常规换班、休息、收取和无人机任务继续按 Mower 时间线模拟。综合收益默认采用 82 口径，可自定义产出加权系数，结果提供逐制造站采样完成件数供核对。

导入干员库时，库内条目是闲置候选；未导入时，按全体干员总表提供闲置候选。主副表已在岗的干员无需列入闲置库。材料库存默认无限；会客室线索产量按全程开启交流估算，调度条件 Party Time 仍固定为空，不执行交流任务；休息、急救及菲亚阈值在策略配置的高级设置调整，孑的精 0 选项在「计算产出」菜单调整。

非宿舍工作主班可在多绑组中设置一列空组名及个人替班，按自身心情独立轮休；具名组休息时仍优先使用对应组的共同替班。宿舍多绑组各列保留具名组，以建立合法的 `Free` 恢复床位。线索搜集计入已解锁、正常在岗的中枢与办公室加成，外部提供者同样遵守实际练度条件。

「设置 → 产出加权系数」可调整作战记录、赤金、订单、源石碎片和合成玉的非负权重；默认分别为 1、0.8、0.2、0、0。内部跑单增益计算、自动排班候选比较、最终产出和日志共用该评分，虚拟赤金用于折算订单溢价，不进入物理库存。自动排班根据实际已解锁技能与站级，选择加权增益最高且增益为正的跑单候补；一级、二级禁用龙舌兰及龙舌兰＋但书组合，存在其他可用跑单候补时排除佩佩。已有排班的独立收益计算保留用户配置的候补。

程序按实际在岗干员识别裁缝 α/β，并采用固定订单概率。三级 α 为 15%/30%/55%，β 为 5%/10%/85%（2/3/4 赤金订单）；一级、二级按用户指定沿用这套模型。PRTS 的上述概率表明确限定三级，低级裁缝概率未经游戏实测核验；普通一级仍为 100% 二金、普通二级为 60% 二金与 40% 三金。当前不模拟裁缝暖机或多个裁缝的精确叠加。

2026-09-27 的固定条件历史复验中，指定 Mower Test 排班在 7 天预热、9 天采样后，默认 82 综合日均与截图参考值相差 0.2404%，普通生产干员 0 心情进驻审计为 0。该历史数值不是当前版本或任意自定义权重的精度承诺，也不证明与实际账号的逐帧识别、屏幕同优先级排序或完整原版循环严格一致。详情见 [长期复验报告](validation/mower-output-2026-09-27/idlePool9-report.md) 与 [排班外部条件](validation/mower-output-2026-09-27/scheduling-external-conditions-2026-09-28.md)。

当前兼容目标固定为 Mower alpha `ab0a4e5bec23f6f8d7c37b0648f05dda28f31866`（2026-10-13）：更新主副表导入、配置增减、共享绑组、同组主班互换、宿舍 `Free` 替班、宿舍高低优位、心情上下限和产物切换。工作台默认使用 alpha 调度。历史验证仍保留原来源与模型，不能代替当前版本的完整对等证明；来源、测试及限制见 [本次兼容报告](docs/UPDATE_2026-10-13_MOWER_ALPHA.md)。

排班上半部设施对齐 Mower 布局，组输入旁可增加共享绑组；下半部策略表支持拖动调整名单顺序。高级设置与心情上下限从策略配置右上角进入。导入的高级设置参与本地模拟；宿舍隔离在同等床位条件下优先分宿，允许床位不足时同宿，并更新实际宿舍占位及相关精英干员设施计数。尚未用于本地模拟的高级项在界面明确标注。

回收站默认未建，1/2/3 级工位为 1/2/2，耗电为 0；材料按效率转化，无人驻守时继续，满仓暂停，待办收取后恢复。统计转化件数与心情、在岗联动，不将随机材料虚构为龙门币收益。导入兼容 14/16 QR 图片，导出采用 14 QR。长期演算另外统计会客室搜集完成的线索日均和总数，结果及导出海报显示数量，不计信用点或加权收益；没有线索字段的旧报告需重新演算。加工与招聘/线索专项面板为当前配置预览；回收站转化提效预览不自动给长期模拟添加投料。

基础收益计算还实现：

- 九个制造/贸易/发电设施的类型与等级编辑；
- 功能设施和宿舍耗电配置；
- 制造、普通贸易、源石订单与五类特殊订单的确定性期望；
- 发电站充能和无人机目标分配；
- 电力不足时停止收益汇总，但保留全部配置编辑；
- 浏览器本地保存方案；
- 从 GameData 导入干员基建档案与最高阶段技能；
- 制造站、贸易站、发电站和控制中枢按设施选择干员；
- 自动计算进驻基础加成、常见直接效率技能、配方限定技能、同房指定干员联动；
- 自动计算标准化/莱茵科技/红松骑士团类别联动，以及海沫转换、多萝西、水月、歌蕾蒂娅等专项规则；
- 自动识别高品质订单与特殊订单，未量化技能会在设施明细中明确列出；
- 支持贸易站跑单：自动排班按实际已解锁技能与加权增益选择候补；龙舌兰和组合仅三级站启用，但书、可露希尔与佩佩按技能解锁和候补规则生效；
- 支持 0 心情状态，以及自动化、清流设施计数、承曦格雷伊和森蚺/Lancet-2 的有效发电站计数；
- 支持为每名进驻干员设置 0–24 当前心情，并配置宿舍当前进驻人数；
- 支持建立跨设施干员组合；同组成员在预测起点同步进驻，任一成员心情耗尽时全组同步离开，未耗尽成员保留剩余心情；
- 主表干员支持多个绑组；共享成员按正在休息的组选择共同替班，最后一个依赖组回岗后才恢复主班；
- 计算基础消耗、制造/贸易人数减免、控制中枢全局减免、个人/同房/全员心情技能，以及派系计数、指定目标、消除效果、热情值和人间烟火联动；
- 在心情耗尽、跨越 12 心情和铅踝每 4 点心情落差时立即重算，并按分段效率积分制造、贸易和无人机产出；
- 基础公式与组合规则单元测试。

动态排班支持三间宿舍布局，并在完整换班任务执行期间保护宿舍安排，避免副表切换或纠错打断任务。收益计算提供进度和中止控制；改变评分系数会取消使用旧系数的后台任务，旧任务结果不会覆盖新配置。

2026-10-16 更新对齐 Mower 原生床位接管与整组顺序分床条件，并为长窗口完整报告增加有界分块回传。来源与验证范围见 [本次更新说明](docs/UPDATE_2026-10-16_MOWER_REPORT.md)。

## Mower 排班兼容工作台 (Main Roster Workbench)

本版本提供与 [Arknights Mower](https://github.com/ArkMowers/arknights-mower) 高度互通的 980px 固定画布主排班工作台，实现排班数据的双向无损交换与确定性收益测算：

- **核心主排班范围 (Core Main-Roster Scope):**
  提供 19 个设施卡片的主排班（`plan1` / active default plan）以及全局策略配置（`conf`）。覆盖左侧 3×3 矩阵共 9 个产出设施（制造站、贸易站、发电站）、控制中枢、4 间宿舍以及 5 间右侧功能设施（会客室、加工站、办公室、训练室、回收站）。沿用 Mower 的 980px 固定宽度、暗色配色、设施主题色、产物水印和拖拽换位交互。
- **JSON / QR 排班图双向导入导出 (JSON/JPG Interchange):**
  - **Mower JSON 无损互通 (`mowerJson.ts`):** 原生解析并生成标准 Mower JSON 顶层结构（`default`、`plan1`、`conf`、`backup_plans`）。通过兼容信封（`MowerCompatibilityEnvelope`）无损保留多方案及第三方自定义字段，保留未知字段，并对旧字段执行明确迁移；
  - **14/16 QR 排班图互通 (`mowerQrCodec.ts`):** 按新版 Mower 导出 14 个二维码（顶部 7 个、左下 7 个），避免遮挡新增回收站；导入兼容这套布局和旧版右下额外 2 个的 16 QR 图片。压缩与编码沿用 zlib level 9 + RFC 9285 Base45，按几何位置排序提取，不依赖 OCR。
- **2/3 发电站设施等级推导规则 (2/3 Power Facility Inference):**
  针对 Mower 排班数据中不持久化设施等级的特点，内置智能等级推导：
  - **3 发电站（如 243、333 等）:** 810 kW 发电量充沛，推导所有 9 个产出设施为 3 级，4 间宿舍全部为 5 级，控制中枢 5 级，已有右侧功能设施均为 3 级；
  - **2 发电站（如 252、342 等）:** 电力预算受限，推导 4 间宿舍为 1 级，发电站 3 级，中枢 5 级，右侧功能设施 3 级；制造站与贸易站则根据在岗干员人数推导：$\text{level} = \max(1, \min(3, \text{staffedCount} \parallel 1))$。
  - **回收站:** 原生 JSON 未包含 `recycle` 时保留未建状态；包含该设施但未给等级时采用 3 级编辑默认值，可在工作台改成实际等级。这个默认值不证明账号中的实际建筑等级。
- **收益测算桥接 (Calculation Bridge):**
  静态收益适配器仍可生成常规收益预估；长期排班使用独立动态模拟，执行主副表、候补、宿舍、定时任务与跑单生产事件。静态投影不可代替长期工休结果。
- **动态覆盖与限制 (Dynamic Coverage and Limits):**
  支持 Mower 主表、副表、候补、部分策略触发、Free 补位与跑单队列。未观测到的账号屏幕顺序及游戏识别耗时使用明确模拟输入；出现未覆盖规则或调度异常时返回诊断，不将静态替补投影冒充完整动态结果。

## 开源许可与致谢 (License & Attribution)

本项目的排班工作台布局结构、设计变量、二维码布局几何常数及互操作协议改编自开源项目 **Arknights Mower**：

- **原项目:** [Arknights Mower](https://github.com/ArkMowers/arknights-mower)
- **原作者:** Nano & Contributors
- **开源协议:** MIT License
- **版权所有:** Copyright (c) 2021 Nano

```
MIT License

Copyright (c) 2021 Nano

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

详细信息请参阅 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 本地运行

Windows 用户可直接双击 `一键启动.bat`。脚本会在首次运行时自动安装依赖并打开浏览器，关闭脚本窗口即可停止服务。

也可以在终端中手动运行：

```powershell
pnpm install
pnpm dev
```

打开 `http://127.0.0.1:4173/`。

## 更新干员数据

完整更新流程见 [DEVELOPMENT_WORKFLOW.md](DEVELOPMENT_WORKFLOW.md)。发布或导入 skill 前先检查 GameData、PRTS、明日方舟工具箱和相关 Mower 的最新状态，并固定版本、提交和哈希；跨来源数据同步使用 `scripts/sync-riic-catalog.mjs`，先生成到临时目录并完成审计。

仅从指定 GameData 导入档案时，在项目根目录执行以下命令。请将 `<GameData目录>` 替换为你下载或克隆的 GameData 根目录，保留路径外的引号：

```powershell
node scripts/import-gamedata.mjs "<GameData目录>/zh_CN/gamedata/excel"
```

导入器会保留每个基建技能槽的全部版本及精英阶段、等级解锁条件，计算时按用户填写的实际练度选择已解锁版本；`skills` 字段仍保留每槽最高阶段的兼容快照，完整版本位于 `skillSlots`。缺失技能定义或无效解锁条件会使导入失败，不会覆盖原数据。技能引擎采用“通用解析器 + 专项规则处理器”，因此新加入的普通百分比技能通常可直接识别，复杂状态、库存、心情和跨设施联动则逐条纳入专项规则。界面中的“手动效率修正”可临时覆盖尚未量化的效果。

`pnpm audit:data "<GameData目录>/zh_CN/gamedata/excel"` 会逐一核对所有设施类型的完整技能槽、各版本解锁条件及最高阶段快照，包括控制中枢、宿舍、办公室、制造站、贸易站、会客室、发电站、训练室、加工站和回收站；任何档案、技能槽或解锁阶段缺失都会以非零状态退出。

导入器生成指定 GameData 的官方档案。工具箱拼音和已有角色标识等附加元数据与官方技能档案分别维护；更新时先在临时目录导入并通过完整技能阶段审计，再核对跨来源字段后替换发布数据。

数据按 GameData 的基建档案计数，不直接按战斗形态总数计算。阿米娅的三种职业形态共用 `char_002_amiya` 的一份基建档案。导入器排除没有 `building_data` 记录、无法常驻玩家基建的集成战略及卫戍协议专属角色；当前固定版本为 432 份有效档案。

## 源码结构

根目录 [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) 提供模块职责和自动生成的完整源码索引。新增、移动或删除文件时运行 `node scripts/update-project-structure.mjs`，交付前以 `--check` 校验。依赖约定详见 [源码结构说明](src/README.md)，维护要求见 [AGENTS.md](AGENTS.md)。

后勤 skill 的独立发布目标为 [arknights-riic-mechanics](https://github.com/Panda-Panta/arknights-riic-mechanics)。格式、来源新鲜度与离线验证按更新流程执行；实际发布状态见本次交付报告，通用 Agent Skills 格式检查不代表所有 agent 平台均已实际导入。

## 验证

```powershell
pnpm typecheck
pnpm test
pnpm audit:data "<GameData目录>/zh_CN/gamedata/excel"
pnpm build
node scripts/update-project-structure.mjs --check
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-sync-tools.ps1
```

后续正式发布须按 [更新流程](DEVELOPMENT_WORKFLOW.md) 验证并同步远程源码，再使用 `scripts/sync-tools.ps1` 同步 `D:\Tools\R.I.I.C-Calculator`。该工具备份并逐文件校验安装，不强制关闭程序，保留用户配置、排班和浏览器数据。本轮自动排班改造的交付范围仅为新分支本地提交，不执行上述发布或安装同步。
