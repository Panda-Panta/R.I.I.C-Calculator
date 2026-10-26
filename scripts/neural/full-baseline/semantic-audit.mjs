/** Read-only historical neural-constraint audit; NEVER alter full teacher output. */
export function auditTradingExclusions(workspace) {
  const aliases = new Map([['char_4058_pepe','佩佩'],['佩佩','佩佩'],['Pepe','佩佩'],['char_4091_ulika','U-Official'],['U-Official','U-Official']]);
  const conflicts=[];
  for(const room of Object.values(workspace?.mainPlan?.facilities??{}))if(room.type==='trading') {
    room.slots.forEach((slot,index)=>{
      const refs=[{role:'main',reference:slot.occupant?.kind==='operator'?slot.occupant.operatorId:null},...(slot.replacements??[]).map((reference,replacementIndex)=>({role:'replacement',reference,replacementIndex}))];
      for(const ref of refs)if(aliases.has(ref.reference))conflicts.push({roomId:room.roomId,slot:index,...ref,name:aliases.get(ref.reference)});
    });
  }
  return {policy:'historical-neural-trading-exclusions',forbidden:['佩佩','U-Official'],conflicts,imitationPolicyCompatible:conflicts.length===0,teacherModified:false};
}
