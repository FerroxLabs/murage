import { copyFileSync,mkdtempSync,readFileSync,realpathSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash,randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as attestation from "../electron/backup-restic-attestation.mjs";
import {fileURLToPath} from "node:url";
import { spawn } from "node:child_process";
import { afterEach,expect,it,vi } from "vitest";
import { safeWipeSync } from "./testing/safe-wipe.mjs";
import { BackupRestic,resticRunner,type BackupResticOptions,type ResticRun,type ResticRunner,type ResticS3Credentials,type ResticS3Target } from "./backup-restic.ts";
import { resticChildEnvironment,resticS3Repository,resticS3TargetSchema } from "./backup-restic-target.ts";
vi.mock("node:child_process",()=>({spawn:vi.fn()}));
const roots:string[]=[];afterEach(()=>{vi.restoreAllMocks();vi.clearAllMocks();for(const root of roots.splice(0))safeWipeSync(root);});
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
it("one strict target supports four S3 configurations without credential URLs or free options",()=>{
 for(const [endpoint,region] of [["https://s3.us-east-1.amazonaws.com","us-east-1"],["https://s3.us-west-004.backblazeb2.com","us-west-004"],["https://fictional.r2.cloudflarestorage.com","auto"],["https://minio.example.invalid:9000","us-east-1"]])expect(resticS3TargetSchema.parse({...target,endpoint,region}).kind).toBe("s3");
 for(const invalid of [{endpoint:"http://localhost:9000"},{endpoint:"https://user:secret@example.invalid"},{endpoint:"https://example.invalid/?token=secret"},{endpoint:"https://example.invalid/#secret"},{endpoint:"https://example.invalid/path"},{prefix:"../outside"},{prefix:"normal//outside"},{bucket:"bad/name"},{region:"auto\n--insecure-tls"},{bucketLookup:"arbitrary"},{options:["--no-lock"]}])expect(()=>resticS3TargetSchema.parse({...target,...invalid})).toThrow();
});
it("builds a fresh child-only environment and refuses incomplete credentials before runner use",async()=>{
 const s3={repository:resticS3Repository(target),region:target.region,bucketLookup:target.bucketLookup,credentials};const env=resticChildEnvironment("/synthetic",s3);expect(Object.keys(env).sort()).toEqual(["HOME","PATH","TMPDIR","RESTIC_REPOSITORY","AWS_DEFAULT_REGION","AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_SESSION_TOKEN"].sort());expect(env.RESTIC_PASSWORD).toBeUndefined();expect(env.AWS_PROFILE).toBeUndefined();
 for(const value of [{accessKeyId:"",secretAccessKey:"secret"},{accessKeyId:"id",secretAccessKey:""},{...credentials,secretAccessKey:"private\nvalue"}]){const f=fixture({credentials:async()=>value});await expect(f.adapter.connect()).rejects.toThrow("CREDENTIALS_UNAVAILABLE");expect(f.run).not.toHaveBeenCalled();}
 expect(()=>resticChildEnvironment("/synthetic",{...s3,repository:"s3:https://user:secret@example.invalid/bucket/prefix"})).toThrow("CREDENTIALS_INVALID");
});
it("connect missing never initializes; initialization needs the exact host guard and tuple",async()=>{
 const f=fixture();f.config.exists=false;await expect(f.adapter.connect()).rejects.toThrow("REPOSITORY_MISSING");expect(f.calls.map(call=>operation(call.args))).toEqual(["cat"]);await expect(f.adapter.initialize()).rejects.toThrow("GUARD_REQUIRED");expect(f.calls).toHaveLength(1);
 let guarded:Readonly<ResticS3Credentials>|undefined;const g=fixture({authorizeInitialization:async input=>{guarded=input.credentials;expect(Object.isFrozen(input.target)).toBe(true);expect(Object.isFrozen(input.credentials)).toBe(true);}});g.config.exists=false;
 expect(await g.adapter.initialize()).toEqual({initialized:true,remoteRef:target.remoteRef,revision:1,repositoryId});expect(g.calls.map(call=>operation(call.args))).toEqual(["cat","init","cat"]);expect(g.calls.every(call=>call.s3?.credentials===guarded)).toBe(true);
 await expect(g.adapter.initialize()).rejects.toThrow("REVIEW_REQUIRED");expect(g.calls).toHaveLength(3);
});
it("refused guard and private callbacks fail safely without persisting credentials",async()=>{
 const f=fixture({authorizeInitialization:async()=>{throw Error(credentials.secretAccessKey);}});await expect(f.adapter.initialize()).rejects.toThrow("INITIALIZATION_REFUSED");expect(f.run).not.toHaveBeenCalled();
 const g=fixture({password:async()=>{throw Error(credentials.secretAccessKey);}});await expect(g.adapter.connect()).rejects.toThrow("PASSWORD_UNAVAILABLE");expect(g.run).not.toHaveBeenCalled();
});
it("binds verified upload to exact repository and reuses journal without another backup",async()=>{
 const f=fixture();await expect(f.adapter.store(f.input,f.receipt)).rejects.toThrow("CONNECTION_REQUIRED");expect(f.run).not.toHaveBeenCalled();expect(await f.adapter.connect()).toEqual({connected:true,remoteRef:target.remoteRef,revision:1,repositoryId});
 expect(await f.adapter.store(f.input,f.receipt)).toMatchObject({state:"verified",snapshotId:id,remoteRef:target.remoteRef,revision:1,repositoryId,jobId:f.receipt.jobId,archiveSha256:f.receipt.sha256});await f.adapter.store(f.input,f.receipt);expect(f.calls.filter(call=>operation(call.args)==="backup")).toHaveLength(1);
 for(const call of f.calls){expect(call.args.join(" ")).not.toMatch(/FAKE-|s3:|--repo\b|prune|forget|unlock/);expect(call.password.every(byte=>byte===0)).toBe(true);expect(call.s3?.credentials).toEqual(credentials);}
 const state=readFileSync(join(f.options.workDirectory,"restic-target.json"),"utf8"),journal=readFileSync(join(f.options.workDirectory,f.receipt.jobId+".json"),"utf8");expect(state+journal).not.toMatch(/FAKE-|https:|private-provider-detail|private-config/);expect(JSON.parse(journal).repository).toMatchObject({remoteRef:target.remoteRef,revision:1,repositoryId});expect(readFileSync(f.input)).toEqual(f.bytes);
});
it("refuses changed target, changed repository and legacy or foreign journals",async()=>{
 const f=fixture();await f.adapter.connect();await f.adapter.store(f.input,f.receipt);
 await expect(new BackupRestic({...f.options,repository:{...target,revision:2}}).connect()).rejects.toThrow("TARGET_REVIEW_REQUIRED");await expect(new BackupRestic({...f.options,repository:{...target,bucket:"different-bucket"}}).store(f.input,f.receipt)).rejects.toThrow("TARGET_REVIEW_REQUIRED");
 f.config.id="e".repeat(64);await expect(f.adapter.store(f.input,f.receipt)).rejects.toThrow("REPOSITORY_CHANGED");f.config.id=repositoryId;
 await expect(new BackupRestic({...f.options,repository:join(f.root,"local")}).store(f.input,f.receipt)).rejects.toThrow("JOB_REVIEW_REQUIRED");
 const journal=join(f.options.workDirectory,f.receipt.jobId+".json"),state=JSON.parse(readFileSync(journal,"utf8"));delete state.repository;writeFileSync(journal,JSON.stringify(state));await expect(f.adapter.store(f.input,f.receipt)).rejects.toThrow("JOB_REVIEW_REQUIRED");expect(f.calls.filter(call=>operation(call.args)==="backup")).toHaveLength(1);
});
it("unknown and non-success uploads preserve local input and never replay",async()=>{
 for(const code of [3,11,12,null]){const f=fixture();await f.adapter.connect();f.config.uploadCode=code;f.config.uncertain=code===null;expect((await f.adapter.store(f.input,f.receipt)).state).toBe("needs-review");await f.adapter.store(f.input,f.receipt);expect(f.calls.filter(call=>operation(call.args)==="backup")).toHaveLength(1);expect(readFileSync(f.input)).toEqual(f.bytes);}
 const f=fixture();await f.adapter.connect();f.config.tamper=true;expect(await f.adapter.store(f.input,f.receipt)).toMatchObject({state:"needs-review",error:"restore-mismatch"});
});
it("unknown initialization is retained and concurrent ownership is not bypassed",async()=>{
 const f=fixture({authorizeInitialization:async()=>{}});f.config.exists=false;const original=f.run.getMockImplementation()!;f.run.mockImplementation(async input=>operation(input.args)==="init"?{code:null,stdout:"private-timeout",uncertain:true}:original(input));await expect(f.adapter.initialize()).rejects.toThrow("INIT_UNCONFIRMED");await expect(f.adapter.initialize()).rejects.toThrow("TARGET_REVIEW_REQUIRED");expect(f.calls.filter(call=>operation(call.args)==="cat")).toHaveLength(1);
 const g=fixture();await g.adapter.connect();let finish!:()=>void;const implementation=g.run.getMockImplementation()!;g.run.mockImplementation(async input=>{if(operation(input.args)==="backup")await new Promise<void>(resolve=>{finish=resolve;});return implementation(input);});const storing=g.adapter.store(g.input,g.receipt);await vi.waitFor(()=>expect(finish).toBeTypeOf("function"));await expect(new BackupRestic(g.options).store(g.input,g.receipt)).rejects.toThrow();finish();expect((await storing).state).toBe("verified");
});
it("saved upload status survives reconstruction without credentials, network or journal mutation",async()=>{
 const f=fixture();expect(f.adapter.storedBackupStatus(f.receipt)).toEqual({state:"not-uploaded",jobId:f.receipt.jobId});expect(f.calls).toHaveLength(0);
 await f.adapter.connect();await f.adapter.store(f.input,f.receipt);const calls=f.calls.length;
 const resumed=new BackupRestic({...f.options,password:async()=>{throw Error("must not read password");},credentials:async()=>{throw Error("must not read access keys");}});
 expect(resumed.storedBackupStatus(f.receipt)).toMatchObject({state:"verified",snapshotId:id});expect(f.calls).toHaveLength(calls);
 const file=join(f.options.workDirectory,f.receipt.jobId+".json"),journal=JSON.parse(readFileSync(file,"utf8"));journal.state="uploading";const original=JSON.stringify(journal);writeFileSync(file,original);
 expect(resumed.storedBackupStatus(f.receipt).state).toBe("needs-review");expect(readFileSync(file,"utf8")).toBe(original);expect(f.calls).toHaveLength(calls);
 expect(()=>resumed.storedBackupStatus({...f.receipt,bytes:f.receipt.bytes+1})).toThrow("REVIEW_REQUIRED");
});
it("explicit reconciliation verifies one committed snapshot without repeating uncertain upload",async()=>{
 const f=fixture();await f.adapter.connect();f.config.uncertain=true;expect((await f.adapter.store(f.input,f.receipt)).state).toBe("needs-review");f.config.uncertain=false;
 expect(await f.adapter.reconcile(f.receipt)).toMatchObject({state:"verified",snapshotId:id});expect(f.calls.filter(call=>operation(call.args)==="backup")).toHaveLength(1);
 const discovery=f.calls.find(call=>call.args.includes("--tag")&&operation(call.args)==="snapshots");expect(discovery?.args.slice(-3)).toEqual(["snapshots","--tag",`murage-job:${f.receipt.jobId}`]);expect(f.adapter.storedBackupStatus(f.receipt).state).toBe("verified");expect(readFileSync(f.input)).toEqual(f.bytes);
});
it("missing ambiguous foreign or corrupt remote copies stay under review without writes",async()=>{
 for(const mode of ["missing","multiple","foreign","corrupt"]){
  const f=fixture();await f.adapter.connect();f.config.uncertain=true;await f.adapter.store(f.input,f.receipt);f.config.uncertain=false;
  const implementation=f.run.getMockImplementation()!;f.run.mockImplementation(async request=>{const result=await implementation(request);if(request.args.includes("--tag")&&operation(request.args)==="snapshots"){const rows=JSON.parse(result.stdout);if(mode==="missing")result.stdout="[]";if(mode==="multiple")result.stdout=JSON.stringify([...rows,...rows]);if(mode==="foreign")result.stdout=JSON.stringify([{...rows[0],tags:["foreign"]}]);}return result;});f.config.tamper=mode==="corrupt";
  expect((await f.adapter.reconcile(f.receipt)).state).toBe("needs-review");expect(f.calls.filter(call=>operation(call.args)==="backup")).toHaveLength(1);expect(f.calls.some(call=>call.args.some(arg=>["prune","forget","init","unlock"].includes(arg)))).toBe(false);expect(readFileSync(f.input)).toEqual(f.bytes);
 }
});
it("recovery lists safe unverified candidates without a local upload journal",async()=>{
 const f=fixture();await f.adapter.connect();const original=f.run.getMockImplementation()!;
 const candidate={id,hostname:"murage",time:"2026-09-13T00:00:00Z",tags:[`murage-job:${f.receipt.jobId}`],paths:["/PRIVATE_OLD_PATH/backup.age","/PRIVATE_OLD_PATH/receipt.json"],private:"SECRET_CANARY"};
 f.run.mockImplementation(async request=>operation(request.args)==="snapshots"?{code:0,stdout:JSON.stringify([candidate,{...candidate,id:"f".repeat(64),hostname:"foreign"},{...candidate,id:"e".repeat(64),tags:[]}])}:original(request));
 const result=await f.adapter.listBackups();expect(result.backups).toEqual([{snapshotId:id,jobId:f.receipt.jobId,createdAt:Date.parse(candidate.time),verified:false}]);expect(result.ignored).toBe(2);expect(JSON.stringify(result)).not.toMatch(/PRIVATE_OLD_PATH|SECRET_CANARY/);expect(f.calls.some(call=>["backup","restore","init"].includes(operation(call.args)))).toBe(false);expect(f.adapter.storedBackupStatus(f.receipt).state).toBe("not-uploaded");
});
it("recovery catalogue refuses duplicates malformed responses and repository drift",async()=>{
 for(const mode of ["duplicate","invalid","oversized","changed"]){const f=fixture();await f.adapter.connect();const original=f.run.getMockImplementation()!;
  const candidate={id,hostname:"murage",time:"2026-09-13T00:00:00Z",tags:[`murage-job:${f.receipt.jobId}`],paths:["/old/backup.age","/old/receipt.json"]};
  f.run.mockImplementation(async request=>{if(operation(request.args)==="snapshots"){if(mode==="changed")f.config.id="f".repeat(64);return{code:0,stdout:mode==="invalid"?"not JSON":JSON.stringify(mode==="oversized"?Array(1001).fill(candidate):mode==="duplicate"?[candidate,candidate]:[candidate])};}return original(request);});
  await expect(f.adapter.listBackups()).rejects.toThrow(mode==="changed"?"REPOSITORY_CHANGED":"CATALOG_INVALID");
 }
});
it("downloads a remote recovery copy without any local upload journal",async()=>{
 const f=fixture();await f.adapter.connect();const original=f.run.getMockImplementation()!;
 f.run.mockImplementation(async request=>{
  if(request.args.includes("dump")){expect(request.args.slice(-3)).toEqual(["dump",id,"/receipt.json"]);return{code:0,stdout:JSON.stringify(f.receipt)};}
  if(operation(request.args)==="snapshots")return{code:0,stdout:JSON.stringify([{id,hostname:"murage",time:"2026-09-13T00:00:00Z",tags:[`murage-job:${f.receipt.jobId}`],paths:["/lost-installation/backup.age","/lost-installation/receipt.json"]}])};
  if(operation(request.args)==="restore"){const directory=request.args[request.args.indexOf("--target")+1];writeFileSync(join(directory,"backup.age"),f.bytes);writeFileSync(join(directory,"receipt.json"),JSON.stringify(f.receipt));return{code:0,stdout:""};}
  return original(request);
 });
 const result=await f.adapter.downloadBackup(id);expect(result.state).toBe("downloaded-verified");expect(readFileSync(result.archivePath)).toEqual(f.bytes);expect(result.receipt).toEqual(f.receipt);expect(f.adapter.storedBackupStatus(f.receipt).state).toBe("not-uploaded");expect(f.run.mock.calls.some(([request])=>["backup","init"].includes(operation(request.args)))).toBe(false);
});
it("remote downloads reject wrong identity oversized metadata and corrupt bytes",async()=>{
 for(const mode of ["foreign","large","corrupt"]){
  const f=fixture();await f.adapter.connect();const original=f.run.getMockImplementation()!;let restores=0;
  f.run.mockImplementation(async request=>{
   if(request.args.includes("dump"))return{code:0,stdout:JSON.stringify({...f.receipt,...(mode==="large"?{bytes:2*1024**3}:{})})};
   if(operation(request.args)==="snapshots")return{code:0,stdout:JSON.stringify([{id:mode==="foreign"?"f".repeat(64):id,hostname:"murage",time:"2026-09-13T00:00:00Z",tags:[`murage-job:${f.receipt.jobId}`],paths:["/old/backup.age","/old/receipt.json"]}])};
   if(operation(request.args)==="restore"){restores++;const directory=request.args[request.args.indexOf("--target")+1];writeFileSync(join(directory,"backup.age"),Buffer.alloc(f.bytes.length));writeFileSync(join(directory,"receipt.json"),JSON.stringify(f.receipt));return{code:0,stdout:""};}
   return original(request);
  });await expect(f.adapter.downloadBackup(id)).rejects.toThrow("DOWNLOAD_UNCONFIRMED");expect(restores).toBe(mode==="corrupt"?1:0);expect(readFileSync(f.input)).toEqual(f.bytes);
 }
});
it.skipIf(process.platform!=="darwin"||process.arch!=="arm64")("actual runner creates only the admitted AWS environment and private stdin using mocked spawn",async()=>{
 const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn()});let stdin="";child.stdin.on("data",chunk=>{stdin+=chunk;});vi.mocked(spawn).mockImplementation(()=>{queueMicrotask(()=>child.emit("close",0));return child as never;});
 const password=Buffer.from("FAKE-STDIN-PASSWORD");expect(await resticRunner(fileURLToPath(new URL("../dist-native/backup-restic/arm64/restic",import.meta.url)))({args:["--json","--no-cache","--no-lock","cat","config"],cwd:"/synthetic",password,timeoutMs:1000,s3:{repository:resticS3Repository(target),region:target.region,bucketLookup:target.bucketLookup,credentials}})).toMatchObject({code:0});
 const [_executable,args,options]=vi.mocked(spawn).mock.calls[0];expect(JSON.stringify(args)).not.toMatch(/FAKE-/);expect(options?.env).toEqual(resticChildEnvironment("/synthetic",{repository:resticS3Repository(target),region:target.region,bucketLookup:target.bucketLookup,credentials}));expect(stdin).toBe("FAKE-STDIN-PASSWORD\n");
});

it("pending or failed attestation cannot construct credentials environment, spawn or transmit password",async()=>{
 let release!:(value:boolean)=>void;const verifier=vi.spyOn(attestation,"trustedBackupResticExecutableAsync").mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
 const input:ResticRun={args:[],cwd:"/synthetic",password:Buffer.from("FAKE-PASSWORD"),timeoutMs:1000};let credentialReads=0;Object.defineProperty(input,"s3",{get(){credentialReads++;throw Error("Environment accessed before trust");}});
 const result=resticRunner("/synthetic/restic")(input);const rejected=expect(result).rejects.toThrow("RESTIC_TOOL_UNVERIFIED");await new Promise(resolve=>setTimeout(resolve,5));expect(verifier).toHaveBeenCalledTimes(1);expect(spawn).not.toHaveBeenCalled();expect(credentialReads).toBe(0);release(false);await rejected;expect(spawn).not.toHaveBeenCalled();expect(credentialReads).toBe(0);
});
it("shutdown during fresh action attestation refuses dispatch and adapter zeroizes password on failure",async()=>{
 const controller=new AbortController();vi.spyOn(attestation,"trustedBackupResticExecutableAsync").mockImplementation(async()=>{controller.abort();return true;});
 const password=Buffer.from("FAKE-PASSWORD");let operationPassword:Uint8Array|undefined;const real=resticRunner("/synthetic/restic",controller.signal);const f=fixture({runner:input=>{operationPassword=input.password;return real(input);},password:async()=>password});await expect(f.adapter.connect()).rejects.toThrow();expect(operationPassword).toBeDefined();expect(operationPassword!.every(byte=>byte===0)).toBe(true);expect(spawn).not.toHaveBeenCalled();
});
