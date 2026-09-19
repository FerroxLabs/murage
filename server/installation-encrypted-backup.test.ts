import { createHash } from "node:crypto";
import { existsSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect,it,vi } from "vitest";
import { acquireDataDirLease } from "../electron/data-dir-lease.mjs";
import { assertRestoreReviewed } from "../electron/restore-review.mjs";
import { inspectEncryptedInstallationBackup,writeEncryptedInstallationBackup,restoreEncryptedInstallationNew } from "./installation-encrypted-backup.ts";
import { installationRecoveryCommand } from "./installation-recovery-command.ts";
import { backupFixture,testAgeKeys } from "./testing/backup-fixture.ts";
import * as encryption from "./installation-backup-encryption.ts";
import { MemoryIndex } from "./memory/index.ts";
import { MemoryEligibility } from "./memory/eligibility.ts";
import { InstallationSnapshotError } from "./installation-database-snapshot.ts";
const selection={scope:"application-data",credentialPolicy:"preserve-in-encrypted-fidelity"} as const;
it("captures raw fidelity and safe recovery in one encrypted file, then restores a separate paused installation",async()=>{
  const f=backupFixture(),keys=testAgeKeys();
  const channel=join(f.data,"channels","slack");mkdirSync(channel,{recursive:true});
  const connection=JSON.stringify({version:1,chosen:{teamId:"TEAM",appId:"APP",ownerUserId:"OWNER",chiefBotId:"bot"},identity:{teamId:"TEAM",userId:"UBOT",botId:"BOT"},enabled:true,paused:false,binding:{connectionId:"fixture-connection",teamId:"TEAM",appId:"APP",botUserId:"UBOT",botId:"BOT",ownerUserId:"OWNER",dmId:"DOWNER",chiefBotId:"bot"},pairing:null});
  const ledger=JSON.stringify({version:1,bindingKey:"fixture-binding",recipient:"DOWNER",records:[{deliveryId:"event",state:"queued",prompt:"pending",occurredAt:1,attempts:0}],tombstones:[{deliveryId:"sent-before",occurredAt:1}]});
  writeFileSync(join(channel,"connection.json"),connection);writeFileSync(join(channel,"fixture-connection.json"),ledger);
  const startup=JSON.stringify({keepRunning:true,startAtLogin:true});writeFileSync(join(f.data,"startup-background.json"),startup);
  const paths=["config.json","bots.json","messages.db","messages.db-wal","workspaces/report.md"];
  const original=paths.map(path=>readFileSync(join(f.data,path)));
  try{
    const archive=join(f.parent,"backup.age");
    const result=await writeEncryptedInstallationBackup(f.data,archive,{...keys,selection});
    expect(result.coverage.fullInstallation).toBe(false);
    expect(readFileSync(archive).includes(Buffer.from("FAKE-CREDENTIAL-CANARY"))).toBe(false);
    const view=await inspectEncryptedInstallationBackup(archive,f.parent,keys);
    expect(readFileSync(join(view.stateDirectory,"raw","config.json"))).toEqual(original[0]);
    expect(readFileSync(join(view.stateDirectory,"raw","bots.json"))).toEqual(original[1]);
    expect(readFileSync(join(view.stateDirectory,"raw","startup-background.json"),"utf8")).toBe(startup);
    expect(readFileSync(join(view.stateDirectory,"raw","channels","slack","connection.json"),"utf8")).toBe(connection);
    expect(readFileSync(join(view.stateDirectory,"raw","channels","slack","fixture-connection.json"),"utf8")).toBe(ledger);
    expect(view.manifest.coverage.components).toContainEqual(expect.objectContaining({path:"channels",status:"included",reason:expect.stringContaining("re-pairing")}));
    expect(readFileSync(join(view.stateDirectory,"recovery","config.json"),"utf8")).not.toContain("FAKE-CREDENTIAL-CANARY");
    rmSync(view.directory,{recursive:true,force:true});
    // The recovery identity is retained independently from the installation.
    const identityPath=join(f.parent,"saved-recovery-identity");writeFileSync(identityPath,keys.identity,{mode:0o600});
    const target=join(f.parent,"restored");
    const restored=await restoreEncryptedInstallationNew(target,archive,result.sha256,{ageExecutable:keys.ageExecutable,identity:readFileSync(identityPath,"utf8")});
    expect(restored.activationAvailable).toBe(false);expect(restored.rawFidelityActivated).toBe(false);
    expect(()=>assertRestoreReviewed(target)).toThrow();
    expect(readFileSync(join(target,"config.json"),"utf8")).not.toContain("FAKE-CREDENTIAL-CANARY");
    expect(existsSync(join(target,"channels"))).toBe(false);
    expect(existsSync(join(target,"startup-background.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(target,"bots.json"),"utf8"))[0]).toMatchObject({autoApprove:false,browser:false,computer:"off",resumeCursors:{}});
    const db=new DatabaseSync(join(target,"messages.db"),{readOnly:true});try{
      expect(String(db.prepare("SELECT json FROM messages").get()?.json)).toContain("WAL-visible transcript");
      expect(db.prepare("SELECT mode FROM memory_meta").get()?.mode).toBe("paused");
      expect(db.prepare("SELECT target_id FROM memory_tombstones").get()?.target_id).toBe("forgotten");
      expect(db.prepare("SELECT state FROM image_operations").get()?.state).toBe("publish-pending");
    }finally{db.close();}
    paths.forEach((path,index)=>expect(readFileSync(join(f.data,path))).toEqual(original[index]));
    expect(readdirSync(f.parent).filter(name=>name.startsWith(".murage-encrypted"))).toEqual([]);
  }finally{f.db.close();rmSync(f.parent,{recursive:true,force:true});}
},20000);
it("keeps only the encrypted output, never plaintext, when an owned tool close cannot be confirmed",async()=>{
  const f=backupFixture(),keys=testAgeKeys();
  const mocked=vi.spyOn(encryption,"encryptBackupStream").mockImplementationOnce(async(_tool,_recipient,input)=>{input.on("error",()=>{});throw new InstallationSnapshotError("AGE_PROCESS_CLOSE_UNCONFIRMED");});
  try{
    let failure:unknown;
    try{await writeEncryptedInstallationBackup(f.data,join(f.parent,"backup.age"),{...keys,selection});}catch(error){failure=error;}
    expect(failure).toMatchObject({code:"AGE_PROCESS_CLOSE_UNCONFIRMED",retainedDirectory:expect.any(String)});
    const retained=(failure as {retainedDirectory:string}).retainedDirectory;
    // The staging folder sits in the backup folder, which may be synced: no plaintext copy stays there.
    expect(existsSync(retained)).toBe(true);expect(readdirSync(retained).filter(name=>name!=="backup.age")).toEqual([]);
    expect(existsSync(join(f.parent,"backup.age"))).toBe(false);
  }finally{mocked.mockRestore();f.db.close();rmSync(f.parent,{recursive:true,force:true});}
});
it("a failed capture leaves nothing in the backup folder",async()=>{
  const f=backupFixture(),keys=testAgeKeys();
  const before=new Set(readdirSync(f.parent));
  const mocked=vi.spyOn(encryption,"encryptBackupStream").mockImplementationOnce(async(_tool,_recipient,input)=>{input.on("error",()=>{});throw new InstallationSnapshotError("AGE_PROCESS_FAILED");});
  try{
    let failure:unknown;
    try{await writeEncryptedInstallationBackup(f.data,join(f.parent,"backup.age"),{...keys,selection});}catch(error){failure=error;}
    expect(failure).toMatchObject({code:"AGE_PROCESS_FAILED"});
    expect((failure as {retainedDirectory?:string}).retainedDirectory).toBeUndefined();
    expect(readdirSync(f.parent).filter(name=>!before.has(name))).toEqual([]);
  }finally{mocked.mockRestore();f.db.close();rmSync(f.parent,{recursive:true,force:true});}
});
it.each(["existing","live","quota","cancel","vm"])("refuses %s without publishing or changing originals",async kind=>{
  const f=backupFixture(),keys=testAgeKeys(),archive=join(f.parent,"backup.age"),before=readFileSync(join(f.data,"config.json"));
  let lease:ReturnType<typeof acquireDataDirLease>|undefined;const abort=new AbortController();
  try{
    if(kind==="existing")writeFileSync(archive,"existing backup");
    if(kind==="live")lease=acquireDataDirLease(f.data);
    if(kind==="cancel")abort.abort();
    if(kind==="vm")mkdirSync(join(f.data,"vm-home"));
    await expect(writeEncryptedInstallationBackup(f.data,archive,{...keys,selection,signal:abort.signal,maxBytes:kind==="quota"?1:undefined})).rejects.toThrow();
    expect(readFileSync(join(f.data,"config.json"))).toEqual(before);
    if(kind==="existing")expect(readFileSync(archive,"utf8")).toBe("existing backup");else expect(existsSync(archive)).toBe(false);
    expect(readdirSync(f.parent).filter(name=>name.startsWith(".murage-encrypted"))).toEqual([]);
  }finally{lease?.release();f.db.close();rmSync(f.parent,{recursive:true,force:true});}
});
it("new encrypted CLI requires an explicit policy and hash-bound separate restore",async()=>{
  const f=backupFixture(),keys=testAgeKeys();try{
    const archive=join(f.parent,"cli.age");
    const saved=await installationRecoveryCommand(["backup-encrypted","--data-dir",f.data,"--output",archive,"--age-tool",keys.ageExecutable,"--recipient",keys.recipient,"--credential-policy",selection.credentialPolicy],{readIdentity:async()=>keys.identity});
    expect(saved.sha256).toBe(createHash("sha256").update(readFileSync(archive)).digest("hex"));
    const target=join(f.parent,"cli-restored");
    const result=await installationRecoveryCommand(["restore-encrypted-new","--data-dir",target,"--archive",archive,"--sha256",String(saved.sha256),"--age-tool",keys.ageExecutable],{readIdentity:async()=>keys.identity});
    expect(result.activationAvailable).toBe(false);expect(existsSync(join(target,"bots.json"))).toBe(true);
  }finally{f.db.close();rmSync(f.parent,{recursive:true,force:true});}
},20000);

it("headless encrypted roundtrip retains WAL-visible memories, pauses authority and rebuilds recall without stale projection",async()=>{
  const f=backupFixture(),keys=testAgeKeys(),index=new MemoryIndex(join(f.data,"memory-index.db"));
  rmSync(join(f.data,"config.json"));
  for(const name of ["door-identity","folder-trust.json","skill-index.db"])writeFileSync(join(f.data,name),"synthetic authority or cache");
  f.db.exec(`INSERT INTO memory_scopes VALUES('scope','bot','bot','["bot"]',1);
    INSERT INTO memory_records VALUES('remembered',1,'scope','fact','quartz lighthouse preference','owner-statement','active',1,1,NULL,NULL,1);
    INSERT INTO memory_records VALUES('forgotten',1,'scope','fact','quartz forgotten preference','owner-statement','active',1,1,NULL,NULL,1);
    INSERT INTO memory_projection_receipts VALUES('remembered',1,1,'indexed','indexed',NULL);
    INSERT INTO memory_projection_receipts VALUES('forgotten',1,1,'indexed','indexed',NULL);`);
  index.upsert([{id:"remembered",version:1,scopeId:"scope",text:"quartz lighthouse preference",deleted:false},{id:"forgotten",version:1,scopeId:"scope",text:"quartz forgotten preference",deleted:false}]);
  index.vector({id:"remembered",version:1,scopeId:"scope",text:"quartz lighthouse preference",deleted:false},"fixture-model",0,[0.2,0.4]);
  const detailsOriginal=f.db.prepare("SELECT * FROM memory_record_details WHERE record_id='remembered'").get();
  const paths=["bots.json","messages.db","messages.db-wal","messages.db-shm","memory-index.db","memory-index.db-wal","memory-index.db-shm","door-identity","folder-trust.json","skill-index.db"];
  const originals=paths.map(name=>readFileSync(join(f.data,name)));
  try{
    const archive=join(f.parent,"headless.age"),saved=await writeEncryptedInstallationBackup(f.data,archive,{...keys,selection});
    expect(existsSync(join(f.data,"config.json"))).toBe(false);expect(saved.coverage.components).toContainEqual(expect.objectContaining({path:"config.json",status:"missing"}));
    const inspected=await inspectEncryptedInstallationBackup(archive,f.parent,keys);
    expect(inspected.manifest.recovery).toMatchObject({missing:expect.arrayContaining(["config.json"])});
    const raw=new DatabaseSync(join(inspected.stateDirectory,"raw","memory-index.db"),{readOnly:true});try{
      expect(raw.prepare("SELECT text FROM entries WHERE id='remembered'").get()?.text).toBe("quartz lighthouse preference");expect(raw.prepare("SELECT COUNT(*) AS n FROM vectors").get()?.n).toBe(1);
    }finally{raw.close();}
    // Opening the copied WAL-mode database above can create new local sidecars;
    // its archive file list establishes that source WAL/SHM were never copied.
    for(const name of ["memory-index.db-wal","memory-index.db-shm"])expect(inspected.manifest.files.some(file=>file.path===`raw/${name}`)).toBe(false);
    for(const name of ["config.json","door-identity","folder-trust.json","skill-index.db"])expect(existsSync(join(inspected.stateDirectory,"raw",name))).toBe(false);
    expect(existsSync(join(inspected.stateDirectory,"recovery","memory-index.db"))).toBe(false);rmSync(inspected.directory,{recursive:true,force:true});
    const target=join(f.parent,"headless-restored"),restored=await restoreEncryptedInstallationNew(target,archive,saved.sha256,keys);
    expect(restored.rawFidelityActivated).toBe(false);expect(()=>assertRestoreReviewed(target)).toThrow();
    const config=JSON.parse(readFileSync(join(target,"config.json"),"utf8"));expect(config.engineDiscovery).toBe("explicit");expect(Object.values(config.instances).every((value:any)=>value.enabled===false)).toBe(true);
    for(const name of ["memory-index.db","door-identity","folder-trust.json","skill-index.db"])expect(existsSync(join(target,name))).toBe(false);
    const authority=new DatabaseSync(join(target,"messages.db"),{readOnly:true});let rows:any[],meta:any;
    try{
      meta=authority.prepare("SELECT * FROM memory_meta").get();expect(meta.mode).toBe("paused");
      expect(authority.prepare("SELECT * FROM memory_record_details WHERE record_id='remembered'").get()).toEqual(detailsOriginal);
      expect(authority.prepare("SELECT state FROM memory_records WHERE id='remembered'").get()?.state).toBe("active");expect(authority.prepare("SELECT state FROM memory_records WHERE id='forgotten'").get()?.state).toBe("deleted");
      expect(authority.prepare("SELECT target_id FROM memory_tombstones").get()?.target_id).toBe("forgotten");expect(authority.prepare("SELECT lexical_status FROM memory_projection_receipts WHERE record_id='remembered'").get()?.lexical_status).toBe("pending");
      rows=authority.prepare("SELECT id,version,scope_id,text,state FROM memory_records").all();
    }finally{authority.close();}
    // Offline reconstruction proof only; review/memory pause barriers remain set.
    const rebuilt=new MemoryIndex(join(f.parent,"rebuilt-memory-index.db")),eligibility=new MemoryEligibility(join(target,"messages.db"));
    try{
      rebuilt.upsert(rows.map(row=>({id:row.id,version:row.version,scopeId:row.scope_id,text:row.text,deleted:row.state==="deleted"})));
      const allowed=eligibility.read({scopeIds:["scope"],policyRevision:meta.policy_revision,deletionEpoch:meta.deletion_epoch,historical:false,cursor:""}).allowed;
      expect(rebuilt.search("quartz",allowed,null,"fixture-model").hits.map(hit=>hit.id)).toEqual(["remembered"]);
    }finally{rebuilt.close();eligibility.close();}
    paths.forEach((name,i)=>expect(readFileSync(join(f.data,name)),name).toEqual(originals[i]));expect(existsSync(join(f.data,"config.json"))).toBe(false);
  }finally{index.close();f.db.close();rmSync(f.parent,{recursive:true,force:true});}
},20000);
