/** Explicit synthetic TRAIN curriculum. Never benchmark-random or user-owned data. */
import { createHash } from 'node:crypto';
import { facilityCapacity } from '../../../src/domain/facilities';
import { OPERATORS } from '../../../src/domain/operators';
import { fullCatalogIdleInventory, compileOperatorInventory } from '../../../src/domain/operatorInventory';
import { createDefaultWorkspace } from '../../../src/workbench/defaults';
import { applyFacilityLayout, captureFacilityLayout } from '../../../src/workbench/layoutPresets';
import { calculateFacilityPower } from '../../../src/workbench/validate';
import { validatePhysicalRoster } from '../../../src/optimizer/rosterDraft';
import { ATOMIC_UNITS } from '../../../src/optimizer/riicAtomicUnits';
import { availableCoreVariants, physicalBackupOperatorIds } from '../../../src/optimizer/combinationModel';
import { formedCombinations } from '../../../src/optimizer/combinationIntegrity';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const rng=(seed:number)=>{let s=seed>>>0;return()=>((s=(Math.imul(s,1664525)+1013904223)>>>0)/4294967296);};
const DURIN=['绮良','杜林','桃金娘','褐果','至简'];
export const ENRICHED_CASES=[
 {targets:['pinus_sylvestris'],required:['薇薇安娜','焰尾','野鬃','灰毫','远牙','玛恩纳'],excluded:[]},
 {targets:['pozemka_durin'],required:['鸿雪','图耶'],excluded:DURIN},
 {targets:['pozemka_durin'],required:['鸿雪','图耶',...DURIN],excluded:[]},
 {targets:['glasgow'],required:['推进之王','摩根','戴菲恩'],excluded:[]},
 {targets:['laterano_alter'],required:['蕾缪安','新约能天使','安比尔'],excluded:['空弦']},
 {targets:['laterano_alter'],required:['蕾缪安','新约能天使','空弦'],excluded:['安比尔']},
 {targets:['blacksteel'],required:['涤火杰西卡','水月','香草','杰西卡'],excluded:[]},
 {targets:['automation'],required:['温蒂','清流','森蚺','Lancet-2','承曦格雷伊'],excluded:[],layout:'software252-three-gold'},
 {targets:['automation'],required:['温蒂','清流','森蚺','Lancet-2','承曦格雷伊'],excluded:[]},
 {targets:['bubble_capacity','vermeil_capacity'],required:['泡泡','火神','贝娜','红云','稀音','刻俄柏'],excluded:[]},
 {targets:['rhine_lab','cantabile_metalcraft'],required:['多萝西','娜斯提','淬羽赫默','苍苔','砾','引星棘刺','白面鸮','赫默','星源','梅尔','溯光星源'],excluded:[]},
 {targets:['pure_perception'],required:['迷迭香','絮雨','黑键','爱丽丝','车尔尼','琴柳'],excluded:[]},
];
export function enrichedWorkspace(layoutTag:string){
 const base=createDefaultWorkspace();if(layoutTag==='empty-default243')return base;
 if(layoutTag!=='software252-three-gold')throw Error('Unknown enriched layout');
 const layout=captureFacilityLayout(base);
 // Exact documented software template, applied by existing capacity-preserving helper.
 Object.assign(layout,{room_1_1:{type:'manufacture',level:3,product:'gold'},room_1_2:{type:'manufacture',level:3,product:'gold'},room_1_3:{type:'power',level:3},room_2_1:{type:'manufacture',level:3,product:'exp'},room_2_2:{type:'manufacture',level:3,product:'exp'},room_2_3:{type:'power',level:3},room_3_1:{type:'trading',level:2,product:'money'},room_3_2:{type:'trading',level:1,product:'money'},room_3_3:{type:'manufacture',level:2,product:'gold'}});
 for(const [id,room]of Object.entries(layout))if(room.type==='dormitory')layout[id as keyof typeof layout]={type:'dormitory',level:1};
 return applyFacilityLayout(base,layout).workspace;
}
export function prepareEnriched(index:number,prepareBase:(seed:number,size:number,declared:any)=>any){
 if(!Number.isSafeInteger(index)||index<1||index>12)throw Error('Unknown enriched case');
 const spec=ENRICHED_CASES[index-1]!,seed=2026103100+index,size=120,layoutTag=spec.layout??'empty-default243',familyId=`molecular-enriched-train-20261031-${index}`;
 const input=prepareBase(seed,size,{familyId,split:'train'}),cards=fullCatalogIdleInventory(),byName=new Map(OPERATORS.map(o=>[o.name,o.charId])),max=new Map(cards.map(c=>[c.operator,c]));
 const requireId=(name:string)=>{const id=byName.get(name);if(!id||!max.has(id))throw Error('Unknown curriculum operator '+name);return id;};
 const random=rng(seed),stages=rng((seed^0x9e3779b9)>>>0);for(let i=cards.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[cards[i],cards[j]]=[cards[j]!,cards[i]!];}
 const excluded=new Set(spec.excluded.map(requireId)),required=new Set(spec.required.map(requireId)),proviso=requireId('但书'),eligible=cards.filter(c=>!excluded.has(c.operator)),selected=eligible.slice(0,size),forcedSelections:any[]=[];
 for(const id of [...required,proviso]){if(selected.some(e=>e.operator===id))continue;const replace=selected.findLastIndex(e=>!required.has(e.operator)&&e.operator!==proviso);if(replace<0)throw Error('No background capacity');forcedSelections.push({operator:id,name:OPERATORS.find(o=>o.charId===id)!.name,replacedOperator:selected[replace]!.operator,reason:id===proviso?'required proviso; stage remains random':'declared curriculum membership'});selected[replace]=max.get(id)!;}
 const forcedStages:any[]=[];
 const entries=selected.map(e=>{const draw=stages(),sample=draw<.5?{...e,elitePhase:0,level:1}:draw<.75?{...e}:{...e,elitePhase:Math.min(1,e.elitePhase),level:1};if(!required.has(e.operator))return sample;forcedStages.push({operator:e.operator,name:OPERATORS.find(o=>o.charId===e.operator)!.name,randomDraw:draw,from:{elitePhase:sample.elitePhase,level:sample.level},to:{elitePhase:e.elitePhase,level:e.level},reason:'declared legal maximum curriculum stage; not random population'});return{...e};}).sort((a,b)=>a.operator<b.operator?-1:1);
 const inventory=compileOperatorInventory(entries),workspace=enrichedWorkspace(layoutTag),power=calculateFacilityPower(workspace.mainPlan.facilities),physical=validatePhysicalRoster(workspace),powerCount=Object.values(workspace.mainPlan.facilities).filter(r=>r.type==='power'&&r.level>0).length;
 const capacityValid=Object.values(workspace.mainPlan.facilities).every(r=>r.slots.length===facilityCapacity(r.type,r.level));
 const targetAvailability=spec.targets.map(id=>{const atom=ATOMIC_UNITS.find(a=>a.id===id);if(!atom)throw Error('Unknown target '+id);const products=atom.preferredFacilityType==='trading'?[undefined]:atom.preferredProduct==='exp'?['exp' as const]:['gold' as const];const variants=products.flatMap(product=>availableCoreVariants(atom,inventory,powerCount,product));return{definitionId:id,available:!!variants.length,allCoreMaximumSkills:variants.some(v=>v.coreMembers.every(m=>inventory.operators.find(o=>o.name===m.name)?.matchesMaximumSkills)),variants:variants.map(v=>({coreNames:v.coreMembers.map(m=>m.name),confPolicy:v.confPolicy}))};});
 if(!capacityValid||!inventory.valid||!power.sufficient||physical.length||targetAvailability.some(t=>!t.available||!t.allCoreMaximumSkills))throw Error(JSON.stringify({inventory:inventory.diagnostics,power,physical,targetAvailability}));
 return{...input,inputProfile:'TRAIN-enriched-catalog-high-stage-v1',layoutTag,stagePolicy:'Declared synthetic curriculum: named core/support at legal maximum; background including required Proviso LCG32 50% E0L1 /25% max /25% min(E1,max)L1. Not original random distribution.',entries,inventoryHash:hash(entries),workspace,requiredProviso:entries.find(e=>e.operator===proviso),enrichment:{index,targets:spec.targets,requiredNames:spec.required,excludedNames:spec.excluded,ownedNames:inventory.operators.map(o=>o.name),forcedSelections,forcedStages,excludedFromDraw:cards.filter(c=>excluded.has(c.operator)).map(c=>c.operator),backgroundProfile:'fresh independent seed draw of120, replace final nonrequired actors for declared targets; no resampling',contrastScope:'unpaired background: twelve distinct fresh draws; not causal matched-pair evidence',hintsUsedAsFeatures:false,teacherOutputForced:false,layoutSource:'243 createDefaultWorkspace;252 documented software-template via applyFacilityLayout, not game-official preset'},offlineValidation:{capacityValid,inventoryValid:inventory.valid,inventoryDiagnostics:inventory.diagnostics,power,physical,powerCount,targetAvailability}};
}
/** Read-only after output generation; never influences ranking, features or placement. */
export function enrichedTargetCoverage(input:any,workspace:any,inventory:any){
 if(!input.enrichment)return null;
 const formed=formedCombinations(workspace,inventory),targets=input.enrichment.targets.map((id:string)=>({definitionId:id,formed:formed.filter(c=>c.definitionId===id)}));
 const required=new Set(input.enrichment.requiredNames),placements:any[]=[];
 for(const room of Object.values(workspace.mainPlan.facilities) as any[])for(const [slotIndex,slot]of room.slots.entries()){
  for(const [role,ids]of [['main',slot.occupant.kind==='operator'?[slot.occupant.operatorId]:[]],['backup',physicalBackupOperatorIds(room,slot)]] as const)for(const id of ids){const name=inventory.operators.find((o:any)=>o.charId===id||o.name===id)?.name;if(required.has(name))placements.push({name,role,roomId:room.roomId,type:room.type,product:room.product??null,slotIndex});}
 }
 return{targets,coverageMiss:targets.some((t:any)=>!t.formed.length),requiredMemberPlacements:placements,interpretation:'Actual core/role recognition and member placements; ownership or presence alone is not quantified causal synergy.'};
}
