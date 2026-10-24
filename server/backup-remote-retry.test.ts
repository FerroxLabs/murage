import {it,expect,vi} from "vitest";
import {createBackupRemoteHost} from "./backup-remote-host.ts";
const input={label:"Remote backup",endpoint:"https://s3.example.invalid",bucket:"fixture-bucket",prefix:"murage",region:"auto",bucketLookup:"path",credentials:{accessKeyId:"FAKE_ACCESS",secretAccessKey:"FAKE_SECRET"}};
const receipt={jobId:"a".repeat(64),installationRef:"install",destinationRef:"local",selectionHash:"b".repeat(64),snapshotId:"97d4fa8e-2c50-4cba-a66f-a7bb84b13d42",artifactRef:"artifact",sha256:"c".repeat(64),bytes:4096,verifiedAt:1};
it("uploadLatest called while the host is still starting is retried once ready (not refused, no failure line)",async()=>{
 let ready=true,document:Record<string,unknown>={},count=0;
 const store=vi.fn(async(_path:string,_receipt:unknown)=>({state:"verified",snapshotId:"e".repeat(64)}));
 const failures:unknown[]=[],lines:string[]=[];
 const host=createBackupRemoteHost({supported:()=>ready,checking:()=>!ready,readyWaitMs:3000,readProtected:async()=>structuredClone(document),updateProtected:async (derive:(current:Record<string,unknown>)=>Record<string,unknown>)=>{document=derive(document);},
  selectPassword:async()=>({passwordRef:"independent-password"}),latestVerified:async()=>({archivePath:"/host/verified.age",receipt}),latestReceipt:()=>receipt,now:()=>10,createId:()=>`ref-${++count}`,
  reportFailure:(error:unknown)=>{failures.push(error);},reportOutcome:(line:string)=>{lines.push(line);},
  createAdapter:(binding:any)=>({connectionStatus:()=>({state:"connected",repositoryId:"d".repeat(64)}),connect:async()=>({connected:true,remoteRef:binding.target.remoteRef,revision:binding.target.revision,repositoryId:"d".repeat(64)}),store})} as never);
 await host.save(0,input);const saved=await host.status();await host.selectRepositoryPassword(saved.remoteRef,1);const ref=(await host.status()).remoteRef;await host.connect(ref,2);
 ready=false; // the host restarted: the tool check is running again
 const upload=host.uploadLatest(ref,2,receipt.jobId);
 await new Promise(resolve=>setTimeout(resolve,120));
 expect(store).not.toHaveBeenCalled(); // still waiting, not refused
 ready=true;
 await expect(upload).resolves.toMatchObject({state:"verified",jobId:receipt.jobId});
 expect(store).toHaveBeenCalledTimes(1);
 expect(failures).toHaveLength(0);
 expect(lines.some(line=>line.startsWith("backup off-site uploaded and verified"))).toBe(true);
});
it("a host that never becomes ready is still refused after the bounded wait, with a reason line",async()=>{
 const lines:string[]=[];
 const host=createBackupRemoteHost({supported:()=>false,checking:()=>true,readyWaitMs:60,readProtected:async()=>({}),updateProtected:async()=>{},selectPassword:async()=>null,reportOutcome:(line:string)=>{lines.push(line);},createAdapter:(()=>{throw Error("unused");}) as never} as never);
 await expect(host.uploadLatest("ref-1",1,receipt.jobId)).rejects.toThrow("BACKUP_REMOTE_");
 expect(lines.some(line=>line.startsWith("backup off-site step refused")&&line.includes("BACKUP_REMOTE_"))).toBe(true);
});
