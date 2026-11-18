// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: boot-tolerance lane. Fixture-F classes not already seeded in low-disk-start.test.ts; each owns its seed and both recovery assertions.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { BROWSER_CHECKING_REASON, browserUnavailableActivityName } from "../../shared/browser-unavailable.ts";

type Record = { [key: string]: any };
export function seedRemainingBootRecoveries(data: string, seed: DatabaseSync) {
  const file = (name: string) => join(data, name);
  const json = (name: string): any => JSON.parse(readFileSync(file(name), "utf8"));
  const save = (name: string, value: unknown) => writeFileSync(file(name), JSON.stringify(value));
  const storedBot=(id:string):Record=>json("bots.json").find((item:Record)=>item.id===id);
  const bots = json("bots.json") as Record[], groups = json("groups.json") as Record[];
  const bot = bots[0]!, group = groups[0]!;
  expect(group, "fixture F has a room").toBeDefined();
  const read = (sql: string, ...args: string[]): any => {
    const db = new DatabaseSync(file("messages.db"), { readOnly: true });
    try { return db.prepare(sql).get(...args); } finally { db.close(); }
  };
  const message = (thread: string, id: string, kind: string, rest: Record) => {
    const value = { id, at: 1, role: "bot", kind, ...rest };
    seed.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,1,'bot',?,?,?)").run(thread,id,kind,null,JSON.stringify(value));
  };
  const field = (id: string, path: string) => read("SELECT json_extract(json,?) AS v FROM messages WHERE id=?", path, id)?.v;
  for (const [id, runId] of [["goal-manual-fixture", "manual-goal-fixture"], ["goal-routine-fixture", "run-goal-fixture"]])
    message(group.threadId,id!,"goal.run",{ text: "Goal in progress", goalRun: { runId, goal: "Fixture goal", status: "working", coordinatorBotId: bot.id, coordinatorName: bot.name, turnCount: 2, maxTurns: 13, startedAt: 1 } });
  writeFileSync(file("events/routine-runs/routine-goal-fixture.jsonl"), JSON.stringify({ id:"run-goal-fixture",routineId:"routine-goal-fixture",routineName:"Fixture goal",target:"room-goal",groupId:group.id,botId:bot.id,runOn:"ember",status:"completed",goalStatus:"completed",manual:false,scheduledFor:1,createdAt:1,threadId:group.threadId,output:"The scheduled report shipped.",finishedAt:2 })+"\n");
  const pendingName = browserUnavailableActivityName(BROWSER_CHECKING_REASON);
  message(bot.threadId,"bcheck-fixture","activity",{ tool:{ name:pendingName,ok:true } });
  seed.prepare("INSERT INTO browser_check_pending VALUES(?,'bcheck-fixture')").run(bot.threadId);
  seed.exec("UPDATE transcript_index_state SET done=1 WHERE name IN ('browser_check','open_card')");
  seed.prepare(`INSERT INTO approval_records(id,source_kind,thread_id,request_key,request_id,bot_id,generation,actor_kind,actor_via,level,why,evidence,registration_hash,deny_rev,input_hash,action_hash,chat_message_id,state,created_at)
    VALUES('appr-fixture','engine',?,'msg-appr-fixture','req-appr-fixture',?,'fixture','owner','owner-typed','ask','base','{"items":[],"action":{},"initiator":{"k":"owner-typed"}}','rh-fixture','[]','ih-fixture','ah-fixture','msg-appr-fixture','open',1)`).run(bot.threadId,bot.id);
  for (const [id,tool] of [["card-peer-fixture","ask_bot"],["card-host-fixture","local_computer_consent"]]) {
    message(bot.threadId,id!,"options",{card:{title:"Fixture permission",subtitle:"",options:["Allow","Deny"],requestId:id,tool}});
    seed.prepare("INSERT INTO open_card VALUES(?,?)").run(bot.threadId,id!);
  }
  save("pending-deletions.json",[{id:"del-fixture",createdAt:1,threadIds:[bot.threadId],desks:[],engineHomes:[],attachments:[],artifactBlobs:[],leftovers:[]}]);
  const packed = bots.find(item=>item.name==="Fixture Packed")!;
  packed.installedPackage={id:"pkg-fixture",name:"Fixture Pack",release:"1.0.0",requiredApps:[]};
  const task=bot.tasks.find((item:Record)=>item.threadId===bot.threadId)!;
  task.heldContinuations=[{id:"wake:fixture",text:"Fixture continuation",at:1,botId:bot.id,dispatcher:"direct",principal:JSON.stringify({kind:"owner"}),options:{askerWake:true}}];
  const profileBot=bots[1]!; const selection=Number(profileBot.selectionRevision??0);profileBot.browserProfile="fixture-profile";
  const modes=json("browser-modes.json");
  modes.bots[profileBot.id]={...modes.bots[profileBot.id],browserMode:"builtin",browserProfile:"fixture-profile",selectionRevision:selection,browserSelectionRevision:selection};
  save("browser-modes.json",modes);
  save("browser-cleanups.json",[{requestId:"11111111-1111-4111-8111-111111111111",kind:"profile",id:"fixture-profile",partitionId:"fixture-partition",phase:"committed"}]);
  save("cloud-computer-turns.json",{version:1,entries:[{turnId:"t-fixture",boxId:"box-fixture",threadId:bot.threadId,promptId:"p1",owner:"prior-process",state:"stopped",at:1000,account:"0000000000000000",lineOwed:"restart-stopped"}]});
  group.channelProject={goal:"Fixture goal",status:"active",startedAt:1,updatedAt:1};
  seed.exec("INSERT INTO project_activity(id,group_id,at,kind,actor,detail) VALUES('pa-fixture','group-fixture',1,'settings','server','{}')");
  seed.prepare("INSERT INTO room_shares(id,bot_id,room_id,room_thread_id,origin_thread_id,query,excerpts,excerpts_hash,nonce,status,stable_id,created_at,expires_at) VALUES('share-fixture',?,?,?,?,'q','[]','h','n','pending','stable-share-fixture',1,9999999999999)").run(bot.id,group.id,group.threadId,bot.threadId);
  seed.exec("INSERT INTO speech_attempts(attempt_id,session_id,command_sequence,thread_id,message_id,generation_id,mode,revision,boot_id,reserved_at,account_scope_id,plan_version,state,outcome) VALUES('att-fixture','sess-fixture',1,'thread-fixture','msg-fixture',NULL,'manual',0,'boot-fixture',1,'scope-fixture','plan-fixture','streaming',NULL)");
  const boot=read("SELECT boot FROM memory_open_turns_build WHERE id=1").boot;
  const trust=json("folder-trust.json");delete trust.seededFrom;save("folder-trust.json",trust);
  save("bots.json",bots);save("groups.json",groups);
  const unchangedFiles=Object.fromEntries(["pending-deletions.json","bots.json","groups.json","browser-cleanups.json","cloud-computer-turns.json","folder-trust.json","browser-modes.json"].map(name=>[name,readFileSync(file(name),"utf8")]));
  const classes = [
    {id:1,before:()=>expect([field("goal-manual-fixture","$.goalRun.status"),field("goal-routine-fixture","$.goalRun.status")]).toEqual(["working","working"]),after:()=>{expect(field("goal-manual-fixture","$.goalRun.status")).toBe("failed");expect(field("goal-routine-fixture","$.goalRun.status")).toBe("completed");expect(field("goal-routine-fixture","$.goalRun.finishedAt")).toBe(2);}},
    {id:3,before:()=>expect(field("bcheck-fixture","$.tool.name")).toBe(pendingName),after:()=>{expect(field("bcheck-fixture","$.tool.name")).not.toBe(pendingName);expect(read("SELECT 1 FROM browser_check_pending WHERE id='bcheck-fixture'")).toBeUndefined();}},
    {id:6,before:()=>expect(read("SELECT state,settled_at FROM approval_records WHERE id='appr-fixture'")).toEqual({state:"open",settled_at:null}),after:()=>{expect(read("SELECT state FROM approval_records WHERE id='appr-fixture'").state).toBe("expired");expect(read("SELECT settled_at FROM approval_records WHERE id='appr-fixture'").settled_at).not.toBeNull();}},
    {id:7,before:()=>expect([field("card-peer-fixture","$.card.answered"),field("card-host-fixture","$.card.answered")]).toEqual([null,null]),after:()=>{for(const id of ["card-peer-fixture","card-host-fixture"]){expect(field(id,"$.card.answered")).not.toBeNull();expect(read("SELECT 1 FROM open_card WHERE id=?",id)).toBeUndefined();}}},
    {id:9,before:()=>expect(json("pending-deletions.json")).toHaveLength(1),after:()=>expect(json("pending-deletions.json")).toEqual([])},
    {id:10,before:()=>expect(json("bots.json").find((item:Record)=>item.id===packed.id).section).toBe("Fixture Pack · General (1a2b3c4d)"),after:()=>expect(json("bots.json").find((item:Record)=>item.id===packed.id).section).toBe("Fixture Pack")},
    {id:11,before:()=>expect(storedBot(bot.id).tasks.find((item:Record)=>item.threadId===bot.threadId).heldContinuations).toHaveLength(1),after:()=>expect(storedBot(bot.id).tasks.find((item:Record)=>item.threadId===bot.threadId).heldContinuations??[]).toEqual([])},
    {id:12,before:()=>{expect(storedBot(profileBot.id).browserProfile).toBe("fixture-profile");expect(json("browser-modes.json").bots[profileBot.id].browserProfile).toBe("fixture-profile");},after:()=>{expect(storedBot(profileBot.id).browserProfile).toBeUndefined();expect(storedBot(profileBot.id).selectionRevision).toBe(selection+1);expect(json("browser-modes.json").bots[profileBot.id].browserProfile).toBeUndefined();expect(json("browser-modes.json").bots[profileBot.id].selectionRevision).toBe(selection+1);}},
    {id:13,before:()=>{expect(json("cloud-computer-turns.json").entries).toHaveLength(1);expect(read("SELECT 1 FROM messages WHERE id='cloud-computer-restart:t-fixture'")).toBeUndefined();},after:()=>{expect(json("cloud-computer-turns.json").entries).toEqual([]);expect(read("SELECT 1 FROM messages WHERE id='cloud-computer-restart:t-fixture'")).toBeDefined();}},
    {id:15,before:()=>expect(read("SELECT 1 FROM project_settings WHERE group_id=?",group.id)).toBeUndefined(),after:()=>{expect(read("SELECT 1 FROM project_settings WHERE group_id=?",group.id)).toBeDefined();expect(read("SELECT migrated_from FROM project_settings WHERE group_id=?",group.id).migrated_from).toBe("channelProject");expect(read("SELECT state FROM project_goals WHERE group_id=?",group.id).state).toBe("draft");}},
    {id:16,before:()=>expect(read("SELECT 1 FROM project_activity WHERE id='pa-fixture'")).toBeDefined(),after:()=>expect(read("SELECT 1 FROM project_activity WHERE id='pa-fixture'")).toBeUndefined()},
    {id:17,before:()=>expect(read("SELECT status FROM room_shares WHERE id='share-fixture'").status).toBe("pending"),after:()=>expect(read("SELECT status FROM room_shares WHERE id='share-fixture'").status).toBe("unavailable")},
    {id:18,before:()=>{expect(read("SELECT state,outcome FROM speech_attempts WHERE attempt_id='att-fixture'")).toEqual({state:"streaming",outcome:null});expect(read("SELECT boot FROM memory_open_turns_build WHERE id=1").boot).toBe(boot);expect(json("folder-trust.json").seededFrom).toBeUndefined();},after:()=>{expect(read("SELECT state,outcome FROM speech_attempts WHERE attempt_id='att-fixture'")).toEqual({state:"interrupted",outcome:"boot"});expect(read("SELECT boot FROM memory_open_turns_build WHERE id=1").boot).toBe(boot+1);expect(json("folder-trust.json").seededFrom).toBe("0.1.52");}},
  ];
  expect(classes.map(item=>item.id)).toEqual([1,3,6,7,9,10,11,12,13,15,16,17,18]);
  return {
    ready:()=>read("SELECT status FROM room_shares WHERE id='share-fixture'").status==="unavailable" && json("cloud-computer-turns.json").entries.length===0,
    untouched:()=>{for(const item of classes) { try { item.before(); } catch(error) { throw new Error(`fixture F class ${item.id} changed read-only`,{cause:error}); }}for(const [name,bytes] of Object.entries(unchangedFiles))expect(readFileSync(file(name),"utf8"),name).toBe(bytes);},
    settled:()=>{for(const item of classes) { try { item.after(); } catch(error) { throw new Error(`fixture F class ${item.id} did not settle`,{cause:error}); }}},
  };
}
