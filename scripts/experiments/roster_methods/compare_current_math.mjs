// Compare the shipped computed manufacturing model with its original candidate
// and caller-side full-F retention policy. No app or frozen adapter is modified.
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const seeds = [42, 20261028, 1198905590, 20260920]
const defaultInputs = [
  'artifacts/roster-method-native-probe-20261028-full/evaluation-00001-input.json',
  'artifacts/roster-method-native-probe-20261028-full/evaluation-00002-input.json',
  'artifacts/roster-method-native-probe-20261028-full/evaluation-00003-input.json',
  'artifacts/roster-method-native-probe-20261028-joint/evaluation-00001-input.json',
]
const log = message => process.stderr.write(`[current-math] ${message}\n`)
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2))

function parseArguments(argv) {
  const args = { inputs: [] }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index], value = argv[++index]
    if (!['--node-modules', '--out', '--input', '--comparison', '--contender-history'].includes(flag) || !value || value.startsWith('--')) throw new Error(`Invalid option ${flag}`)
    if (flag === '--input') args.inputs.push(resolve(value))
    else args[flag.slice(2)] = resolve(value)
  }
  if (!args.out || !args['node-modules']) throw new Error('Usage: node compare_current_math.mjs --node-modules PATH --out NEW_DIRECTORY [--input INPUT ...]')
  if (existsSync(args.out)) throw new Error(`Refusing to overwrite ${args.out}`)
  if (!args.inputs.length) args.inputs = defaultInputs.map(path => resolve(root, path))
  return args
}

async function bundle(args) {
  const require = createRequire(pathToFileURL(resolve(args['node-modules'], '../package.json')))
  const { build, version } = require(require.resolve('esbuild', { paths: [require.resolve('vite')] }))
  const packagePath = require.resolve('pinyin-pro/package.json')
  const packageInfo = JSON.parse(readFileSync(packagePath, 'utf8'))
  const pinyinEntry = resolve(dirname(packagePath), packageInfo.exports['.'].import.default)
  const modules = [
    'optimizer/computedManufacturingRoster', 'optimizer/manufacturingCrewDomain',
    'optimizer/rosterDraft', 'optimizer/recoveryGroupCapacity', 'optimizer/combinationIntegrity',
    'domain/operatorInventory', 'workbench/scheduleSimulationBridge', 'optimizer/incomeComparison',
    'simulator/productionScore',
  ]
  const captured = new Map(), enginePath = resolve(args.out, 'current-math-engine.mjs')
  const result = await build({
    absWorkingDir: root,
    stdin: { contents: modules.map(path => `export * from './src/${path}';`).join('\n'), resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', outfile: enginePath,
    metafile: true, nodePaths: [args['node-modules']], alias: { 'pinyin-pro': pinyinEntry }, logLevel: 'silent',
    plugins: [{ name: 'hash-unmodified-source', setup(builder) {
      builder.onLoad({ filter: /\.(?:[cm]?js|tsx?|json)$/ }, input => {
        const bytes = readFileSync(input.path)
        captured.set(resolve(input.path), hash(bytes))
        const loader = input.path.endsWith('.json') ? 'json' : input.path.endsWith('.tsx') ? 'tsx'
          : input.path.endsWith('.ts') ? 'ts' : 'js'
        return { contents: bytes.toString('utf8'), loader, resolveDir: dirname(input.path) }
      })
    } }],
  })
  const inputs = Object.keys(result.metafile.inputs).filter(path => path !== '<stdin>').map(path => {
    const absolute = resolve(root, path), sha256 = captured.get(absolute)
    if (!sha256 || sha256 !== hash(readFileSync(absolute))) throw new Error(`Source changed while bundling: ${absolute}`)
    return { path: relative(root, absolute).replaceAll('\\', '/'), sha256 }
  }).sort((a, b) => a.path.localeCompare(b.path))
  const manifest = { sourceRoot: root, sourceSha256: hash(JSON.stringify(inputs)), inputs,
    bundleSha256: hash(readFileSync(enginePath)), toolSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    nodeVersion: process.version, esbuildVersion: version,
    transformations: ['No source-text transformation. Temporary stdin entry exports existing source modules.',
      'Installed pinyin-pro ESM entry resolved through Node to avoid Windows cross-directory pnpm symlink traversal.'],
    modelOptions: args.comparison ? 'Attribution mode reuses the recorded original math result without changing or rerunning it.'
      : 'Only onProgress callback supplied; all original enumeration, valuation, assignment and 24/72 horizon defaults retained.',
    seeds, selectionPolicy: 'Choose max valid F(initial, computed) at seed42, then freeze that candidate for the three replication seeds. Per-seed maxima are separate diagnostics.',
  }
  write(resolve(args.out, 'source-manifest.json'), manifest)
  return { engine: await import(pathToFileURL(enginePath).href), manifest }
}

function makeInput(engine, recorded) {
  if (!recorded.workspace || !Array.isArray(recorded.options?.operatorInventory)) throw new Error('Missing recorded workspace or actual inventory')
  if (recorded.options.warmupHours !== 24 || recorded.options.sampleHours !== 72) throw new Error('The comparison requires the recorded full 24/72 horizon')
  const initial = structuredClone(recorded.workspace), userBase = structuredClone(initial)
  // These are constructed fixtures, with no user lock declarations. Keep the
  // layout, fixed dorm residents and config, but do not mislabel generated
  // workplace occupants as user locks. The original model still determines all
  // fixed outside actors, formed cores, variants and unsupported frozen blocks.
  for (const room of Object.values(userBase.mainPlan.facilities)) {
    if (room.type === 'dormitory') continue
    room.slots = room.slots.map(slot => ({ ...slot, occupant: { kind: 'empty' },
      groupId: null, replacements: [], ...(slot.groupBindings ? { groupBindings: [] } : {}) }))
  }
  const entries = structuredClone(recorded.options.operatorInventory)
  const inventory = engine.compileOperatorInventory(entries)
  if (!inventory.valid) throw new Error(JSON.stringify(inventory.diagnostics))
  return { input: { userBase, initial, inventory, lockedPositions: new Set(), lockedOperators: new Set() }, entries }
}

function domainEvidence(engine, input) {
  const prepared = engine.prepareManufacturingCrewDomain(input), domain = prepared.domain
  return { status: prepared.status, frozenComponents: prepared.frozenComponents, diagnostics: prepared.diagnostics,
    userLocks: { positions: [...input.lockedPositions], operators: [...input.lockedOperators] },
    userCores: engine.formedCombinations(input.userBase, input.inventory),
    initialCores: engine.formedCombinations(input.initial, input.inventory),
    domain: domain ? { rooms: domain.rooms, groups: domain.groups,
      fixedOperatorIds: [...domain.fixedOperatorIds], ownedOperatorIds: [...domain.ownedOperatorIds],
      coreIds: domain.coreIds, requiredCores: domain.requiredCores, initialColumns: domain.initialColumns,
      scope: 'Original supported manufacturing crew domain, not the experiments\' 96-vector decision space.' } : null,
  }
}

function evaluate(engine, workspace, recorded, seed, target) {
  if (!workspace) return null
  const started = performance.now()
  const options = { ...structuredClone(recorded.options), warmupHours: 24, sampleHours: 72,
    production: { ...structuredClone(recorded.options.production), seed }, recordSegments: false }
  const assumptions = structuredClone(recorded.assumptions ?? {})
  const structural = [...engine.validatePhysicalRoster(workspace), ...engine.recoveryGroupCapacityIssues(workspace)]
  const request = { workspace, options, assumptions }
  write(`${target}-input.json`, request)
  const response = structural.length ? { report: null, error: structural.map(issue => `${issue.code}: ${issue.message}`).join('; ') }
    : engine.runScheduleSimulationBridge(workspace, options, assumptions)
  const report = response.report, integrity = report ? engine.summarizeIncome(report) : null
  const valid = !!integrity?.eligible
  const score = valid ? engine.scoreSimulationProduction(report) : null
  if (report) write(`${target}-report.json`, report)
  const result = { seed, valid, F: score?.total ?? null, score, integrity,
    issues: [...(response.error ? [response.error] : []), ...(integrity?.issues ?? [])],
    elapsedMs: performance.now() - started,
    observedHours: report?.observedHours ?? null, elapsedHours: report?.elapsedHours ?? null,
    inputSha256: hash(JSON.stringify(request)),
    evidence: { input: `${target}-input.json`, report: report ? `${target}-report.json` : null },
  }
  write(`${target}-summary.json`, result)
  return result
}

function best(initial, computed) {
  if (!initial?.valid && !computed?.valid) return { candidate: null, F: null }
  if (computed?.valid && (!initial?.valid || computed.F > initial.F)) return { candidate: 'computed', F: computed.F }
  return { candidate: 'initial', F: initial.F }
}

function number(value) { return value === null || value === undefined ? '—' : Number(value).toFixed(6) }

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value)
}

function fieldDifferences(before, after, path = '') {
  if (canonical(before) === canonical(after)) return []
  if (before !== null && after !== null && typeof before === 'object' && typeof after === 'object') {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    return keys.flatMap(key => fieldDifferences(before[key], after[key], `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`))
  }
  return [{ path, kind: before === undefined ? 'added' : after === undefined ? 'removed' : 'changed',
    before: before === undefined ? null : before, after: after === undefined ? null : after }]
}

async function attribution(args) {
  if (!args.comparison || !args['contender-history']) throw new Error('Attribution requires --comparison BASELINE_DIRECTORY and --contender-history FROZEN_METHOD_HISTORY')
  const comparison = JSON.parse(readFileSync(resolve(args.comparison, 'comparison.json'), 'utf8'))
  const oldRow = comparison.rows.find(row => row.scene_id === 'native-joint-base')
  if (!oldRow?.computedOffered) throw new Error('The recorded joint original-model candidate is unavailable')
  const oldPath = resolve(args.comparison, 'native-joint-base/original-computation.json')
  const oldWorkspace = JSON.parse(readFileSync(oldPath, 'utf8')).workspace
  const recorded = JSON.parse(readFileSync(oldRow.sourceInput, 'utf8'))
  const method = JSON.parse(readFileSync(args['contender-history'], 'utf8'))
  const vector = method.result.best_vector
  const observation = method.history.find(row => row.valid && row.fidelity === 'full' && row.seed === 42 && canonical(row.vector) === canonical(vector))
  if (!observation?.evidence?.input) throw new Error('Frozen selected vector has no queried full-F input evidence')
  const contenderBytes = readFileSync(observation.evidence.input)
  if (observation.evidence.input_sha256 && hash(contenderBytes) !== observation.evidence.input_sha256) throw new Error('Contender input receipt hash does not match')
  const contender = JSON.parse(contenderBytes.toString('utf8'))
  if (contender.scene_id !== 'native-joint-base') throw new Error('Contender belongs to a different scene')
  if (canonical(contender.options) !== canonical(recorded.options) || canonical(contender.assumptions) !== canonical(recorded.assumptions)) {
    throw new Error('Frozen candidate and baseline do not share identical full-F options, actual inventory and assumptions')
  }
  mkdirSync(args.out, { recursive: true })
  const { engine, manifest } = await bundle(args)
  const differences = fieldDifferences(oldWorkspace, contender.workspace)
  write(resolve(args.out, 'workspace-field-differences.json'), differences)
  const experimentRoom = 'room_2_1'
  const oldPlusExp = structuredClone(oldWorkspace)
  oldPlusExp.mainPlan.facilities[experimentRoom].slots = structuredClone(contender.workspace.mainPlan.facilities[experimentRoom].slots)
  const contenderOldExp = structuredClone(contender.workspace)
  contenderOldExp.mainPlan.facilities[experimentRoom].slots = structuredClone(oldWorkspace.mainPlan.facilities[experimentRoom].slots)
  const variants = { original_math: oldWorkspace, frozen_m01: contender.workspace,
    original_math_plus_m01_exp: oldPlusExp, frozen_m01_with_original_exp: contenderOldExp }
  const results = {}
  for (const [label, workspace] of Object.entries(variants)) {
    log(`Attribution: ${label}, fixed seed42 full F`)
    results[label] = evaluate(engine, workspace, recorded, 42, resolve(args.out, label))
    if (!results[label].valid) throw new Error(`Controlled candidate ${label} did not complete full F`)
  }
  const tolerance = 1e-7
  if (Math.abs(results.original_math.F - oldRow.evaluations[0].computed.F) > tolerance ||
      Math.abs(results.frozen_m01.F - observation.score) > tolerance) throw new Error('Reference full-F replay changed')
  const gain = results.frozen_m01.F - results.original_math.F
  const forwardGain = results.original_math_plus_m01_exp.F - results.original_math.F
  const reverseGain = results.frozen_m01.F - results.frozen_m01_with_original_exp.F
  const attributable = Math.abs(forwardGain - gain) <= tolerance && Math.abs(reverseGain - gain) <= tolerance
  const output = { manifest, scene_id: 'native-joint-base', selected_vector: vector,
    baselineComparison: resolve(args.comparison, 'comparison.json'), contenderHistory: args['contender-history'],
    contenderInput: observation.evidence.input, contenderInputSha256: hash(contenderBytes),
    originalComputedWorkspaceSha256: hash(JSON.stringify(oldWorkspace)),
    frozenContenderWorkspaceSha256: hash(JSON.stringify(contender.workspace)),
    optionsIdentical: true, actualInventoryIdentical: true, assumptionsIdentical: true,
    differences, originalDomain: oldRow.domain.domain,
    originalFrozenComponents: oldRow.calculation.frozenComponents,
    controlledChanges: {
      forward: fieldDifferences(oldWorkspace, oldPlusExp),
      reverse: fieldDifferences(contender.workspace, contenderOldExp),
    },
    results, gain, gainPercent: gain / results.original_math.F * 100, forwardGain, reverseGain,
    gainAttributedToFrozenExpRoomInThisRun: attributable,
    interpretation: attributable
      ? 'At this source/window/seed, replacing only the frozen EXP group reproduces the entire gain in both directions. This is a search-domain/support extension, not evidence of G/F reversal within the original supported manufacturing domain.'
      : 'The two controlled replacements do not explain the full difference; no single-source attribution is claimed.',
    scope: 'Four directly replayed full-F conditions on one fixture at seed42; no broad benefit or mathematical-optimality claim.' }
  write(resolve(args.out, 'attribution.json'), output)
  const lines = ['# 联合场景333.33差异归因', '',
    '先前四场景、四种子的原始对照保持原样。本轮从方法01实际查询history的回执读取已冻结方案，未重新选优，也没有读取SQL。库存、F配置、假设逐字段一致；以原仿真器重新执行两基准及两个最小受控替换。', '',
    '| 条件 | F42 | 经验/日 | 订单面值LMD/日 | 金条/日 |', '| --- | ---: | ---: | ---: | ---: |']
  for (const [label, value] of Object.entries(results)) lines.push(`| ${label} | ${number(value.F)} | ${number(value.score.exp)} | ${number(value.score.orderValue)} | ${number(value.score.goldValue / 500)} |`)
  lines.push('', `总差异：${number(gain)}，相对原程序保留解约${output.gainPercent.toFixed(4)}%。正向仅换经验组：${number(forwardGain)}；反向还原经验组：${number(reverseGain)}。`, '',
    `判定：${output.interpretation}`, '',
    `旧模型冻结块：${JSON.stringify(output.originalFrozenComponents)}；其支持计算房间：${JSON.stringify(output.originalDomain.rooms)}。`, '',
    '完整差异保存于workspace-field-differences.json；两组策略的配置、贸易、发电和宿舍未改变。金条组的人员顺序/普通替班也有差异，但不能将这些差异直接归为产出改善；两次受控替换给出本窗口内的实际作用。', '',
    '本实验只覆盖一个构造库存与固定seed42；它不证明当前数学方法在自身域中找错最优解，不证明一般G/F排序反转，也不能外推到正常满员243或玩家基地。', '',
    `输入回执SHA256：${output.contenderInputSha256}；本轮源码集合SHA256：${manifest.sourceSha256}。`)
  writeFileSync(resolve(args.out, 'REPORT.md'), lines.join('\n') + '\n')
  for (const input of manifest.inputs) if (input.sha256 !== hash(readFileSync(resolve(root, input.path)))) throw new Error(`Source changed during attribution: ${input.path}`)
  console.log(JSON.stringify({ scene_id: output.scene_id, original_math_F42: results.original_math.F,
    frozen_m01_F42: results.frozen_m01.F, gain, gain_percent: output.gainPercent,
    forward_exp_only_gain: forwardGain, reverse_exp_only_gain: reverseGain, frozen_exp_attribution: attributable }))
}

function reportMarkdown(rows, manifest) {
  const lines = [
    '# 当前制造数学模型同条件对照', '',
    '调用当前源码的computeManufacturingRoster，保留所有默认预算及24小时预热＋72小时采样。输入复用先前原生记录，实际库存、设施及配置不变；构造场景没有用户锁，userBase与生成initial明确分开。', '',
    'G只属于原有有限制造周期模型；F是同一全排班仿真器和共享产出计分。无效/未完成均为null；unsupported/冻结不会伪装成零收益。', '',
    '| 场景 | 数学状态 | G初始 | G指派 | F42初始 | F42计算解 | F42原程序保留 | search42后固定候选 |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
  ]
  for (const row of rows) lines.push(`| ${row.scene_id} | ${row.calculation.status} | ${number(row.calculation.initialObjective)} | ${number(row.calculation.assignment?.objective)} | ${number(row.evaluations[0].initial.F)} | ${number(row.evaluations[0].computed?.F)} | ${number(row.searchDecision.F)} | ${row.searchDecision.candidate ?? '无有效候选'} |`)
  lines.push('', '三次复验只评价search42已固定的原程序保留候选；以下不是按复验种子重新选优。另将逐种子max保留作单独诊断记录于JSON，不能作为无选择偏差的冻结策略复验。', '',
    '| 场景 | 固定候选F@20261028 | F@1198905590 | F@20260920 | 有效复验均值 |',
    '| --- | ---: | ---: | ---: | ---: |')
  for (const row of rows) lines.push(`| ${row.scene_id} | ${row.replications.map(value => number(value.F)).join(' | ')} | ${number(row.replicationMean)} |`)
  for (const row of rows) {
    lines.push('', `## ${row.scene_id}`, '', `初始输入SHA256：${row.inputSha256}。`, '',
      `原模型冻结块：${JSON.stringify(row.calculation.frozenComponents)}。`, '',
      `原模型诊断：${JSON.stringify(row.diagnostics)}。`, '',
      `枚举完整：${row.calculation.libraryComplete}；列数：${row.calculation.columnCount}；已量化列数：${row.calculation.quantifiedColumnCount}；返回新workspace：${row.computedOffered}。`, '',
      '原数学模型搜索域与实验离散域不保证互相包含；冻结/unsupported说明模型支持范围，不能据此宣称数学优化理论被击败。')
  }
  lines.push('', `源码输入集合SHA256：${manifest.sourceSha256}。`, '',
    '仅证明固定构造库存、源码、仿真窗口与权重下的程序行为，不是玩家库存、真实游戏或无限期日产出的证据。')
  return lines.join('\n') + '\n'
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  if (args.comparison || args['contender-history']) return attribution(args)
  const originals = args.inputs.map(path => ({ path, bytes: readFileSync(path) }))
  mkdirSync(args.out, { recursive: true })
  const { engine, manifest } = await bundle(args)
  const rows = []
  for (const source of originals) {
    const recorded = JSON.parse(source.bytes.toString('utf8'))
    const folder = resolve(args.out, recorded.scene_id)
    mkdirSync(folder)
    const { input, entries } = makeInput(engine, recorded)
    const initialBytes = JSON.stringify(input.initial)
    write(resolve(folder, 'comparison-input.json'), { userBase: input.userBase, initial: input.initial,
      entries, lockedPositions: [], lockedOperators: [], sourceInput: source.path,
      transformation: 'Clear generated non-dorm occupants/replacements/group IDs only in the separate userBase; retain original initial and all actual inventory/config/room data.' })
    const domain = domainEvidence(engine, input)
    write(resolve(folder, 'original-model-domain.json'), domain)
    log(`${recorded.scene_id}: computing original model with default budgets`)
    const started = performance.now(), cpuStarted = process.cpuUsage()
    const computed = engine.computeManufacturingRoster(input, { onProgress: label => log(`${recorded.scene_id}: ${label}`) })
    const cpu = process.cpuUsage(cpuStarted)
    if (JSON.stringify(input.initial) !== initialBytes) throw new Error('The original calculation mutated its initial input')
    write(resolve(folder, 'original-computation.json'), computed)
    const evaluations = []
    for (const seed of seeds) {
      log(`${recorded.scene_id}: full F seed ${seed}, initial${computed.workspace ? ' and computed' : ' only'}`)
      const initial = evaluate(engine, input.initial, recorded, seed, resolve(folder, `initial-${seed}`))
      const candidate = evaluate(engine, computed.workspace, recorded, seed, resolve(folder, `computed-${seed}`))
      evaluations.push({ seed, initial, computed: candidate, perSeedMaximum: best(initial, candidate) })
    }
    const searchDecision = best(evaluations[0].initial, evaluations[0].computed)
    const replications = evaluations.slice(1).map(value => ({ seed: value.seed,
      candidate: searchDecision.candidate,
      F: searchDecision.candidate ? value[searchDecision.candidate]?.F ?? null : null,
      valid: searchDecision.candidate ? !!value[searchDecision.candidate]?.valid : false }))
    const eligible = replications.filter(value => value.valid).map(value => value.F)
    const row = { scene_id: recorded.scene_id, sourceInput: source.path, inputSha256: hash(source.bytes),
      inventorySha256: hash(JSON.stringify(entries)), initialWorkspaceSha256: hash(initialBytes),
      userBaseSha256: hash(JSON.stringify(input.userBase)), calculation: computed.calculation,
      computedOffered: !!computed.workspace, diagnostics: computed.diagnostics, domain,
      elapsedMs: performance.now() - started, calculationCpuMicros: cpu.user + cpu.system,
      evaluations, searchDecision, replications,
      replicationMean: eligible.length === 3 ? eligible.reduce((sum, value) => sum + value, 0) / 3 : null,
      evidenceScope: 'Default original math G, common full F, constructed actual-stage inventory; frozen search42 selection on held-out seeds.' }
    rows.push(row)
    write(resolve(folder, 'comparison.json'), row)
    write(resolve(args.out, 'comparison.json'), { manifest, rows })
    writeFileSync(resolve(args.out, 'REPORT.md'), reportMarkdown(rows, manifest))
    console.log(JSON.stringify({ scene_id: row.scene_id, math_status: row.calculation.status,
      computed_offered: row.computedOffered, initial_F42: evaluations[0].initial.F,
      computed_F42: evaluations[0].computed?.F ?? null, retained_F42: searchDecision.F,
      fixed_replication_mean: row.replicationMean }))
  }
  for (const source of originals) if (hash(source.bytes) !== hash(readFileSync(source.path))) throw new Error(`Original evidence input changed: ${source.path}`)
  for (const input of manifest.inputs) if (input.sha256 !== hash(readFileSync(resolve(root, input.path)))) throw new Error(`Frozen source changed during comparison: ${input.path}`)
  write(resolve(args.out, 'integrity.json'), { sourceInputsUnchanged: true, originalInputsUnchanged: true,
    sourceSha256: manifest.sourceSha256, originalInputs: originals.map(source => ({ path: source.path, sha256: hash(source.bytes) })) })
}

main().catch(error => { log(error.stack ?? String(error)); process.exitCode = 1 })
