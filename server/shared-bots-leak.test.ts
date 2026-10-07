// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { teamIdFor } from "./team-identities.ts";
import { learningDestination, partitionOfScope, partitionOfScopeKey, partitionRoots } from "./execution-audience.ts";
import { ensureWorkspace, loadMemory, readMemoryTopic, selectFileWorkspace } from "./workspace.ts";
import { standingContextParts } from "./standing-context.ts";
import { backgroundMemoryAudience, backgroundMemoryScopes, ensureScope, memoryAccess, reconcileMemoryRoster } from "./memory/policy.ts";
import { threadCaptureScope } from "./memory/capture-scope.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { previewMemoryImport, commitMemoryImport } from "./memory/import.ts";
import { searchMemory } from "./memory/search.ts";
import { buildMemoryBundle } from "./memory/bundle.ts";
import { ownWorkspaceRoots } from "./own-workspace-approval.ts";
import { goalOpenCards, leadNextStep } from "./project-turn-engine.ts";
import { applyGoalEnvelopeV2 } from "./project-envelope.ts";
import { channelToProjectRows } from "./project-settings.ts";
import { createProjectGoal } from "./project-goals.ts";
import { insertRoomRequest as projectInsertRoomRequest } from "./project-records.ts";
import { roomRequest } from "./room-requests.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
function fixture() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const make = (name: string, section: string) => { const bot = store.createBot(); store.patchBot(bot.id, { name, section }); return bot; };
  const iris = make("Iris", "Design"), carl = make("Carl", "Design"), sam = make("Sam", "Sales");
  const sales = teamIdFor("Sales"), support = teamIdFor("Support");
  iris.partitionedAt = 1; iris.sharedWith = { mode: "list", teams: [{ id: sales, name: "Sales" }, { id: support, name: "Support" }] };
  const work = store.createSharedWorkTask(iris.id, sales)!, other = store.createSharedWorkTask(iris.id, support)!;
  const room = store.createGroup("CANARY_GENERAL_ROOM_NAME", [iris.id, carl.id, sam.id], false, "");
  const salesRoom = store.createGroup("Sales", [iris.id, sam.id], false, "Sales");
  const partition = { kind: "team" as const, teamId: sales };
  const root = partitionRoots(iris, partition)[0]; mkdirSync(join(root, "memory"), { recursive: true });
  writeFileSync(join(ensureWorkspace(iris.id), "MEMORY.md"), "CANARY_DESIGN_NOTE");
  writeFileSync(join(root, "MEMORY.md"), "CANARY_SALES_NOTE");
  writeFileSync(join(root, "memory", "topic.md"), "CANARY_SALES_TOPIC");
  const general = partitionRoots(iris, { kind: "general" })[0]; mkdirSync(general, { recursive: true });
  writeFileSync(join(general, "GENERAL.md"), "CANARY_GENERAL_OWNER");
  const scopes = { home: ensureScope("bot", iris.id), sales: ensureScope("team", "Sales"), own: ensureScope("bot", `${iris.id}#team:${sales}`), general: ensureScope("bot", `${iris.id}#general`), other: ensureScope("bot", `${iris.id}#team:${support}`), room: ensureScope("room", room.id) };
  reconcileMemoryRoster(store);
  database().exec("UPDATE memory_meta SET mode='active'");
  return { store, iris, work, other, room, salesRoom, sales, support, partition, root, scopes };
}
it("captured standing prompt selects Sales notebook and general notes without home material", () => {
  const f = fixture(); const prompt = standingContextParts(f.iris, { ownerAudience: true, fileTools: false, partition: f.partition });
  expect(prompt.memory).toContain("CANARY_SALES_NOTE"); expect(prompt.memory).toContain("CANARY_GENERAL_OWNER");
  expect(JSON.stringify(prompt)).not.toContain("CANARY_DESIGN");
  expect(loadMemory(f.iris.id, f.partition)?.text).toBe("CANARY_SALES_NOTE");
  expect(readMemoryTopic(f.iris.id, "topic.md", f.partition)).toBe("CANARY_SALES_TOPIC");
});
it("final read scope set drops explicit home grants and every other partition", () => {
  const f = fixture();
  database().prepare("INSERT INTO memory_scope_bindings VALUES('leak-grant',?,'bot',?,0,'granted','{}')").run(f.scopes.home, f.iris.id);
  const scopes = backgroundMemoryScopes(f.iris.id, f.work.threadId, f.store);
  expect(scopes).toEqual(expect.arrayContaining([f.scopes.sales, f.scopes.own, f.scopes.general]));
  for (const id of [f.scopes.home, f.scopes.other, f.scopes.room]) expect(scopes).not.toContain(id);
  const home = backgroundMemoryScopes(f.iris.id, f.iris.threadId, f.store);
  for (const id of [f.scopes.sales, f.scopes.own, f.scopes.other, f.scopes.room]) expect(home).not.toContain(id);
});
it("work capture resolves memory_key while a marked room still captures room scope", () => {
  const f = fixture(); database().prepare("UPDATE team_identities SET memory_key='Revenue' WHERE team_id=?").run(f.sales);
  expect(threadCaptureScope(f.work.threadId, f.store)).toEqual({ kind: "team", owner: "Revenue" });
  expect(threadCaptureScope(f.salesRoom.threadId, f.store)).toEqual({ kind: "room", owner: f.salesRoom.id });
});
it("background learning selects the Sales composite destination and audience", () => {
  const f = fixture(); expect(backgroundMemoryAudience(f.iris.id, f.work.threadId, f.store)).toMatchObject({ scopeId: f.scopes.own, audienceKey: `bot:${f.iris.id}:team:${f.sales}:owner` });
});
it("retired teams retain their own notebook but cannot recall their tombstoned memory", () => {
  const f = fixture(); database().prepare("UPDATE team_identities SET retired_at=1 WHERE team_id=?").run(f.sales);
  const scopes = backgroundMemoryScopes(f.iris.id, f.work.threadId, f.store);
  expect(scopes).toContain(f.scopes.own); expect(scopes).not.toContain(f.scopes.sales);
});
it("recall payloads and bundles reject home canaries even when the search bridge returns them", async () => {
  const f = fixture(), ticket = ownerMemoryTicket();
  const preview = previewMemoryImport(ticket, [{ kind: "bot", botId: f.iris.id }], f.store);
  const ids = commitMemoryImport(ticket, preview.previewId, f.store).recordIds;
  const registry = new InternalCapabilities(); registry.begin(f.iris.id, f.work.threadId, "generation");
  const token = registry.mint({ botId: f.iris.id, threadId: f.work.threadId, generation: "generation", depth: 0, kind: "memory", skillAuthoring: false });
  const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => f.store);
  const bridge = { async search(input: { scopeIds: string[] }) {
    expect(input.scopeIds).toEqual(expect.arrayContaining([f.scopes.sales, f.scopes.own, f.scopes.general]));
    for (const scope of [f.scopes.home, f.scopes.other, f.scopes.room]) expect(input.scopeIds).not.toContain(scope);
    return { hits: ids.map(id => ({ id, version: 1, score: 1, lexical: true })), vectorRows: 0, coverageComplete: false };
  } };
  await expect(searchMemory("CANARY", access, bridge)).rejects.toThrow("MEMORY_SCOPE_DENIED");
  expect((await buildMemoryBundle("CANARY", access, bridge)).text).not.toContain("CANARY_DESIGN_NOTE");
});
it("selected managed roots and bookkeeping never include the home folder on Sales work", () => {
  const f = fixture(); f.work.cwd = join(DATA_DIR, "workspaces", f.iris.id, "threads", f.work.threadId);
  expect(selectFileWorkspace(DATA_DIR, f.store, f.iris.id, f.work.threadId, true)?.root).toBe(join(f.root, "threads", f.work.threadId));
  expect(ownWorkspaceRoots({ dataDir: DATA_DIR, botId: f.iris.id, threadId: f.work.threadId })).toEqual([f.root]);
});
it("V13 exports no isolated partition and refuses quarantined evidence", () => {
  const f = fixture(); f.work.sharedWork!.quarantined = true;
  const scope = ensureScope("conversation", f.work.threadId);
  expect(partitionOfScopeKey("conversation", "unresolved")).toBeNull(); expect(partitionOfScope(scope)).toBeNull();
  expect(learningDestination({ botId: f.iris.id, threadId: f.work.threadId, evidenceScopeIds: [scope], target: "memory" })).toEqual({ ok: false, reason: "cross-partition" });
});

it("session keys reset on sharing and folder re-pin, including pooled sessions", async () => {
  const f = fixture(); const { partitionSessionAudience, sessionAudienceChanged, PooledSessionAudiences } = await import("./session-audience.ts");
  const home = partitionSessionAudience("owner", f.iris, f.iris.threadId, "/home");
  const sales = partitionSessionAudience("owner", f.iris, f.work.threadId, f.root);
  expect(sales).toContain("|x2:1:team:"); expect(sales).not.toBe(home);
  expect(sessionAudienceChanged("owner", true, sales)).toBe(true);
  expect(partitionSessionAudience("owner", f.iris, f.work.threadId, "/repinned")).not.toBe(sales);
  const pool = new PooledSessionAudiences(); pool.accepted("thread", "engine", home); expect(pool.changed("thread", "engine", sales)).toBe(true);
});
it("file partition denial outranks Full access and general notes cannot be written", async () => {
  const f = fixture(); f.iris.autoApprove = true; f.iris.fullAccess = true; f.iris.noLimits = true; const { partitionFileRefusal } = await import("./partition-files.ts");
  expect(partitionFileRefusal(f.iris, f.work.threadId, [join(DATA_DIR, "workspaces", f.iris.id, "MEMORY.md")])).toContain("another team");
  expect(partitionFileRefusal(f.iris, f.iris.threadId, [join(f.root, "x")])).toContain("another team");
  expect(partitionFileRefusal(f.iris, f.work.threadId, [join(f.root, "x")])).toBeNull();
  expect(partitionFileRefusal(f.iris, f.work.threadId, [join(partitionRoots(f.iris, {kind:"general"})[0], "GENERAL.md")])).toContain("Only you");
});
it("Sales working context contains no home, other-team, room or routine canaries", async () => {
  const f = fixture(); const { workingContext } = await import("./working-context.ts");
  for (const [thread, text] of [[f.iris.threadId, "CANARY_DESIGN_REPLY"], [f.other.threadId, "CANARY_SUPPORT_REPLY"], [f.room.threadId, "CANARY_GENERAL_ROOM_REPLY"]]) f.store.appendMessage(thread, { role:"bot", kind:"text", text, from:{botId:f.iris.id,name:"Iris",color:f.iris.color} });
  const text = workingContext({botId:f.iris.id,currentThreadId:f.work.threadId,bots:f.store.bots,groups:f.store.groups,routines:[{name:"CANARY_DESIGN_ROUTINE",botId:f.iris.id,enabled:true}],now:Date.now()});
  expect(text).not.toMatch(/CANARY_(DESIGN|SUPPORT|GENERAL_ROOM)/);
});
it("unproven turns get neither general nor private partition scopes", () => {
  const f = fixture(), registry = new InternalCapabilities(); registry.begin(f.iris.id,f.work.threadId,"unproven");
  const token = registry.mint({botId:f.iris.id,threadId:f.work.threadId,generation:"unproven",depth:0,kind:"memory",skillAuthoring:false,notOwnerAudience:true});
  const access = memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>f.store);
  for (const scope of Object.values(f.scopes)) expect(access.scopeIds).not.toContain(scope);
});
it("Sales roster exposes reachable bots only and shared entries have no private profile", async () => {
  const f = fixture(); const { partitionRoster } = await import("./shared-bots-roster.ts");
  const roster = partitionRoster(f.store, f.iris, f.work.threadId, true);
  expect(roster.map(bot => bot.name)).toContain("Sam"); expect(roster.map(bot => bot.name)).not.toContain("Carl");
  const sam = f.store.bots.find(bot => bot.name === "Sam")!; sam.chiefOfStaff = true;
  const shared = partitionRoster(f.store,sam,sam.threadId,true).find(bot=>bot.id===f.iris.id)!;
  expect(shared).toEqual({id:f.iris.id,name:"Iris (shared)",shared:true,busy:false});
});
it("partitioned bot management reveals only name and busy and refuses Sales caller", async () => {
  const f=fixture(); const { manageBot }=await import("./bot-management.ts");
  const options={pendingWork:()=>false,validateSelection:()=>f.iris.modelSelection,validateLeader:()=>{},revoke:()=>{}};
  expect(()=>manageBot(f.store,f.iris,{action:"get",botId:f.iris.id},{...options,threadId:f.work.threadId})).toThrow("own team");
  expect(manageBot(f.store,f.iris,{action:"get",botId:f.iris.id},{...options,threadId:f.iris.threadId})).toEqual({bot:{name:"Iris",busy:false}});
});
it("partition imports retain distinct scope ids and owner lists include them", async () => {
  const f=fixture(),ticket=ownerMemoryTicket(); const { ownerListScopes }=await import("./memory/owner-list.ts");
  const preview=previewMemoryImport(ticket,[{kind:"partition",botId:f.iris.id,partition:f.partition},{kind:"partition",botId:f.iris.id,partition:{kind:"general"}}],f.store);
  expect(preview.items.map(item=>item.scopeId)).toEqual([f.scopes.own,f.scopes.general]);
  const result=commitMemoryImport(ticket,preview.previewId,f.store); expect(result.imported).toBe(2);
  expect(ownerListScopes({botId:f.iris.id},f.store)).toEqual(expect.arrayContaining([f.scopes.own,f.scopes.general]));
});
it("deleting a bot removes all four sibling trees", async () => {
  const f=fixture(); const { existsSync }=await import("node:fs");
  const roots=["general","teams","projects","rooms"].map(suffix=>join(DATA_DIR,"workspaces",`${f.iris.id}.${suffix}`));
  for(const root of roots)mkdirSync(root,{recursive:true});
  f.store.deleteBot(f.iris.id); for(const root of roots)expect(existsSync(root)).toBe(false);
});
it("project summaries refuse a private source from another partition", async () => {
  const f=fixture(); const {updateProjectSummary}=await import("./project-memory-tools.ts");
  const message=f.store.appendMessage(f.iris.threadId,{role:"user",kind:"text",text:"CANARY_DESIGN_SUMMARY"});
  const result=updateProjectSummary(database(),f.store,{groupId:f.salesRoom.id,botId:f.iris.id,now:Date.now(),request:{targetThreadId:f.work.threadId,rootThreadId:f.work.threadId}}, {text:"CANARY_DESIGN_SUMMARY",sourceMessageIds:[message.id]});
  expect(result.status).toBe(403);
});
it("project read-messages checks the consuming partition before returning canaries", async () => {
  const f=fixture(); const {readProjectMessages}=await import("./project-memory-tools.ts");
  f.store.appendMessage(f.room.threadId,{role:"user",kind:"text",text:"CANARY_GENERAL_ROOM_PRIVATE"});
  const result=readProjectMessages(database(),f.store,f.room.id,{}, {botId:f.iris.id,threadId:f.work.threadId});
  expect(result.status).toBe(403); expect(JSON.stringify(result.body)).not.toContain("CANARY_GENERAL_ROOM_PRIVATE");
});
it("Sales skill pin omits learned home revisions but retains owner-installed skills", async () => {
  const f=fixture(); const {installSkill,setSkillEnabled}=await import("./skills.ts"); const {createProcedurePin}=await import("./procedure-bundles.ts"); const {readFileSync}=await import("node:fs");
  for(const [name,source,canary] of [["private-note","learn:conversation","CANARY_DESIGN_SKILL"],["owner-note","owner:fixture","CANARY_GENERAL_SKILL"]]) {
    const installed=installSkill(f.iris.id,source,[{path:"SKILL.md",content:`---\nname: ${name}\ndescription: ${canary}\n---\n\n${canary}\n`}]); expect(installed).not.toHaveProperty("error");
    expect(setSkillEnabled(f.iris.id,name,true)).not.toHaveProperty("error");
  }
  const pin=createProcedurePin(f.iris.id,f.work.threadId,[],[],undefined,{audienceKey:`bot:${f.iris.id}:team:${f.sales}:owner`,allowedScopeIds:[f.scopes.own]});
  const text=readFileSync(join(DATA_DIR,"skill-state",f.iris.id,"task-bundles",f.work.threadId,pin.bundleId+".json"),"utf8");
  expect(text).not.toContain("CANARY_DESIGN_SKILL"); expect(text).toContain("CANARY_GENERAL_SKILL");
});
it("artifact publication refuses an explicitly supplied other-team scope", async () => {
  const f=fixture(); const {registerArtifact}=await import("./artifacts.ts");
  const root=partitionRoots(f.iris,{kind:"team",teamId:f.support})[0];mkdirSync(root,{recursive:true});writeFileSync(join(root,"report.txt"),"CANARY_SUPPORT_ARTIFACT");
  expect(()=>registerArtifact(database(),join(DATA_DIR,"artifacts"),{botId:f.iris.id,threadId:f.work.threadId,relativePath:"report.txt"},{owner:true,scopes:[{botId:f.iris.id,botName:"Iris",threadId:f.work.threadId,workspaceRoot:root}]})).toThrow("another team");
});
it("internal routine and staged-skill routes refuse non-home callers", async () => {
  const f=fixture();const {partitionToolRefusal}=await import("./shared-bots-roster.ts");
  for(const path of ["/api/internal/routines","/api/internal/routine-requests","/api/internal/skills","/api/internal/skills/stage"]) {
    expect(partitionToolRefusal(f.iris,f.work.threadId,path)).toContain("own team");
    expect(partitionToolRefusal(f.iris,f.iris.threadId,path)).toBeNull();
  }
});
it("project derived summary consumption excludes a home-source canary", async () => {
  const f=fixture();const {projectSummaryLayer}=await import("./project-layers.ts");
  database().prepare("INSERT INTO project_settings(group_id,updated_at) VALUES(?,1)").run(f.salesRoom.id);
  const source=f.store.appendMessage(f.iris.threadId,{role:"user",kind:"text",text:"CANARY_DESIGN_DERIVED"});
  database().prepare("INSERT INTO project_summaries(group_id,version,text,source_message_ids,made_by,at,stale) VALUES(?,1,?,?,?,1,0)").run(f.salesRoom.id,"CANARY_DESIGN_DERIVED",JSON.stringify([source.id]),f.iris.id);
  const prompt=projectSummaryLayer(database(),{groupId:f.salesRoom.id,botId:f.iris.id,threadId:f.work.threadId,names:new Map()},true);
  expect(prompt).not.toContain("CANARY_DESIGN_DERIVED");
});
it("card-boundary summaries validate copied source ancestry", async () => {
  const f=fixture();const {partitionSourcesAllowed}=await import("./partition-sources.ts");
  const privateSource=f.store.appendMessage(f.iris.threadId,{role:"user",kind:"text",text:"CANARY_DESIGN_CARD"});
  const copy=f.store.appendMessage(f.work.threadId,{role:"bot",kind:"text",text:"CANARY_DESIGN_CARD",copyOf:{threadId:f.iris.threadId,messageIds:[privateSource.id]}});
  expect(partitionSourcesAllowed(database(),f.iris.id,f.work.threadId,[copy.id])).toBe(false);
});
it("a pre-share procedure pin cannot materialize learned home bytes into Sales", async () => {
  const f=fixture();const {installSkill,setSkillEnabled}=await import("./skills.ts");const {createProcedurePin,preparePinnedProcedures}=await import("./procedure-bundles.ts");
  installSkill(f.iris.id,"learn:conversation",[{path:"SKILL.md",content:"---\nname: secret-work\ndescription: CANARY_DESIGN_PIN\n---\n\nCANARY_DESIGN_PIN"}]);setSkillEnabled(f.iris.id,"secret-work",true);
  const old=createProcedurePin(f.iris.id,f.work.threadId,[],[],undefined,{audienceKey:`bot:${f.iris.id}:owner`,allowedScopeIds:[f.scopes.home]});
  expect(()=>preparePinnedProcedures(f.iris.id,f.work.threadId,old,false,{audienceKey:`bot:${f.iris.id}:team:${f.sales}:owner`,allowedScopeIds:[f.scopes.own]})).toThrow("AUDIENCE");
});
// A pin that no longer fits its audience (here: a pinned skill was removed)
// is released and the turn pins again (index.ts). The native links in the
// Sales desk still named the earlier pin, so the refused turn failed every
// time, and a removed skill's link stayed discoverable.
it("a released Sales pin relinks its native skills and drops a removed skill's link", async () => {
  const f=fixture();const {installSkill,setSkillEnabled,removeSkill}=await import("./skills.ts");const {createProcedurePin,preparePinnedProcedures,procedurePinFitsAudience}=await import("./procedure-bundles.ts");
  const {existsSync,realpathSync}=await import("node:fs");const {taskWorkspacePath,botWorkspacePath}=await import("./workspace.ts");
  for(const name of ["owner-note","other-note"]){
    expect(installSkill(f.iris.id,"owner:fixture",[{path:"SKILL.md",content:`---\nname: ${name}\ndescription: ${name}\n---\n\n${name}`}])).not.toHaveProperty("error");
    expect(setSkillEnabled(f.iris.id,name,true)).not.toHaveProperty("error");
  }
  const sales={audienceKey:`bot:${f.iris.id}:team:${f.sales}:owner`,allowedScopeIds:[f.scopes.own]};
  const old=f.store.pinTaskProcedures(f.iris.id,f.work.threadId,createProcedurePin(f.iris.id,f.work.threadId,[],[],undefined,sales));
  preparePinnedProcedures(f.iris.id,f.work.threadId,old,true,sales);
  const desk=taskWorkspacePath(DATA_DIR,f.iris.id,f.work.threadId);
  expect(desk.startsWith(join(botWorkspacePath(DATA_DIR,f.iris.id),"threads"))).toBe(false);
  expect(existsSync(join(desk,".agents","skills","other-note"))).toBe(true);
  expect(removeSkill(f.iris.id,"other-note")).not.toHaveProperty("error");
  // the dispatch path (index.ts): a pin that no longer fits is released, then the turn pins again
  expect(procedurePinFitsAudience(f.iris.id,f.work.threadId,old,sales)).toBe(false);
  f.store.releaseTaskProcedures(f.iris.id,f.work.threadId);
  const pin=f.store.pinTaskProcedures(f.iris.id,f.work.threadId,createProcedurePin(f.iris.id,f.work.threadId,[],[],undefined,sales));
  expect(pin.bundleId).not.toBe(old.bundleId);
  expect(()=>preparePinnedProcedures(f.iris.id,f.work.threadId,pin,true,sales)).not.toThrow();
  for(const dir of [".claude",".agents",".grok"]){
    expect(existsSync(join(desk,dir,"skills","other-note"))).toBe(false);
    expect(realpathSync(join(desk,dir,"skills","owner-note"))).toBe(realpathSync(join(desk,".murage-procedures",pin.bundleId,"skills","owner-note")));
  }
});
it("notebook topic links cannot read a home file from Sales", async () => {
  const f=fixture();const {symlinkSync}=await import("node:fs");
  symlinkSync(join(DATA_DIR,"workspaces",f.iris.id,"MEMORY.md"),join(f.root,"memory","linked.md"));
  expect(readMemoryTopic(f.iris.id,"linked.md",f.partition)).toBeNull();
});
it.each(["home","support","project","room"])("Sales recall and bundles omit %s private canaries", async kind=>{
  const f=fixture(),ticket=ownerMemoryTicket();
  const part=kind==="home"?{kind:"home" as const}:kind==="support"?{kind:"team" as const,teamId:f.support}:kind==="project"?{kind:"project" as const,groupId:"fixture-project"}:{kind:"room" as const,groupId:f.room.id};
  const root=partitionRoots(f.iris,part)[0];mkdirSync(root,{recursive:true});const canary=`CANARY_PRIVATE_${kind}`;writeFileSync(join(root,"MEMORY.md"),canary);
  const preview=previewMemoryImport(ticket,[{kind:"partition",botId:f.iris.id,partition:part}],f.store);const ids=commitMemoryImport(ticket,preview.previewId,f.store).recordIds;
  const registry=new InternalCapabilities();registry.begin(f.iris.id,f.work.threadId,"turn");const token=registry.mint({botId:f.iris.id,threadId:f.work.threadId,generation:"turn",depth:0,kind:"memory",skillAuthoring:false});
  const access=memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>f.store);
  const bridge={async search(){return {hits:ids.map(id=>({id,version:1,score:1,lexical:true})),vectorRows:0,coverageComplete:false};}};
  await expect(searchMemory("CANARY",access,bridge)).rejects.toThrow("MEMORY_SCOPE_DENIED");
  expect((await buildMemoryBundle("CANARY",access,bridge)).text).not.toContain(canary);
  const scopedBridge={async search(input:{scopeIds:string[]}){
    const hits=ids.filter(id=>input.scopeIds.includes(String(database().prepare("SELECT scope_id FROM memory_records WHERE id=? AND version=1").get(id)!.scope_id))).map(id=>({id,version:1,score:1,lexical:true}));
    expect(hits).toHaveLength(0);
    return {hits,vectorRows:0,coverageComplete:false};
  }};
  expect(JSON.stringify(await searchMemory("CANARY",access,scopedBridge))).not.toContain(canary);
  expect((await buildMemoryBundle("CANARY",access,scopedBridge)).text).not.toContain(canary);
});
it("a result can only be consumed by the requesting thread", async()=>{
  const f=fixture();const {requestReturnsTo}=await import("./partition-sources.ts");
  const {insertRoomRequest}=await import("./room-requests.ts");
  const row=insertRoomRequest(database(),{id:"result-request",groupId:f.salesRoom.id,verb:"ask",fromKind:"bot",fromBotId:f.iris.id,toBotId:f.iris.id,targetThreadId:f.work.threadId,admissionKey:"result-request",lineage:{rootThreadId:f.work.threadId,origin:"desktop",audienceFingerprint:"owner",notOwnerAudience:false,unattended:false},returnThreadId:f.work.threadId,now:1}).request;
  expect(requestReturnsTo(database(),row.id,f.work.threadId)).toBe(true);expect(requestReturnsTo(database(),row.id,f.iris.threadId)).toBe(false);
});
it("bots cannot save facts into the general scope", async()=>{
  const f=fixture(),ticket=ownerMemoryTicket();const {saveMemoryCandidate}=await import("./memory/authority.ts");
  const preview=previewMemoryImport(ticket,[{kind:"partition",botId:f.iris.id,partition:{kind:"general"}}],f.store);const record=commitMemoryImport(ticket,preview.previewId,f.store).recordIds[0];
  const evidence=database().prepare("SELECT source_id,source_revision,start_byte,end_byte FROM memory_evidence WHERE record_id=?").get(record)!;
  const registry=new InternalCapabilities();registry.begin(f.iris.id,f.work.threadId,"general");const token=registry.mint({botId:f.iris.id,threadId:f.work.threadId,generation:"general",depth:0,kind:"memory",skillAuthoring:false});const access=memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>f.store);
  expect(()=>saveMemoryCandidate("changed",[{sourceId:String(evidence.source_id),revision:Number(evidence.source_revision),startByte:Number(evidence.start_byte),endByte:Number(evidence.end_byte)}],"general-write",access)).toThrow("Only you can change what Iris knows for every team.");
});
it("deleting a bot erases its imported partition record text",()=>{
  const f=fixture(),ticket=ownerMemoryTicket();const preview=previewMemoryImport(ticket,[{kind:"partition",botId:f.iris.id,partition:f.partition}],f.store);const ids=commitMemoryImport(ticket,preview.previewId,f.store).recordIds;
  f.store.deleteBot(f.iris.id);for(const id of ids)expect(database().prepare("SELECT text,state FROM memory_records WHERE id=?").get(id)).toMatchObject({text:"",state:"deleted"});
});
it("project members can read another member's desk in the same project partition",async()=>{
  const f=fixture();const {threadPartition,sameThreadPartition}=await import("./execution-audience.ts");
  const sam=f.store.bots.find(bot=>bot.name==="Sam")!;
  database().prepare("INSERT INTO project_settings(group_id,updated_at) VALUES(?,1)").run(f.salesRoom.id);
  const mine=f.store.ensureProjectDesk(f.iris.id,f.salesRoom.id,"Project")!,theirs=f.store.ensureProjectDesk(sam.id,f.salesRoom.id,"Project")!;
  expect(threadPartition(f.iris,mine.threadId)).toMatchObject({kind:"project",groupId:f.salesRoom.id});
  expect(sameThreadPartition(f.iris,mine.threadId,theirs.threadId)).toBe(true);
});
it("non-home terminal replies never update home identity memory",async()=>{
  const f=fixture();const {writeBotIdentity,readBotIdentity}=await import("./memory/identity.ts");const {claimMemoryJob,publishMemoryWork}=await import("./memory/jobs.ts");const {captureWork}=await import("./memory/chunks.ts");const {captureBotReveals}=await import("./memory/reveal-capture.ts");
  const ticket=ownerMemoryTicket(),text="CANARY_SALES_IDENTITY Iris once tended a fictional lighthouse.";
  writeBotIdentity(ticket,{action:"identity-write",botId:f.iris.id,kind:"character-canon",key:"lighthouse",expectedVersion:0,text,basis:"fiction",audience:"owner-private"},f.store);
  const reply=f.store.appendMessage(f.work.threadId,{role:"bot",kind:"text",text,turnId:"turn",turnTerminal:true});
  let job;while((job=claimMemoryJob("fixture")))publishMemoryWork(job,"fixture",captureWork(job));
  const id=database().prepare("SELECT id FROM memory_jobs WHERE source_id=?").get(`message:${f.work.threadId}:${reply.id}`)!.id;
  await captureBotReveals(String(id),()=>f.store,null,new AbortController().signal);
  expect(readBotIdentity(ticket,f.iris.id,f.store).records.filter(row=>row.kind==="reveal-state")).toHaveLength(0);
});
it.each(["brief-update","card-update","blocked","done","assign","review-result"])("%s refuses inherited home sources before producing project text",async name=>{
  const f=fixture();const {insertRoomRequest}=await import("./room-requests.ts");const {authorizeProjectTool}=await import("./project-tool-routing.ts");
  const source=f.store.appendMessage(f.iris.threadId,{role:"user",kind:"text",text:"CANARY_DESIGN_INHERITED"});
  const request=insertRoomRequest(database(),{id:"producer",admissionKey:"producer",groupId:f.salesRoom.id,verb:"ask",fromKind:"owner",toBotId:f.iris.id,targetThreadId:f.work.threadId,sourceMessageId:source.id,state:"running",now:1,lineage:{rootThreadId:f.work.threadId,origin:"desktop",audienceFingerprint:"owner",notOwnerAudience:false,unattended:false}}).request;
  expect(authorizeProjectTool(database(),{name,botId:f.iris.id,request,body:{},memberIds:f.salesRoom.memberIds,ownerAudience:true})).toMatchObject({ok:false,status:403,body:{error:"Those sources belong to another team."}});
});
it("contact grants cannot expose general or partition scopes",async()=>{
  const f=fixture();const {observeVerifiedHuman,linkHumanBinding,resolveHumanBinding,bindHumanThread}=await import("./human-principals.ts");
  const binding=observeVerifiedHuman({platform:"slack",connectionId:"fixture",authorityId:"fixture",userId:"contact"});linkHumanBinding(ownerMemoryTicket(),{bindingId:binding,expectedRevision:1,as:"person"});const principal=resolveHumanBinding(binding);bindHumanThread(f.work.threadId,principal);
  for(const [key,scope] of Object.entries(f.scopes))database().prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'person',?,0,'granted','{}')").run(`contact-${key}`,scope,principal.personId);
  const scopes=backgroundMemoryScopes(f.iris.id,f.work.threadId,f.store);for(const scope of Object.values(f.scopes))expect(scopes).not.toContain(scope);
});
it("memory-off non-home turns still pin only their allowed skills",async()=>{
  const f=fixture();database().exec("UPDATE memory_meta SET mode='off'");const {installSkill,setSkillEnabled}=await import("./skills.ts");const {createProcedurePin,preparePinnedProcedures}=await import("./procedure-bundles.ts");
  installSkill(f.iris.id,"learn:conversation",[{path:"SKILL.md",content:"---\nname: private-method\ndescription: CANARY_DESIGN_OFF\n---\n\nCANARY_DESIGN_OFF"}]);setSkillEnabled(f.iris.id,"private-method",true);
  const pin=createProcedurePin(f.iris.id,f.work.threadId,[],[]);
  expect(()=>preparePinnedProcedures(f.iris.id,f.work.threadId,pin,false)).not.toThrow();
});
it("room prompt consumption omits copied results from another partition",async()=>{
  const f=fixture();const {partitionTranscriptMessages}=await import("./partition-sources.ts");
  const source=f.store.appendMessage(f.iris.threadId,{role:"bot",kind:"text",text:"CANARY_DESIGN_RESULT"});
  f.store.appendMessage(f.salesRoom.threadId,{role:"bot",kind:"text",text:"CANARY_DESIGN_RESULT",copyOf:{threadId:f.iris.threadId,messageIds:[source.id]}});
  const messages=partitionTranscriptMessages(database(),f.iris.id,f.salesRoom.threadId,f.store.messagesFor(f.salesRoom.threadId));
  expect(JSON.stringify(messages)).not.toContain("CANARY_DESIGN_RESULT");
});

// Round 13 (A3, A4): a lead that is a shared specialist, woken in its Sales
// work, never reads the title of a goal card citing its home thread: not in
// the open cards, not in the next step, and the duplicate match skips it so
// the title cannot be probed.
function projectForSharedLead(f: ReturnType<typeof fixture>) {
  const db = database();
  const sam = f.store.bots.find(bot => bot.name === "Sam")!;
  const home = f.store.appendMessage(f.iris.threadId, { role: "user", kind: "text", text: "CANARY_HOME_SOURCE" });
  const sales = f.store.appendMessage(f.work.threadId, { role: "user", kind: "text", text: "sales source" });
  channelToProjectRows(db, { groupId: f.salesRoom.id, bulletin: "", leadBotId: f.iris.id, now: 1 });
  const goal = createProjectGoal(db, { groupId: f.salesRoom.id, title: "Ship", now: 1 });
  if (!goal.ok) throw new Error("setup");
  db.prepare("UPDATE project_goals SET state='working' WHERE id=?").run(goal.goal.id);
  const card = (id: string, number: number, sources: string[], state: string) => db.prepare(`INSERT INTO project_work_items
    (id, group_id, goal_id, number, title, state, position, generation, source_message_ids, assignee_bot_id, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1, 1)`).run(id, f.salesRoom.id, goal.goal.id, number, `CANARY_TITLE_${id}`, state, number, JSON.stringify(sources), sam.id, f.iris.id);
  card("h1", 1, [home.id], "review");
  card("v1", 2, [sales.id], "todo");
  return { db, sam, goalId: goal.goal.id, viewer: { botId: f.iris.id, threadId: f.work.threadId } };
}
it("a shared lead's open cards and next step leave out a home-sourced card's title", () => {
  const f = fixture();
  const { db, sam, goalId, viewer } = projectForSharedLead(f);
  const name = () => "Sam";
  expect(goalOpenCards(db, goalId, name, viewer).cards.map(card => [card.id, card.title])).toEqual([["h1", null], ["v1", "CANARY_TITLE_v1"]]);
  // at home the same lead reads it
  expect(goalOpenCards(db, goalId, name, { botId: f.iris.id, threadId: f.iris.threadId }).cards[0]!.title).toBe("CANARY_TITLE_h1");
  const run = projectInsertRoomRequest(db, { groupId: f.salesRoom.id, verb: "assign", fromKind: "bot", fromBotId: f.iris.id, toBotId: sam.id, workItemId: "h1", cardGeneration: 1,
    projectGoalId: goalId, admissionKey: "run-h1", rootThreadId: f.salesRoom.threadId, now: 2 });
  const step = leadNextStep(db, roomRequest(db, run!)!, { memberIds: [f.iris.id, sam.id], name, viewer });
  expect(step).toMatchObject({ step: "review", card: { id: "h1", number: 1, title: null } });
  expect(JSON.stringify(step)).not.toContain("CANARY_TITLE_h1");
});
it("a shared lead's plan is never matched against a home-sourced card's title", () => {
  const f = fixture();
  const { db, sam, goalId } = projectForSharedLead(f);
  projectInsertRoomRequest(db, { id: "lead-req", groupId: f.salesRoom.id, verb: "wake", fromKind: "murage", toBotId: f.iris.id, state: "running",
    targetThreadId: f.work.threadId, rootThreadId: f.salesRoom.threadId, admissionKey: "lead-wake", now: 3 });
  const plan = (title: string) => applyGoalEnvelopeV2(db, { groupId: f.salesRoom.id, goalId, leadBotId: f.iris.id, leadRequestId: "lead-req", memberIds: [f.iris.id, sam.id],
    memberNames: new Map([[sam.id, "Sam"]]), now: 4 }, { v: 2, status: "assign", cards: [{ key: title, assignee: sam.id, title }] });
  const visible = plan("CANARY_TITLE_v1");
  expect(visible.ok).toBe(false);
  expect(JSON.stringify(visible)).toContain("already has card 2");
  const hidden = plan("CANARY_TITLE_h1");
  expect(JSON.stringify(hidden)).not.toContain("already has");
});
