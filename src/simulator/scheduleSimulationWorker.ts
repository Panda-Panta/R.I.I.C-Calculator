import {runScheduleSimulationBridge} from '../workbench/scheduleSimulationBridge'
import {buildTimelineData} from '../workbench/timeline/timelineModel'
self.onmessage=event=>{
 const {workspace,options,assumptions}=event.data
 try{const result=runScheduleSimulationBridge(workspace,options,assumptions);self.postMessage({...result,timelineData:result.report?buildTimelineData(result.report):null})}
 catch(error){self.postMessage({report:null,error:error instanceof Error?error.message:String(error)})}
}
