import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { createProcedurePin, preparePinnedProcedures, readProcedureBundle } from "./procedure-bundles.ts";
import { applyStagedSkillWrite, installSkill, migrateSkillDiscoveryToTasks, rollbackSkillRevision, setSkillEnabled, skillRevisionHistory, stageSkillWrite, syncSkillLinks, skillEvolutionDescriptor } from "./skills.ts";
import { renderSkillInstructions, selectBundledSkills, type BundledSkill } from "./skill-library.ts";
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
  expect(result.importedPrompt).toContain(taskWorkspacePath(DATA_DIR,id,"custom-task"));
  expect(readdirSync(custom)).toEqual(before);expect(readFileSync(join(custom,"user.txt"),"utf8")).toBe("keep");
});
it("another room responder cannot consume this bot's pinned catalogue",()=>{
  const first=bot(),second=bot();const pin=createProcedurePin(first,"room",[],[]);
  expect(()=>readProcedureBundle(second,"room",pin)).toThrow();
});
it("migration waits for active peers and preserves unknown native files",()=>{
  const id=bot();learned(id,"Original");
  const directory=join(workspaceDir(id),".agents","skills");mkdirSync(join(directory,"owner-only"),{recursive:true});writeFileSync(join(directory,"owner-only","SKILL.md"),"Owner native skill");
  expect(()=>migrateSkillDiscoveryToTasks(id,false)).toThrow("another active task");
  migrateSkillDiscoveryToTasks(id,true);
  expect(readFileSync(join(directory,"owner-only","SKILL.md"),"utf8")).toBe("Owner native skill");
  expect(()=>migrateSkillDiscoveryToTasks(id,false)).not.toThrow();
});
