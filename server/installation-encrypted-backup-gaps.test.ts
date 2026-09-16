import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { expect, it, vi } from "vitest";
import { acquireDataDirLease, dataDirLeasePaths } from "../electron/data-dir-lease.mjs";
import { assertRestoreReviewed } from "../electron/restore-review.mjs";
import * as encryption from "./installation-backup-encryption.ts";
import * as fidelity from "./installation-fidelity-snapshot.ts";
import { inspectEncryptedInstallationBackup, restoreEncryptedInstallationNew, writeEncryptedInstallationBackup } from "./installation-encrypted-backup.ts";
import { backupFixture, testAgeKeys } from "./testing/backup-fixture.ts";

// B20 recovery gaps on a genuinely closed synthetic installation with the real
// pinned age tool: in-flight cancellation, a destination raced into existence,
// truncated ciphertext and durable restore receipt/archive correspondence.
const selection={scope:"application-data",credentialPolicy:"preserve-in-encrypted-fidelity"} as const;
const sha=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
const refusal=async(promise:Promise<unknown>)=>{try{await promise;}catch(error){return (error as {code?:string}).code;}return "RESOLVED";};
function digestTree(root:string){
  const out:Record<string,string>={};
  const walk=(dir:string)=>{for(const name of readdirSync(dir).sort()){const file=join(dir,name),rel=relative(root,file),stat=lstatSync(file);
    if(stat.isSymbolicLink())out[rel]="symlink";else if(stat.isDirectory()){out[rel+"/"]="dir";walk(file);}else out[rel]=sha(readFileSync(file));}};
  walk(root);return out;
}
// Accepted SQLite-sidecar rule: every pre-existing entry stays byte-identical;
// only a newly added messages.db-shm and an empty messages.db-wal may appear.
function expectOriginalPreserved(root:string,before:Record<string,string>){
  const after=digestTree(root);
  for(const [path,digest] of Object.entries(before))expect(after[path],path).toBe(digest);
  const added=Object.keys(after).filter(path=>!(path in before));
  expect(added.filter(path=>path!=="messages.db-wal"&&path!=="messages.db-shm")).toEqual([]);
  if(added.includes("messages.db-wal"))expect(statSync(join(root,"messages.db-wal")).size).toBe(0);
}
const ownedAge=(tool:string)=>execFileSync("ps",["-axo","pid=,command="],{encoding:"utf8"}).split("\n").filter(line=>line.includes(tool)).map(line=>line.trim());
async function expectNoOwnedAge(tool:string){
  const deadline=Date.now()+5000;
  while(ownedAge(tool).length&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
  expect(ownedAge(tool)).toEqual([]);
}
function closedFixture(){
  const f=backupFixture(),keys=testAgeKeys();
  writeFileSync(join(f.data,"workspaces","large.bin"),Buffer.alloc(8*1024**2,0x5a));
  f.db.close();
  // A unique pinned copy lets process checks name only this test's children.
  const tool=join(f.parent,"Resources","backup-tools",process.arch,"age");
  mkdirSync(dirname(tool),{recursive:true});copyFileSync(keys.ageExecutable,tool);
  return{parent:f.parent,data:f.data,tool,keys:{...keys,ageExecutable:tool}};
}
const leftovers=(directory:string)=>readdirSync(directory).filter(name=>name.startsWith(".murage-encrypted"));

it("cancels an in-flight capture, stops the pinned age child, publishes nothing and releases ownership",async()=>{
  const f=closedFixture(),before=digestTree(f.data),archive=join(f.parent,"backup.age"),controller=new AbortController();
  const open=fidelity.openFidelitySource;let observed:{running:string[];staged:boolean}|undefined;
  const hook=vi.spyOn(fidelity,"openFidelitySource").mockImplementation(item=>{
    const stream=open(item);
    if(item.path==="workspaces/large.bin")stream.once("data",()=>{
      observed={running:ownedAge(f.tool),staged:leftovers(f.parent).some(name=>existsSync(join(f.parent,name,"backup.age")))};
      controller.abort(new Error("synthetic in-flight capture cancellation"));
    });
    return stream;
  });
  try{
    expect(await refusal(writeEncryptedInstallationBackup(f.data,archive,{...f.keys,selection,signal:controller.signal}))).toBe("SNAPSHOT_CANCELLED");
    expect(observed?.running.length).toBeGreaterThan(0);expect(observed?.staged).toBe(true);
    await expectNoOwnedAge(f.tool);
    expect(existsSync(archive)).toBe(false);expect(leftovers(f.parent)).toEqual([]);
    expectOriginalPreserved(f.data,before);
    acquireDataDirLease(f.data).release();
    hook.mockRestore();
    const saved=await writeEncryptedInstallationBackup(f.data,archive,{...f.keys,selection});
    expect(saved.sha256).toBe(sha(readFileSync(archive)));expect(lstatSync(archive).nlink).toBe(1);
    expectOriginalPreserved(f.data,before);
  }finally{hook.mockRestore();rmSync(f.parent,{recursive:true,force:true});}
},60000);

it("refuses a destination another writer creates during capture and keeps that writer's bytes",async()=>{
  const f=closedFixture(),before=digestTree(f.data),archive=join(f.parent,"backup.age");
  const open=fidelity.openFidelitySource;let raced=false;
  const hook=vi.spyOn(fidelity,"openFidelitySource").mockImplementation(item=>{
    if(item.path==="workspaces/large.bin"&&!raced){writeFileSync(archive,"other writer bytes",{flag:"wx"});raced=true;}
    return open(item);
  });
  try{
    expect(await refusal(writeEncryptedInstallationBackup(f.data,archive,{...f.keys,selection}))).toBe("DESTINATION_EXISTS");
    expect(raced).toBe(true);
    expect(readFileSync(archive,"utf8")).toBe("other writer bytes");expect(lstatSync(archive).nlink).toBe(1);
    await expectNoOwnedAge(f.tool);expect(leftovers(f.parent)).toEqual([]);
    expectOriginalPreserved(f.data,before);
  }finally{hook.mockRestore();rmSync(f.parent,{recursive:true,force:true});}
},60000);

it("refuses truncated ciphertext and an in-flight restore cancellation; the durable receipt then matches the archive",async()=>{
  const f=closedFixture(),before=digestTree(f.data),archive=join(f.parent,"backup.age"),restores=join(f.parent,"restores");mkdirSync(restores);
  try{
    const saved=await writeEncryptedInstallationBackup(f.data,archive,{...f.keys,selection});
    const bytes=readFileSync(archive),archiveSha=sha(bytes);expect(saved.sha256).toBe(archiveSha);
    for(const [name,length] of [["tail",bytes.length-1],["half",Math.floor(bytes.length/2)]] as const){
      const truncated=join(f.parent,`truncated-${name}.age`);writeFileSync(truncated,bytes.subarray(0,length),{mode:0o600});
      expect(await refusal(inspectEncryptedInstallationBackup(truncated,restores,f.keys))).toBe("AGE_PROCESS_FAILED");
      const target=join(restores,`truncated-${name}`);
      expect(await refusal(restoreEncryptedInstallationNew(target,truncated,sha(readFileSync(truncated)),f.keys))).toBe("AGE_PROCESS_FAILED");
      expect(existsSync(target)).toBe(false);expect(readdirSync(restores)).toEqual([]);
    }
    await expectNoOwnedAge(f.tool);

    const target=join(restores,"restored"),controller=new AbortController();
    const decrypt=encryption.decryptBackupFile;let running:string[]=[];
    const hook=vi.spyOn(encryption,"decryptBackupFile").mockImplementation((...args)=>{
      // runAge spawns synchronously; cancel while that child is running.
      const pending=decrypt(...args);running=ownedAge(f.tool);controller.abort(new Error("synthetic in-flight restore cancellation"));return pending;
    });
    try{expect(await refusal(restoreEncryptedInstallationNew(target,archive,archiveSha,{...f.keys,signal:controller.signal}))).toBe("SNAPSHOT_CANCELLED");}
    finally{hook.mockRestore();}
    expect(running.length).toBeGreaterThan(0);await expectNoOwnedAge(f.tool);
    expect(existsSync(target)).toBe(false);expect(readdirSync(restores)).toEqual([]);expect(sha(readFileSync(archive))).toBe(archiveSha);

    const restored=await restoreEncryptedInstallationNew(target,archive,archiveSha,f.keys);
    expect(restored).toMatchObject({status:"restored-review-required",snapshotId:saved.snapshotId,encryptedSha256:archiveSha,previousDataDir:null,activationAvailable:false,rawFidelityActivated:false});
    const inspected=await inspectEncryptedInstallationBackup(archive,f.parent,f.keys);
    try{expect(inspected.sha256).toBe(archiveSha);expect(inspected.manifest.snapshotId).toBe(saved.snapshotId);expect(inspected.manifest.coverage).toEqual(saved.coverage);}
    finally{rmSync(inspected.directory,{recursive:true,force:true});}
    // Durable on-disk records, not only the in-memory result, bind the same snapshot and verified projection.
    const receipt=JSON.parse(readFileSync(restored.receipt,"utf8"));
    expect(receipt).toMatchObject({version:1,snapshotId:saved.snapshotId,archiveSha256:restored.archiveSha256,hadOriginal:false,originalIdentity:null,phase:"candidate-installed"});
    const review=JSON.parse(readFileSync(join(target,"restore-review.json"),"utf8"));
    expect(review).toMatchObject({status:"review-required",snapshotId:saved.snapshotId,archiveSha256:restored.archiveSha256});
    expect(()=>assertRestoreReviewed(target)).toThrow();
    expect(existsSync(`${dataDirLeasePaths(target).leasePath}.restore.json`)).toBe(false);
    expect(sha(readFileSync(archive))).toBe(archiveSha);expect(lstatSync(archive).nlink).toBe(1);
    expect(leftovers(restores)).toEqual([]);expect(leftovers(f.parent)).toEqual([]);
    await expectNoOwnedAge(f.tool);
    expectOriginalPreserved(f.data,before);
  }finally{rmSync(f.parent,{recursive:true,force:true});}
},90000);
