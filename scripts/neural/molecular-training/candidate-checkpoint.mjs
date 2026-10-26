import { sha256 } from '../provenance.mjs';
import { publishExclusiveJson } from '../full-baseline/atomic.mjs';
/** Durable evidence only. A partial family checkpoint is NOT an admitted target. */
export function checkpointCandidate(path, binding, candidate, index, total) {
 for(const key of ['inputHash','sourceHash','bundleHash'])if(!/^[a-f0-9]{64}$/.test(binding?.[key]??''))throw Error('Missing candidate evidence binding: '+key);
 if(!Number.isSafeInteger(index)||index<0||!Number.isSafeInteger(total)||total<1||total>3||index>=total)throw Error('Invalid candidate position');
 const raw=JSON.parse(JSON.stringify(candidate,(_k,v)=>typeof v==='number'&&!Number.isFinite(v)?{$nonfinite:String(v)}:v));
 const envelope={schemaVersion:1,sourceKind:'molecular-simulated',purpose:'training',baselineEligible:false,admittedTarget:false,comparisonComplete:false,scope:'Durable individual candidate evidence; requires full family completion or separately authorized partial-family ingestion',binding,index,total,candidate:raw,candidateHash:sha256(raw),workspaceHash:raw.workspace?sha256(raw.workspace):null,simulationHash:raw.simulation?sha256(raw.simulation):null,replayHash:raw.replay?sha256(raw.replay):null};
 publishExclusiveJson(path,envelope);return envelope;
}
