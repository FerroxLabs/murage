import { createHash,randomBytes,randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync,readFileSync,readdirSync,realpathSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,describe,expect,it,vi } from "vitest";
import { safeWipeSync } from "./testing/safe-wipe.mjs";
import { BackupRestic,resticRunner,type ResticRun } from "./backup-restic.ts";
import type { ResticS3Target } from "./backup-restic-target.ts";
import { startLoopbackS3 } from "./backup-restic-loopback-s3.fixture.ts";

// Actual pinned restic 0.19.1 against a scripted loopback S3 service, through the
// product adapter and runner. The only test difference is a prepended --cacert
// for the fixture's throwaway loopback certificate. No real provider or bucket.
const tool=process.env.MURAGE_BACKUP_TEST_RESTIC;
const qualified=!!tool&&process.platform==="darwin"&&process.arch==="arm64";
const sha=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
const hex=/^[a-f0-9]{64}$/;
const cleanups:(()=>unknown)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});

async function fixture(timeoutMs=60000){
  const s3=await startLoopbackS3();cleanups.push(()=>s3.close());
  const root=realpathSync.native(mkdtempSync(join(tmpdir(),"murage-restic-loopback-")));cleanups.push(()=>safeWipeSync(root));
  const bytes=Buffer.concat([Buffer.from("age-encryption.org/v1\n"),randomBytes(256*1024)]);
  const input=join(root,"synthetic.age");writeFileSync(input,bytes,{mode:0o600});
  const password=randomBytes(24).toString("hex"),prefix="murage/installation";
  const receipt=(job="b")=>({jobId:job.repeat(64),installationRef:"installation",destinationRef:"local-destination",selectionHash:"c".repeat(64),snapshotId:randomUUID(),artifactRef:"artifact",sha256:sha(bytes),bytes:bytes.length,verifiedAt:1});
  const calls:string[][]=[],real=resticRunner(tool!);
  const runner=(request:ResticRun)=>{calls.push(request.args);return real({...request,args:["--cacert",s3.caFile,...request.args]});};
  const target:ResticS3Target={kind:"s3",remoteRef:"loopback",revision:1,credentialRef:"loopback-credential",endpoint:s3.endpoint,bucket:s3.bucket,prefix,region:s3.region,bucketLookup:"path"};
  const workDirectory=join(root,"work");
  const adapter=new BackupRestic({executable:tool!,repository:target,workDirectory,password:async()=>Buffer.from(password),credentials:async()=>({accessKeyId:s3.accessKeyId,secretAccessKey:s3.secretAccessKey}),authorizeInitialization:async()=>{},runner,timeoutMs});
  const backups=()=>calls.filter(args=>args.includes("backup")).length;
  const locks=()=>[...s3.objects.keys()].filter(key=>key.startsWith(`${prefix}/locks/`));
  return{s3,root,bytes,input,password,prefix,receipt,calls,adapter,backups,locks,workDirectory};
}
async function connected(timeoutMs?:number){const f=await fixture(timeoutMs);await f.adapter.initialize();return f;}
const neverMaintains=(calls:string[][])=>expect(calls.some(args=>args.some(arg=>["unlock","forget","prune","repair"].includes(arg)))).toBe(false);

describe.skipIf(!qualified)("pinned restic over loopback S3",()=>{
  it("guarded init, connect, verified store, journal reuse, catalogue and download use the actual protocol",async()=>{
    const f=await fixture();
    await expect(f.adapter.connect()).rejects.toThrow("RESTIC_REPOSITORY_MISSING");expect(f.s3.objects.size).toBe(0);
    const init=await f.adapter.initialize();expect(init).toMatchObject({initialized:true,remoteRef:"loopback",revision:1,repositoryId:expect.stringMatching(hex)});
    const repositoryId=(init as {repositoryId:string}).repositoryId;
    expect(await f.adapter.connect()).toEqual({connected:true,remoteRef:"loopback",revision:1,repositoryId});
    const receipt=f.receipt(),stored=await f.adapter.store(f.input,receipt);
    expect(stored).toMatchObject({state:"verified",snapshotId:expect.stringMatching(hex),repositoryId,jobId:receipt.jobId,archiveSha256:receipt.sha256});
    expect(stored).not.toHaveProperty("lockRelease");expect(f.locks()).toEqual([]);
    expect(await f.adapter.store(f.input,receipt)).toEqual(stored);expect(f.backups()).toBe(1);
    expect(f.adapter.storedBackupStatus(receipt)).toEqual({state:"verified",jobId:receipt.jobId,snapshotId:stored.snapshotId});
    expect(await f.adapter.listBackups()).toMatchObject({repositoryId,ignored:0,backups:[{snapshotId:stored.snapshotId,jobId:receipt.jobId,verified:false}]});
    const copy=await f.adapter.downloadBackup(stored.snapshotId!);expect(readFileSync(copy.archivePath)).toEqual(f.bytes);expect(copy.receipt).toEqual(receipt);
    expect(readFileSync(f.input)).toEqual(f.bytes);neverMaintains(f.calls);
    const persisted=readdirSync(f.workDirectory,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile()&&entry.name.endsWith(".json")).map(entry=>readFileSync(join(entry.parentPath,entry.name),"utf8")).join("\n");
    for(const secret of [f.password,f.s3.secretAccessKey,f.s3.accessKeyId])expect(persisted.includes(secret)||JSON.stringify(f.calls).includes(secret)).toBe(false);
    expect(f.s3.requests.filter(request=>request.method==="DELETE").every(request=>request.key.startsWith(`${f.prefix}/locks/`))).toBe(true);
  },60000);

  it("a transient provider error is retried inside restic without an outer replay",async()=>{
    const f=await connected();
    f.s3.fault=({method,key,attempt})=>method==="PUT"&&key.includes("/data/")&&attempt===1?{status:500,code:"InternalError"}:undefined;
    expect(await f.adapter.store(f.input,f.receipt())).toMatchObject({state:"verified",snapshotId:expect.stringMatching(hex)});
    expect(f.backups()).toBe(1);expect(f.s3.requests.some(request=>request.method==="PUT"&&request.status===500)).toBe(true);
    expect(f.locks()).toEqual([]);neverMaintains(f.calls);
  },60000);

  it.each([["expired upload credential",{status:403,code:"ExpiredToken"}],["partial upload connection reset","reset"],["provider quota",{status:507,code:"QuotaExceeded"}]] as const)("%s stays needs-review within the operation deadline and never replays",async(_name,fault)=>{
    const f=await connected(8000),receipt=f.receipt();
    f.s3.fault=({method,key})=>method==="PUT"&&key.includes("/data/")?fault:undefined;
    const started=Date.now();
    expect(await f.adapter.store(f.input,receipt)).toMatchObject({state:"needs-review",error:"upload-uncertain"});
    expect(Date.now()-started).toBeLessThan(20000);
    f.s3.fault=undefined;
    expect(await f.adapter.store(f.input,receipt)).toMatchObject({state:"needs-review",error:"upload-uncertain"});
    expect(f.backups()).toBe(1);expect(f.adapter.storedBackupStatus(receipt).state).toBe("needs-review");
    expect(readFileSync(f.input)).toEqual(f.bytes);neverMaintains(f.calls);
  },60000);

  it("rotated provider credentials fail before any upload attempt or journal",async()=>{
    const f=await connected(),receipt=f.receipt();
    f.s3.acceptedAccessKeyId="AKIAROTATEDELSEWHERE";
    await expect(f.adapter.store(f.input,receipt)).rejects.toThrow("RESTIC_CONNECT_UNCONFIRMED");
    expect(f.backups()).toBe(0);expect(f.adapter.storedBackupStatus(receipt)).toEqual({state:"not-uploaded",jobId:receipt.jobId});
    f.s3.acceptedAccessKeyId=f.s3.accessKeyId;
    expect((await f.adapter.store(f.input,receipt)).state).toBe("verified");expect(f.backups()).toBe(1);
  },60000);

  it("another client's exclusive maintenance lock is reported as locked and never removed",async()=>{
    const f=await connected(),receipt=f.receipt();
    const env={HOME:f.root,PATH:"",TMPDIR:f.root,RESTIC_REPOSITORY:`s3:${f.s3.endpoint}/${f.s3.bucket}/${f.prefix}`,AWS_DEFAULT_REGION:f.s3.region,AWS_ACCESS_KEY_ID:f.s3.accessKeyId,AWS_SECRET_ACCESS_KEY:f.s3.secretAccessKey};
    const other=spawn(tool!,["--cacert",f.s3.caFile,"--no-cache","-o","s3.bucket-lookup=path","prune"],{cwd:f.root,env,stdio:["pipe","ignore","ignore"]});
    const closed=new Promise(resolve=>other.once("close",resolve));
    cleanups.push(async()=>{if(other.exitCode===null&&other.signalCode===null){other.kill("SIGCONT");other.kill("SIGKILL");}await closed;});
    other.stdin.on("error",()=>{});other.stdin.end(f.password+"\n");
    await vi.waitFor(()=>expect(f.locks()).toHaveLength(1),{timeout:20000,interval:10});
    other.kill("SIGSTOP");
    const held=f.locks();expect(held).toHaveLength(1);
    expect(await f.adapter.store(f.input,receipt)).toMatchObject({state:"needs-review",error:"repository-locked"});
    other.kill("SIGKILL");await closed;
    expect(await f.adapter.store(f.input,f.receipt("e"))).toMatchObject({state:"needs-review",error:"repository-locked"});
    expect(await f.adapter.store(f.input,receipt)).toMatchObject({state:"needs-review",error:"repository-locked"});
    expect(f.locks()).toEqual(held);expect(f.backups()).toBe(2);neverMaintains(f.calls);
    expect(f.s3.requests.some(request=>request.method==="DELETE"&&request.key===held[0])).toBe(false);
  },60000);

  it("an immutable destination keeps verified data but reports unconfirmed lock release truthfully",async()=>{
    const f=await connected(),receipt=f.receipt();
    f.s3.fault=({method})=>method==="DELETE"?{status:403,code:"AccessDenied"}:undefined;
    const stored=await f.adapter.store(f.input,receipt);
    expect(stored).toMatchObject({state:"verified",snapshotId:expect.stringMatching(hex),lockRelease:"unconfirmed"});
    expect(f.locks().length).toBeGreaterThan(0);
    expect(await f.adapter.store(f.input,receipt)).toEqual(stored);
    expect(f.adapter.storedBackupStatus(receipt)).toMatchObject({state:"verified",lockRelease:"unconfirmed"});
    expect(f.backups()).toBe(1);neverMaintains(f.calls);expect(readFileSync(f.input)).toEqual(f.bytes);
  },60000);
});
