import { copyFileSync,mkdtempSync,readFileSync,readdirSync,realpathSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash,randomUUID } from "node:crypto";
import { afterEach,expect,it,vi } from "vitest";
import { safeWipeSync } from "./testing/safe-wipe.mjs";
import { BackupRestic,type BackupResticOptions,type ResticRun,type ResticRunner,type ResticS3Credentials,type ResticS3Target } from "./backup-restic.ts";
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))safeWipeSync(root);});
const target:ResticS3Target={kind:"s3",remoteRef:"remote-one",revision:1,credentialRef:"credential-one",endpoint:"https://s3.example.invalid",bucket:"fixture-bucket",prefix:"murage/installation-one",region:"us-east-1",bucketLookup:"path"};
const credentials:ResticS3Credentials={accessKeyId:"FAKE-ACCESS-CANARY",secretAccessKey:"FAKE-SECRET-CANARY",sessionToken:"FAKE-SESSION-CANARY"};
const repositoryId="a".repeat(64),id="d".repeat(64);
const operation=(args:string[])=>args.includes("cat")?"cat":args.includes("init")?"init":args.includes("backup")?"backup":args.includes("snapshots")?"snapshots":args.includes("restore")?"restore":"unknown";
function fixture(extra:Partial<BackupResticOptions>={}){
 const root=realpathSync.native(mkdtempSync(join(tmpdir(),"murage-restic-s3-fake-")));roots.push(root);const input=join(root,"input.age"),bytes=Buffer.from("synthetic opaque ciphertext");writeFileSync(input,bytes);
 const receipt={jobId:"b".repeat(64),installationRef:"installation",destinationRef:"local-destination",selectionHash:"c".repeat(64),snapshotId:randomUUID(),artifactRef:"artifact",sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length,verifiedAt:1};
 const config={exists:true,id:repositoryId,uploadCode:0 as number|null,uncertain:false,tamper:false};const calls:ResticRun[]=[];
 const run=vi.fn<ResticRunner>(async request=>{calls.push(request);switch(operation(request.args)){
  case "cat":return{code:config.exists?0:10,stdout:config.exists?JSON.stringify({version:2,id:config.id,chunker_polynomial:"private-config-not-exported"}):"private-missing-detail"};
  case "init":config.exists=true;return{code:0,stdout:"private-init-detail"};
  case "backup":return{code:config.uploadCode,uncertain:config.uncertain,stdout:JSON.stringify({message_type:"summary",snapshot_id:id,private:"private-provider-detail"})};
  case "snapshots":return{code:0,stdout:JSON.stringify([{id,tags:[`murage-job:${receipt.jobId}`],paths:[join(request.cwd,"backup.age"),join(request.cwd,"receipt.json")]}])};
  case "restore":{const destination=request.args[request.args.indexOf("--target")+1];copyFileSync(join(request.cwd,"backup.age"),join(destination,"backup.age"));copyFileSync(join(request.cwd,"receipt.json"),join(destination,"receipt.json"));if(config.tamper)writeFileSync(join(destination,"backup.age"),Buffer.alloc(bytes.length,1));return{code:0,stdout:""};}
  default:throw Error("Unexpected fake operation");
 }});
 const options:BackupResticOptions={executable:"/private/tmp/murage-restic-tool-evidence-4zOHAV/restic",repository:target,workDirectory:join(root,"work"),password:async()=>Buffer.from("FAKE-REPOSITORY-PASSWORD"),credentials:async()=>credentials,runner:run,...extra};return{root,input,bytes,receipt,config,calls,run,options,adapter:new BackupRestic(options)};
}

// Protocol: fake runner handles connect/store/restore and dry-run only. Persist valid
// interrupted journal as a crashed process would; reconstruct adapter over same disk.
it.each(["forgetting","pruning"] as const)("persisted %s requires exact idle acknowledgement and fresh removal preview",async state=>{
 const f=fixture({maintenanceCredentials:async()=>({accessKeyId:"FAKE-MAINTENANCE",secretAccessKey:"FAKE-SECRET"})});
 await f.adapter.connect();expect((await f.adapter.store(f.input,f.receipt)).state).toBe("verified");
 const originalRun=f.run.getMockImplementation()!;
 f.run.mockImplementation(async request=>request.args.includes("forget")?{code:0,stdout:JSON.stringify([{keep:[{id,tags:["murage-installation:installation"]}],remove:[]}])}:originalRun(request));
 const policy={keepLast:1},input={installationRef:"installation",protectedJobId:f.receipt.jobId};
 const journal=join(f.options.workDirectory,"restic-retention.json"),previewId="f".repeat(64);
 const bytes=Buffer.from(JSON.stringify({version:1,previewId,repositoryId,installationRef:"installation",remove:["e".repeat(64)],state},null,2)+"\n");writeFileSync(journal,bytes);
 const resumed=new BackupRestic(f.options),calls=f.run.mock.calls.length;
 expect(resumed.retentionStatus()).toMatchObject({state,previewId,removed:1});
 await expect(resumed.previewRetention(policy,input)).rejects.toThrow("RETENTION_REVIEW_REQUIRED");
 expect(()=>resumed.clearRetentionReview("0".repeat(64))).toThrow("RETENTION_REVIEW_REQUIRED");
 expect(readFileSync(journal)).toEqual(bytes);expect(f.run.mock.calls).toHaveLength(calls);
 // Hold a real adapter operation lease while its fake runner awaits release.
 let release!:()=>void;let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
 f.run.mockImplementationOnce(async request=>{entered();await new Promise<void>(resolve=>{release=resolve;});return originalRun(request);});
 const live=new BackupRestic(f.options).connect();await ready;
 try{expect(()=>resumed.clearRetentionReview(previewId)).toThrow();expect(readFileSync(journal)).toEqual(bytes);}finally{release();await live;}
 expect(resumed.clearRetentionReview(previewId)).toEqual({state:"none"});
 const archives=readdirSync(f.options.workDirectory).filter(name=>name.startsWith("restic-retention-reviewed-"));expect(archives).toHaveLength(1);expect(readFileSync(join(f.options.workDirectory,archives[0]))).toEqual(bytes);
 expect(new BackupRestic(f.options).retentionStatus()).toEqual({state:"none"});
 await expect(resumed.applyRetention(policy,input,previewId)).rejects.toThrow("RETENTION_PREVIEW_CHANGED");
 const preview=await resumed.previewRetention(policy,input);expect(preview.remove).toEqual([]);expect(preview.previewId).not.toBe(previewId);
 expect(await resumed.applyRetention(policy,input,preview.previewId)).toMatchObject({state:"nothing-to-remove"});
 expect(f.run.mock.calls.filter(([request])=>request.args.includes("prune")||request.args.includes("forget")&&!request.args.includes("--dry-run"))).toHaveLength(0);
});
