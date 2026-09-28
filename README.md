# 明日方舟基建收益预测

## 当前版本：Mower 排班与长期仿真

`main` 分支提供 Mower 排班导入、编辑、动态跑单与长期收益测算。默认理想跑单在订单完成时应用已配置的但书／龙舌兰收益，保留 Mower 对跑单任务的读取、排序与唤醒，不执行临时跑单换人；常规换班、休息、收取和无人机任务继续按 Mower 时间线模拟。可选葛朗台跑单执行 Mower 临时换人、等待与恢复，前置和缓冲时间可在模拟页面设置。综合收益采用 82 口径；两种模式的普通排班仍可能不同。结果提供逐制造站采样完成件数供核对。

导入干员库时，库内条目是闲置候选；未导入时，按全体干员总表提供闲置候选。主副表已在岗的干员无需列入闲置库。材料库存默认无限，Party Time 线索交流固定关闭；无人机、休息阈值等仍按计算设置执行。

指定的 Mower Test 排班在 7 天预热、9 天采样后，综合日均与截图参考值相差 0.2404%，普通生产干员 0 心情进驻审计为 0。该数值验收并不证明与实际账号的逐帧识别、屏幕同优先级排序或完整原版循环严格一致。详情见 [长期复验报告](validation/mower-output-2026-09-27/idlePool9-report.md) 与 [排班外部条件](validation/mower-output-2026-09-27/scheduling-external-conditions-2026-09-28.md)。

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
- 支持贸易站“跑单”：3 级站按但书·β与龙舌兰·β同时生效，1/2 级站仅使用但书·β，并作为本分支贸易站的默认订单模式；
- 支持 0 心情状态，以及自动化、清流设施计数、承曦格雷伊和森蚺/Lancet-2 的有效发电站计数；
- 支持为每名进驻干员设置 0–24 当前心情，并配置宿舍当前进驻人数；
- 支持建立跨设施干员组合；同组成员在预测起点同步进驻，任一成员心情耗尽时全组同步离开，未耗尽成员保留剩余心情；
- 每名干员最多属于一个组合，不足两人的组合保留为编辑草稿且不参与模拟；
- 计算基础消耗、制造/贸易人数减免、控制中枢全局减免、个人/同房/全员心情技能，以及派系计数、指定目标、消除效果、热情值和人间烟火联动；
- 在心情耗尽、跨越 12 心情和铅踝每 4 点心情落差时立即重算，并按分段效率积分制造、贸易和无人机产出；
- 基础公式与组合规则单元测试。

## Mower 排班兼容工作台 (Main Roster Workbench)

本版本提供与 [Arknights Mower](https://github.com/ArkMowers/arknights-mower) 高度互通的 980px 固定画布主排班工作台，实现排班数据的双向无损交换与确定性收益测算：

- **核心主排班范围 (Core Main-Roster Scope):**
  专注于 18 设施卡片主力主排班（`plan1` / active default plan）以及全局策略配置（`conf`）。覆盖左侧 3×3 矩阵共 9 个产出设施（制造站、贸易站、发电站）、控制中枢、4 间宿舍以及 4 间右侧功能设施（会客室、加工站、办公室、训练室）。视觉设计严格遵循 Mower 经典暗色调风格（980px 宽度、设施分类左侧主题色边框、产物水印、45px 干员头像、拖拽换位交互）。
- **JSON / 16-QR 排班图双向导入导出 (JSON/JPG Interchange):**
  - **Mower JSON 无损互通 (`mowerJson.ts`):** 原生解析并生成标准 Mower JSON 顶层结构（`default`、`plan1`、`conf`、`backup_plans`）。通过兼容信封（`MowerCompatibilityEnvelope`）无损保留多方案及第三方自定义字段，确保往返保存时非主排班配置不丢失；
  - **16-QR 排班图互通 (`mowerQrCodec.ts`):** 严格依照 Mower `arknights_mower/utils/qrcode.py` 几何标准（顶部 7 个，左下 7 个，右下 2 个，zlib level 9 压缩 + RFC 9285 Base45 编码），使用坐标掩模与纯几何排序算法直接从画布提取并还原排班，**完全不依赖 OCR**。
- **2/3 发电站设施等级推导规则 (2/3 Power Facility Inference):**
  针对 Mower 排班数据中不持久化设施等级的特点，内置智能等级推导：
  - **3 发电站（如 243、333 等）:** 810 kW 发电量充沛，推导所有 9 个产出设施为 3 级，4 间宿舍全部为 5 级，控制中枢 5 级，右侧功能设施均为 3 级；
  - **2 发电站（如 252、342 等）:** 电力预算受限，推导 4 间宿舍为 1 级，发电站 3 级，中枢 5 级，右侧功能设施 3 级；制造站与贸易站则根据在岗干员人数推导：$\text{level} = \max(1, \min(3, \text{staffedCount} \parallel 1))$。
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

GameData 更新后，在本项目根目录执行以下命令，重新生成规范化数据。请将 `<GameData目录>` 替换为你下载或克隆的 GameData 根目录，保留路径外的引号：

```powershell
node scripts/import-gamedata.mjs "<GameData目录>/zh_CN/gamedata/excel"
```

当前统一按每名干员已解锁的最高阶段基建技能计算。技能引擎采用“通用解析器 + 专项规则处理器”，因此新加入的普通百分比技能通常可直接识别，复杂状态、库存、心情和跨设施联动则逐条纳入专项规则。界面中的“手动效率修正”可临时覆盖尚未量化的效果。

`pnpm audit:data "<GameData目录>/zh_CN/gamedata/excel"` 会逐一核对所有设施类型的最高阶段技能槽，包括控制中枢、宿舍、办公室、制造站、贸易站、会客室、发电站、训练室和加工站；任何档案或技能槽缺失都会以非零状态退出。

数据口径：PRTS 的 427 个正式战斗形态包含阿米娅的近卫、医疗两个职业转换形态；GameData 中三种阿米娅形态共用 `char_002_amiya` 的一份基建档案，因此有效基建档案为 425 份。导入器会排除没有 `building_data` 记录、无法常驻玩家基建的集成战略及卫戍协议专属角色。

## 验证

```powershell
pnpm typecheck
pnpm test
pnpm audit:data "<GameData目录>/zh_CN/gamedata/excel"
pnpm build
```
