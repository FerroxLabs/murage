import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { createProcedurePin, preparePinnedProcedures, procedurePinServesTurn, readProcedureBundle, skillLinkNotice } from "./procedure-bundles.ts";
import * as bundleExports from "./procedure-bundles.ts";
import { emulateElectronWindowsRmSync } from "./testing/electron-windows-rmsync.ts";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { applyStagedSkillWrite, installSkill, migrateSkillDiscoveryToTasks, rollbackSkillRevision, setSkillEnabled, skillRevisionHistory, stageSkillWrite, syncSkillLinks, skillEvolutionDescriptor } from "./skills.ts";
import { loadBundledSkills, loadUserSkills, mergeSkills, renderSkillInstructions, selectBundledSkills, shippedSkillCheck, type BundledSkill } from "./skill-library.ts";
import { installedPlaybookInstructions } from "./installed-playbooks.ts";
import { taskWorkspacePath, workspaceDir } from "./workspace.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const owned:string[]=[];
const bot=()=>{const id=`procedure-test-${randomUUID()}`;owned.push(join(DATA_DIR,"workspaces",id),join(DATA_DIR,"skill-state",id));return id;};
afterEach(()=>{for(const path of owned.splice(0))removeTempDirSync(path);});
const md=(body:string)=>`---\nname: checked-method\ndescription: Check a result\n---\n${body}\n`;
function learned(id:string,body:string,action:"create"|"update"="create"){
  const staged=stageSkillWrite(id,{action,targetName:action==="update"?"checked-method":undefined,source:"learn:fixture",files:[{path:"SKILL.md",content:md(body)}]});
  if("error" in staged)throw new Error(staged.error);
  const applied=applyStagedSkillWrite(id,staged.id,{expectedSha256:staged.sha256});if("error" in applied)throw new Error(applied.error);
  return staged.id;
}
it("actual skill selection and playbook rendering stay frozen across definition edits and reload",()=>{
  const id=bot(),thread="task-one",root=join(workspaceDir(id),"catalogue-source","check");mkdirSync(root,{recursive:true});
  writeFileSync(join(root,"SKILL.md"),md("Original check"));writeFileSync(join(root,"helper.py"),"print('original')\n");
  const catalogue:BundledSkill[]=[{manifest:{id:"check",name:"Check",version:"1.0.0",description:"Check",defaultEnabled:true,triggerTerms:["verify"],requiredCapabilities:[]},instructions:md("Original check").trim(),directory:root}];
  const playbooks=[{key:"check",name:"Check",summary:"check",triggers:["verify"],instructions:"Original playbook"}];
  const pin=createProcedurePin(id,thread,catalogue,playbooks,undefined,undefined,{ownerTurn:true,shipped:()=>true});
  writeFileSync(join(root,"SKILL.md"),md("Changed check"));catalogue[0]!.instructions=md("Changed check");playbooks[0]!.instructions="Changed playbook";
  const restored=preparePinnedProcedures(id,thread,JSON.parse(JSON.stringify(pin)),true);
  expect(renderSkillInstructions(selectBundledSkills("verify",[],restored.catalogue))).toContain("Original check");
  expect(installedPlaybookInstructions("verify",restored.playbooks)).toContain("Original playbook");
  expect(readFileSync(join(restored.catalogue[0]!.directory,"helper.py"),"utf8")).toContain("original");
});
// The owner's recording fixture: a shipped skill and the owner's own recording, in one catalogue.
function ownerCatalogue(id:string){
  const base=join(workspaceDir(id),"audience-catalogue");
  const write=(root:string,skillId:string,extra:Record<string,unknown>)=>{
    const dir=join(root,skillId);mkdirSync(join(dir,"references"),{recursive:true});
    writeFileSync(join(dir,"manifest.json"),JSON.stringify({id:skillId,name:skillId,version:"1.0.0",description:"Recorded",defaultEnabled:true,triggerTerms:["expense"],requiredCapabilities:[],...extra}));
    writeFileSync(join(dir,"SKILL.md"),`---\nname: ${skillId}\ndescription: Recorded\n---\nWindow title: ${skillId==="recorded-expense"?"Payroll":"Shipped"}.\n`);
    writeFileSync(join(dir,"references","recording.json"),`{"windowTitle":"${skillId==="recorded-expense"?"Payroll":"Shipped"}"}\n`);
  };
  write(join(base,"shipped"),"shipped-check",{});write(join(base,"user"),"recorded-expense",{audience:"owner"});
  const shipped=loadBundledSkills(join(base,"shipped"));
  return {catalogue:mergeSkills(shipped,loadUserSkills(join(base,"user"))),isShipped:shippedSkillCheck(shipped)};
}
// Every regular file under a folder, read without following a link: what an engine with this folder as its cwd can open.
function filesUnder(root:string):string[]{
  if(!existsSync(root))return [];
  const out:string[]=[];
  const walk=(dir:string)=>{for(const name of readdirSync(dir)){const full=join(dir,name),stat=fs.lstatSync(full);if(stat.isSymbolicLink())continue;if(stat.isDirectory())walk(full);else if(stat.isFile())out.push(full);}};
  walk(root);return out;
}
const deskHolds=(id:string,thread:string,text:string)=>filesUnder(taskWorkspacePath(DATA_DIR,id,thread)).filter(path=>readFileSync(path,"utf8").includes(text));
it("an owner turn gets its recording from app state; the task's desk never holds it, and a non-owner turn never reuses that pin",()=>{
  const id=bot(),thread="room-task",{catalogue,isShipped}=ownerCatalogue(id);
  const ownerPin=createProcedurePin(id,thread,catalogue,[],undefined,undefined,{ownerTurn:true,shipped:isShipped});
  expect(readProcedureBundle(id,thread,ownerPin).files.filter(file=>file.path.includes("recorded-expense")).map(file=>file.path).sort())
    .toEqual(["owner/recorded-expense/SKILL.md","owner/recorded-expense/manifest.json","owner/recorded-expense/references/recording.json"]);
  const owner=preparePinnedProcedures(id,thread,ownerPin,true);
  // the owner's turn still has its recording: its text for the prompt, and its frames under the skill's root
  const recorded=owner.catalogue.find(skill=>skill.manifest.id==="recorded-expense")!;
  expect(renderSkillInstructions(selectBundledSkills("expense",[],owner.catalogue),{includeRoot:true})).toContain("Window title: Payroll.");
  expect(readFileSync(join(recorded.directory,"references","recording.json"),"utf8")).toContain("Payroll");
  expect(owner.ownerRoot).toBe(join(DATA_DIR,"skill-state",id,"task-bundles",thread,"owner",ownerPin.bundleId));
  expect(recorded.directory.startsWith(owner.ownerRoot!)).toBe(true);
  // the shipped skill is on the desk as before; nothing of the owner's is
  expect(owner.catalogue.find(skill=>skill.manifest.id==="shipped-check")!.directory.startsWith(taskWorkspacePath(DATA_DIR,id,thread))).toBe(true);
  expect(deskHolds(id,thread,"Payroll")).toEqual([]);
  expect(procedurePinServesTurn(id,thread,ownerPin,true)).toBe(true);
  expect(procedurePinServesTurn(id,thread,ownerPin,false)).toBe(false);
  // a later turn in the same desk that does not answer the owner pins its own, which holds none of it
  const roomPin=createProcedurePin(id,thread,catalogue,[],undefined,undefined,{ownerTurn:false,shipped:isShipped});
  expect(readProcedureBundle(id,thread,roomPin).files.some(file=>file.path.startsWith("owner/")||file.path.includes("recorded-expense"))).toBe(false);
  expect(procedurePinServesTurn(id,thread,roomPin,false)).toBe(true);
  expect(procedurePinServesTurn(id,thread,roomPin,true)).toBe(false);
  const room=preparePinnedProcedures(id,thread,roomPin,true);
  expect(room.catalogue.map(skill=>skill.manifest.id)).toEqual(["shipped-check"]);
  expect(room.ownerRoot).toBeUndefined();
  expect(deskHolds(id,thread,"Payroll")).toEqual([]);
  // the owner's next turn gets the same pin and its recording back, with nothing to rewrite
  const again=createProcedurePin(id,thread,catalogue,[],undefined,undefined,{ownerTurn:true,shipped:isShipped});
  expect(again.bundleId).toBe(ownerPin.bundleId);
  expect(readFileSync(join(preparePinnedProcedures(id,thread,again,false).catalogue.find(skill=>skill.manifest.id==="recorded-expense")!.directory,"SKILL.md"),"utf8")).toContain("Payroll");
});
it("a pin written before whom it serves was recorded serves no turn, so its desk copy is never written again",()=>{
  const id=bot(),thread="legacy",root=join(DATA_DIR,"skill-state",id,"task-bundles",thread);mkdirSync(root,{recursive:true});
  const bytes=JSON.stringify({schema:1,botId:id,threadId:thread,imported:[],catalogue:[],playbooks:[],files:[]});
  const bundleId=createHash("sha256").update(bytes).digest("hex");writeFileSync(join(root,`${bundleId}.json`),bytes);
  const legacy={schema:1 as const,bundleId};
  expect(readProcedureBundle(id,thread,legacy).ownerTurn).toBeUndefined();
  expect(procedurePinServesTurn(id,thread,legacy,true)).toBe(false);
  expect(procedurePinServesTurn(id,thread,legacy,false)).toBe(false);
  // an owner file in a pin that is not an owner turn's is refused, never projected anywhere
  const forged=JSON.stringify({schema:1,botId:id,threadId:thread,imported:[],catalogue:[],playbooks:[],ownerTurn:false,
    files:[{path:"owner/x/SKILL.md",bytes:Buffer.from("Payroll").toString("base64"),sha256:createHash("sha256").update("Payroll").digest("hex"),executable:false}]});
  const forgedId=createHash("sha256").update(forged).digest("hex");writeFileSync(join(root,`${forgedId}.json`),forged);
  expect(()=>preparePinnedProcedures(id,thread,{schema:1,bundleId:forgedId},false)).toThrow(/Pinned procedures/u);
  expect(existsSync(join(root,"owner",forgedId))).toBe(false);
  expect(deskHolds(id,thread,"Payroll")).toEqual([]);
});
it("turns pin from the audience's catalogue on direct and room turns, with no sweep, retire or folder delete left",()=>{
  const index=readFileSync(join(import.meta.dirname,"index.ts"),"utf8"),source=readFileSync(join(import.meta.dirname,"procedure-bundles.ts"),"utf8");
  expect(index).toContain("const pinAudience = { ownerTurn: directOwnerAudience && ownServersAllowedFor(bot), shipped: murageSkill };");
  expect(index).toContain("const pinAudience = { ownerTurn: roomOwnerAudience && ownServersAllowedFor(bot), shipped: murageSkill };");
  expect(index.match(/procedureContext\(bot\.id,threadId\), pinAudience\)/gu)).toHaveLength(2);
  for(const gone of ["clearOwnerProjections","retireOwnerPin","retireBundle"]){expect(index).not.toContain(gone);expect(source).not.toContain(gone);}
  expect(source).not.toContain("rmdirSync");
  expect(source).not.toMatch(/recursive\s*:\s*true/u);
  // the owner's folder is handed only to the owner's own turn, on the terms of every other read folder
  expect(index).toContain("if (bot.autoApprove === true && pinAudience.ownerTurn && !opts?.projectCardRun && !opts?.sharedWorkRun && opts?.runOn !== \"cloud\" && pinnedProcedures.ownerRoot) grantedDirs.push(pinnedProcedures.ownerRoot);");
});
it("renaming the desk's projection folder exposes nothing of the owner's, before or after a turn that does not answer the owner",()=>{
  const id=bot(),thread="renamed",{catalogue,isShipped}=ownerCatalogue(id);
  const ownerPin=createProcedurePin(id,thread,catalogue,[],undefined,undefined,{ownerTurn:true,shipped:isShipped});
  preparePinnedProcedures(id,thread,ownerPin,false);
  const procedures=join(taskWorkspacePath(DATA_DIR,id,thread),".murage-procedures");
  fs.renameSync(join(procedures,ownerPin.bundleId),join(procedures,`${ownerPin.bundleId}.bak`));
  expect(deskHolds(id,thread,"Payroll")).toEqual([]);
  const roomPin=createProcedurePin(id,thread,catalogue,[],undefined,undefined,{ownerTurn:false,shipped:isShipped});
  preparePinnedProcedures(id,thread,roomPin,true);
  expect(deskHolds(id,thread,"Payroll")).toEqual([]);
  expect(deskHolds(id,thread,"Shipped").length).toBeGreaterThan(0);
});
it("a symlinked ancestor of the owner's folder is refused, and nothing outside it is written or removed",()=>{
  const id=bot(),thread="linked",{catalogue,isShipped}=ownerCatalogue(id);
  const pin=createProcedurePin(id,thread,catalogue,[],undefined,undefined,{ownerTurn:true,shipped:isShipped});
  const outside=join(workspaceDir(id),"outside");mkdirSync(join(outside,pin.bundleId,"owner","recorded-expense","references"),{recursive:true});
  writeFileSync(join(outside,"keep.txt"),"keep");
  const before=filesUnder(outside).concat(readdirSync(join(outside,pin.bundleId,"owner","recorded-expense")));
  symlinkSync(outside,join(DATA_DIR,"skill-state",id,"task-bundles",thread,"owner"),"dir");
  expect(()=>preparePinnedProcedures(id,thread,pin,false)).toThrow(/Pinned procedures/u);
  expect(existsSync(join(outside,pin.bundleId,"owner","recorded-expense","references"))).toBe(true);
  expect(filesUnder(outside).concat(readdirSync(join(outside,pin.bundleId,"owner","recorded-expense")))).toEqual(before);
  expect(deskHolds(id,thread,"Payroll")).toEqual([]);
});
it("a non-owner turn's procedure work stays flat however many pins the task has had",()=>{
  const {catalogue,isShipped}=ownerCatalogue(bot());
  const listed=(history:number)=>{
    const id=bot(),thread=`history-${history}`;
    for(let i=0;i<history;i++){
      const playbooks=[{key:`p${i}`,name:`P${i}`,summary:"s",triggers:["t"],instructions:`run ${i}`}];
      preparePinnedProcedures(id,thread,createProcedurePin(id,thread,catalogue,playbooks,undefined,undefined,{ownerTurn:i%2===0,shipped:isShipped}),true);
    }
    expect(readdirSync(join(taskWorkspacePath(DATA_DIR,id,thread),".murage-procedures")).length).toBe(Math.max(history,1));
    const room=createProcedurePin(id,thread,catalogue,[],undefined,undefined,{ownerTurn:false,shipped:isShipped});
    preparePinnedProcedures(id,thread,room,true);
    const holder=fs as unknown as Record<string,unknown>,original=fs.readdirSync,calls:string[]=[];
    const put=(value:unknown)=>{Object.defineProperty(holder,"readdirSync",{value,writable:true,configurable:true,enumerable:true});syncBuiltinESMExports();};
    put((path:string,options?:object)=>{calls.push(String(path));return original(path,options as never);});
    try{
      // the per-turn steps of a turn that does not answer the owner (index.ts taskPinFits, then the projection)
      expect(procedurePinServesTurn(id,thread,room,false)).toBe(true);
      preparePinnedProcedures(id,thread,room,true);
    }finally{put(original);}
    expect(calls.some(path=>path.endsWith(".murage-procedures"))).toBe(false);
    return calls.length;
  };
  // no step lists the task's earlier projections (the sweep before a non-owner turn is gone)
  expect(Object.keys(bundleExports)).not.toContain("clearOwnerProjections");
  expect(listed(40)).toBe(listed(1));
});
it("refuses a pin that does not say whom its turn answers",()=>{
  const id=bot();
  expect(()=>createProcedurePin(id,"no-audience",[],[],undefined,undefined,undefined as never)).toThrow("PROCEDURE_AUDIENCE_REQUIRED");
  expect(()=>createProcedurePin(id,"no-audience",[],[],undefined,undefined,{ownerTurn:true} as never)).toThrow("PROCEDURE_AUDIENCE_REQUIRED");
  expect(existsSync(join(DATA_DIR,"skill-state",id,"task-bundles","no-audience"))).toBe(false);
});
// A Windows install ships bundled skills with CRLF line endings; the loader
// reads them as LF, and the pin still matches the bytes on disk.
it("pins a catalogue skill whose file has CRLF line endings",()=>{
  const id=bot(),root=join(workspaceDir(id),"catalogue-crlf","check");mkdirSync(root,{recursive:true});
  writeFileSync(join(root,"SKILL.md"),md("Line one\nLine two").replace(/\n/g,"\r\n"));
  writeFileSync(join(root,"manifest.json"),JSON.stringify({id:"check",name:"Check",version:"1.0.0",description:"Check",defaultEnabled:true,triggerTerms:["verify"],requiredCapabilities:[]}));
  const catalogue=loadBundledSkills(join(root,".."));
  expect(catalogue).toHaveLength(1);expect(catalogue[0]!.instructions).not.toContain("\r");
  const pin=createProcedurePin(id,"crlf-task",catalogue,[],undefined,undefined,{ownerTurn:true,shipped:()=>true});
  const restored=preparePinnedProcedures(id,"crlf-task",pin,true);
  expect(renderSkillInstructions(selectBundledSkills("verify",[],restored.catalogue))).toContain("Line one\nLine two");
});
it("copies complete imported support bytes and native links follow this task rather than live updates",()=>{
  const id=bot();expect(installSkill(id,"fixture",[{path:"SKILL.md",content:md("Original")}])).not.toHaveProperty("error");
  const source=join(workspaceDir(id),"skills","checked-method");mkdirSync(join(source,"references"));writeFileSync(join(source,"references","check.txt"),"support bytes");setSkillEnabled(id,"checked-method",true);
  const pin=createProcedurePin(id,"first",[],[],undefined,undefined,{ownerTurn:true,shipped:()=>true});
  expect(skillEvolutionDescriptor(id,"checked-method")).toBeNull();
  expect(readProcedureBundle(id,"first",pin).imported[0]).toMatchObject({editable:false,revision:null});
  migrateSkillDiscoveryToTasks(id);
  const first=preparePinnedProcedures(id,"first",pin,true);
  const link=join(taskWorkspacePath(DATA_DIR,id,"first"),".agents","skills","checked-method");
  expect(readFileSync(join(readlinkSync(link),"references","check.txt"),"utf8")).toBe("support bytes");
  setSkillEnabled(id,"checked-method",false);syncSkillLinks(id);
  expect(preparePinnedProcedures(id,"first",pin,true).importedPrompt).toBe(first.importedPrompt);
  expect(createProcedurePin(id,"next",[],[],undefined,undefined,{ownerTurn:true,shipped:()=>true})).not.toEqual(pin);
  expect(preparePinnedProcedures(id,"next",createProcedurePin(id,"next",[],[],undefined,undefined,{ownerTurn:true,shipped:()=>true}),false).importedPrompt).toBe("");
});
it("rollback through the actual staged publisher changes future tasks and rejects stale owner state",()=>{
  const id=bot(),old=learned(id,"Use original verification"),pin=createProcedurePin(id,"first",[],[],undefined,undefined,{ownerTurn:true,shipped:()=>true});
  preparePinnedProcedures(id,"first",pin,true);
  expect(readProcedureBundle(id,"first",pin).imported[0]).toMatchObject({revision:old,editable:true,enabled:true});
  const next=learned(id,"Use improved verification","update");
  expect(skillEvolutionDescriptor(id,"checked-method")).toMatchObject({revision:next,enabled:true});
  expect(readProcedureBundle(id,"first",pin).imported[0]!.revision).toBe(old);
  expect(skillRevisionHistory(id,"checked-method")?.revisions.some(item=>item.revision===old)).toBe(true);
  expect(rollbackSkillRevision(id,"checked-method",old,old)).toHaveProperty("error");
  expect(rollbackSkillRevision(id,"checked-method",next,old)).not.toHaveProperty("error");
  expect(skillEvolutionDescriptor(id,"checked-method")?.revision).not.toBe(old);
  expect(skillRevisionHistory(id,"checked-method")?.current).toMatchObject({origin:"rollback",rollbackOf:old});
  expect(rollbackSkillRevision(id,"checked-method",old,next)).toHaveProperty("error");
  expect(preparePinnedProcedures(id,"first",pin,true).importedPrompt).toContain("checked-method");
  const future=readProcedureBundle(id,"future",createProcedurePin(id,"future",[],[],undefined,undefined,{ownerTurn:true,shipped:()=>true}));
  expect(Buffer.from(future.files.find(file=>file.path.endsWith("SKILL.md"))!.bytes,"base64").toString()).toContain("original verification");
});
it("missing or changed pinned materialization fails without using current skill bytes",()=>{
  const id=bot();learned(id,"Original");const pin=createProcedurePin(id,"task",[],[],undefined,undefined,{ownerTurn:true,shipped:()=>true});preparePinnedProcedures(id,"task",pin,true);
  const path=join(taskWorkspacePath(DATA_DIR,id,"task"),".murage-procedures",pin.bundleId,"skills","checked-method","SKILL.md");
  rmSync(path);expect(()=>preparePinnedProcedures(id,"task",pin,true)).toThrow("Pinned procedures");
  const state=join(DATA_DIR,"skill-state",id,"task-bundles","task",`${pin.bundleId}.json`);writeFileSync(state,"{}");
  expect(()=>readProcedureBundle(id,"task",pin)).toThrow("Pinned procedures");
});
it("custom folder is unchanged while prompt references immutable absolute bytes",()=>{
  const id=bot();learned(id,"Original");const custom=join(workspaceDir(id),"custom-project");mkdirSync(custom);writeFileSync(join(custom,"user.txt"),"keep");
  const before=readdirSync(custom),pin=createProcedurePin(id,"custom-task",[],[],undefined,undefined,{ownerTurn:true,shipped:()=>true});
  const result=preparePinnedProcedures(id,"custom-task",pin,false);
  // The prompt names the path as a JSON string (backslashes doubled on Windows).
  expect(result.importedPrompt).toContain(JSON.stringify(taskWorkspacePath(DATA_DIR,id,"custom-task")).slice(1,-1));
  expect(readdirSync(custom)).toEqual(before);expect(readFileSync(join(custom,"user.txt"),"utf8")).toBe("keep");
});
it("another room responder cannot consume this bot's pinned catalogue",()=>{
  const first=bot(),second=bot();const pin=createProcedurePin(first,"room",[],[],undefined,undefined,{ownerTurn:true,shipped:()=>true});
  expect(()=>readProcedureBundle(second,"room",pin)).toThrow();
});
// AFTER-REVIEW: a brand new lead's room wake and its review started together,
// and each refused to migrate because the other was running.
it("a bot with nothing to move migrates while another of its turns runs; an old app link still waits",()=>{
  const fresh=bot();
  expect(()=>migrateSkillDiscoveryToTasks(fresh,false)).not.toThrow();
  expect(existsSync(join(DATA_DIR,"skill-state",fresh,"task-discovery.json"))).toBe(true);
  const old=bot(),root=workspaceDir(old);
  mkdirSync(join(root,"skills","old-habit"),{recursive:true});writeFileSync(join(root,"skills","old-habit","SKILL.md"),"Old habit");
  mkdirSync(join(root,".claude","skills"),{recursive:true});symlinkSync("../../skills/old-habit",join(root,".claude","skills","old-habit"));
  // a user's own native skill is not the app's to move, and does not hold the move
  mkdirSync(join(root,".agents","skills","owner-only"),{recursive:true});writeFileSync(join(root,".agents","skills","owner-only","SKILL.md"),"Owner native skill");
  expect(()=>migrateSkillDiscoveryToTasks(old,false)).toThrow("another active task");
  expect(existsSync(join(DATA_DIR,"skill-state",old,"task-discovery.json"))).toBe(false);
  migrateSkillDiscoveryToTasks(old,true);
  expect(existsSync(join(root,".claude","skills","old-habit"))).toBe(false);
  expect(readFileSync(join(root,".agents","skills","owner-only","SKILL.md"),"utf8")).toBe("Owner native skill");
});
it("migration waits for active peers and preserves unknown native files",()=>{
  const id=bot();learned(id,"Original");
  const directory=join(workspaceDir(id),".agents","skills");mkdirSync(join(directory,"owner-only"),{recursive:true});writeFileSync(join(directory,"owner-only","SKILL.md"),"Owner native skill");
  expect(()=>migrateSkillDiscoveryToTasks(id,false)).toThrow("another active task");
  migrateSkillDiscoveryToTasks(id,true);
  expect(readFileSync(join(directory,"owner-only","SKILL.md"),"utf8")).toBe("Owner native skill");
  expect(()=>migrateSkillDiscoveryToTasks(id,false)).not.toThrow();
});

// A routine that runs again in its own conversation releases the task's pin
// (store.releaseTaskProcedures), so the next turn pins again. When anything in
// the pin changed (here: the app's bundled catalogue gained a skill, as 0.1.61
// added image-generation), the native links still pointed at the earlier
// pin's projection and every later run failed with "Pinned procedures are
// unavailable or changed".
const NATIVE_DIRS=[".claude/skills",".agents/skills",".grok/skills"];
const skillMd=(name:string,body:string)=>`---\nname: ${name}\ndescription: ${name} fixture\n---\n${body}\n`;
function catalogueSkill(id:string,name:string):BundledSkill{
  const root=join(workspaceDir(id),"catalogue-rerun",name);mkdirSync(root,{recursive:true});
  const text=skillMd(name,`Use ${name}`);writeFileSync(join(root,"SKILL.md"),text);
  return {manifest:{id:name,name,version:"1.0.0",description:name,defaultEnabled:true,triggerTerms:[name],requiredCapabilities:[]},instructions:text.trim(),directory:root};
}
function installEnabled(id:string,name:string){
  expect(installSkill(id,"fixture",[{path:"SKILL.md",content:skillMd(name,`Use ${name}`)}])).not.toHaveProperty("error");
  expect(setSkillEnabled(id,name,true)).not.toHaveProperty("error");
}
const pinTarget=(id:string,thread:string,bundleId:string,name:string)=>join(taskWorkspacePath(DATA_DIR,id,thread),".murage-procedures",bundleId,"skills",name);
const nativeLink=(id:string,thread:string,dir:string,name:string)=>join(taskWorkspacePath(DATA_DIR,id,thread),dir,name);
// Upgrade-shaped: pinned under the old catalogue, the app update adds a
// catalogue skill, and the routine re-runs in the same conversation.
it("a routine re-run whose catalogue changed relinks native skills to the new pin",()=>{
  const id=bot(),thread="routine-conv",routine={id:"routine-1",instructionRevision:"a".repeat(64)};learned(id,"Original");
  const first=createProcedurePin(id,thread,[catalogueSkill(id,"alpha")],[],routine,undefined,{ownerTurn:true,shipped:()=>true});
  preparePinnedProcedures(id,thread,first,true);
  const second=createProcedurePin(id,thread,[catalogueSkill(id,"alpha"),catalogueSkill(id,"image-generation")],[],routine,undefined,{ownerTurn:true,shipped:()=>true});
  expect(second.bundleId).not.toBe(first.bundleId);
  expect(()=>preparePinnedProcedures(id,thread,second,true)).not.toThrow();
  for(const dir of NATIVE_DIRS)expect(readlinkSync(nativeLink(id,thread,dir,"checked-method"))).toBe(pinTarget(id,thread,second.bundleId,"checked-method"));
  expect(readFileSync(join(nativeLink(id,thread,".claude/skills","checked-method"),"SKILL.md"),"utf8")).toContain("Original");
  // history stays: the earlier pin's projection is not deleted
  expect(existsSync(join(pinTarget(id,thread,first.bundleId,"checked-method"),"SKILL.md"))).toBe(true);
});
it("a skill removed between runs loses its native link; unknown entries stay",()=>{
  const id=bot(),thread="routine-conv";learned(id,"Original");installEnabled(id,"second-method");
  const first=createProcedurePin(id,thread,[],[],undefined,undefined,{ownerTurn:true,shipped:()=>true});preparePinnedProcedures(id,thread,first,true);
  for(const dir of NATIVE_DIRS)expect(readlinkSync(nativeLink(id,thread,dir,"second-method"))).toBe(pinTarget(id,thread,first.bundleId,"second-method"));
  const agents=join(taskWorkspacePath(DATA_DIR,id,thread),".agents","skills");
  mkdirSync(join(agents,"owner-only"));writeFileSync(join(agents,"owner-only","SKILL.md"),"Owner native skill");
  const outside=join(workspaceDir(id),"outside-skill");mkdirSync(outside);symlinkSync(outside,join(agents,"owner-link"),process.platform==="win32"?"junction":"dir");
  setSkillEnabled(id,"second-method",false);
  const second=createProcedurePin(id,thread,[],[],undefined,undefined,{ownerTurn:true,shipped:()=>true});
  preparePinnedProcedures(id,thread,second,true);
  for(const dir of NATIVE_DIRS){
    expect(existsSync(nativeLink(id,thread,dir,"second-method"))).toBe(false);
    expect(readlinkSync(nativeLink(id,thread,dir,"checked-method"))).toBe(pinTarget(id,thread,second.bundleId,"checked-method"));
  }
  expect(readFileSync(join(agents,"owner-only","SKILL.md"),"utf8")).toBe("Owner native skill");
  expect(readlinkSync(join(agents,"owner-link"))).toBe(outside);
  // every imported skill switched off: the earlier links still go, unknown entries stay
  setSkillEnabled(id,"checked-method",false);
  const third=createProcedurePin(id,thread,[],[],undefined,undefined,{ownerTurn:true,shipped:()=>true});
  expect(preparePinnedProcedures(id,thread,third,true).importedPrompt).toBe("");
  for(const dir of NATIVE_DIRS)expect(existsSync(nativeLink(id,thread,dir,"checked-method"))).toBe(false);
  expect(readFileSync(join(agents,"owner-only","SKILL.md"),"utf8")).toBe("Owner native skill");
  expect(readlinkSync(join(agents,"owner-link"))).toBe(outside);
  expect(existsSync(join(pinTarget(id,thread,first.bundleId,"second-method"),"SKILL.md"))).toBe(true);
});
it("a same-name entry that is not this task's earlier pin projection still fails",()=>{
  const id=bot();learned(id,"Original");installEnabled(id,"second-method");
  const other=createProcedurePin(id,"other-task",[],[],undefined,undefined,{ownerTurn:true,shipped:()=>true});preparePinnedProcedures(id,"other-task",other,true);
  const replacements:Array<[string,(thread:string,oldId:string)=>void]>=[
    ["a link outside the desk",(thread)=>{const outside=join(workspaceDir(id),`outside-${thread}`);mkdirSync(outside);symlinkSync(outside,nativeLink(id,thread,".agents/skills","checked-method"),process.platform==="win32"?"junction":"dir");}],
    ["a link to another task's procedures",(thread)=>symlinkSync(pinTarget(id,"other-task",other.bundleId,"checked-method"),nativeLink(id,thread,".agents/skills","checked-method"),process.platform==="win32"?"junction":"dir")],
    ["a link to a different skill of the earlier pin",(thread,oldId)=>symlinkSync(pinTarget(id,thread,oldId,"second-method"),nativeLink(id,thread,".agents/skills","checked-method"),process.platform==="win32"?"junction":"dir")],
    ["a link into a folder that is not a bundle id",(thread)=>{const fake=join(taskWorkspacePath(DATA_DIR,id,thread),".murage-procedures","not-a-bundle","skills","checked-method");mkdirSync(fake,{recursive:true});symlinkSync(fake,nativeLink(id,thread,".agents/skills","checked-method"),process.platform==="win32"?"junction":"dir");}],
    ["a real directory",(thread)=>{mkdirSync(nativeLink(id,thread,".agents/skills","checked-method"));writeFileSync(join(nativeLink(id,thread,".agents/skills","checked-method"),"SKILL.md"),"Owner bytes");}],
  ];
  for(const [label,replace] of replacements){
    const thread=`task-${replacements.findIndex(item=>item[0]===label)}`;
    setSkillEnabled(id,"second-method",true);
    const first=createProcedurePin(id,thread,[],[],undefined,undefined,{ownerTurn:true,shipped:()=>true});preparePinnedProcedures(id,thread,first,true);
    rmSync(nativeLink(id,thread,".agents/skills","checked-method"));replace(thread,first.bundleId);
    setSkillEnabled(id,"second-method",false);
    const second=createProcedurePin(id,thread,[],[],undefined,undefined,{ownerTurn:true,shipped:()=>true});
    expect(()=>preparePinnedProcedures(id,thread,second,true),label).toThrow("Pinned procedures are unavailable or changed");
  }
  expect(readFileSync(join(nativeLink(id,"task-4",".agents/skills","checked-method"),"SKILL.md"),"utf8")).toBe("Owner bytes");
});
it("preparing the same pin twice keeps its links",()=>{
  const id=bot(),thread="routine-conv";learned(id,"Original");
  const first=createProcedurePin(id,thread,[catalogueSkill(id,"alpha")],[],undefined,undefined,{ownerTurn:true,shipped:()=>true});preparePinnedProcedures(id,thread,first,true);
  const second=createProcedurePin(id,thread,[catalogueSkill(id,"alpha"),catalogueSkill(id,"beta")],[],undefined,undefined,{ownerTurn:true,shipped:()=>true});
  const once=preparePinnedProcedures(id,thread,second,true);
  expect(preparePinnedProcedures(id,thread,second,true)).toEqual(once);
  for(const dir of NATIVE_DIRS)expect(readlinkSync(nativeLink(id,thread,dir,"checked-method"))).toBe(pinTarget(id,thread,second.bundleId,"checked-method"));
});

// upstream #2060: the prompt index used to stop at 15 skills (and at its byte
// budget) without a word, so some house skills never reached the bot.
it("names the skills the pinned index leaves out instead of dropping them silently",()=>{
  const id=bot(),total=24;
  for(let i=0;i<total;i++){
    const name=`house-skill-${String(i).padStart(2,"0")}`;
    expect(installSkill(id,"fixture",[{path:"SKILL.md",content:`---\nname: ${name}\ndescription: Does one house task the way the team does it, step by step.\n---\nBody\n`}])).not.toHaveProperty("error");
    setSkillEnabled(id,name,true);
  }
  const prompt=preparePinnedProcedures(id,"many",createProcedurePin(id,"many",[],[],undefined,undefined,{ownerTurn:true,shipped:()=>true}),true).importedPrompt;
  const kept=(prompt.match(/^- house-skill-\d{2}:/gm)??[]).length;
  const omitted=Number(/(\d+) enabled skills? omitted/.exec(prompt)?.[1]??0);
  expect(Buffer.byteLength(prompt,"utf8")).toBeLessThanOrEqual(4_000);
  expect(kept).toBeGreaterThan(0);
  expect(omitted).toBeGreaterThan(0);
  expect(kept+omitted).toBe(total);
  expect(prompt).toContain("skills_list");
});

// murage#16 / #15 / #12 / releases#5: on Windows the app's runtime (Electron's
// Node) throws "Path is a directory" for rmSync on a junction, and a recursive
// rmSync deletes what the junction points to. Plain Node on CI did neither.
// The emulation makes rmSync behave that way here (testing/electron-windows-rmsync.ts).
it("a routine re-run relinks and drops earlier-pin links under the Windows runtime's rmSync",()=>{
  const id=bot(),thread="routine-electron",routine={id:"routine-1",instructionRevision:"a".repeat(64)};learned(id,"Original");installEnabled(id,"second-method");
  const first=createProcedurePin(id,thread,[catalogueSkill(id,"alpha")],[],routine,undefined,{ownerTurn:true,shipped:()=>true});
  preparePinnedProcedures(id,thread,first,true);
  setSkillEnabled(id,"second-method",false);
  const second=createProcedurePin(id,thread,[catalogueSkill(id,"alpha"),catalogueSkill(id,"image-generation")],[],routine,undefined,{ownerTurn:true,shipped:()=>true});
  const restore=emulateElectronWindowsRmSync();
  let prepared:ReturnType<typeof preparePinnedProcedures>;
  try{prepared=preparePinnedProcedures(id,thread,second,true);}finally{restore();}
  expect(prepared.linkNotice).toBeUndefined();
  for(const dir of NATIVE_DIRS){
    expect(readlinkSync(nativeLink(id,thread,dir,"checked-method"))).toBe(pinTarget(id,thread,second.bundleId,"checked-method"));
    expect(existsSync(nativeLink(id,thread,dir,"second-method"))).toBe(false);
  }
  // the earlier pin's projections keep every file
  expect(readFileSync(join(pinTarget(id,thread,first.bundleId,"checked-method"),"SKILL.md"),"utf8")).toContain("Original");
  expect(existsSync(join(pinTarget(id,thread,first.bundleId,"second-method"),"SKILL.md"))).toBe(true);
});

it("a relink that fails twice does not refuse the turn and names the skill for the chat",()=>{
  const id=bot(),thread="routine-locked",routine={id:"routine-1",instructionRevision:"a".repeat(64)};learned(id,"Original");
  const first=createProcedurePin(id,thread,[catalogueSkill(id,"alpha")],[],routine,undefined,{ownerTurn:true,shipped:()=>true});preparePinnedProcedures(id,thread,first,true);
  const second=createProcedurePin(id,thread,[catalogueSkill(id,"alpha"),catalogueSkill(id,"beta")],[],routine,undefined,{ownerTurn:true,shipped:()=>true});
  const locked=nativeLink(id,thread,".claude/skills","checked-method");
  const original=fs.symlinkSync;let attempts=0;
  const replace=(value:unknown)=>{Object.defineProperty(fs,"symlinkSync",{value,writable:true,configurable:true,enumerable:true});syncBuiltinESMExports();};
  replace(function lockedSymlink(this:unknown,...args:Parameters<typeof original>){
    if(String(args[1])===locked){attempts++;throw Object.assign(new Error("EBUSY: resource busy or locked"),{code:"EBUSY"});}
    return original.apply(this,args);
  });
  let prepared:ReturnType<typeof preparePinnedProcedures>;
  try{prepared=preparePinnedProcedures(id,thread,second,true);}finally{replace(original);}
  expect(attempts).toBe(2);
  expect(prepared.linkNotice).toBe(skillLinkNotice(["checked-method"]));
  expect(prepared.linkNotice).toContain("\"checked-method\"");
  // the bot still has the exact path of every pinned skill
  // the path is quoted as a JSON string in the prompt (a Windows backslash is written escaped)
  expect(prepared.importedPrompt).toContain(JSON.stringify(join(pinTarget(id,thread,second.bundleId,"checked-method"),"SKILL.md")));
  for(const dir of [".agents/skills",".grok/skills"])expect(readlinkSync(nativeLink(id,thread,dir,"checked-method"))).toBe(pinTarget(id,thread,second.bundleId,"checked-method"));
  // the next turn links it again
  expect(preparePinnedProcedures(id,thread,second,true).linkNotice).toBeUndefined();
  expect(readlinkSync(locked)).toBe(pinTarget(id,thread,second.bundleId,"checked-method"));
});

it("the chat line for unlinked skills names each one",()=>{
  expect(skillLinkNotice([])).toBeUndefined();
  expect(skillLinkNotice(["a"])).toBe("The skill \"a\" could not be linked into the engine's skill folder on this turn, so the bot reads it from the pinned copy instead. The next turn links it again.");
  expect(skillLinkNotice(["a","b"])).toContain("The skills \"a\", \"b\"");
  expect(skillLinkNotice(["a","b"])).not.toMatch(/\u2014/);
});

it("an earlier pin's link that cannot be removed refuses the turn with a clear message",()=>{
  const id=bot(),thread="routine-stuck",routine={id:"routine-1",instructionRevision:"a".repeat(64)};learned(id,"Original");
  const first=createProcedurePin(id,thread,[catalogueSkill(id,"alpha")],[],routine,undefined,{ownerTurn:true,shipped:()=>true});preparePinnedProcedures(id,thread,first,true);
  const second=createProcedurePin(id,thread,[catalogueSkill(id,"alpha"),catalogueSkill(id,"beta")],[],routine,undefined,{ownerTurn:true,shipped:()=>true});
  const stuck=nativeLink(id,thread,".claude/skills","checked-method");
  // A lock holds the link: on Windows a junction unlink refuses is removed by rmdir, so the lock refuses both.
  const originals={unlinkSync:fs.unlinkSync,rmdirSync:fs.rmdirSync};let attempts=0;
  const replace=(name:"unlinkSync"|"rmdirSync",value:unknown)=>{Object.defineProperty(fs,name,{value,writable:true,configurable:true,enumerable:true});syncBuiltinESMExports();};
  for(const name of ["unlinkSync","rmdirSync"] as const){
    const original=originals[name] as (...args:unknown[])=>unknown;
    replace(name,function locked(this:unknown,...args:unknown[]){
      if(String(args[0])===stuck){if(name==="unlinkSync")attempts++;throw Object.assign(new Error("EBUSY: resource busy or locked"),{code:"EBUSY"});}
      return original.apply(this,args);
    });
  }
  try{expect(()=>preparePinnedProcedures(id,thread,second,true)).toThrow("Murage could not move the link for the skill \"checked-method\"");}
  finally{replace("unlinkSync",originals.unlinkSync);replace("rmdirSync",originals.rmdirSync);}
  expect(attempts).toBeGreaterThanOrEqual(2);
  expect(readlinkSync(stuck)).toBe(pinTarget(id,thread,first.bundleId,"checked-method"));
});
