/** Independent whole-worker watchdog survives abrupt collector death. No optimizer code. */
import { spawn } from 'node:child_process';
import { publishExclusiveJson } from './atomic.mjs';
const [timeoutText, receiptPath, command, ...args]=process.argv.slice(2), timeoutMs=Number(timeoutText);
if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||!command)process.exit(125);
const startedUtc=new Date().toISOString(), worker=spawn(command,args,{stdio:'inherit'});
let reason=null,launchError=null;
const kill=()=>worker.kill('SIGKILL');
const timeout=()=>{reason='EXTERNAL_PROCESS_TIMEOUT';kill();};const timer=setTimeout(timeout,timeoutMs);process.on('SIGUSR2',timeout);
const cancel=()=>{reason??='CANCELLED';kill();};process.on('SIGTERM',cancel);process.on('SIGINT',cancel);
worker.on('error',error=>{launchError=String(error);});
worker.on('close',(exitCode,signal)=>{
 clearTimeout(timer);
 const receipt={schemaVersion:1,startedUtc,endedUtc:new Date().toISOString(),supervisorPid:process.pid,workerPid:worker.pid,closed:true,exitCode,signal,reason,launchError,timeoutMs};
 if(receiptPath!=='-')try{publishExclusiveJson(receiptPath,receipt);}catch(error){process.stderr.write(JSON.stringify({event:'receipt-error',error:String(error)})+'\n');process.exitCode=125;}
 if(!process.exitCode)process.exitCode=reason==='EXTERNAL_PROCESS_TIMEOUT'?124:reason==='CANCELLED'?130:exitCode??1;
});
