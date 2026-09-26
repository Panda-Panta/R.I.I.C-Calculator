import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const directory = resolve(process.argv[2] ?? 'validation/roster-quality-2026-09-27')
const read = name => JSON.parse(readFileSync(resolve(directory, name), 'utf8'))
const hash = name => createHash('sha256').update(readFileSync(resolve(directory, name))).digest('hex')
const source = read('import-verification.json')
assert.equal(source.matchesBaselineInventory, true, 'Workbook inventory must match the frozen baseline')
assert.equal(createHash('sha256').update(readFileSync(source.sourcePath)).digest('hex'), source.sha256, 'Source workbook changed')
const baseline = read('baseline-summary.json')
const isolatedBaseline252 = read('baseline-isolated-252-summary.json')[0]
assert.equal(hash('baseline-engine.mjs'),hash('baseline-isolated-engine.mjs'))
const improved = read('improved-summary.json')
const comparisons = ['243', '252'].map(layout => {
  const before = layout === '252' ? isolatedBaseline252 : baseline.find(row => row.layout === layout)
  const after = improved.find(row => row.layout === layout)
  const oldRequest = read(layout === '252' ? 'baseline-isolated-252-request.json' : `${layout}-request.json`)
  const newRequest = read(`improved-${layout}-request.json`)
  assert.deepEqual(oldRequest.inventory, newRequest.inventory)
  assert.deepEqual(oldRequest.base, newRequest.base)
  for (const key of ['seed','branchCount','simulationWarmupHours','simulationSampleHours','enableDeepSearch','droneTarget']) {
    assert.deepEqual(oldRequest.options[key], newRequest.options[key], `${layout}: changed ${key}`)
  }
  assert.equal(before.status, 'draft')
  assert.equal(after.status, 'draft')
  assert.ok(Number.isFinite(before.score) && Number.isFinite(after.score))
  assert.ok(after.score >= before.score - 1e-6, `${layout}: score regressed`)
  const beforeReport = read(`${layout === '252' ? 'baseline-isolated' : 'baseline'}-${layout}-report.json`)
  const afterReport = read(`improved-${layout}-report.json`)
  assert.deepEqual(beforeReport.phases.simulation.candidates.map(c=>c.id).sort(),afterReport.phases.simulation.candidates.map(c=>c.id).sort())
  const initialComparisons = beforeReport.phases.simulation.candidates.map(candidate => {
    const other = afterReport.phases.simulation.candidates.find(c=>c.id===candidate.id)
    assert.ok(other, `Missing initial candidate ${candidate.id}`)
    assert.deepEqual(candidate.workspace, other.workspace, `${layout}: different initial roster ${candidate.id}`)
    assert.ok(Math.abs(candidate.simScore-other.simScore)<1e-6, `${layout}: different initial score ${candidate.id}`)
    return {id:candidate.id,scoreDelta:other.simScore-candidate.simScore}
  })
  for (const [label, report] of [['baseline',beforeReport],['improved',afterReport]]) {
    writeFileSync(resolve(directory, `${label}-${layout}-workspace.json`), JSON.stringify(report.workspace,null,2))
  }
  const gain = Math.abs(after.score-before.score) < 1e-6 ? 0 : after.score-before.score
  return {layout,before:before.score,after:after.score,gain,percent:gain/before.score*100,
    baselineSeconds:before.elapsedSeconds,improvedSeconds:after.elapsedSeconds,refinements:after.refinements,
    sameRoster:JSON.stringify(beforeReport.workspace.mainPlan)===JSON.stringify(afterReport.workspace.mainPlan),
    initialComparisons,diagnostics:after.diagnostics}
})
const evidence = {source,baselineCommit:'359503f0ff0869e0e48378bd638f32e0ba77dfe1',
  engines:{baseline:hash('baseline-engine.mjs'),improved:hash('improved-engine.mjs')},originalSequentialBaseline:baseline,
  testedOptimizationCommit:'5732104',finalDefaultSearchBudget:0,
  settings:{seed:42,branches:10,warmupHours:24,sampleHours:72,runOrderMode:'ideal',outputMode:'potential',droneTarget:'gold',searchBudget:24,refinementTopK:3},comparisons}
writeFileSync(resolve(directory,'comparison.json'),JSON.stringify(evidence,null,2))
const number = n => n.toLocaleString('en-US',{maximumFractionDigits:2})
const lines = [
  '# 自动排班优化实测对比', '',
  '测试日期：2026-09-27。使用用户提供的 `干员练度表.xlsx`，通过应用自身的导入器读取。', '',
  `文件 SHA-256：\`${source.sha256}\`。原文件校验保持不变。`, '',
  '431 行：378 行已招募记录、53 行未招募；阿米娅三个职业合并后，得到 376 名不同干员，其中精二 73、精一 41、未精英化 262。', '',
  '## 结果', '',
  '| 布局 | 旧版评分/日 | 优化版评分/日 | 增量/日 | 增幅 |',
  '| --- | ---: | ---: | ---: | ---: |',
  ...comparisons.map(c=>`| ${c.layout} | ${number(c.before)} | ${number(c.after)} | ${number(c.gain)} | ${c.percent.toFixed(2)}% |`), '',
  '本轮两个布局均无提升，各追加 24 个候选均未被采用。因此新增搜索保留为可选项，最终默认追加预算为 0；实测使用显式预算 24。小于 1e-6 的浮点尾差按 0 展示。', '',
  '分数为模型计算的 82 综合评分，不是实际游戏观测。只覆盖此练度表、两个指定布局及固定种子，不代表全局最优或所有用户均有提升。', '',
  '## 对比条件', '',
  '- 旧版冻结于 `359503f0ff0869e0e48378bd638f32e0ba77dfe1`；新旧引擎文件哈希保存在 comparison.json。',
  '- 两版使用完全一致的建筑、干员练度、种子 42、10 个初始分支、24 小时预热及 72 小时采样；已逐项校验初始排班相同、分数差小于 1e-6。',
  '- 评分使用既有 scoreProduction；potential 产出、ideal 跑单、无人机加速赤金。不是 natural 跑单的收益承诺。',
  '- 243 使用默认建筑布局；252 将 room_3_3 改为三级经验制造站、room_3_1 降为二级两工位，宿舍/会客室/加工站/训练室为一级；完整建筑设置见 request.json。',
  '- 优化版保留旧流程，再把 24 个追加候选名额分配到前 3 个不同方案；名额包含起点，复核模拟另计。',
  '- 候选须同时提高同窗口评分，并通过不同种子、至少 168 小时采样、两种时间步长的共同基准复核，否则保留原结果。', '',
  '## 计算成本', '',
  '| 布局 | 旧版实测秒数 | 优化版实测秒数 | 追加评估候选 | 接受追加改进 |',
  '| --- | ---: | ---: | ---: | ---: |',
  ...comparisons.map(c=>`| ${c.layout} | ${number(c.baselineSeconds)} | ${number(c.improvedSeconds)} | ${c.refinements.reduce((s,r)=>s+r.evaluated,0)} | ${c.refinements.filter(r=>r.accepted).length} |`), '',
  '计时为本机实测墙钟时间。优化版两个布局并行，部分运行与测试/构建重叠；不是受控速度基准，不据此计算加速比。', '',
  '最初旧版依次运行 243 和 252，252 与独立运行存在中枢候补顺序差异及约 1e-10 分数尾差。排查发现原有 staffingQuality 模块有跨运行缓存，缓存键未覆盖布局等全部上下文。因此表中 252 改用同一冻结旧引擎在独立进程的补跑结果；保留原始顺序运行报告供审计。本次未修改该缓存实现。', '',
  '## 验证与复现', '',
  '- 完整测试：125 个测试文件通过、1 个跳过；1202 项测试通过、1 项跳过。类型检查和生产构建通过。',
  '- 测试日志存在 jsdom ResizeObserver 清理阶段 global.removeEventListener 警告；构建有大 chunk 提示。命令退出码均为 0。',
  '- 实际浏览器已导入此练度表，并检查新增参数、禁用状态和弹窗滚动；浏览器未再重复运行耗时排班。',
  '- `node scripts/benchmark-roster-quality.mjs <新标签> "C:/Users/Panda-Panta/Downloads/干员练度表.xlsx"` 可测试当前源码；脚本拒绝覆盖同名汇总，baseline 只允许冻结旧引擎。',
  '- `node scripts/compare-roster-quality.mjs` 校验输入并重新生成本报告。',
  '- 完整输入、引擎快照、运行日志、before/after workspace 和报告均保存在同目录。', '',
  '## 排班文件', '',
  '- `roster-243.json` 和 `roster-252.json` 为 Mower 排班格式；`roster-*-building-levels.json` 单独记录测试建筑等级。',
  '- Mower 格式不保存建筑等级。252 回读时应用会把办公室、加工站、训练室推断成三级，产生 80 电力赤字；使用本次测试的一等级配置后校验通过。使用 252 文件时必须同时恢复测试建筑等级，不能直接沿用导入推断值。',
  '- `improved-*-workspace.json` 保存包含建筑等级在内的完整内部工作区，适用于核查和复现。', '',
]
writeFileSync(resolve(directory,'comparison.md'),lines.join('\n'))
console.log(JSON.stringify(comparisons,null,2))
