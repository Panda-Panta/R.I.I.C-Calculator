import type {CompiledRoom} from '../scheduler/types'
import {isTradeRunOrderOperator as isSpecial} from '../domain/shiftRunPolicy'
export interface RunOrderSwap {positionId:string;slotIndex:number;outgoingOperatorId:string|null;incomingOperatorId:string}
export interface PreparedRunOrderSwap {roomId:string;swaps:RunOrderSwap[];restoreOccupants:Record<string,string>;diagnostics:{code:string;message:string}[]}
/** Literal positional projection of Mower plan_run_order; availability/reservations belong to the caller. */
export function prepareRunOrderSwap(room:CompiledRoom,currentOccupants:Readonly<Record<string,string>>):PreparedRunOrderSwap {
 const result:PreparedRunOrderSwap={roomId:room.roomId,swaps:[],restoreOccupants:{},diagnostics:[]}
 if(room.type!=='trading')return result
 for(const slot of room.slots){
  const positionId=`${room.roomId}_${slot.slotIndex}`,previous=currentOccupants[positionId]
  if(previous)result.restoreOccupants[positionId]=previous
  const dedicated=slot.orderedCandidates.filter(isSpecial)
  if(!dedicated.length)continue
  const incoming=slot.orderedCandidates[0]!
  if(!isSpecial(incoming))result.diagnostics.push({code:'RUN_ORDER_FIRST_CANDIDATE_NOT_SPECIAL',message:`${positionId}: Mower selects replacement[0], which is not a dedicated run-order operator`})
  if(dedicated.length>1)result.diagnostics.push({code:'RUN_ORDER_MULTIPLE_SPECIAL_CANDIDATES',message:`${positionId}: Mower rejects multiple dedicated operators in one replacement list`})
  result.swaps.push({positionId,slotIndex:slot.slotIndex,outgoingOperatorId:previous ?? null,incomingOperatorId:incoming})
 }
 return result
}
