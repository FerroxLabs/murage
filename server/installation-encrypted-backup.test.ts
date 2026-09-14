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
it("retains private staging when an owned tool close cannot be confirmed",async()=>{
  const f=backupFixture(),keys=testAgeKeys();
  const mocked=vi.spyOn(encryption,"encryptBackupStream").mockImplementationOnce(async(_tool,_recipient,input)=>{input.on("error",()=>{});throw new InstallationSnapshotError("AGE_PROCESS_CLOSE_UNCONFIRMED");});
  try{
    let failure:unknown;
    try{await writeEncryptedInstallationBackup(f.data,join(f.parent,"backup.age"),{...keys,selection});}catch(error){failure=error;}
    expect(failure).toMatchObject({code:"AGE_PROCESS_CLOSE_UNCONFIRMED",retainedDirectory:expect.any(String)});
    const retained=(failure as {retainedDirectory:string}).retainedDirectory;
    expect(existsSync(retained)).toBe(true);expect(readdirSync(retained).some(name=>name.startsWith(".murage-state-snapshot-"))).toBe(true);
    expect(existsSync(join(f.parent,"backup.age"))).toBe(false);
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
