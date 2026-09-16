import { existsSync,linkSync,mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect,it } from "vitest";
import { withOfflineInstallation } from "./installation-database-snapshot.ts";
import { stageInstallationStateWhileOwned } from "./installation-state-snapshot.ts";
import { inventoryFidelity } from "./installation-fidelity-snapshot.ts";
import { backupFixture } from "./testing/backup-fixture.ts";
const selection={scope:"application-data",credentialPolicy:"preserve-in-encrypted-fidelity"} as const;
it("keeps fidelity metadata under the same lease and detects later component changes",async()=>{
  const f=backupFixture();try{await withOfflineInstallation(f.data,async installation=>{
    const stage=await stageInstallationStateWhileOwned(installation,f.parent);
    const inventory=await inventoryFidelity(installation,stage,selection);
    expect(inventory.coverage.fullInstallation).toBe(false);
    expect(inventory.sources.find(file=>file.path==="config.json")?.bytes).toBe(readFileSync(join(f.data,"config.json")).length);
    writeFileSync(join(f.data,"workspaces","report.md"),"changed");
    expect(inventory.assertUnchanged).toThrow();expect(stage.assertSourceUnchanged).toThrow();
  });}finally{f.db.close();rmSync(f.parent,{recursive:true,force:true});}
});
it.each(["unknown","symlink"])("refuses incomplete selected coverage: %s",async kind=>{
  const f=backupFixture();try{
    if(kind==="unknown")writeFileSync(join(f.data,"new-state.json"),"private unknown component");
    else{mkdirSync(join(f.parent,"outside"));symlinkSync(join(f.parent,"outside"),join(f.data,"workspaces","linked"));}
    await expect(withOfflineInstallation(f.data,async installation=>{const stage=await stageInstallationStateWhileOwned(installation,f.parent);return inventoryFidelity(installation,stage,selection);})).rejects.toThrow();
  }finally{f.db.close();rmSync(f.parent,{recursive:true,force:true});}
});

it("accepts unsaved headless config and consistently snapshots memory projection without restoring authority files",async()=>{
  const f=backupFixture(),indexFile=join(f.data,"memory-index.db");rmSync(join(f.data,"config.json"));
  const index=new DatabaseSync(indexFile);index.exec("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE entries(text TEXT);INSERT INTO entries VALUES('committed WAL memory')");
  for(const name of ["door-identity","folder-trust.json","skill-index.db","skill-index.db-wal","skill-index.db-shm"])writeFileSync(join(f.data,name),"private fixture");
  const before=new Map(["messages.db","messages.db-wal","memory-index.db","memory-index.db-wal"].map(name=>[name,readFileSync(join(f.data,name))]));
  try{await withOfflineInstallation(f.data,async installation=>{
    const stage=await stageInstallationStateWhileOwned(installation,f.parent);
    const inventory=await inventoryFidelity(installation,stage,selection);inventory.assertUnchanged();stage.assertSourceUnchanged();
    expect(inventory.coverage.components).toContainEqual(expect.objectContaining({path:"config.json",status:"missing"}));expect(existsSync(join(f.data,"config.json"))).toBe(false);
    for(const name of ["door-identity","folder-trust.json","skill-index.db"])expect(inventory.coverage.components).toContainEqual(expect.objectContaining({path:name,status:"excluded"}));
    expect(stage.manifest.files.some(file=>file.path==="memory-index.db")).toBe(false);
    const memory=inventory.sources.find(file=>file.path==="memory-index.db")!;expect(memory).toBeDefined();
    expect(inventory.sources.some(file=>file.path.endsWith("-wal")||file.path.endsWith("-shm"))).toBe(false);
    const copied=new DatabaseSync(memory.source,{readOnly:true});try{expect(copied.prepare("SELECT text FROM entries").get()?.text).toBe("committed WAL memory");}finally{copied.close();}
    for(const [name,bytes]of before)expect(readFileSync(join(f.data,name))).toEqual(bytes);
    index.exec("INSERT INTO entries VALUES('unexpected concurrent edit')");expect(inventory.assertUnchanged).toThrow();
  });}finally{index.close();f.db.close();rmSync(f.parent,{recursive:true,force:true});}
});
it.each(["symlink","hardlink","corrupt","orphan-wal"])("refuses unsafe memory projection: %s",async kind=>{
  const f=backupFixture(),target=join(f.data,"memory-index.db"),outside=join(f.parent,"outside.db");writeFileSync(outside,"outside preserved");
  try{
    if(kind==="symlink")symlinkSync(outside,target);else if(kind==="hardlink")linkSync(outside,target);else if(kind==="corrupt")writeFileSync(target,"not sqlite");else writeFileSync(target+"-wal","orphan");
    await expect(withOfflineInstallation(f.data,async installation=>{const stage=await stageInstallationStateWhileOwned(installation,f.parent);return inventoryFidelity(installation,stage,selection);})).rejects.toThrow();
    expect(readFileSync(outside,"utf8")).toBe("outside preserved");
  }finally{f.db.close();rmSync(f.parent,{recursive:true,force:true});}
});
