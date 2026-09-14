import {spawn} from "node:child_process";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {BackupCoordinator} from "../server/backup-coordinator.ts";
import {runClosedBackupTrigger} from "../electron/backup-closed-trigger.mjs";
import {CLOSED_DESCRIPTOR_FLAG} from "../electron/backup-closed-profile.mjs";
import {assertClosedRegistration,closedControlDirectory} from "../electron/backup-closed-controller.mjs";
import {createNativeClosedBackupProvider} from "../electron/backup-closed-native.mjs";

const statuses=new Set(["disabled","not-due","busy","verified","needs-review","unavailable"]);
/** Only the exact finite result is retained; child stdout/stderr is never logged. */
export function launchClosedCapture(invocation:any,{spawnChild=spawn,timeoutMs=32*60*1000}:any={}){
  return new Promise<{status:string}>(resolve=>{
    let child:any,bytes=0,text="",failed=false,force:ReturnType<typeof setTimeout>|undefined;
    try{child=spawnChild(invocation.executable,invocation.args,{env:invocation.env,stdio:["ignore","pipe","pipe"],windowsHide:true});}catch{resolve({status:"unavailable"});return;}
    const stop=()=>{failed=true;child.kill("SIGTERM");force=setTimeout(()=>child.kill("SIGKILL"),10000);force.unref?.();};
    const timer=setTimeout(stop,timeoutMs);timer.unref?.();
    const collect=(chunk:Buffer,stdout:boolean)=>{
      bytes+=chunk.length;if(bytes>65536){if(!failed)stop();return;}
      if(stdout)text+=chunk.toString("utf8");
    };
    child.stdout?.on("data",(chunk:Buffer)=>collect(chunk,true));child.stderr?.on("data",(chunk:Buffer)=>collect(chunk,false));
    child.once("error",()=>{failed=true;});
    child.once("close",(code:number)=>{
      clearTimeout(timer);if(force)clearTimeout(force);
      let result;try{const lines=text.trim().split(/\r?\n/).filter(line=>line.startsWith('{"type":"murage:closed-backup-result"'));if(lines.length!==1)throw Error();result=JSON.parse(lines[0]);}catch{failed=true;}
      resolve({status:!failed&&code===0&&result?.type==="murage:closed-backup-result"&&statuses.has(result.status)?result.status:"needs-review"});
    });
  });
}
export async function runBackupScheduleTrigger(argv=process.argv.slice(2),{environment=process.env,provider=createNativeClosedBackupProvider(),launch=launchClosedCapture,now=Date.now}:any={}){
  if(argv.length!==2||argv[0]!==CLOSED_DESCRIPTOR_FLAG)return{status:"unavailable"};
  return runClosedBackupTrigger({descriptorPath:argv[1],environment,
    validateRegistration:async(descriptor:any,file:string)=>{await assertClosedRegistration(descriptor,file,provider);return true;},
    createCoordinator:(descriptor:any)=>new BackupCoordinator({stateDirectory:closedControlDirectory(descriptor.installation),now}),launch,
  });
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const result=await runBackupScheduleTrigger();
  process.stdout.write(JSON.stringify({type:"murage:closed-backup-trigger",status:result.status})+"\n");
}
