import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const indexName = 'PROJECT_STRUCTURE.md'
const compareNames = (a, b) => a < b ? -1 : a > b ? 1 : 0
const ignoredNames = new Set(['node_modules', 'bin', 'obj', 'dist', '.git', '__pycache__', '.DS_Store'])
const indexedRoots = ['.github/workflows', '.codex/skills/arknights-riic-mechanics', 'desktop', 'docs', 'scripts', 'src']
const rootFiles = [
  '.gitattributes', '.gitignore', 'AGENTS.md', 'DEVELOPMENT_WORKFLOW.md', indexName, 'README.md', 'UPDATE_PLAN.md',
  'THIRD_PARTY_MOWER_LICENSE', 'THIRD_PARTY_NOTICES.md', 'index.html', 'package.json',
  'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.app.json', 'tsconfig.json',
  'tsconfig.node.json', 'vite.config.ts', '一键启动.bat',
]

function indexedFiles(root) {
  if (!existsSync(join(root, '.git'))) return null
  const result = spawnSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...rootFiles, ...indexedRoots, 'public'], { encoding: 'utf8' })
  if (result.error || result.status !== 0) throw new Error(`读取源码路径清单失败：${result.error?.message ?? result.stderr}`)
  return new Set(result.stdout.split('\0').filter(Boolean))
}

function entriesAt(root, relativePath, included) {
  return readdirSync(join(root, relativePath), { withFileTypes: true })
    .filter(entry => !ignoredNames.has(entry.name) && !entry.name.endsWith('.tsbuildinfo'))
    .filter(entry => !included || (entry.isDirectory()
      ? [...included].some(path => path.startsWith(`${relativePath}/${entry.name}/`))
      : included.has(`${relativePath}/${entry.name}`)))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || compareNames(a.name, b.name))
}

function treeLines(root, relativePath, prefix = '', collected = [], included) {
  const entries = entriesAt(root, relativePath, included)
  return entries.flatMap((entry, index) => {
    if (entry.isSymbolicLink()) throw new Error(`源码索引不追踪符号链接：${relativePath}/${entry.name}`)
    const last = index === entries.length - 1
    const path = `${relativePath}/${entry.name}`
    const line = `${prefix}${last ? '└──' : '├──'} ${entry.name}${entry.isDirectory() ? '/' : ''}`
    if (!entry.isDirectory()) collected.push(path)
    return entry.isDirectory()
      ? [line, ...treeLines(root, path, `${prefix}${last ? '    ' : '│   '}`, collected, included)]
      : [line]
  })
}

function countFiles(root, relativePath, included) {
  const fullPath = join(root, relativePath)
  if (!existsSync(fullPath)) return 0
  if (lstatSync(fullPath).isSymbolicLink()) throw new Error(`资源目录不能是符号链接：${relativePath}`)
  if (!lstatSync(fullPath).isDirectory()) return 1
  return entriesAt(root, relativePath, included).reduce((count, entry) => count + countFiles(root, `${relativePath}/${entry.name}`, included), 0)
}

export function renderProjectStructure(root = projectRoot) {
  const included = indexedFiles(root)
  const collected = []
  const rootListing = rootFiles.filter(name => name === indexName || (existsSync(join(root, name)) && (!included || included.has(name)))).sort(compareNames)
  const trees = indexedRoots.filter(path => existsSync(join(root, path)) && (!included || [...included].some(file => file.startsWith(path + '/')))).map(path => {
    const lines = treeLines(root, path, '', collected, included)
    return `### ${path}\n\n\`\`\`text\n${path}/\n${lines.join('\n')}\n\`\`\``
  })
  const productionFiles = collected.filter(path => path.startsWith('src/') && /\.(?:ts|vue|css)$/.test(path) && !/\.(?:spec|test)\.ts$/.test(path))
  const testFiles = collected.filter(path => /\.(?:spec|test)\.ts$/.test(path))
  const publicEntries = existsSync(join(root, 'public')) ? entriesAt(root, 'public', included).map(entry => {
    const path = `public/${entry.name}`
    return `| \`${path}${entry.isDirectory() ? '/' : ''}\` | ${countFiles(root, path, included)} |`
  }) : []
  return `# 项目源码结构索引

此文件由 \`node scripts/update-project-structure.mjs\` 生成。新增、移动或删除源码、脚本、skill 文件后重新生成；交付前运行 \`node scripts/update-project-structure.mjs --check\`。索引只记录路径，不包含时间戳，因此相同结构产生相同结果。

开发约定见 [AGENTS.md](AGENTS.md)，当前实施与交付状态见 [UPDATE_PLAN.md](UPDATE_PLAN.md)，更新流程见 [DEVELOPMENT_WORKFLOW.md](DEVELOPMENT_WORKFLOW.md)。

## 模块职责与依赖

| 位置 | 职责与边界 |
| --- | --- |
| \`src/domain/\` | 与界面无关的业务类型、干员标识与身份、设施名称、排班模型和公共计分；共享定义优先放在这里 |
| \`src/rules/\` | 独立、可测试的订单规则；规则不引用界面状态 |
| \`src/engine/\` | 静态效率、心情及后勤技能条件；新增机制使用专项模块 |
| \`src/scheduler/\` | Mower 调度、主副表、策略、任务队列和原生兼容规则 |
| \`src/simulator/\` | 生产、资源和回收站事件时间线；不依赖优化器 |
| \`src/optimizer/\` | 候选枚举、配员搜索和方案比较；调用既有规则而不复制它们 |
| \`src/workbench/\` | 工作台状态、迁移、Mower JSON/二维码兼容及计算桥接 |
| \`src/workbench/composables/\` | 持久化、收益任务和自动排班任务生命周期 |
| \`src/workbench/timeline/\` | 报告时间线、密集区间展示及纯坐标、刻度与导出布局；浏览器副作用留在组件 |
| \`src/components/workbench/\` | 页面、编辑器与弹窗；WorkbenchShell 只组装界面和路由交互 |
| \`src/data/\` | 固定版本数据、来源清单和生成结果，不手改自动生成数据 |
| \`src/test/\` | 架构契约、报告输出与测试辅助；相应业务测试通常与模块放在一起 |
| \`scripts/\` | 数据审计、结构生成、性能诊断、构建和安全安装同步 |
| \`desktop/\` | Windows WebView2 外壳；浏览器数据位于用户 LocalApplicationData 下 |
| \`.codex/skills/arknights-riic-mechanics/\` | 项目后勤 skill、来源证据和离线查询；同步发布到独立仓库 |
| \`.github/workflows/\` | 远程构建、发布与页面部署 |

领域、规则、效率引擎与调度层不依赖 Vue、Pinia、界面或优化器。源码运行时导入保持无环，仅类型引用不计入运行时环。\`src/test/architecture.spec.ts\` 校验这些约定。完整职责说明见 [src/README.md](src/README.md)。

## 新后勤机制的维护入口

- \`src/domain/facilities.ts\`：设施工位和等级的共享规则，由编辑、校验和配员共同使用。
- \`src/engine/supportFacilitySkills.ts\`：回收效率、加工副产品及新招聘/线索技能条件。
- \`src/simulator/recycleTimeline.ts\`：材料转化进度、满仓暂停、收取和采样计数。
- \`src/data/support-facilities.generated.json\`：GameData 设施等级、容量、提效与配方参数。
- \`src/workbench/compat/mowerJson.ts\`、\`mowerQrCodec.ts\`：导入导出协议及旧数据保留。
- \`src/components/workbench/SupportFacilityPreview.vue\`：专项预览，避免向通用组件堆积公式。
- \`scripts/sync-riic-catalog.mjs\`：固定版本输入校验与软件、skill 数据生成。

## 纳入范围

共 ${collected.length + rootListing.length} 个索引文件，其中应用 TypeScript/Vue/CSS 文件 ${productionFiles.length} 个，业务测试文件 ${testFiles.length} 个。纳入 Git 已登记和未忽略的源码路径，排除仅存本地的忽略文件，保证干净检出可重新生成相同索引。大批头像、技能图标等静态资源按目录汇总；\`artifacts/\`、\`validation/\`、\`release/\`、\`dist/\`、依赖目录、临时实验和 Git 内部文件不作为源码树展开。\`validation/\` 保存历史输入与核验记录，\`artifacts/\` 保存本次生成的证据和备份。

### 根目录管理入口

\`\`\`text
./
${rootListing.map((name, index) => `${index === rootListing.length - 1 ? '└──' : '├──'} ${name}`).join('\n')}
\`\`\`

${trees.join('\n\n')}

### 静态资源汇总

| 位置 | 文件数 |
| --- | ---: |
${publicEntries.join('\n')}
`
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== '--check')) throw new Error('用法：node scripts/update-project-structure.mjs [--check]')
  const target = join(projectRoot, indexName)
  const expected = renderProjectStructure()
  if (args.includes('--check')) {
    if (!existsSync(target) || readFileSync(target, 'utf8').replaceAll('\r\n', '\n') !== expected) {
      console.error('PROJECT_STRUCTURE.md 与当前结构不一致，请运行 node scripts/update-project-structure.mjs 后提交。')
      process.exitCode = 1
    } else {
      console.log('PROJECT_STRUCTURE.md 与当前源码结构一致。')
    }
  } else {
    writeFileSync(target, expected, 'utf8')
    console.log(`已更新 ${indexName}。`)
  }
}
