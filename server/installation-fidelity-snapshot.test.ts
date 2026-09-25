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
  // Closing Murage mid skill-index build leaves its temp file and journal behind.
  for(const name of ["door-identity","folder-trust.json","pending-deletions.json","skill-index.db","skill-index.db-wal","skill-index.db-shm","skill-index.db.1268.ffjn5f.tmp","skill-index.db.1268.ffjn5f.tmp-journal"])writeFileSync(join(f.data,name),"private fixture");
  const before=new Map(["messages.db","messages.db-wal","memory-index.db","memory-index.db-wal"].map(name=>[name,readFileSync(join(f.data,name))]));
  try{await withOfflineInstallation(f.data,async installation=>{
    const stage=await stageInstallationStateWhileOwned(installation,f.parent);
    const inventory=await inventoryFidelity(installation,stage,selection);inventory.assertUnchanged();stage.assertSourceUnchanged();
    expect(inventory.coverage.components).toContainEqual(expect.objectContaining({path:"config.json",status:"missing"}));expect(existsSync(join(f.data,"config.json"))).toBe(false);
    for(const name of ["door-identity","folder-trust.json","pending-deletions.json","skill-index.db","skill-index.db.1268.ffjn5f.tmp","skill-index.db.1268.ffjn5f.tmp-journal"])expect(inventory.coverage.components).toContainEqual(expect.objectContaining({path:name,status:"excluded"}));
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
it("keeps the pre-memory-v2 snapshot out of state and fidelity backups without failing the sweep",async()=>{
  const f=backupFixture();writeFileSync(join(f.data,"messages.pre-memory-v2.db"),"pre-upgrade copy fixture");
  try{await withOfflineInstallation(f.data,async installation=>{
    const stage=await stageInstallationStateWhileOwned(installation,f.parent);
    expect(stage.manifest.files.some(file=>file.path==="messages.pre-memory-v2.db")).toBe(false);
    expect(stage.manifest.omitted.some(item=>item.path==="messages.pre-memory-v2.db")).toBe(true);
    const inventory=await inventoryFidelity(installation,stage,selection);
    expect(inventory.coverage.components).toContainEqual(expect.objectContaining({path:"messages.pre-memory-v2.db",status:"excluded"}));
    expect(inventory.sources.some(file=>file.path==="messages.pre-memory-v2.db")).toBe(false);
    expect(existsSync(join(f.data,"messages.pre-memory-v2.db"))).toBe(true);
  });}finally{f.db.close();rmSync(f.parent,{recursive:true,force:true});}
});
// Every name Murage itself writes at the data-folder root must be classified.
// setup.json (first run), queued-messages.json (F7), team-library/ and the
// rest arrived after the inventory lists did, and any one of them made every
// backup refuse with BACKUP_UNCLASSIFIED_COMPONENT.
it("classifies every root name Murage writes, keeping owner state and leaving caches out",async()=>{
  const f=backupFixture();
  const files:Record<string,string>={"setup.json":JSON.stringify({version:1,startedAt:1,steps:{},chiefBotId:"bot"}),"queued-messages.json":JSON.stringify([["thread",{items:[{text:"sent while it was busy"}]}]]),
    "coordination-roots.json":JSON.stringify({version:1,roots:[]}),"browser-control.json":"[]","flux-composio-broker-token.json":"{}","restore-review.json":"{}","restored-connections.json":"{}","perm-a1b2c3.sock":"",".DS_Store":""};
  const directories:Record<string,string>={"provider-catalogs":"catalog.json","managed-engines":"engine.bin","team-library":"catalog.json","memory-model":"model.onnx","providers":"credentials.json","flux-hermes-home":"config.yaml","local-models":"local-servers.json","tools":"agent-browser","recovery-quarantine":"old.json",".memory-evolution-a1B2c3":"scratch",".package-import-Z9y8X7":"staged.json"};
  for(const [name,body]of Object.entries(files))writeFileSync(join(f.data,name),body);
  for(const [name,child]of Object.entries(directories)){mkdirSync(join(f.data,name));writeFileSync(join(f.data,name,child),"fixture");}
  try{await withOfflineInstallation(f.data,async installation=>{
    const stage=await stageInstallationStateWhileOwned(installation,f.parent);
    const inventory=await inventoryFidelity(installation,stage,selection);inventory.assertUnchanged();
    for(const name of ["setup.json","queued-messages.json"]){
      expect(inventory.coverage.components).toContainEqual(expect.objectContaining({path:name,status:"included"}));
      expect(stage.manifest.files.some(file=>file.path===name)).toBe(true);
    }
    for(const name of [...Object.keys(files).filter(name=>!["setup.json","queued-messages.json"].includes(name)),...Object.keys(directories)]){
      expect(inventory.coverage.components).toContainEqual(expect.objectContaining({path:name,status:"excluded"}));
      expect(inventory.sources.some(file=>file.path===name||file.path.startsWith(`${name}/`))).toBe(false);
    }
    // Present only when Murage closed with a message still waiting: never "missing".
    expect(stage.manifest.missing).not.toContain("queued-messages.json");expect(stage.manifest.missing).not.toContain("setup.json");
  });}finally{f.db.close();rmSync(f.parent,{recursive:true,force:true});}
});
// An interrupted bot-package import is recovered at the next start. Until
// then bots.json may be half-way between two rosters, so it stays refused.
it("still refuses an unrecovered package-import transaction",async()=>{
  const f=backupFixture();mkdirSync(join(f.data,".package-import-transaction"));writeFileSync(join(f.data,".package-import-transaction","journal.json"),"{}");
  try{await expect(withOfflineInstallation(f.data,async installation=>{const stage=await stageInstallationStateWhileOwned(installation,f.parent);return inventoryFidelity(installation,stage,selection);})).rejects.toThrow("BACKUP_UNCLASSIFIED_COMPONENT");
  }finally{f.db.close();rmSync(f.parent,{recursive:true,force:true});}
});
