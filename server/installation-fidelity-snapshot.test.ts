import { existsSync,linkSync,mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect,it } from "vitest";
import { withOfflineInstallation } from "./installation-database-snapshot.ts";
import { stageInstallationStateWhileOwned } from "./installation-state-snapshot.ts";
import { inventoryFidelity } from "./installation-fidelity-snapshot.ts";
import { backupFixture } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { HEALTH_FILES, HEALTH_LIMITS } from "../shared/health-protocol.mjs";
import { HealthPublisher } from "./health/publisher.ts";
import { StatsPublisher } from "./health/stats-publisher.ts";
const selection={scope:"application-data",credentialPolicy:"preserve-in-encrypted-fidelity"} as const;
it("keeps fidelity metadata under the same lease and detects later component changes",async()=>{
  const f=backupFixture();try{await withOfflineInstallation(f.data,async installation=>{
    const stage=await stageInstallationStateWhileOwned(installation,f.parent);
    const inventory=await inventoryFidelity(installation,stage,selection);
    expect(inventory.coverage.fullInstallation).toBe(false);
    expect(inventory.sources.find(file=>file.path==="config.json")?.bytes).toBe(readFileSync(join(f.data,"config.json")).length);
    // Owner files are stored once, through the stage; the stage notices them.
    writeFileSync(join(f.data,"workspaces","report.md"),"changed");
    expect(stage.assertSourceUnchanged).toThrow();
    // Records keep a raw copy too; both notice those.
    writeFileSync(join(f.data,"config.json"),JSON.stringify({profile:{name:"Changed"}}));
    expect(inventory.assertUnchanged).toThrow();
  });}finally{f.db.close();removeTempDirSync(f.parent);}
});
it("leaves an unknown top-level file or folder out of selected coverage and lists it, without stopping",async()=>{
  const f=backupFixture();try{
    writeFileSync(join(f.data,"new-state.json"),"private unknown component");
    mkdirSync(join(f.data,"new-state"));writeFileSync(join(f.data,"new-state","a.json"),"private unknown component");
    await withOfflineInstallation(f.data,async installation=>{const stage=await stageInstallationStateWhileOwned(installation,f.parent);const inventory=await inventoryFidelity(installation,stage,selection);
      for(const name of ["new-state.json","new-state"]){
        expect(inventory.coverage.components).toContainEqual(expect.objectContaining({path:name,status:"excluded"}));
        expect(inventory.sources.some(file=>file.path===name||file.path.startsWith(`${name}/`))).toBe(false);
        expect(stage.manifest.files.some(file=>file.path===name||file.path.startsWith(`${name}/`))).toBe(false);
        expect(stage.manifest.skipped).toContainEqual({path:name,reason:"unrecognised"});
      }
      inventory.assertUnchanged();});
  }finally{f.db.close();removeTempDirSync(f.parent);}
});
// 0.1.60 audit A-01: a shortcut in a bot's folder is stored as a shortcut,
// never followed; one to a folder outside the data folder is also listed, so
// the owner knows its contents are not in the backup.
it("stores a shortcut to a folder outside the data folder without following it, and lists it",async()=>{
  const f=backupFixture();try{
    mkdirSync(join(f.parent,"outside"));writeFileSync(join(f.parent,"outside","private.txt"),"outside bytes");
    symlinkSync(join(f.parent,"outside"),join(f.data,"workspaces","linked"));
    await withOfflineInstallation(f.data,async installation=>{
      const stage=await stageInstallationStateWhileOwned(installation,f.parent);await inventoryFidelity(installation,stage,selection);
      expect(stage.manifest.links).toEqual([{path:"workspaces/linked",target:join(f.parent,"outside"),type:"dir"}]);
      expect(stage.manifest.files.some(file=>file.path.startsWith("workspaces/linked/"))).toBe(false);
      expect(stage.manifest.skipped).toContainEqual({path:"workspaces/linked",reason:"linked-folder"});
    });
  }finally{f.db.close();removeTempDirSync(f.parent);}
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
  });}finally{index.close();f.db.close();removeTempDirSync(f.parent);}
});
it.each(["symlink","hardlink","corrupt","orphan-wal"])("refuses unsafe memory projection: %s",async kind=>{
  const f=backupFixture(),target=join(f.data,"memory-index.db"),outside=join(f.parent,"outside.db");writeFileSync(outside,"outside preserved");
  try{
    if(kind==="symlink")symlinkSync(outside,target);else if(kind==="hardlink")linkSync(outside,target);else if(kind==="corrupt")writeFileSync(target,"not sqlite");else writeFileSync(target+"-wal","orphan");
    await expect(withOfflineInstallation(f.data,async installation=>{const stage=await stageInstallationStateWhileOwned(installation,f.parent);return inventoryFidelity(installation,stage,selection);})).rejects.toThrow();
    expect(readFileSync(outside,"utf8")).toBe("outside preserved");
  }finally{f.db.close();removeTempDirSync(f.parent);}
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
  });}finally{f.db.close();removeTempDirSync(f.parent);}
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
  });}finally{f.db.close();removeTempDirSync(f.parent);}
});
// What a bot learned from prospects stays on this computer (bot learning, B0).
it("leaves learning-local out of the backup stage and the fidelity inventory, without failing the sweep",async()=>{
  const f=backupFixture();mkdirSync(join(f.data,"learning-local","bot-1"),{recursive:true});writeFileSync(join(f.data,"learning-local","bot-1","guide.json"),"prospect-derived fixture");
  try{await withOfflineInstallation(f.data,async installation=>{
    const stage=await stageInstallationStateWhileOwned(installation,f.parent);
    expect(stage.manifest.files.some(file=>file.path==="learning-local"||file.path.startsWith("learning-local/"))).toBe(false);
    expect(stage.manifest.omitted.some(item=>item.path==="learning-local")).toBe(true);
    const inventory=await inventoryFidelity(installation,stage,selection);inventory.assertUnchanged();
    expect(inventory.coverage.components).toContainEqual(expect.objectContaining({path:"learning-local",status:"excluded"}));
    expect(inventory.sources.some(file=>file.path==="learning-local"||file.path.startsWith("learning-local/"))).toBe(false);
    expect(existsSync(join(f.data,"learning-local","bot-1","guide.json"))).toBe(true);
  });}finally{f.db.close();removeTempDirSync(f.parent);}
});
// An interrupted bot-package import is recovered at the next start. Until
// then bots.json may be half-way between two rosters, so it stays refused.
it("still refuses an unrecovered package-import transaction",async()=>{
  const f=backupFixture();mkdirSync(join(f.data,".package-import-transaction"));writeFileSync(join(f.data,".package-import-transaction","journal.json"),"{}");
  try{await expect(withOfflineInstallation(f.data,async installation=>{const stage=await stageInstallationStateWhileOwned(installation,f.parent);return inventoryFidelity(installation,stage,selection);})).rejects.toThrow("BACKUP_UNCLASSIFIED_COMPONENT");
  }finally{f.db.close();removeTempDirSync(f.parent);}
});
// 0.1.60 added four writers at the data-folder root and none was classified,
// so on a packaged 0.1.60 app EVERY backup refused with
// BACKUP_UNCLASSIFIED_COMPONENT once What's New had been shown (found
// 2026-09-26). Written here by the real modules, not by hand.
it("backs up a 0.1.60 data folder: What's New, announcements and House Rules kept, caches left out",async()=>{
  const f=backupFixture();
  const { markWhatsNewSeen }=await import("./whats-new.ts");
  const { saveHouseRules }=await import("./house-rules.ts");
  const { EngineCommandCache }=await import("./engine-commands.ts");
  markWhatsNewSeen("0.1.60",f.data);
  saveHouseRules({text:"Always answer in plain English.",enabled:true},f.data);
  new EngineCommandCache(f.data).record("bot-1","codex",[{name:"review",description:"Review"}]);
  // announcements.ts RECORD_FILE and CACHE_DIR, as Announcements writes them.
  writeFileSync(join(f.data,"announcements.json"),JSON.stringify({version:1,seen:["a1"],dismissed:[]}));
  mkdirSync(join(f.data,"announcements-cache"));writeFileSync(join(f.data,"announcements-cache","feed.json"),"{}");
  try{await withOfflineInstallation(f.data,async installation=>{
    const stage=await stageInstallationStateWhileOwned(installation,f.parent);
    const inventory=await inventoryFidelity(installation,stage,selection);inventory.assertUnchanged();
    for(const name of ["whats-new.json","announcements.json","house-rules.md","house-rules.json"]){
      expect(inventory.coverage.components).toContainEqual(expect.objectContaining({path:name,status:"included"}));
      expect(stage.manifest.files.some(file=>file.path===name)).toBe(true);
    }
    for(const name of ["announcements-cache","engine-commands.json"]){
      expect(inventory.coverage.components).toContainEqual(expect.objectContaining({path:name,status:"excluded"}));
      expect(inventory.sources.some(file=>file.path===name||file.path.startsWith(`${name}/`))).toBe(false);
    }
  });}finally{f.db.close();removeTempDirSync(f.parent);}
});
// skills.ts syncSkillLinks links every enabled skill into the bot workspace's
// .claude/.agents/.grok skills folders. Those links made EVERY backup of a bot
// with a skill stop with BACKUP_SELECTED_COMPONENT_UNAVAILABLE on the packaged
// 0.1.60 app (2026-09-26). They are left out and re-created; the skill itself
// is captured. A link that leads anywhere else is stored as a link.
it.each(["murage-skill-link","outside-link"])("backs up a bot with skills: %s",async kind=>{
  const f=backupFixture(),bot=join(f.data,"workspaces","bot-1"),skill=join(bot,"skills","brand-voice");
  mkdirSync(skill,{recursive:true});writeFileSync(join(skill,"SKILL.md"),"---\nname: brand-voice\n---\nWrite plainly.\n");
  mkdirSync(join(f.parent,"elsewhere"));
  for(const dir of [".claude/skills",".agents/skills",".grok/skills"]){
    mkdirSync(join(bot,dir),{recursive:true});
    symlinkSync(kind==="murage-skill-link"?skill:join(f.parent,"elsewhere"),join(bot,dir,"brand-voice"),"dir");
  }
  try{
    const run=()=>withOfflineInstallation(f.data,async installation=>{const stage=await stageInstallationStateWhileOwned(installation,f.parent);return{stage,inventory:await inventoryFidelity(installation,stage,selection)};});
    // 0.1.60 audit A-01: any other shortcut is stored as a shortcut (never
    // followed) and, pointing outside the data folder, listed.
    if(kind==="outside-link"){
      const {stage}=await run();
      expect(stage.manifest.links?.map(link=>link.path).sort()).toEqual([".agents",".claude",".grok"].map(dir=>`workspaces/bot-1/${dir}/skills/brand-voice`));
      expect(stage.manifest.skipped?.filter(item=>item.reason==="linked-folder").length).toBe(3);
      return;
    }
    const {stage}=await run();
    expect(stage.manifest.files.some(file=>file.path.replaceAll("\\","/")==="workspaces/bot-1/skills/brand-voice/SKILL.md")).toBe(true);
    expect(stage.manifest.omitted.filter(item=>item.path.replaceAll("\\","/").endsWith("/skills/brand-voice")).length).toBe(3);
  }finally{f.db.close();removeTempDirSync(f.parent);}
});
it("leaves the retired own connected-apps key out of the raw config copy and keeps the source",async()=>{
  const f=backupFixture();try{
    const config=JSON.stringify({profile:{name:"A"},composio:{apiKey:"ak_old_own_key_value",userId:"u"}});
    writeFileSync(join(f.data,"config.json"),config);
    await withOfflineInstallation(f.data,async installation=>{
      const stage=await stageInstallationStateWhileOwned(installation,f.parent);
      const inventory=await inventoryFidelity(installation,stage,selection);
      const raw=inventory.sources.find(file=>file.path==="config.json")!;
      const copy=readFileSync(raw.source,"utf8");
      expect(copy).not.toContain("ak_old_own_key_value");
      expect(JSON.parse(copy).profile.name).toBe("A");
      expect(readFileSync(join(f.data,"config.json"),"utf8")).toBe(config);
      stage.assertSourceUnchanged();inventory.assertUnchanged();
    });
  }finally{f.db.close();removeTempDirSync(f.parent);}
});

// 1.0.9 Sentinel (GAP-SENTINEL-109 section 13, SENTINEL-PRODUCERS): DATA_DIR/health is runtime metadata. A capture with it
// present (segments, sealed stats generations, manifests, an interrupted temporary child) completes and stores none of it;
// publishing below the root during a capture keeps the capture's membership; a capture that began without the root keeps
// that membership because the publisher defers instead of creating it; an outside change to the top level still stops it.
const healthWindow=(seq:number)=>({schemaVersion:1 as const,installationId:"e".repeat(32),producer:"server" as const,epoch:7,seq,startAt:1_793_000_000_000+seq*60_000,endAt:1_793_000_060_000+seq*60_000,activeMs:60_000,complete:true,omitted:0,coverageByDetector:{backup:"complete" as const},counters:[],facts:[],lifecycle:"running" as const});
async function populatedHealth(data:string){
  let now=1_793_000_000_000;const publisher=new HealthPublisher({dataDir:data,now:()=>now});
  expect(publisher.initialize()).toBe("ready");
  await publisher.appendWindow("server",healthWindow(0));await publisher.appendWindow("desktop",{...healthWindow(0),producer:"desktop"});
  writeFileSync(join(data,"health",HEALTH_FILES.serverPrevious),"{}\n",{mode:0o600});
  const stats=new StatsPublisher({publisher,installationId:"e".repeat(32),now:()=>now});
  expect(await stats.publishStatsGeneration({at:now,rows:[{role:"messages",page_size:4096,page_count:10}]})).not.toBeNull();
  now+=1000;expect(await stats.publishStatsGeneration({at:now,rows:[{role:"messages",page_size:4096,page_count:11}]})).not.toBeNull();
  expect(publisher.replaceManifest(HEALTH_FILES.backupStatus,JSON.stringify({placeholder:true}))).toBe(true);
  writeFileSync(join(data,"health",".tmp-0123456789abcdef.sqlite"),"interrupted",{mode:0o600});
  return {publisher,advance:(ms:number)=>{now+=ms;}};
}
const healthStored=(paths:string[])=>paths.filter(path=>path==="health"||path.startsWith("health/"));
it("captures with health/ present, stores none of it, and publication below it during the capture keeps membership",async()=>{
  const f=backupFixture();try{
    const {publisher,advance}=await populatedHealth(f.data);
    await withOfflineInstallation(f.data,async installation=>{
      const stage=await stageInstallationStateWhileOwned(installation,f.parent);
      const inventory=await inventoryFidelity(installation,stage,selection);
      expect(healthStored([...stage.manifest.files.map(file=>file.path),...inventory.sources.map(file=>file.path)])).toEqual([]);
      expect(inventory.coverage.components).toContainEqual(expect.objectContaining({path:"health",status:"excluded"}));
      expect((stage.manifest.skipped??[]).map(item=>item.path)).not.toContain("health");
      // Child rotation, a new window and a manifest replacement while the capture runs.
      writeFileSync(join(f.data,"health",HEALTH_FILES.serverCurrent),"x".repeat(HEALTH_LIMITS.producerSegmentBytes)+"\n",{mode:0o600});
      const again=new HealthPublisher({dataDir:f.data,deferWhileCaptureActive:()=>true});expect(again.initialize()).toBe("ready");
      advance(60_000);expect(await again.appendWindow("server",healthWindow(1))).toBe(true);
      expect(publisher.replaceManifest(HEALTH_FILES.backupStatus,JSON.stringify({placeholder:2}))).toBe(true);
      stage.assertSourceUnchanged();inventory.assertUnchanged();
    });
    expect(readFileSync(join(f.data,"health",".tmp-0123456789abcdef.sqlite"),"utf8")).toBe("interrupted"); // never touched by the backup
  }finally{f.db.close();removeTempDirSync(f.parent);}
});
it("a capture that began without health/ keeps its membership: the publisher defers instead of creating the root",async()=>{
  const f=backupFixture();let capturing=false;try{
    await withOfflineInstallation(f.data,async installation=>{
      capturing=true;
      const stage=await stageInstallationStateWhileOwned(installation,f.parent);
      const publisher=new HealthPublisher({dataDir:f.data,deferWhileCaptureActive:()=>capturing});
      expect(publisher.initialize()).toBe("publication-deferred");
      expect(publisher.replaceManifest(HEALTH_FILES.backupStatus,"{}")).toBe(false);
      expect(await publisher.appendWindow("server",healthWindow(0))).toBe(false);
      expect(existsSync(join(f.data,"health"))).toBe(false);
      stage.assertSourceUnchanged();
      capturing=false;
    });
    expect(new HealthPublisher({dataDir:f.data}).initialize()).toBe("ready"); // the next owned boundary creates it
  }finally{f.db.close();removeTempDirSync(f.parent);}
});
it("an outside change to the top level during a capture still stops it with SOURCE_CHANGED",async()=>{
  const f=backupFixture();try{
    await withOfflineInstallation(f.data,async installation=>{
      const stage=await stageInstallationStateWhileOwned(installation,f.parent);
      mkdirSync(join(f.data,"health"),{mode:0o700}); // not through the publisher, mid-capture
      expect(stage.assertSourceUnchanged).toThrow(/SOURCE_CHANGED/);
    });
  }finally{f.db.close();removeTempDirSync(f.parent);}
});
