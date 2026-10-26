/** Bounded auxiliary TRAIN targets, never full mathematical teacher evidence. */
export const cohort = Array.from({length:8},(_,i)=>({seed:2026103001+i,size:100*(1+Math.floor(i/2)),familyId:`molecular-train-20261030-${i+1}`,split:'train',layout:'empty-default243',stagePolicy:'actual-mixture-v1'}));
export function validatePolicy(input) {
 if(input.sourceKind!=='molecular-simulated'||input.purpose!=='training'||input.split!=='train'||input.options?.branchCount!==3||input.options?.enableDeepSearch!==false||input.options?.simulationWarmupHours!==24||input.options?.simulationSampleHours!==72) throw Error('Not declared bounded molecular TRAIN policy');
}
export function selectQualified(records,preference,efficiency) {
 return records.filter(r=>r.qualified===true&&Number.isFinite(r.score)).sort((a,b)=>preference(b,a)||efficiency(b,a)||b.score-a.score)[0]??null;
}
export function auditTradingReferences(workspace) {
 const banned=new Set(['char_4058_pepe','佩佩','Pepe','char_4091_ulika','U-Official']),conflicts=[];
 function walk(value,path){if(typeof value==='string'&&banned.has(value))conflicts.push({path,reference:value});else if(value&&typeof value==='object')for(const [key,child]of Object.entries(value))walk(child,`${path}.${key}`);}
 for(const [id,room]of Object.entries(workspace?.mainPlan?.facilities??{}))if(room.type==='trading')walk(room,`mainPlan.facilities.${id}`);
 return {imitationPolicyCompatible:!conflicts.length,conflicts,policy:'all-trading-references-no-Pepe-or-U-Official'};
}
