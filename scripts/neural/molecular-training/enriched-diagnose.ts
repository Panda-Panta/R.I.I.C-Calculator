/** Read-only eligibility probe; no simulation or target alteration. See diagnostic bundler. */
import {readFileSync}from'node:fs';
import{compileOperatorInventory}from'../../../src/domain/operatorInventory';
import{normalizeProductionWeights}from'../../../src/domain/productionWeights';
import{buildCombinationPool}from'../../../src/optimizer/combinationEvaluation';
import{generateMolecularCandidates}from'../../../src/optimizer/molecularSynthesis';
const input=JSON.parse(readFileSync(0,'utf8')),inventory=compileOperatorInventory(input.entries),workspace=structuredClone(input.workspace);workspace.productionWeights=normalizeProductionWeights(input.options.productionWeights);
(globalThis as any).__molecularTrace=[];
const pool=buildCombinationPool(workspace,inventory),target=new Set(input.enrichment.targets),targetValues=pool.values.filter(v=>target.has(v.variant.definitionId));
const candidates=generateMolecularCandidates(workspace,input.entries,inventory,{branchCount:3,seed:input.options.seed,droneTarget:input.options.droneTarget});
process.stdout.write(JSON.stringify({familyId:input.familyId,source:'Read-only instrumented copy of same source; only return-path logging added; no simulations',pool:{enumeratedCount:pool.enumeratedCount,evaluated:pool.values.filter(v=>v.status==='evaluated').length,diagnostics:pool.diagnostics,targetValues:targetValues.map(v=>({id:v.variant.id,status:v.status,perCapita:v.perCapita,diagnostics:v.diagnostics,placements:v.variant.placements}))},candidateCount:candidates.length,trace:(globalThis as any).__molecularTrace},null,2));
