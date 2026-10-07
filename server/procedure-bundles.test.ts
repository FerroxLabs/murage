import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { createProcedurePin, preparePinnedProcedures, readProcedureBundle } from "./procedure-bundles.ts";
import { applyStagedSkillWrite, installSkill, migrateSkillDiscoveryToTasks, rollbackSkillRevision, setSkillEnabled, skillRevisionHistory, stageSkillWrite, syncSkillLinks, skillEvolutionDescriptor } from "./skills.ts";
import { loadBundledSkills, renderSkillInstructions, selectBundledSkills, type BundledSkill } from "./skill-library.ts";
import { installedPlaybookInstructions } from "./installed-playbooks.ts";
import { taskWorkspacePath, workspaceDir } from "./workspace.ts";
const owned:string[]=[];
const bot=()=>{const id=`procedure-test-${randomUUID()}`;owned.push(join(DATA_DIR,"workspaces",id),join(DATA_DIR,"skill-state",id));return id;};
afterEach(()=>{for(const path of owned.splice(0))rmSync(path,{recursive:true,force:true});});
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
  const pin=createProcedurePin(id,thread,catalogue,playbooks);
  writeFileSync(join(root,"SKILL.md"),md("Changed check"));catalogue[0]!.instructions=md("Changed check");playbooks[0]!.instructions="Changed playbook";
  const restored=preparePinnedProcedures(id,thread,JSON.parse(JSON.stringify(pin)),true);
  expect(renderSkillInstructions(selectBundledSkills("verify",[],restored.catalogue))).toContain("Original check");
  expect(installedPlaybookInstructions("verify",restored.playbooks)).toContain("Original playbook");
  expect(readFileSync(join(restored.catalogue[0]!.directory,"helper.py"),"utf8")).toContain("original");
});
// A Windows install ships bundled skills with CRLF line endings; the loader
// reads them as LF, and the pin still matches the bytes on disk.
it("pins a catalogue skill whose file has CRLF line endings",()=>{
  const id=bot(),root=join(workspaceDir(id),"catalogue-crlf","check");mkdirSync(root,{recursive:true});
  writeFileSync(join(root,"SKILL.md"),md("Line one\nLine two").replace(/\n/g,"\r\n"));
  writeFileSync(join(root,"manifest.json"),JSON.stringify({id:"check",name:"Check",version:"1.0.0",description:"Check",defaultEnabled:true,triggerTerms:["verify"],requiredCapabilities:[]}));
  const catalogue=loadBundledSkills(join(root,".."));
  expect(catalogue).toHaveLength(1);expect(catalogue[0]!.instructions).not.toContain("\r");
  const pin=createProcedurePin(id,"crlf-task",catalogue,[]);
  const restored=preparePinnedProcedures(id,"crlf-task",pin,true);
  expect(renderSkillInstructions(selectBundledSkills("verify",[],restored.catalogue))).toContain("Line one\nLine two");
});
it("copies complete imported support bytes and native links follow this task rather than live updates",()=>{
  const id=bot();expect(installSkill(id,"fixture",[{path:"SKILL.md",content:md("Original")}])).not.toHaveProperty("error");
  const source=join(workspaceDir(id),"skills","checked-method");mkdirSync(join(source,"references"));writeFileSync(join(source,"references","check.txt"),"support bytes");setSkillEnabled(id,"checked-method",true);
  const pin=createProcedurePin(id,"first",[],[]);
  expect(skillEvolutionDescriptor(id,"checked-method")).toBeNull();
  expect(readProcedureBundle(id,"first",pin).imported[0]).toMatchObject({editable:false,revision:null});
  migrateSkillDiscoveryToTasks(id);
  const first=preparePinnedProcedures(id,"first",pin,true);
  const link=join(taskWorkspacePath(DATA_DIR,id,"first"),".agents","skills","checked-method");
  expect(readFileSync(join(readlinkSync(link),"references","check.txt"),"utf8")).toBe("support bytes");
  setSkillEnabled(id,"checked-method",false);syncSkillLinks(id);
  expect(preparePinnedProcedures(id,"first",pin,true).importedPrompt).toBe(first.importedPrompt);
  expect(createProcedurePin(id,"next",[],[])).not.toEqual(pin);
  expect(preparePinnedProcedures(id,"next",createProcedurePin(id,"next",[],[]),false).importedPrompt).toBe("");
});
it("rollback through the actual staged publisher changes future tasks and rejects stale owner state",()=>{
  const id=bot(),old=learned(id,"Use original verification"),pin=createProcedurePin(id,"first",[],[]);
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
  const future=readProcedureBundle(id,"future",createProcedurePin(id,"future",[],[]));
  expect(Buffer.from(future.files.find(file=>file.path.endsWith("SKILL.md"))!.bytes,"base64").toString()).toContain("original verification");
});
it("missing or changed pinned materialization fails without using current skill bytes",()=>{
  const id=bot();learned(id,"Original");const pin=createProcedurePin(id,"task",[],[]);preparePinnedProcedures(id,"task",pin,true);
  const path=join(taskWorkspacePath(DATA_DIR,id,"task"),".murage-procedures",pin.bundleId,"skills","checked-method","SKILL.md");
  rmSync(path);expect(()=>preparePinnedProcedures(id,"task",pin,true)).toThrow("Pinned procedures");
  const state=join(DATA_DIR,"skill-state",id,"task-bundles","task",`${pin.bundleId}.json`);writeFileSync(state,"{}");
  expect(()=>readProcedureBundle(id,"task",pin)).toThrow("Pinned procedures");
});
it("custom folder is unchanged while prompt references immutable absolute bytes",()=>{
  const id=bot();learned(id,"Original");const custom=join(workspaceDir(id),"custom-project");mkdirSync(custom);writeFileSync(join(custom,"user.txt"),"keep");
  const before=readdirSync(custom),pin=createProcedurePin(id,"custom-task",[],[]);
  const result=preparePinnedProcedures(id,"custom-task",pin,false);
  // The prompt names the path as a JSON string (backslashes doubled on Windows).
  expect(result.importedPrompt).toContain(JSON.stringify(taskWorkspacePath(DATA_DIR,id,"custom-task")).slice(1,-1));
  expect(readdirSync(custom)).toEqual(before);expect(readFileSync(join(custom,"user.txt"),"utf8")).toBe("keep");
});
it("another room responder cannot consume this bot's pinned catalogue",()=>{
  const first=bot(),second=bot();const pin=createProcedurePin(first,"room",[],[]);
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
  const first=createProcedurePin(id,thread,[catalogueSkill(id,"alpha")],[],routine);
  preparePinnedProcedures(id,thread,first,true);
  const second=createProcedurePin(id,thread,[catalogueSkill(id,"alpha"),catalogueSkill(id,"image-generation")],[],routine);
  expect(second.bundleId).not.toBe(first.bundleId);
  expect(()=>preparePinnedProcedures(id,thread,second,true)).not.toThrow();
  for(const dir of NATIVE_DIRS)expect(readlinkSync(nativeLink(id,thread,dir,"checked-method"))).toBe(pinTarget(id,thread,second.bundleId,"checked-method"));
  expect(readFileSync(join(nativeLink(id,thread,".claude/skills","checked-method"),"SKILL.md"),"utf8")).toContain("Original");
  // history stays: the earlier pin's projection is not deleted
  expect(existsSync(join(pinTarget(id,thread,first.bundleId,"checked-method"),"SKILL.md"))).toBe(true);
});
it("a skill removed between runs loses its native link; unknown entries stay",()=>{
  const id=bot(),thread="routine-conv";learned(id,"Original");installEnabled(id,"second-method");
  const first=createProcedurePin(id,thread,[],[]);preparePinnedProcedures(id,thread,first,true);
  for(const dir of NATIVE_DIRS)expect(readlinkSync(nativeLink(id,thread,dir,"second-method"))).toBe(pinTarget(id,thread,first.bundleId,"second-method"));
  const agents=join(taskWorkspacePath(DATA_DIR,id,thread),".agents","skills");
  mkdirSync(join(agents,"owner-only"));writeFileSync(join(agents,"owner-only","SKILL.md"),"Owner native skill");
  const outside=join(workspaceDir(id),"outside-skill");mkdirSync(outside);symlinkSync(outside,join(agents,"owner-link"),process.platform==="win32"?"junction":"dir");
  setSkillEnabled(id,"second-method",false);
  const second=createProcedurePin(id,thread,[],[]);
  preparePinnedProcedures(id,thread,second,true);
  for(const dir of NATIVE_DIRS){
    expect(existsSync(nativeLink(id,thread,dir,"second-method"))).toBe(false);
    expect(readlinkSync(nativeLink(id,thread,dir,"checked-method"))).toBe(pinTarget(id,thread,second.bundleId,"checked-method"));
  }
  expect(readFileSync(join(agents,"owner-only","SKILL.md"),"utf8")).toBe("Owner native skill");
  expect(readlinkSync(join(agents,"owner-link"))).toBe(outside);
  // every imported skill switched off: the earlier links still go, unknown entries stay
  setSkillEnabled(id,"checked-method",false);
  const third=createProcedurePin(id,thread,[],[]);
  expect(preparePinnedProcedures(id,thread,third,true).importedPrompt).toBe("");
  for(const dir of NATIVE_DIRS)expect(existsSync(nativeLink(id,thread,dir,"checked-method"))).toBe(false);
  expect(readFileSync(join(agents,"owner-only","SKILL.md"),"utf8")).toBe("Owner native skill");
  expect(readlinkSync(join(agents,"owner-link"))).toBe(outside);
  expect(existsSync(join(pinTarget(id,thread,first.bundleId,"second-method"),"SKILL.md"))).toBe(true);
});
it("a same-name entry that is not this task's earlier pin projection still fails",()=>{
  const id=bot();learned(id,"Original");installEnabled(id,"second-method");
  const other=createProcedurePin(id,"other-task",[],[]);preparePinnedProcedures(id,"other-task",other,true);
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
    const first=createProcedurePin(id,thread,[],[]);preparePinnedProcedures(id,thread,first,true);
    rmSync(nativeLink(id,thread,".agents/skills","checked-method"));replace(thread,first.bundleId);
    setSkillEnabled(id,"second-method",false);
    const second=createProcedurePin(id,thread,[],[]);
    expect(()=>preparePinnedProcedures(id,thread,second,true),label).toThrow("Pinned procedures are unavailable or changed");
  }
  expect(readFileSync(join(nativeLink(id,"task-4",".agents/skills","checked-method"),"SKILL.md"),"utf8")).toBe("Owner bytes");
});
it("preparing the same pin twice keeps its links",()=>{
  const id=bot(),thread="routine-conv";learned(id,"Original");
  const first=createProcedurePin(id,thread,[catalogueSkill(id,"alpha")],[]);preparePinnedProcedures(id,thread,first,true);
  const second=createProcedurePin(id,thread,[catalogueSkill(id,"alpha"),catalogueSkill(id,"beta")],[]);
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
  const prompt=preparePinnedProcedures(id,"many",createProcedurePin(id,"many",[],[]),true).importedPrompt;
  const kept=(prompt.match(/^- house-skill-\d{2}:/gm)??[]).length;
  const omitted=Number(/(\d+) enabled skills? omitted/.exec(prompt)?.[1]??0);
  expect(Buffer.byteLength(prompt,"utf8")).toBeLessThanOrEqual(4_000);
  expect(kept).toBeGreaterThan(0);
  expect(omitted).toBeGreaterThan(0);
  expect(kept+omitted).toBe(total);
  expect(prompt).toContain("skills_list");
});
