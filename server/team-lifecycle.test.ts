import { manageBot } from "./bot-management.ts";
import { DatabaseSync } from "node:sqlite";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, rmSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { threadPartition } from "./execution-audience.ts";
import { teamIdFor, teamMemoryKey } from "./team-identities.ts";
import { ensureScope } from "./memory/policy.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { renameTeam, deleteTeam, teamRevision, changeTeamMembers } from "./team-sections.ts";
import { readSectionContext, writeSectionContext } from "./section-context.ts";
import { sharingRoute } from "./sharing-routes.ts";
import { reconcileTeamIdentities, reconcileTeamJournalFiles, setTeamJournalCheckpoint } from "./team-lifecycle.ts";
const fresh = () => new Store(() => ({instanceId:"fixture",model:"fixture"}));
const deps = {memoryTicket:ownerMemoryTicket(),leadershipError:()=>null,groupWorking:()=>false,channelArchived:()=>{},reachabilityChanged:()=>{}};
beforeEach(()=>{setTeamJournalCheckpoint(undefined);closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});});
function fixture(){const store=fresh(),bot=store.createBot();store.patchBot(bot.id,{name:"Iris",section:"Sales",sharedWith:{mode:"all",teams:[]}});const group=store.createGroup("Sales",[bot.id],false,"Sales"),id=teamIdFor("Sales");ensureScope("team","Sales");return {store,bot,group,id};}
it.each(["rename:1","rename:2","rename:bots","rename:3","rename:4","rename:5","rename:6"])("rename recovery after hard stop at %s uses disk only",phase=>{
 const f=fixture();setTeamJournalCheckpoint(at=>{if(at===phase)throw Error("HARD_STOP");});
 expect(()=>renameTeam(f.store,{section:"Sales",name:"Revenue",revision:teamRevision(f.store)},deps)).toThrow("HARD_STOP");
 setTeamJournalCheckpoint(undefined);closeDatabase();const restored=fresh();reconcileTeamIdentities(restored);
 const label=phase==="rename:1"?"Sales":"Revenue";
 expect(restored.bot(f.bot.id)?.section).toBe(label);expect(restored.group(f.group.id)?.section).toBe(label);
 expect(teamIdFor(label)).toBe(f.id);expect(teamMemoryKey(f.id)).toBe(label);
 expect(database().prepare("SELECT op FROM team_identities WHERE team_id=?").get(f.id)?.op).toBeNull();
 expect(JSON.parse(readFileSync(join(DATA_DIR,"bots.json"),"utf8")).some((b:{id:string;section:string})=>b.id===f.bot.id&&b.section===label)).toBe(true);
});
it.each(["delete:1","delete:2","delete:bots","delete:3","delete:4","delete:5","delete:6"])("delete recovery after hard stop at %s retires the identity",phase=>{
 const f=fixture();setTeamJournalCheckpoint(at=>{if(at===phase)throw Error("HARD_STOP");});
 expect(()=>deleteTeam(f.store,{section:"Sales",bots:"keep",revision:teamRevision(f.store)},deps)).toThrow("HARD_STOP");
 setTeamJournalCheckpoint(undefined);closeDatabase();const restored=fresh();reconcileTeamIdentities(restored);
 expect(restored.bot(f.bot.id)?.section).toBeUndefined();expect(restored.bot(f.bot.id)?.sharedWith?.mode??"none").toBe("none");
 expect(teamMemoryKey(f.id)).toBeNull();expect(teamIdFor("Sales")).not.toBe(f.id);
});
it("rename refuses destination scopes and briefs before opening a journal",()=>{
 const f=fixture();ensureScope("team","Revenue");expect(()=>renameTeam(f.store,{section:"Sales",name:"Revenue",revision:teamRevision(f.store)},deps)).toThrow();
 expect(database().prepare("SELECT op FROM team_identities WHERE team_id=?").get(f.id)?.op).toBeNull();
});
it("both scope names present preserves the journal, lets the boot finish and the owner retry the rename (R3c C4)",()=>{
 const f=fixture();setTeamJournalCheckpoint(at=>{if(at==="rename:1")throw Error("HARD_STOP");});
 expect(()=>renameTeam(f.store,{section:"Sales",name:"Revenue",revision:teamRevision(f.store)},deps)).toThrow();setTeamJournalCheckpoint(undefined);ensureScope("team","Revenue");
 closeDatabase();const restarted=fresh();let notes:string[]=[];
 expect(()=>{notes=reconcileTeamIdentities(restarted);}).not.toThrow();
 expect(notes).toContain("A team rename could not finish. Rename it again.");
 expect(database().prepare("SELECT op FROM team_identities WHERE team_id=?").get(f.id)?.op).toBe("rename");expect(()=>teamIdFor("Other")).toThrow("still finishing");
 expect(()=>restarted.createGroup("Other",[f.bot.id],false,"Sales")).toThrow("A team rename could not finish. Rename it again.");
 expect(()=>renameTeam(restarted,{section:"Sales",name:"Revenue",revision:teamRevision(restarted)},deps)).toThrow("A team rename could not finish. Rename it again.");
 expect(database().prepare("SELECT op FROM team_identities WHERE team_id=?").get(f.id)?.op).toBe("rename");
 database().prepare("DELETE FROM memory_scopes WHERE kind='team' AND owner_key='Revenue'").run();
 renameTeam(restarted,{section:"Sales",name:"Revenue",revision:teamRevision(restarted)},deps);
 expect(database().prepare("SELECT op,label FROM team_identities WHERE team_id=?").get(f.id)).toMatchObject({op:null,label:"Revenue"});
 expect(restarted.bot(f.bot.id)?.section).toBe("Revenue");expect(teamMemoryKey(f.id)).toBe("Revenue");
});
it("R4d C-r3 4: the owner renames a stalled team again with a new name, which finishes and unlocks the sections",()=>{
 const f=fixture();setTeamJournalCheckpoint(at=>{if(at==="rename:1")throw Error("HARD_STOP");});
 expect(()=>renameTeam(f.store,{section:"Sales",name:"Revenue",revision:teamRevision(f.store)},deps)).toThrow();setTeamJournalCheckpoint(undefined);ensureScope("team","Revenue");
 closeDatabase();const restarted=fresh();expect(reconcileTeamIdentities(restarted)).toContain("A team rename could not finish. Rename it again.");
 expect(()=>renameTeam(restarted,{section:"Sales",name:"Revenue",revision:teamRevision(restarted)},deps)).toThrow("A team rename could not finish. Rename it again.");
 const result=renameTeam(restarted,{section:"Sales",name:"Growth",revision:teamRevision(restarted)},deps);
 expect(result.team.name).toBe("Growth");
 expect(database().prepare("SELECT op,label,memory_key FROM team_identities WHERE team_id=?").get(f.id)).toMatchObject({op:null,label:"Growth",memory_key:"Growth"});
 expect(restarted.bot(f.bot.id)?.section).toBe("Growth");expect(restarted.group(f.group.id)?.section).toBe("Growth");
 expect(database().prepare("SELECT count(*) AS n FROM memory_scopes WHERE kind='team' AND owner_key IN ('Growth','Revenue')").get()).toMatchObject({n:2});
 expect(database().prepare("SELECT 1 FROM team_identities WHERE label='Sales' AND retired_at IS NULL").get()).toBeUndefined();
 const other=restarted.createGroup("Other",[],false,"Other");expect(other.section).toBe("Other");expect(()=>teamIdFor("Other")).not.toThrow();
});
it("R4d C-r3 4: a stalled rename's new name gets the rename checks",()=>{
 const f=fixture();setTeamJournalCheckpoint(at=>{if(at==="rename:1")throw Error("HARD_STOP");});
 expect(()=>renameTeam(f.store,{section:"Sales",name:"Revenue",revision:teamRevision(f.store)},deps)).toThrow();setTeamJournalCheckpoint(undefined);ensureScope("team","Revenue");ensureScope("team","Growth");
 closeDatabase();const restarted=fresh();reconcileTeamIdentities(restarted);
 expect(()=>renameTeam(restarted,{section:"Sales",name:"Growth",revision:teamRevision(restarted)},deps)).toThrow("There is already a team named Growth.");
 expect(database().prepare("SELECT op,op_label FROM team_identities WHERE team_id=?").get(f.id)).toMatchObject({op:"rename",op_label:"Revenue"});
});
it("home moves and member changes refuse partitioned bots",()=>{
 const f=fixture();expect(()=>f.store.patchBot(f.bot.id,{section:"Design"})).toThrow("home team cannot change");
 expect(()=>f.store.setBotsSection([f.bot.id],"Design")).toThrow("home team cannot change");
 expect(()=>changeTeamMembers(f.store,{section:"Sales",revision:teamRevision(f.store),remove:[f.bot.id]},deps)).toThrow("home team cannot change");
});

it("channel-only rename with neither memory scope completes forward from phase 1",()=>{
 const store=fresh(),group=store.createGroup("Sales",[],false,"Sales"),id=teamIdFor("Sales");
 setTeamJournalCheckpoint(at=>{if(at==="rename:1")throw Error("HARD_STOP");});expect(()=>renameTeam(store,{section:"Sales",name:"Revenue",revision:teamRevision(store)},deps)).toThrow("HARD_STOP");
 setTeamJournalCheckpoint(undefined);closeDatabase();const restored=fresh();reconcileTeamIdentities(restored);expect(restored.group(group.id)?.section).toBe("Revenue");expect(teamIdFor("Revenue")).toBe(id);
});
it("phase 2 with only the old scope is treated as phase 1 and undone",()=>{
 const f=fixture();setTeamJournalCheckpoint(at=>{if(at==="rename:1")throw Error("HARD_STOP");});expect(()=>renameTeam(f.store,{section:"Sales",name:"Revenue",revision:teamRevision(f.store)},deps)).toThrow("HARD_STOP");
 database().prepare("UPDATE team_identities SET op_phase=2 WHERE team_id=?").run(f.id);setTeamJournalCheckpoint(undefined);closeDatabase();const restored=fresh();reconcileTeamIdentities(restored);expect(restored.bot(f.bot.id)?.section).toBe("Sales");expect(teamIdFor("Sales")).toBe(f.id);
});
it("an open journal locks membership, filing and another team operation",()=>{
 const f=fixture();setTeamJournalCheckpoint(at=>{if(at==="rename:1")throw Error("HARD_STOP");});expect(()=>renameTeam(f.store,{section:"Sales",name:"Revenue",revision:teamRevision(f.store)},deps)).toThrow("HARD_STOP");
 expect(()=>f.store.patchGroup(f.group.id,{memberIds:[]})).toThrow("still finishing");expect(()=>f.store.patchBot(f.bot.id,{section:"New"})).toThrow("still finishing");
 expect(()=>deleteTeam(f.store,{section:"Sales",bots:"keep",revision:teamRevision(f.store)},deps)).toThrow("still finishing");
});

it("restored journal recovery changes only the supplied restored files and database",()=>{
 const f=fixture();setTeamJournalCheckpoint(at=>{if(at==="rename:2")throw Error("HARD_STOP");});expect(()=>renameTeam(f.store,{section:"Sales",name:"Revenue",revision:teamRevision(f.store)},deps)).toThrow("HARD_STOP");
 setTeamJournalCheckpoint(undefined);const restoredRoot=join(DATA_DIR,"restored");mkdirSync(restoredRoot);
 const bots=JSON.parse(readFileSync(join(DATA_DIR,"bots.json"),"utf8")),groups=JSON.parse(readFileSync(join(DATA_DIR,"groups.json"),"utf8"));
 database().exec("PRAGMA wal_checkpoint(TRUNCATE)");copyFileSync(join(DATA_DIR,"messages.db"),join(restoredRoot,"messages.db"));
 const restoredDb=new DatabaseSync(join(restoredRoot,"messages.db"));
 try{reconcileTeamJournalFiles(restoredRoot,restoredDb,bots,groups);expect(bots.find((b:{id:string})=>b.id===f.bot.id).section).toBe("Revenue");expect(database().prepare("SELECT op FROM team_identities WHERE team_id=?").get(f.id)?.op).toBe("rename");expect(f.store.bot(f.bot.id)?.section).toBe("Sales");}finally{restoredDb.close();}
});

it("bot-management move returns the same 409 home-move refusal",()=>{
 const f=fixture(),chief=f.store.createBot();f.store.patchBot(chief.id,{chiefOfStaff:true,chiefScope:"workspace"});
 expect(()=>manageBot(f.store,chief,{action:"move",botId:f.bot.id,section:"Design",revision:"a".repeat(64),organizationRevision:"a".repeat(64)},{pendingWork:()=>false,validateSelection:()=>f.bot.modelSelection,validateLeader:()=>{},revoke:()=>{}})).toThrow(expect.objectContaining({status:409,message:expect.stringContaining("home team cannot change")}));
});

it("R3c A4: an ordinary rename preserves the partition of an unmarked home room",()=>{
 const f=fixture();expect(threadPartition(f.bot,f.group.threadId)).toEqual({kind:"home"});
 renameTeam(f.store,{section:"Sales",name:"Revenue",revision:teamRevision(f.store)},deps);
 expect(f.group.partitionedFor?.[f.bot.id]).toBeUndefined();
 expect(threadPartition(f.bot,f.group.threadId)).toEqual({kind:"home"});
 closeDatabase();const restarted=fresh();reconcileTeamIdentities(restarted);
 expect(threadPartition(restarted.bot(f.bot.id)!,f.group.threadId)).toEqual({kind:"home"});
});
it("R4: a team rename retitles a work thread that still carries the old team name, and leaves one the owner renamed",()=>{
 const store=fresh(),iris=store.createBot(),sam=store.createBot();
 store.patchBot(iris.id,{name:"Iris",section:"Design",sharedWith:{mode:"all",teams:[]}});store.patchBot(sam.id,{name:"Sam",section:"Sales"});
 const sales=teamIdFor("Sales"),support=store.createBot();store.patchBot(support.id,{name:"Tia",section:"Support"});const supportId=teamIdFor("Support");
 const work=store.createSharedWorkTask(iris.id,sales)!,other=store.createSharedWorkTask(iris.id,supportId)!;
 expect(work.title).toBe("Iris · work for Sales");
 store.bot(iris.id)!.tasks!.find(t=>t.threadId===other.threadId)!.title="Kept";
 renameTeam(store,{section:"Sales",name:"Revenue",revision:teamRevision(store)},deps);
 const tasks=store.bot(iris.id)!.tasks!;
 expect(tasks.find(t=>t.threadId===work.threadId)!.title).toBe("Iris · work for Revenue");
 expect(tasks.find(t=>t.threadId===other.threadId)!.title).toBe("Kept");
});

// R4e: a legacy label over 60 characters has no identity and cannot get one, so
// the journal cannot hold it; its rename and delete take the earlier direct path.
function legacy(){const store=fresh(),long="L".repeat(61),lead=store.createBot(),mate=store.createBot();
 store.patchBot(lead.id,{name:"Old",section:long,chiefOfStaff:true});store.patchBot(mate.id,{name:"Mate",section:long,sharedWith:{mode:"all",teams:[]}});
 const group=store.createGroup(long,[lead.id,mate.id],false,long);ensureScope("team",long);writeSectionContext(long,"Brief");return {store,long,lead,mate,group};}
it("R4e: renaming a 61-character legacy team succeeds without a journal, as it did before identities",()=>{
 const f=legacy(),result=renameTeam(f.store,{section:f.long,name:"Heritage",revision:teamRevision(f.store)},deps);
 expect(result.team.name).toBe("Heritage");expect(result.team.members.map(m=>m.id).sort()).toEqual([f.lead.id,f.mate.id].sort());
 expect(result.changed.bots.map(b=>b.id).sort()).toEqual([f.lead.id,f.mate.id].sort());
 for(const id of [f.lead.id,f.mate.id])expect(f.store.bot(id)?.section).toBe("Heritage");
 expect(f.store.group(f.group.id)).toMatchObject({section:"Heritage",name:"Heritage"});
 expect(readSectionContext("Heritage")?.text).toBe("Brief");expect(readSectionContext(f.long)).toBeNull();
 const keys=database().prepare("SELECT owner_key FROM memory_scopes WHERE kind='team'").all().map(r=>String(r.owner_key));expect(keys).toContain("Heritage");expect(keys).not.toContain(f.long);
 expect(database().prepare("SELECT count(*) AS n FROM team_identities").get()).toMatchObject({n:0});
 expect(()=>teamIdFor("Heritage")).not.toThrow();
});
it("R4e: deleting a 61-character legacy team succeeds without a journal, as it did before identities",()=>{
 const f=legacy(),result=deleteTeam(f.store,{section:f.long,bots:"archive",revision:teamRevision(f.store)},deps);
 expect(result).toMatchObject({bots:2,channels:1});
 for(const id of [f.lead.id,f.mate.id]){const bot=f.store.bot(id)!;expect(bot.section).toBeUndefined();expect(bot.hidden).toBe(true);expect(bot.chiefOfStaff??false).toBe(false);}
 expect(f.store.bot(f.mate.id)?.sharedWith?.mode).toBe("none");
 expect(f.store.group(f.group.id)).toMatchObject({hidden:true});expect(f.store.group(f.group.id)?.section).toBeUndefined();
 expect(readSectionContext(f.long)).toBeNull();
 const keys=database().prepare("SELECT owner_key FROM memory_scopes WHERE kind='team'").all().map(r=>String(r.owner_key));expect(keys).not.toContain(f.long);expect(keys.filter(k=>/^deleted-team:.*:L{61}$/.test(k))).toHaveLength(1);
 expect(database().prepare("SELECT count(*) AS n FROM team_identities").get()).toMatchObject({n:0});
});
it("R4e: a legacy team still waits while another team's journal is open",()=>{
 const f=legacy(),sales=teamIdFor("Sales");
 database().prepare("UPDATE team_identities SET op='rename',op_label='Revenue',op_phase=1,op_records='{\"bots\":[],\"groups\":[]}',op_since=1 WHERE team_id=?").run(sales);
 expect(()=>renameTeam(f.store,{section:f.long,name:"Heritage",revision:teamRevision(f.store)},deps)).toThrow(expect.objectContaining({status:409,message:expect.stringContaining("still finishing")}));
 expect(()=>deleteTeam(f.store,{section:f.long,bots:"keep",revision:teamRevision(f.store)},deps)).toThrow(expect.objectContaining({status:409}));
 expect(f.store.bot(f.lead.id)?.section).toBe(f.long);
});
it("R4e: a 61-character team an all-mode bot covers renames, and then the work opens and mints the team",async()=>{
 const f=legacy(),iris=f.store.createBot();f.store.patchBot(iris.id,{name:"Iris",section:"Design",sharedWith:{mode:"all",teams:[]}});
 const open=async(teamName:string)=>(await sharingRoute({method:"POST",path:`/api/bots/${iris.id}/work-threads`,desktop:true,visible:()=>true,readBody:async()=>({teamName}),deps:{store:f.store}}))!;
 const refused=await open(f.long);expect(refused.status).toBe(400);expect((refused.body as {error:string}).error).toContain("Rename the team");
 expect(renameTeam(f.store,{section:f.long,name:"Heritage",revision:teamRevision(f.store)},deps).team.name).toBe("Heritage");
 const opened=await open("Heritage");expect(opened.status).toBe(200);
 const id=String(database().prepare("SELECT team_id FROM team_identities WHERE label='Heritage' AND retired_at IS NULL").get()?.team_id);
 expect(f.store.bot(iris.id)?.tasks?.find(t=>t.threadId===(opened.body as {threadId:string}).threadId)?.sharedWork?.teamId).toBe(id);
});
