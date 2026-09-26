import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
const require = createRequire(import.meta.url)
const { build } = require(require.resolve('esbuild', { paths: [require.resolve('vite')] }))
const out = resolve('validation/roster-quality-2026-09-27')
mkdirSync(out, { recursive: true })
const label = process.argv[2] ?? 'improved'
const selectedLayout = process.argv[4]
const enginePath = `${out}/${label}-engine.mjs`
if (!selectedLayout) {
  if (label !== 'prepare' && existsSync(`${out}/${label}-summary.json`)) throw new Error('Result already exists; choose a new label to preserve comparison evidence.')
  if (label === 'baseline') {
    if (!existsSync(enginePath)) throw new Error('Missing frozen baseline-engine.mjs from commit 359503f; never substitute current source for the baseline.')
  } else if (label !== 'prepare') {
    await build({ stdin: { contents: `export * from './src/optimizer/smartRoster'; export * from './src/workbench/defaults'; export * from './src/optimizer/candidateSimulation';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: enginePath })
  }
  await build({ stdin: { contents: `export * from './src/domain/operatorImport'; export * from './src/domain/operatorInventory';`, resolveDir: process.cwd(), loader:'ts' },bundle:true,platform:'node',format:'esm',outfile:`${out}/importer.mjs` })
}
const importer = await import(pathToFileURL(`${out}/importer.mjs`).href)
const sourcePath = process.argv[3] ?? 'C:/Users/Panda-Panta/Downloads/干员练度表.xlsx'
const source = readFileSync(sourcePath)
const imported = importer.parseYituliuXlsx(source)
const inventory = imported.entries
const admitted = importer.compileOperatorInventory(inventory)
if (!admitted.valid) throw new Error(JSON.stringify(admitted.diagnostics))
const previousRequest = existsSync(`${out}/243-request.json`) ? JSON.parse(readFileSync(`${out}/243-request.json`, 'utf8')) : null
const provenance = {sourcePath,sha256:createHash('sha256').update(source).digest('hex'),totalRows:imported.totalInFile,unowned:imported.unownedCount,uniqueOwned:inventory.length,
  eliteCounts:inventory.reduce((counts,e)=>(counts[e.elitePhase]=(counts[e.elitePhase]??0)+1,counts),{}),matchesBaselineInventory:previousRequest ? JSON.stringify(inventory)===JSON.stringify(previousRequest.inventory) : null}
writeFileSync(`${out}/inventory.json`,JSON.stringify(inventory,null,2))
writeFileSync(`${out}/import-verification.json`,JSON.stringify(provenance,null,2))
console.log(JSON.stringify(provenance))
if(label==='prepare') process.exit(0)
if (!selectedLayout) {
  await Promise.all(['243','252'].map(layout=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),label,sourcePath,layout],{stdio:'inherit',windowsHide:true})
    child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`${layout} exited ${code}`)))
  })))
  const summaries=['243','252'].map(layout=>JSON.parse(readFileSync(`${out}/${label}-${layout}-summary.json`,'utf8'))[0])
  writeFileSync(`${out}/${label}-summary.json`,JSON.stringify(summaries,null,2))
  process.exit(0)
}
const engine = await import(pathToFileURL(enginePath).href)
const summaries = []
for (const layout of [selectedLayout]) {
  const base = engine.createDefaultWorkspace()
  if (layout === '252') {
    base.mainPlan.facilities.room_3_3 = { roomId: 'room_3_3', type: 'manufacture', level: 3, product: 'exp', slots: Array.from({length:3}, () => ({occupant:{kind:'empty'},groupId:null,replacements:[]})) }
    base.mainPlan.facilities.room_3_1.level = 2
    base.mainPlan.facilities.room_3_1.slots.length = 2
    for (const room of Object.values(base.mainPlan.facilities)) if (['dormitory','contact','factory','train'].includes(room.type)) room.level = 1
  }
  const options = {seed:42,branchCount:10,simulationWarmupHours:24,simulationSampleHours:72,enableDeepSearch:true,droneTarget:'gold',searchBudget:24,refinementTopK:3}
  writeFileSync(`${out}/${label}-${layout}-request.json`, JSON.stringify({base,inventory,options,source:provenance}, null, 2))
  const started = performance.now()
  let last = 0
  const report = engine.runSmartRoster(base, inventory, options, p => {
    if (performance.now() - last > 10000 || p.phase === 'done') { console.log(JSON.stringify({label,layout,seconds:Math.round((performance.now()-started)/1000),phase:p.phase,message:p.label})); last=performance.now() }
  })
  const summary = {label,layout,elapsedSeconds:(performance.now()-started)/1000,status:report.status,score:report.score,candidates:report.phases.simulation?.candidates.length,search:report.phases.search ? {gain:report.phases.search.gain,improved:report.phases.search.improved} : null,refinements:report.phases.refinements,diagnostics:report.diagnostics}
  writeFileSync(`${out}/${label}-${layout}-report.json`,JSON.stringify(report))
  summaries.push(summary)
  writeFileSync(`${out}/${label}-${layout}-summary.json`,JSON.stringify(summaries,null,2))
  console.log(JSON.stringify(summary))
}
