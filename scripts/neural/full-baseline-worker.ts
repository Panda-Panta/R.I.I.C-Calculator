/** Whole, unmodified smart-roster teacher. Never used for neural decoding. */
import { readFileSync } from 'node:fs';
import { referenceProtocol, resolveReferenceProtocol, HISTORICAL_REFERENCE, LATEST_DATA_VERSION } from './full-baseline/reference-protocol.mjs';
import { createHash } from 'node:crypto';
import { OPERATORS } from '../../src/domain/operators';
import { fullCatalogIdleInventory, compileOperatorInventory } from '../../src/domain/operatorInventory';
import { createDefaultWorkspace } from '../../src/workbench/defaults';
import { runSmartRoster } from '../../src/optimizer/smartRoster';
import { validatePhysicalRoster } from '../../src/optimizer/rosterDraft';
import { productionEfficiencyVector } from '../../src/optimizer/productionEfficiencyPriority';
import { compareWorkspacePreference } from '../../src/optimizer/automaticCombinationPreferences';
const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
export function prepare(seed: number, size: number, declared?: { familyId?: string; split?: string; layout?: string; stagePolicy?: string; referenceProtocolId?: string }) {
  if (declared?.layout && declared.layout !== 'empty-default243' || declared?.stagePolicy && declared.stagePolicy !== 'actual-mixture-v1') throw Error('Unsupported input policy');
  if (declared?.split && !['train', 'dev'].includes(declared.split)) throw Error('Unsupported input split');
  const protocol = referenceProtocol(declared?.referenceProtocolId);
  if (protocol.id === HISTORICAL_REFERENCE) throw Error('Historical teachers can only resume their original frozen bundles');
  const cards = fullCatalogIdleInventory(), random = rng(seed), stages = rng((seed ^ 0x9e3779b9) >>> 0);
  if (!Number.isInteger(size) || size < 1 || size > cards.length) throw Error('Invalid inventory size');
  for (let i = cards.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [cards[i], cards[j]] = [cards[j]!, cards[i]!]; }
  const selected = cards.slice(0, size), proviso = OPERATORS.find(o => o.name === '但书')!.charId;
  if (!selected.some(o => o.operator === proviso)) selected[size - 1] = cards.find(o => o.operator === proviso)!;
  const entries = selected.map(e => { const roll = stages(); return roll < .5 ? { ...e, elitePhase: 0, level: 1 } : roll < .75 ? e : { ...e, elitePhase: Math.min(1, e.elitePhase), level: 1 }; }).sort((a,b) => a.operator < b.operator ? -1 : 1);
  const inventory = compileOperatorInventory(entries);
  if (!inventory.valid) throw Error(JSON.stringify(inventory.diagnostics));
  const optimizerSeed = (seed ^ 0x85ebca6b) >>> 0;
  return { schemaVersion: 3, dataVersion: LATEST_DATA_VERSION, referenceProtocol: protocol, familyId: declared?.familyId ?? `latest-full-v3-dev-${seed}-${size}`, split: declared?.split ?? 'dev', seed, size,
    seedRoots: { inventory: seed, stage: (seed ^ 0x9e3779b9) >>> 0, optimizer: optimizerSeed },
    stagePolicy: 'LCG32; 50% E0L1, 25% legal maximum, 25% min(E1, legal max) L1; proviso same draw policy',
    entries, inventoryHash: hash(entries), requiredProviso: entries.find(e => e.operator === proviso), workspace: createDefaultWorkspace(),
    options: { seed: optimizerSeed, enableDeepSearch: protocol.deepSearch, simulationWarmupHours: 24, simulationSampleHours: 72, droneTarget: 'gold' as const, productionWeights: { exp: 1, gold: .8, orders: .2, fragments: 0, orundum: 0 } },
    simulationDefaults: { schedulingModel: 'mower-alpha', outputMode: 'potential', runOrderMode: 'ideal', maxStepHours: .25, maxEvents: 200000, restingThreshold: .65, operationDurationHours: 0, initialMorale: 24, initialMoraleSource: 'compileRosterSchedule DEFAULTS.initialMorale; empty input has no per-operator overrides' } };
}
try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (process.argv.includes('--prepare')) process.stdout.write(JSON.stringify(prepare(input.seed, input.size, input)));
  else {
    const protocol = resolveReferenceProtocol(input);
    if (protocol.id === HISTORICAL_REFERENCE) throw Error('Current worker cannot relabel latest optimizer as historical reference');
    const started = performance.now(), cpu = process.cpuUsage();
    process.stderr.write(JSON.stringify({ event: 'started', utc: new Date().toISOString(), inputHash: hash(input), pid: process.pid }) + '\n');
    const result = runSmartRoster(structuredClone(input.workspace), input.entries, input.options, progress => process.stderr.write(JSON.stringify({ event: 'optimizer-progress', elapsedMs: performance.now() - started, progress }) + '\n'));
    const physical = result.workspace ? validatePhysicalRoster(result.workspace) : null;
    const completed = result.status === 'draft' && result.workspace !== null && Number.isFinite(result.score) && physical?.length === 0 && !!result.calculationReport;
    const envelope = { sourceKind: 'full-optimizer', dataVersion: LATEST_DATA_VERSION, referenceProtocol: protocol, requestOptionsHash: hash(input.options), completed, score: completed ? result.score : null, result, validation: { physical, inventory: compileOperatorInventory(input.entries).diagnostics, fullSemanticReplay: 'pending-full-v2-replay-not-projected-to-singletons' },
      preference: { versusEmptyInput: result.workspace ? compareWorkspacePreference(result.workspace, input.workspace) : null, authoritativeWorkspacePreserved: true },
      efficiencyVector: result.workspace ? productionEfficiencyVector(result.workspace, compileOperatorInventory(input.entries)).map(n => Number.isFinite(n) ? n : String(n)) : null,
      degradedBaseline: result.diagnostics.some(d => d.code === 'SEARCH_FALLBACK'), dynamicCalls: { status: 'not-instrumented', count: null, reason: 'public progress omits synchronous ordering/replacement/final jobs; not inferred from progress' },
      elapsedMs: performance.now() - started, cpuUsage: process.cpuUsage(cpu), resourceUsage: process.resourceUsage() };
    process.stdout.write(JSON.stringify(envelope, (_k, v) => typeof v === 'number' && !Number.isFinite(v) ? { $nonfinite: String(v) } : v));
  }
} catch (error) { process.stderr.write(JSON.stringify({ event: 'worker-error', error: String(error), stack: error instanceof Error ? error.stack : null }) + '\n'); process.exitCode = 1; }
