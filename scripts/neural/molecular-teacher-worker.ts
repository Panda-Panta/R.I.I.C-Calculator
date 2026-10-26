import { prepareEnriched, enrichedTargetCoverage } from './molecular-training/enriched-input';
/** TEACHER-ONLY bounded molecular TRAIN producer. Not a full mathematical baseline. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkpointCandidate } from './molecular-training/candidate-checkpoint.mjs';
import { createHash } from 'node:crypto';
import { OPERATORS } from '../../src/domain/operators';
import { fullCatalogIdleInventory, compileOperatorInventory } from '../../src/domain/operatorInventory';
import { createDefaultWorkspace } from '../../src/workbench/defaults';
import { validatePhysicalRoster } from '../../src/optimizer/rosterDraft';
import { productionEfficiencyVector } from '../../src/optimizer/productionEfficiencyPriority';
import { compareWorkspacePreference } from '../../src/optimizer/automaticCombinationPreferences';
const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
export function prepare(seed: number, size: number, declared?: { familyId?: string; split?: string; layout?: string; stagePolicy?: string }) {
  if (declared?.layout && declared.layout !== 'empty-default243' || declared?.stagePolicy && declared.stagePolicy !== 'actual-mixture-v1') throw Error('Unsupported input policy');
  if (declared?.split && !['train', 'dev'].includes(declared.split)) throw Error('Unsupported input split');
  const cards = fullCatalogIdleInventory(), random = rng(seed), stages = rng((seed ^ 0x9e3779b9) >>> 0);
  if (!Number.isInteger(size) || size < 1 || size > cards.length) throw Error('Invalid inventory size');
  for (let i = cards.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [cards[i], cards[j]] = [cards[j]!, cards[i]!]; }
  const selected = cards.slice(0, size), proviso = OPERATORS.find(o => o.name === '但书')!.charId;
  if (!selected.some(o => o.operator === proviso)) selected[size - 1] = cards.find(o => o.operator === proviso)!;
  const entries = selected.map(e => { const roll = stages(); return roll < .5 ? { ...e, elitePhase: 0, level: 1 } : roll < .75 ? e : { ...e, elitePhase: Math.min(1, e.elitePhase), level: 1 }; }).sort((a,b) => a.operator < b.operator ? -1 : 1);
  const inventory = compileOperatorInventory(entries);
  if (!inventory.valid) throw Error(JSON.stringify(inventory.diagnostics));
  const optimizerSeed = (seed ^ 0x85ebca6b) >>> 0;
  return { schemaVersion: 2, sourceKind: 'molecular-simulated', purpose: 'training', familyId: declared?.familyId ?? `full-v2-dev-${seed}-${size}`, split: declared?.split ?? 'train', seed, size,
    seedRoots: { inventory: seed, stage: (seed ^ 0x9e3779b9) >>> 0, optimizer: optimizerSeed },
    stagePolicy: 'LCG32; 50% E0L1, 25% legal maximum, 25% min(E1, legal max) L1; proviso same draw policy',
    entries, inventoryHash: hash(entries), requiredProviso: entries.find(e => e.operator === proviso), workspace: createDefaultWorkspace(),
    options: { seed: optimizerSeed, branchCount: 3, enableDeepSearch: false, simulationWarmupHours: 24, simulationSampleHours: 72, droneTarget: 'gold' as const, productionWeights: { exp: 1, gold: .8, orders: .2, fragments: 0, orundum: 0 } },
    simulationDefaults: { schedulingModel: 'mower-alpha', outputMode: 'potential', runOrderMode: 'ideal', maxStepHours: .25, maxEvents: 200000, restingThreshold: .65, operationDurationHours: 0, initialMorale: 24, initialMoraleSource: 'compileRosterSchedule DEFAULTS.initialMorale; empty input has no per-operator overrides' } };
}
import { generateMolecularCandidates } from '../../src/optimizer/molecularSynthesis';
import { simulateCandidate } from '../../src/optimizer/candidateSimulation';
import { compareProductionEfficiencyVectors } from '../../src/optimizer/productionEfficiencyPriority';
import { normalizeProductionWeights } from '../../src/domain/productionWeights';
import { createFullScenario } from '../../src/optimizer/neural/fullActionSpace';
import { replayFullTeacher, fullSemanticWorkspace } from '../../src/optimizer/neural/fullTeacherTraces';
import { validatePolicy, selectQualified, auditTradingReferences } from './molecular-training/policy.mjs';
export function collect(input: any, durability?: { directory: string; sourceHash: string; bundleHash: string }) {
 validatePolicy(input);
 const start=performance.now(), inventory=compileOperatorInventory(input.entries), base=structuredClone(input.workspace);
 base.productionWeights=normalizeProductionWeights(input.options.productionWeights??base.productionWeights);
 if(!inventory.valid||validatePhysicalRoster(base).length)throw Error('Invalid original input');
 const assumptions={restingThreshold:.65,operationDurationHours:0};
 const scenario=createFullScenario(base,inventory,{simulationConditioning:{schedulerAssumptions:assumptions,droneTarget:input.options.droneTarget,warmupHours:24,sampleHours:72,maxStepHours:.25,seed:input.options.seed}});
 const branches=generateMolecularCandidates(base,input.entries,inventory,{branchCount:3,seed:input.options.seed,droneTarget:input.options.droneTarget});
 if(branches.length>3)throw Error('Producer exceeded declared branch cap');
 const candidates:any[]=[];
 for(const branch of branches){
  const workspace=branch.workspace,physical=validatePhysicalRoster(workspace),exclusions=auditTradingReferences(workspace),reasons:string[]=[];
  if(physical.length)reasons.push('PHYSICAL_INVALID');if(!exclusions.imitationPolicyCompatible)reasons.push('TRADING_POLICY_CONFLICT');
  if(workspace.compatibility.backupPlans.length)reasons.push('AUTOMATIC_BACKUP_PLANS_FORBIDDEN');
  const record:any={id:branch.id,targetCoverage:enrichedTargetCoverage(input,workspace,inventory),workspace,workspaceHash:hash(workspace),producerDiagnostics:branch.diagnostics,staticScore:Number.isFinite(branch.staticScore)?branch.staticScore:null,qualified:false,score:null,status:'rejected',physical,exclusions,reasons};
  candidates.push(record);
  if(!reasons.length){
   const options={warmupHours:24,sampleHours:72,maxStepHours:.25,productionWeights:normalizeProductionWeights(input.options.productionWeights??input.workspace.productionWeights),operatorInventory:input.entries,production:{outputMode:'potential' as const,runOrderMode:'ideal' as const,droneTarget:input.options.droneTarget,seed:input.options.seed}};
   record.simulationSettings={options,assumptions};
   const simulation=simulateCandidate({workspace,options,assumptions});
   record.simulation={...simulation,simScore:simulation.completed&&Number.isFinite(simulation.simScore)?simulation.simScore:null};
   if(!simulation.completed||!Number.isFinite(simulation.simScore)||!simulation.calculationReport)reasons.push('SIMULATION_INCOMPLETE');
   // Replay original effective input, never borrow auxiliary context from teacher.
   const replay=replayFullTeacher(scenario,workspace);
   record.replay={complete:replay.complete,exactReplay:replay.exactReplay,diagnostics:replay.diagnostics};
   if(!scenario.valid||!replay.complete||!replay.exactReplay||replay.diagnostics.length)reasons.push('UNSUPPORTED_EXACT_REPLAY');
   record.score=simulation.completed&&Number.isFinite(simulation.simScore)?simulation.simScore:null;
   record.efficiencyVector=productionEfficiencyVector(workspace,inventory);
   record.qualified=!reasons.length;record.status=record.qualified?'qualified':'rejected';
   if(record.qualified){record.actionIds=replay.trace.map(t=>t.action.id);record.teacherSemanticHash=hash(fullSemanticWorkspace(scenario,workspace));}
  }
  if(durability)checkpointCandidate(join(durability.directory,`candidate-${candidates.length}.json`),{inputHash:hash(input),sourceHash:durability.sourceHash,bundleHash:durability.bundleHash},record,candidates.length-1,branches.length);
  process.stderr.write(JSON.stringify({event:'candidate-finished',id:record.id,status:record.status,score:record.score,reasons,elapsedMs:performance.now()-start})+'\n');
 }
 const selected=selectQualified(candidates,(a:any,b:any)=>compareWorkspacePreference(a.workspace,b.workspace),(a:any,b:any)=>compareProductionEfficiencyVectors(a.efficiencyVector,b.efficiencyVector));
 return {sourceKind:'molecular-simulated',purpose:'training',inputProfile:input.inputProfile??'actual-mixture-v1',layoutTag:input.layoutTag??'empty-default243',targetCoverage:selected?.targetCoverage??null,baselineEligible:false,completed:!!selected,score:selected?.score??null,comparisonComplete:true,attemptedCandidates:candidates.length,totalCandidates:branches.length,branchCount:3,enableDeepSearch:false,selectedId:selected?.id??null,selectedReason:selected?'qualified candidates ordered by workspace preference, production efficiency vector, actual simulated score; stable producer order on tie':'no qualified candidate; no resampling or fallback',candidates,
 result:{status:selected?'draft':'unqualified',workspace:selected?.workspace??null,score:selected?.score??null,calculationReport:selected?.simulation.calculationReport??null},validation:{physical:selected?.physical??null,exactReplay:selected?.replay??null},degradedBaseline:false,elapsedMs:performance.now()-start};
}
if(!process.argv.includes('--library'))try{const input=JSON.parse(readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(process.argv.includes('--prepare-enriched')?prepareEnriched(input.index,prepare):process.argv.includes('--prepare')?prepare(input.seed,input.size,input):collect(input,process.argv.includes('--candidate-evidence')?JSON.parse(process.argv[process.argv.indexOf('--candidate-evidence')+1]!):undefined),(_k,v)=>typeof v==='number'&&!Number.isFinite(v)?{$nonfinite:String(v)}:v));}catch(error){process.stderr.write(JSON.stringify({event:'worker-error',error:String(error),stack:error instanceof Error?error.stack:null})+'\n');process.exitCode=1;}
