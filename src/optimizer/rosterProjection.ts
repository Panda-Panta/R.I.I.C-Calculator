import {createDefaultConfig} from '../domain/defaults'
import {compileMainPlanToAppConfig} from '../workbench/adapter'
import {resolveOperatorCharId as resolveId} from '../workbench/compat/mowerJson'
import {type RosterWorkspace} from '../workbench/model'
import {projectControlOutput} from './controlImpact'

export function projectRosterConfig(workspace:RosterWorkspace){
 const snapshot=structuredClone(workspace)
 for(const room of Object.values(snapshot.mainPlan.facilities))for(const slot of room.slots){if(slot.occupant.kind==='operator')slot.occupant.operatorId=resolveId(slot.occupant.operatorId);slot.replacements=slot.replacements.map(resolveId)}
 const config=compileMainPlanToAppConfig(snapshot.mainPlan,snapshot,createDefaultConfig())
 config.dormitoryOccupantCount=config.facilityOperatorIds.dormitories.flat().length
 config.operatorBackups={};config.operatorGroups=[];config.operatorMorale={};config.zeroMoraleOperatorIds=[];config.workaholicOperatorIds=[];config.droneTarget='none'
 for(const room of config.rooms){room.skillBonus=0;room.specialOrder='none';room.quality='normal';room.powerStaffed=room.type==='power'&&room.operatorIds.length>0}
 return config
}

export function projectRosterOutput(workspace:RosterWorkspace){
 return projectControlOutput(projectRosterConfig(workspace))
}
