import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifyEnvelope, digest } from '../full-training/state.mjs';
const latest = { id: 'latest-default-two-stage-v1', revision: 1, construction: 'one-initial-plus-computed-manufacturing', ranking: 'finite-score-first-preference-efficiency-ties', warmupPolicy: 'generated-warmup-exhaustion-v1', recoveryPolicy: 'generated-recovery-v1', deepSearch: false, modelBudgetPolicy: 'exact-frozen-upstream-defaults', modelProofScope: 'quantified-manufacturing-model-only' };
function fixture() {
 const workspace={mainPlan:{fixture:true}}, referenceProtocol=structuredClone(latest), input={split:'dev', dataVersion:'latest-math-v3', referenceProtocol, options:{seed:42,enableDeepSearch:false,simulationWarmupHours:24,simulationSampleHours:72,droneTarget:'gold',productionWeights:{exp:1,gold:.8,orders:.2,fragments:0,orundum:0}}};
 const candidate={id:'initial',workspace,simScore:0}, result={status:'draft',score:0,workspace,calculationReport:{fixture:true},phases:{calculation:{status:'limited',proofScope:'quantified-manufacturing-model-only'},static:{candidates:[candidate]},simulation:{candidates:[candidate],bestScore:0},search:null}};
 const outcome={status:'completed',completed:true,score:0,result:{completed:true,score:0,referenceProtocol:structuredClone(referenceProtocol),requestOptionsHash:digest(input.options),result,validation:{physical:[]}}};
 return {input,outcome};
}
test('latest default finite-score reference qualifies independently of historical branch10/deeptrue',()=>{
 const {input,outcome}=fixture(); const q=qualifyEnvelope(input,outcome,'dev-overfit'); assert.equal(q.qualified,true,JSON.stringify(q));assert.deepEqual(q.referenceProtocol,latest);
});
test('latest reference rejects relabeled legacy settings, missing request/policy/phase evidence and non-winning workspace',()=>{
 for(const change of [x=>x.input.options.branchCount=10,x=>x.input.options.enableDeepSearch=true,x=>delete x.outcome.result.referenceProtocol,x=>x.outcome.result.requestOptionsHash='other',x=>x.input.referenceProtocol.warmupPolicy='none',x=>delete x.outcome.result.result.phases.calculation,x=>x.outcome.result.result.phases.search={},x=>x.outcome.result.result.phases.simulation.candidates[0].simScore=1,x=>x.outcome.result.result.workspace={changed:true}]){
  const x=fixture();change(x);assert.equal(qualifyEnvelope(x.input,x.outcome,'dev-overfit').qualified,false);
 }
});
test('no explicit latest identity never turns deepfalse output into historical full teacher',()=>{const x=fixture();delete x.input.referenceProtocol;delete x.outcome.result.referenceProtocol;assert.equal(qualifyEnvelope(x.input,x.outcome,'dev-overfit').qualified,false);});
test('default and enhanced protocols cannot be mixed, while model limits remain honest default evidence',async()=>{
 const {referenceProtocol,resolveReferenceProtocol,referenceManifestContract}=await import('./reference-protocol.mjs');
 assert.deepEqual(referenceProtocol('latest-default-two-stage-v1'),latest);
 const x=fixture();assert.equal(resolveReferenceProtocol(x.input).id,latest.id);
 assert.throws(()=>referenceProtocol('anything'));
 const enhanced=referenceProtocol('latest-enhanced-deep-v1');assert.equal(enhanced.deepSearch,true);assert.notEqual(digest(enhanced),digest(latest));
 assert.throws(()=>referenceManifestContract({referenceProtocol:enhanced},[x.input]),/protocol/);
});
test('full dataset metadata rejects protocol mixing and dropped latest record identity',async()=>{
 const {assertFullBaselineDataset}=await import('../full-training/evaluate.mjs');const {input}=fixture();
 const data={records:[{input,referenceProtocol:latest}],referenceProtocols:[latest]};assert.doesNotThrow(()=>assertFullBaselineDataset(data,{}));
 assert.throws(()=>assertFullBaselineDataset({...data,referenceProtocols:[]},{}),/reference protocol/);
 assert.throws(()=>assertFullBaselineDataset({...data,records:[...data.records,{input:{options:{branchCount:10,enableDeepSearch:true,simulationWarmupHours:24,simulationSampleHours:72}}}]},{}),/reference protocol/);
});
test('baseline reuse never crosses declared reference populations even with identical simulation job bytes',async()=>{
 const {verifyBaselineReuse}=await import('../full-training/baseline-cache.mjs');const job={mode:'evaluate',workspace:{fixture:true}}, provenance={bundleHash:'bundle',sourceHashes:{physics:'hash'}}, base={job,artifact:{job,binding:{jobHash:digest(job),bundleHash:'bundle'},score:0,outcome:{status:'completed',result:{completed:true,score:0}}},cacheManifest:{provenance},currentManifest:{provenance},cacheAdapterHash:'adapter',currentAdapterHash:'adapter',physicsPaths:['physics'],referenceContract:{reference:{referenceProtocol:latest,producerSourceHash:'source',producerBundleHash:'producer'}}};
 assert.throws(()=>verifyBaselineReuse({...base,cacheReferenceContract:{reference:{...base.referenceContract.reference,referenceProtocol:{...latest,id:'latest-enhanced-deep-v1',deepSearch:true}}}}),/reference population/);
 base.artifact.binding.referenceContract=base.referenceContract.reference;assert.doesNotThrow(()=>verifyBaselineReuse({...base,cacheReferenceContract:base.referenceContract}));
 assert.throws(()=>verifyBaselineReuse({...base,cacheReferenceContract:{reference:{...base.referenceContract.reference,producerSourceHash:'other'}}}),/reference population/);
});
test('invalid computed stage is degraded, not a full latest mathematical reference',()=>{const x=fixture();x.outcome.result.result.phases.calculation.status='invalid';assert.equal(qualifyEnvelope(x.input,x.outcome,'dev-overfit').qualified,false);});
test('static and simulated latest candidate workspace identities must agree',()=>{const x=fixture();x.outcome.result.result.phases.static.candidates=[{id:'initial',workspace:{different:true},simScore:0}];assert.equal(qualifyEnvelope(x.input,x.outcome,'dev-overfit').qualified,false);});
test('latest cached score requires its own committed reference contract, not merely an evaluator label',async()=>{
 const {verifyBaselineReuse}=await import('../full-training/baseline-cache.mjs');const {input}=fixture(),job={mode:'evaluate',input,workspace:{}},provenance={bundleHash:'b',sourceHashes:{p:'h'}},referenceContract={reference:{referenceProtocol:latest,producerSourceHash:'s',producerBundleHash:'b',requests:[]}};
 const options={job,artifact:{job,binding:{jobHash:digest(job),bundleHash:'b'},score:0,outcome:{status:'completed',result:{completed:true,score:0}}},cacheManifest:{provenance},currentManifest:{provenance},cacheAdapterHash:'a',currentAdapterHash:'a',physicsPaths:['p'],referenceContract,cacheReferenceContract:referenceContract};
 assert.throws(()=>verifyBaselineReuse(options),/reference commitment/);options.artifact.binding.referenceContract=referenceContract.reference;assert.doesNotThrow(()=>verifyBaselineReuse(options));
});
test('enhanced reference requires its actual extra-stage evidence and may not degrade phase-two best',async()=>{const {referenceProtocol}=await import('./reference-protocol.mjs');const x=fixture();x.input.referenceProtocol=referenceProtocol('latest-enhanced-deep-v1');x.input.options.enableDeepSearch=true;x.outcome.result.referenceProtocol=x.input.referenceProtocol;x.outcome.result.requestOptionsHash=digest(x.input.options);assert.equal(qualifyEnvelope(x.input,x.outcome,'dev-overfit').qualified,false);x.outcome.result.result.phases.search={improved:false,gain:0};x.outcome.result.result.phases.replacement={swappedCount:0,logs:[]};assert.equal(qualifyEnvelope(x.input,x.outcome,'dev-overfit').qualified,true);x.outcome.result.result.phases.simulation.candidates[0].simScore=1;x.outcome.result.result.phases.simulation.bestScore=1;assert.equal(qualifyEnvelope(x.input,x.outcome,'dev-overfit').qualified,false);});
