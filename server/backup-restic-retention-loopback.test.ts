import { createHash,randomBytes,randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync,mkdtempSync,readFileSync,realpathSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,describe,expect,it } from "vitest";
import { safeWipeSync } from "./testing/safe-wipe.mjs";
import { BackupRestic,resticRunner,type ResticRun } from "./backup-restic.ts";
import type { ResticS3Target } from "./backup-restic-target.ts";
import { startLoopbackS3 } from "./backup-restic-loopback-s3.fixture.ts";

// Retention/maintenance with actual pinned restic 0.19.1 against the scripted
// loopback S3 service. The fixture lets the writer key delete only lock objects,
// so any snapshot or pack deletion proves the separate maintenance key was used.
const tool=process.env.MURAGE_BACKUP_TEST_RESTIC;
const qualified=!!tool&&process.platform==="darwin"&&process.arch==="arm64";
const sha=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
const hex=/^[a-f0-9]{64}$/;
const cleanups:(()=>unknown)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});

async function fixture(options:{timeoutMs?:number;maintenance?:"separate"|"shared"|"missing"}={}){
  const s3=await startLoopbackS3();cleanups.push(()=>s3.close());
  const root=realpathSync.native(mkdtempSync(join(tmpdir(),"murage-restic-retention-")));cleanups.push(()=>safeWipeSync(root));
  const password=randomBytes(24).toString("hex"),prefix="murage/installation",calls:string[][]=[],real=resticRunner(tool!);
  const runner=(request:ResticRun)=>{calls.push(request.args);return real({...request,args:["--cacert",s3.caFile,...request.args]});};
  const target:ResticS3Target={kind:"s3",remoteRef:"loopback",revision:1,credentialRef:"loopback-credential",endpoint:s3.endpoint,bucket:s3.bucket,prefix,region:s3.region,bucketLookup:"path"};
  const writer={accessKeyId:s3.accessKeyId,secretAccessKey:s3.secretAccessKey};
  const maintenance=options.maintenance==="shared"?writer:{accessKeyId:s3.maintenanceAccessKeyId,secretAccessKey:s3.maintenanceSecretAccessKey};
  const adapter=new BackupRestic({executable:tool!,repository:target,workDirectory:join(root,"work"),password:async()=>Buffer.from(password),credentials:async()=>writer,
    ...(options.maintenance==="missing"?{}:{maintenanceCredentials:async()=>maintenance}),authorizeInitialization:async()=>{},runner,timeoutMs:options.timeoutMs??60000});
  await adapter.initialize();
  let uploads=0;
  const upload=async(job:string,installationRef="installation")=>{
    const bytes=randomBytes(64*1024),input=join(root,`${job}-${++uploads}.age`);writeFileSync(input,bytes,{mode:0o600});
    const receipt={jobId:job.repeat(64),installationRef,destinationRef:"local-destination",selectionHash:"c".repeat(64),snapshotId:randomUUID(),artifactRef:"artifact",sha256:sha(bytes),bytes:bytes.length,verifiedAt:uploads};
    return{receipt,bytes,stored:await adapter.store(input,receipt)};
  };
  // A pre-change snapshot carrying no installation tag, written with the writer key.
  const legacy=async(job:string)=>{
    const stage=join(root,`legacy-${job}`);mkdirSync(stage);writeFileSync(join(stage,"backup.age"),randomBytes(64*1024));writeFileSync(join(stage,"receipt.json"),"{}");
    const env={HOME:root,PATH:"",TMPDIR:root,RESTIC_REPOSITORY:`s3:${s3.endpoint}/${s3.bucket}/${prefix}`,AWS_DEFAULT_REGION:s3.region,AWS_ACCESS_KEY_ID:writer.accessKeyId,AWS_SECRET_ACCESS_KEY:writer.secretAccessKey};
    const child=spawn(tool!,["--cacert",s3.caFile,"--json","--no-cache","-o","s3.bucket-lookup=path","backup","--host","murage","--tag",`murage-job:${job.repeat(64)}`,"backup.age","receipt.json"],{cwd:stage,env,stdio:["pipe","pipe","ignore"]});
    let stdout="";child.stdout.on("data",chunk=>{stdout+=chunk;});child.stdin.on("error",()=>{});child.stdin.end(password+"\n");
    expect(await new Promise(resolve=>child.once("close",resolve))).toBe(0);
    const summary=stdout.trim().split("\n").map(line=>{try{return JSON.parse(line);}catch{return {};}}).find(row=>row.message_type==="summary");
    expect(summary?.snapshot_id).toMatch(hex);return summary.snapshot_id as string;
  };
  const snapshots=async()=>(await adapter.listBackups()).backups.map(item=>item.snapshotId).sort();
  const deletes=(part:string)=>s3.requests.filter(request=>request.method==="DELETE"&&request.status===204&&request.key.includes(`/${part}/`));
  const maintains=()=>calls.filter(args=>(args.includes("forget")&&!args.includes("--dry-run"))||args.includes("prune")).length;
  return{s3,adapter,upload,legacy,snapshots,deletes,maintains,calls};
}

describe.skipIf(!qualified)("pinned restic retention over loopback S3",()=>{
  it("approved retention removes only this installation's unprotected copies with maintenance credentials and reclaims their data",async()=>{
    const f=await fixture();
    const a=await f.upload("a"),b=await f.upload("b"),c=await f.upload("c"),foreign=await f.upload("d","other-installation"),legacy=await f.legacy("e");
    for(const item of [a,b,c,foreign])expect(item.stored.state).toBe("verified");
    const input={installationRef:"installation",protectedJobId:c.receipt.jobId},policy={keepLast:1};
    const preview=await f.adapter.previewRetention(policy,input);
    expect(preview).toMatchObject({previewId:expect.stringMatching(hex),keep:1,remove:[a.stored.snapshotId,b.stored.snapshotId].sort()});
    expect(preview).not.toHaveProperty("lockRelease");expect(f.maintains()).toBe(0);expect(f.deletes("snapshots")).toEqual([]);
    expect(await f.adapter.applyRetention(policy,input,preview.previewId)).toEqual({state:"complete",previewId:preview.previewId,removed:2});
    expect(await f.snapshots()).toEqual([c.stored.snapshotId,foreign.stored.snapshotId,legacy].sort());
    expect(f.deletes("snapshots")).toHaveLength(2);expect(f.deletes("data").length).toBeGreaterThan(0);expect(f.maintains()).toBe(2);
    expect(f.s3.requests.filter(request=>request.method==="DELETE"&&!request.key.includes("/locks/")).every(request=>request.accessKeyId===f.s3.maintenanceAccessKeyId)).toBe(true);
    const copy=await f.adapter.downloadBackup(c.stored.snapshotId!);expect(readFileSync(copy.archivePath)).toEqual(c.bytes);
    expect(f.adapter.retentionStatus()).toEqual({state:"complete",previewId:preview.previewId,removed:2});
  },120000);

  it("an approved preview that no longer matches the repository deletes nothing",async()=>{
    const f=await fixture();
    const a=await f.upload("a");await f.upload("b");const c=await f.upload("c");
    const input={installationRef:"installation",protectedJobId:c.receipt.jobId},policy={keepLast:2};
    const preview=await f.adapter.previewRetention(policy,input);expect(preview.remove).toEqual([a.stored.snapshotId]);
    await f.upload("e");
    await expect(f.adapter.applyRetention(policy,input,preview.previewId)).rejects.toThrow("RESTIC_RETENTION_PREVIEW_CHANGED");
    await expect(f.adapter.applyRetention(policy,input,"not-a-preview")).rejects.toThrow("RESTIC_RETENTION_PREVIEW_CHANGED");
    expect(f.maintains()).toBe(0);expect(f.deletes("snapshots")).toEqual([]);expect(await f.snapshots()).toHaveLength(4);
    expect(f.adapter.retentionStatus()).toEqual({state:"none"});
  },120000);

  it("missing, shared or unsettled maintenance conditions refuse before any deletion",async()=>{
    const missing=await fixture({maintenance:"missing"}),m=await missing.upload("a");
    await expect(missing.adapter.previewRetention({keepLast:1},{installationRef:"installation",protectedJobId:m.receipt.jobId})).rejects.toThrow("RESTIC_MAINTENANCE_CREDENTIALS_UNAVAILABLE");
    const shared=await fixture({maintenance:"shared"}),s=await shared.upload("a");
    await expect(shared.adapter.previewRetention({keepLast:1},{installationRef:"installation",protectedJobId:s.receipt.jobId})).rejects.toThrow("RESTIC_MAINTENANCE_CREDENTIALS_NOT_SEPARATE");
    const f=await fixture({timeoutMs:8000}),ok=await f.upload("a"),input={installationRef:"installation",protectedJobId:ok.receipt.jobId};
    for(const policy of [{},{keepLast:0},{keepLast:1,keepForever:true},undefined])await expect(f.adapter.previewRetention(policy,input)).rejects.toThrow("RESTIC_RETENTION_POLICY_INVALID");
    await expect(f.adapter.previewRetention({keepLast:1},{...input,protectedJobId:"f".repeat(64)})).rejects.toThrow("RESTIC_RETENTION_VERIFIED_COPY_REQUIRED");
    await expect(f.adapter.previewRetention({keepLast:1},{...input,installationRef:"other-installation"})).rejects.toThrow("RESTIC_RETENTION_VERIFIED_COPY_REQUIRED");
    f.s3.fault=({method,key})=>method==="PUT"&&key.includes("/data/")?"reset":undefined;
    expect((await f.upload("b")).stored).toMatchObject({state:"needs-review"});f.s3.fault=undefined;
    await expect(f.adapter.previewRetention({keepLast:1},input)).rejects.toThrow("RESTIC_RETENTION_REVIEW_REQUIRED");
    await expect(f.adapter.applyRetention({keepLast:1},input,"1".repeat(64))).rejects.toThrow("RESTIC_RETENTION_REVIEW_REQUIRED");
    for(const item of [missing,shared,f]){expect(item.maintains()).toBe(0);expect(item.deletes("snapshots")).toEqual([]);expect(item.calls.some(args=>args.includes("forget"))).toBe(false);}
  },120000);

  it("an immutable destination refuses approved forgetting, records review and never retries",async()=>{
    const f=await fixture();
    await f.upload("a");await f.upload("b");const c=await f.upload("c");
    const input={installationRef:"installation",protectedJobId:c.receipt.jobId},policy={keepLast:1};
    const preview=await f.adapter.previewRetention(policy,input);
    f.s3.fault=({method})=>method==="DELETE"?{status:403,code:"AccessDenied"}:undefined;
    const applied=await f.adapter.applyRetention(policy,input,preview.previewId);
    expect(applied).toMatchObject({state:"needs-review",previewId:preview.previewId,removed:2,error:expect.stringMatching(/^(repository-locked|forget-failed)$/),lockRelease:"unconfirmed"});
    expect(f.adapter.retentionStatus()).toMatchObject({state:"needs-review",error:(applied as {error?:string}).error});
    // An undeletable leftover exclusive lock blocks restic reads, so count stored snapshot objects directly.
    expect([...f.s3.objects.keys()].filter(key=>key.includes("/snapshots/"))).toHaveLength(3);expect(f.deletes("snapshots")).toEqual([]);
    const maintained=f.maintains();
    await expect(f.adapter.applyRetention(policy,input,preview.previewId)).rejects.toThrow("RESTIC_RETENTION_REVIEW_REQUIRED");
    await expect(f.adapter.previewRetention(policy,input)).rejects.toThrow("RESTIC_RETENTION_REVIEW_REQUIRED");
    expect(f.maintains()).toBe(maintained);
    expect(()=>f.adapter.clearRetentionReview("f".repeat(64))).toThrow("RESTIC_RETENTION_REVIEW_REQUIRED");
    expect(f.adapter.clearRetentionReview(preview.previewId)).toEqual({state:"none"});expect(f.adapter.retentionStatus()).toEqual({state:"none"});
  },120000);

  it("a prune whose object deletions are refused is not reported complete",async()=>{
    const f=await fixture();
    await f.upload("a");await f.upload("b");const c=await f.upload("c");
    const input={installationRef:"installation",protectedJobId:c.receipt.jobId},policy={keepLast:1};
    const preview=await f.adapter.previewRetention(policy,input);
    f.s3.fault=({method,key})=>method==="DELETE"&&key.includes("/data/")?{status:403,code:"AccessDenied"}:undefined;
    expect(await f.adapter.applyRetention(policy,input,preview.previewId)).toEqual({state:"needs-review",previewId:preview.previewId,removed:2,error:"prune-failed"});
    expect(await f.snapshots()).toEqual([c.stored.snapshotId]);expect(f.deletes("snapshots")).toHaveLength(2);
    expect(f.s3.requests.some(request=>request.method==="DELETE"&&request.key.includes("/data/")&&request.status===403)).toBe(true);
  },120000);
});
