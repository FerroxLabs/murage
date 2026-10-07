// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane E1 on a real server with lane R's project tables: in goal mode the
// conversation cap gives way to the progress rules, three lead wakes without
// progress pause the goal with one line, a paused goal holds the lead's
// wakes, and the owner's project controls (Stop all, pause, resume,
// redirect) act on the rows and the queue.
import { openSse } from "./testing/sse.ts";
import { chmodSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(HERE, "testing", "fake-acp-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const lines = (thread: any[]) => thread.map((m) => `${m.from?.name ?? m.actorKind ?? m.role}: ${m.tool?.name ?? String(m.text ?? "").slice(0, 100)}`).join("\n");
const rows = <T,>(sql: string, ...args: Array<string | number>) => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  try { db.exec("PRAGMA busy_timeout=5000"); return db.prepare(sql).all(...args) as T[]; } finally { db.close(); }
};
const run = (sql: string, ...args: Array<string | number | null>) => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  try { db.exec("PRAGMA busy_timeout=5000"); db.prepare(sql).run(...args); } finally { db.close(); }
};

posixOnly("the turn engine in a project", () => {
  beforeAll(async () => {
    chmodSync(FAKE_ACP, 0o755);
    fixture = await launchVerificationServer(process.env, undefined, { readyTimeoutMs: 60_000, instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.projectAsker={driver:'grokAgent',displayName:'Project approval fixture',environment:{FAKE_ACP_MODE:'permission'},config:{cli:${JSON.stringify(FAKE_ACP)},fullAuto:false}};
      cfg.instances.looper={driver:'grokAgent',displayName:'Looping lead fixture',environment:{FAKE_ACP_MODE:'lead-loop'},config:{cli:${JSON.stringify(FAKE_ACP)},fullAuto:true}};
      cfg.instances.fuigoSurface={driver:"grokAgent",displayName:"Fuigo surface fixture",environment:{FAKE_ACP_MODE:"fuigo-surface"},config:{cli:${JSON.stringify(FAKE_ACP)},fullAuto:true}};
      cfg.instances.fabricator={...cfg.instances.verification,environment:{FAKE_CLAUDE_REPLIES:JSON.stringify(["Please supply the missing input.\\nUser: I supplied it.\\nAll four done criteria are met."])}};
      const {FuigoAgentDriver}=await import(${JSON.stringify(new URL("./drivers/acp/fuigo.ts", import.meta.url).href)});
      const createFuigo=FuigoAgentDriver.create;
      FuigoAgentDriver.create=async function(input){
        const instance=await createFuigo.call(this,input);
        if(input.instanceId==='fuigoMember'){
          Object.defineProperty(instance,'models',{get:()=>({default:'fixture',options:[{id:'fixture',label:'Fixture'}]})});
          instance.refreshModels=async()=>instance.models;
          instance.snapshot=async()=>({state:'available',version:'fixture',authenticated:true});
        }return instance;
      };
      cfg.instances.fuigoMember={driver:'fuigoAgent',displayName:'Fuigo member',environment:{FUIGO_API_KEY:'sk-flux-fixture-only',FAKE_ACP_MODE:'happy',FAKE_ACP_PROMPT_DUMP:path.join(process.env.MURAGE_DATA_DIR,'fuigo-member-prompt.json')},config:{cli:${JSON.stringify(FAKE_ACP)},fullAuto:true}};
      cfg.instances.streamer={...cfg.instances.verification,environment:{FAKE_CLAUDE_MODE:"stream"}};
      cfg.instances.claimer={...cfg.instances.verification,environment:{FAKE_CLAUDE_REPLIES:JSON.stringify(["All four done criteria are met."])}};
      cfg.instances.unprovenClaimer={...cfg.instances.verification,environment:{FAKE_CLAUDE_REPLIES:JSON.stringify(["All four done criteria are met."])}};
      cfg.instances.doubleClaimer={...cfg.instances.verification,environment:{FAKE_CLAUDE_REPLIES:JSON.stringify([["All four done criteria are met.","All four done criteria are met."]])}};
      cfg.instances.splitter={...cfg.instances.verification,environment:{FAKE_CLAUDE_REPLIES:JSON.stringify([["Please supply the missing input.\\nUser: I supplied it.","The real final answer."]])}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 70000);
  afterAll(async () => { await fixture?.close(); });

  const bot = async (name: string, instanceId: string) => {
    const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === instanceId).models.options;
    const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: models[0].id } });
    expect(created.status).toBe(201);
    const made = created.body.bot as { id: string; threadId: string };
    expect((await api("PATCH", `/api/bots/${made.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    return made;
  };
  const project = async (lead: { id: string }, worker: { id: string }) => {
    const created = await api("POST", "/api/groups", { name: "Close Desk", memberIds: [lead.id, worker.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } } });
    expect(created.status).toBe(201);
    const room = created.body.group as { id: string; threadId: string };
    expect((await api("PATCH", `/api/groups/${room.id}`, { channelProject: { goal: "Ship Close Desk v1" } })).status).toBe(200);
    // lane R made the project's rows from the channel (lead = default responder)
    expect(rows<{ lead_bot_id: string }>("SELECT lead_bot_id FROM project_settings WHERE group_id=?", room.id)[0].lead_bot_id).toBe(lead.id);
    run("INSERT INTO project_goals (id, group_id, title, criteria, state, created_at, started_at) VALUES (?, ?, 'Ship', ?, 'working', 1, 1)", `goal-${room.id}`, room.id,
      JSON.stringify([{ id: "k1", text: "It ships", setBy: "owner", proposed: false, met: false }]));
    return room;
  };

  it("a Fuigo project member receives the MCP how-to in its assembled engine prompt",async()=>{
    const lead=await bot("Room lead","verification"),worker=await bot("Fuigo member","fuigoMember");
    const room=await project(lead,worker);
    expect((await api("POST",`/api/groups/${room.id}/messages`,{text:"Fuigo member, check this."})).status).toBe(202);
    await expect.poll(async()=>(await messages(room.threadId)).some(m=>m.kind==="text" && m.from?.botId===worker.id),{timeout:30000}).toBe(true);
    const prompt=readFileSync(join(fixture.info.dataDir,"fuigo-member-prompt.json"),"utf8");
    expect(prompt).toContain("Murage tools are MCP tools. Call use_tool");
    expect(prompt).toContain("agents__ask_bot");
    expect(prompt).not.toMatch(/use (ask_bot|delegate_bot)\b|\{\{murage-tool:/);
  },45000);

  it.each([false,true])("preserves live streaming in room (project=%s)", async isProject => {
    const lead=await bot("Stream lead","streamer"),worker=await bot("Stream worker","verification");
    const room=isProject ? await project(lead,worker) : (await api("POST","/api/groups",{name:"Stream channel",memberIds:[lead.id,worker.id],setup:{bulletin:"",defaultResponder:{kind:"member",botId:lead.id}}})).body.group;
    const stream=await openSse(`${fixture.info.url}/api/events`,headers);
    try {
      await stream.until(frame=>frame.kind==="hello");
      expect((await api("POST",`/api/groups/${room.id}/messages`,{text:"Say hello."})).status).toBe(202);
      await stream.until(frame=>frame.kind==="runtime" && frame.event.threadId===room.threadId && frame.event.type==="turn.completed",30000);
      expect(stream.frames.filter(frame=>frame.kind==="runtime" && frame.event.threadId===room.threadId && frame.event.type==="content.delta" && frame.event.streamKind==="assistant_text").map(frame=>frame.event.delta).join("")).toBe("hello from fake claude");
    } finally {stream.close();}
  },45000);

  it("keeps lead card corrections in the desk and with the mirrored room result",async()=>{
    const lead=await bot("Claim lead","claimer"),worker=await bot("Claim worker","verification");
    const room=await project(lead,worker);
    run("UPDATE project_goals SET review=0 WHERE group_id=?",room.id);
    const created=await api("POST",`/api/groups/${room.id}/board/cards`,{clientId:"claim-card",goalId:`goal-${room.id}`,title:"Check criteria",assigneeBotId:lead.id});
    expect(created.status).toBe(200);
    const card=created.body.card;
    expect((await api("PATCH",`/api/groups/${room.id}/board/cards/${card.id}`,{action:"start",expectedRevision:card.revision})).status).toBe(200);
    await expect.poll(()=>rows<{state:string}>("SELECT state FROM project_work_items WHERE id=?",card.id)[0].state,{timeout:30000}).toBe("done");
    const desk=rows<{desk_thread_id:string}>("SELECT desk_thread_id FROM project_work_items WHERE id=?",card.id)[0].desk_thread_id;
    for(const threadId of [desk,room.threadId]) {
      const all=await messages(threadId),reply=all.find(m=>m.kind==="text" && m.text==="All four done criteria are met.");
      expect(Boolean(reply)).toBe(true);
      const correction=all.find(m=>m.actorKind==="murage" && m.tool?.name?.startsWith("On record:"));
      expect(correction?.replyToId).toBe(reply.id);
      expect(correction?.requestId).toBe(reply.requestId);
      expect(correction?.tool.name).toContain("0 of 1 done criteria met");
    }
  },45000);

  it("runs a teammate named in a later sentence in a lead-led project", async () => {
    const lead = await bot("Ivy", "verification"), worker = await bot("Juno", "verification");
    const room = await project(lead, worker);
    expect((await api("POST", `/api/groups/${room.id}/messages`, {
      text: "Marta liked the second headline option best. Juno, write the About page intro (80 to 120 words) in that tone.",
    })).status).toBe(202);
    await expect.poll(async () => (await messages(room.threadId)).filter(m => m.kind === "text" && m.from?.botId === worker.id).length, { timeout: 30000 }).toBe(1);
    expect((await messages(room.threadId)).filter(m => m.kind === "text" && m.from?.botId === lead.id)).toEqual([]);
  }, 45000);

  it("removes an invented owner turn before storing the room reply", async () => {
    const lead = await bot("Nova", "fabricator"), worker = await bot("Reed", "verification");
    const room = await project(lead, worker);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Check the missing input." })).status).toBe(202);
    await expect.poll(async () => (await messages(room.threadId)).filter(m => m.kind === "text" && m.from?.botId === lead.id).length, { timeout: 30000 }).toBe(1);
    const reply = (await messages(room.threadId)).find(m => m.kind === "text" && m.from?.botId === lead.id);
    expect(reply.text).toBe("Please supply the missing input.");
    expect(reply.removedSpeaker).toBe("User");
  }, 45000);

  it("a cut ends only its own item, and the removed line stays with the owner's removal row", async () => {
    const lead = await bot("Nova", "splitter"), worker = await bot("Reed", "verification");
    const room = await project(lead, worker);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Check the missing input." })).status).toBe(202);
    await expect.poll(async () => (await messages(room.threadId)).filter(m => m.kind === "text" && m.from?.botId === lead.id).length, { timeout: 30000 }).toBe(2);
    const all = await messages(room.threadId), replies = all.filter(m => m.kind === "text" && m.from?.botId === lead.id);
    expect(replies.map(m => m.text)).toEqual(["Please supply the missing input.", "The real final answer."]);
    expect(replies.map(m => m.removedSpeaker)).toEqual(["User", undefined]);
    const removal = all.filter(m => m.kind === "activity" && m.removedSpeaker);
    expect(removal).toHaveLength(1);
    expect(removal[0].removedText).toBe("User: I supplied it.");
    expect(all.filter(m => m.kind === "text").some(m => String(m.text).includes("I supplied it"))).toBe(false);
  }, 45000);

  it("records one criteria correction when two items of a turn claim the goal is done", async () => {
    const lead = await bot("Twice lead", "doubleClaimer"), worker = await bot("Twice worker", "verification");
    const room = await project(lead, worker);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Where are we?" })).status).toBe(202);
    await expect.poll(async () => (await messages(room.threadId)).filter(m => m.kind === "text" && m.from?.botId === lead.id).length, { timeout: 30000 }).toBe(2);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect((await messages(room.threadId)).filter(m => m.actorKind === "murage" && m.tool?.name?.startsWith("On record:"))).toHaveLength(1);
  }, 45000);

  it("keeps the goal's criteria out of a turn that is not the owner's", async () => {
    const lead = await bot("Unproven lead", "unprovenClaimer"), worker = await bot("Unproven worker", "verification");
    const room = await project(lead, worker);
    const posted = await fetch(`${fixture.info.url}/api/groups/${room.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Where are we?" }) });
    expect(posted.status).toBe(202);
    await expect.poll(async () => (await messages(room.threadId)).filter(m => m.kind === "text" && m.from?.botId === lead.id).length, { timeout: 30000 }).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 300));
    const all = await messages(room.threadId);
    expect(all.find(m => m.role === "user")?.origin).toBe("unproven");
    expect(all.filter(m => m.actorKind === "murage" && m.tool?.name?.startsWith("On record:"))).toEqual([]);
    expect(all.some(m => String(m.tool?.name ?? m.text ?? "").includes("It ships"))).toBe(false);
  }, 45000);

  it("a lead follows the qualified Fuigo tool instruction through the real agents proxy", async () => {
    const lead = await bot("Surface lead", "fuigoSurface"), worker = await bot("Surface worker", "verification");
    const room = await project(lead, worker);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Ask the teammate for an answer." })).status).toBe(202);
    await expect.poll(async () => rows<{ n: number }>("SELECT COUNT(*) AS n FROM room_requests WHERE group_id=? AND verb='ask'", room.id)[0].n, { timeout: 30000 }).toBeGreaterThan(0);
    expect((await messages(room.threadId)).some(m => String(m.text ?? "").includes("Tool not found"))).toBe(false);
    await api("POST", `/api/groups/${room.id}/project/control/stop`, {});
  }, 45000);

  it("runs three owner cards from a planning goal and leaves planning", async () => {
    const lead = await bot("Cards lead", "verification"), worker = await bot("Cards worker", "verification");
    const room = await project(lead, worker);
    run("UPDATE project_goals SET state='planning',review=0 WHERE group_id=?", room.id);
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      const created = await api("POST", `/api/groups/${room.id}/board/cards`, { clientId: `owner-card-${index}`, goalId: `goal-${room.id}`, title: `Owner work ${index}`, assigneeBotId: worker.id });
      expect(created.status).toBe(200);
      const card = created.body.card;
      ids.push(card.id);
      expect((await api("PATCH", `/api/groups/${room.id}/board/cards/${card.id}`, { action: "start", expectedRevision: card.revision })).status).toBe(200);
    }
    expect(rows<{ state: string }>("SELECT state FROM project_goals WHERE group_id=?", room.id)[0].state).toBe("working");
    await expect.poll(() => rows<{ state: string }>("SELECT state FROM project_work_items WHERE group_id=? ORDER BY number", room.id).map(row => row.state), { timeout: 45000 }).toEqual(["done", "done", "done"]).catch(error => {
      throw new Error(`${error}\n${JSON.stringify({ goals: rows("SELECT state,state_reason,no_progress FROM project_goals WHERE group_id=?", room.id), requests: rows("SELECT verb,state,refusal,outcome_note FROM room_requests WHERE group_id=?", room.id) })}`);
    });
    expect(rows<{ n: number }>("SELECT COUNT(*) AS n FROM room_requests WHERE group_id=? AND verb='assign' AND from_kind='owner' AND state='done'", room.id)[0].n).toBe(ids.length);
  }, 60000);

  it("groups a live project approval in one Inbox row and keeps its individual answer",async()=>{
    const lead=await bot("Approval lead","projectAsker"),worker=await bot("Approval worker","verification");
    const room=await project(lead,worker);
    expect((await api("POST",`/api/groups/${room.id}/messages`,{text:"Please check this."})).status).toBe(202);
    let row:any;
    await expect.poll(async()=>{row=(await api("GET","/api/inbox?view=decisions")).body.projects?.find((item:any)=>item.groupId===room.id);return row?.approvals.length;},{timeout:20000}).toBe(1);
    expect(row.sentence).toBe("Close Desk: 1 thing needs your OK");
    expect((await api("GET",`/api/groups/${room.id}/project`)).body.strip.needsYou).toBe(1);
    expect((await api("GET","/api/inbox?view=decisions")).body.projects.filter((item:any)=>item.groupId===room.id)).toHaveLength(1);
    const approval=row.approvals[0];
    expect((await api("POST",`/api/threads/${approval.threadId}/respond`,{requestId:approval.requestId,behavior:"deny"})).status).toBe(200);
    await expect.poll(async()=>(await api("GET","/api/inbox?view=decisions")).body.projects?.find((item:any)=>item.groupId===room.id)?.approvals.length??0,{timeout:20000}).toBe(0);
    await api("POST",`/api/groups/${room.id}/project/control/stop`,{});
  },45000);

  it("three lead wakes without progress pause the goal with one line, and the paused goal holds the lead", async () => {
    for (const existing of (await api("GET", "/api/bots?messages=0")).body.bots) await api("PATCH", `/api/bots/${existing.id}`, { hidden: true });
    const lead = await bot("Finch", "looper");
    const worker = await bot("Jax", "verification");
    const room = await project(lead, worker);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "LEAD_ASSIGN: get it done" })).status).toBe(202);
    await expect.poll(async () => (await messages(room.threadId)).some((m) => m.actorKind === "murage" && /3 team steps without progress/.test(m.tool?.name ?? "")), { timeout: 90000 }).toBe(true)
      .catch(async (error) => { throw new Error(`${error}\n${lines(await messages(room.threadId))}`); });
    const goal = rows<{ state: string; state_reason: string; lead_wakes: number; no_progress: number }>("SELECT state, state_reason, lead_wakes, no_progress FROM project_goals WHERE group_id=?", room.id)[0];
    expect(goal).toMatchObject({ state: "paused", no_progress: 3 });
    expect(goal.state_reason).toMatch(/3 team steps without progress/);
    // goal mode: the conversation cap did not stop it first
    expect((await messages(room.threadId)).some((m) => /6 team steps/.test(m.tool?.name ?? ""))).toBe(false);
    // the next result's wake waits: the goal is paused
    await expect.poll(async () => ((await api("GET", `/api/groups/${room.id}/requests?open=1`)).body.requests as any[])
      .some((request) => request.verb === "wake" && request.state === "queued" && request.refusalLine === "Paused"), { timeout: 30000 }).toBe(true);
    expect((await messages(room.threadId)).filter((m) => /3 team steps without progress/.test(m.tool?.name ?? ""))).toHaveLength(1);

    // Stop all: the waiting wake is cancelled and the project paused
    const stopped = await api("POST", `/api/groups/${room.id}/project/control/stop`, {});
    expect(stopped.status).toBe(200);
    expect(stopped.body.stopped.requests).toBeGreaterThanOrEqual(1);
    expect(((await api("GET", `/api/groups/${room.id}/requests?open=1`)).body.requests as any[]).filter((request) => request.state === "queued")).toEqual([]);
    expect(rows<{ run_state: string }>("SELECT run_state FROM project_settings WHERE group_id=?", room.id)[0].run_state).toBe("paused");

    // a steering note waits for resume, then reaches the lead as a wake
    const note = await api("POST", `/api/groups/${room.id}/project/control/redirect`, { clientId: "redirect-client-0001", text: "Pricing first, then the FAQ." });
    expect(note.status).toBe(200);
    const again = await api("POST", `/api/groups/${room.id}/project/control/redirect`, { clientId: "redirect-client-0001", text: "Pricing first, then the FAQ." });
    expect(again.body.requestId).toBe(note.body.requestId);
    await expect.poll(async () => ((await api("GET", `/api/groups/${room.id}/requests?open=1`)).body.requests as any[]).find((request) => request.id === note.body.requestId)?.refusalLine, { timeout: 15000 }).toBe("Paused");
    const resumed = await api("POST", `/api/groups/${room.id}/project/control/resume`, {});
    expect(resumed.status).toBe(200);
    // no cards yet, so the goal goes back to planning (SPEC-P 5.3 resume)
    expect(resumed.body).toMatchObject({ settings: { runState: "running" }, goal: { state: "planning" } });
    await expect.poll(async () => rows<{ state: string }>("SELECT state FROM room_requests WHERE id=?", note.body.requestId)[0].state, { timeout: 30000 }).not.toBe("queued");
    // and the owner pauses it again from the strip
    const paused = await api("POST", `/api/groups/${room.id}/project/control/pause`, {});
    expect(paused.body).toMatchObject({ settings: { runState: "paused", runStateReason: "Paused by you" }, goal: { state: "paused" } });
    await api("POST", `/api/groups/${room.id}/project/control/stop`, {});
  }, 200000);

  it("a routine in a project is queued by lane R and answered by the lead in the project's chat", async () => {
    const lead = await bot("Rowan", "verification"), worker = await bot("Ivy", "verification");
    const room = await project(lead, worker);
    expect((await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === lead.id).partitionedAt).toBeUndefined();
    const created = await api("POST", "/api/routines", {
      name: "Morning notes", prompt: "ROUTINE_NOTES write the morning notes", target: "room-goal", groupId: room.id, botId: lead.id,
      runOn: "ember", schedule: { type: "once", at: Date.now() + 60 * 60_000 }, durationMinutes: 30,
    });
    expect(created.status).toBe(201);
    expect((await api("POST", `/api/routines/${created.body.routine.id}/run`)).status).toBe(201);
    await expect.poll(() => rows<{ state: string; to_bot_id: string }>("SELECT state, to_bot_id FROM room_requests WHERE group_id=? AND verb='routine'", room.id)[0], { timeout: 60000 })
      .toMatchObject({ state: "done", to_bot_id: lead.id });
    await expect.poll(async()=>rows<{n:number}>("SELECT COUNT(*) AS n FROM usage_ledger WHERE group_id=?",room.id)[0]?.n,{timeout:10000}).toBeGreaterThan(0);
    const usage=await api("GET",`/api/groups/${room.id}/usage`);
    expect(usage.status).toBe(200);expect(usage.body.totals.workMs).toBeGreaterThanOrEqual(0);
    expect(rows<{n:number}>("SELECT COUNT(*) AS n FROM usage_ledger WHERE group_id=? AND request_id IS NULL",room.id)[0]?.n).toBe(0);
    const thread = await messages(room.threadId);
    const asked = thread.findIndex((m) => m.role === "user" && String(m.text ?? "").includes("ROUTINE_NOTES"));
    expect(asked).toBeGreaterThanOrEqual(0);
    expect(thread.slice(asked + 1).some((m) => m.from?.botId === lead.id && m.kind === "text")).toBe(true);
  }, 90000);

  it("an ongoing project's routine runs its card in the desk and delivers its result", async () => {
    const lead = await bot("Sage", "verification"), worker = await bot("Ren", "verification");
    const room = await project(lead, worker);
    run("DELETE FROM project_goals WHERE group_id=?", room.id);
    run("UPDATE project_settings SET mode='ongoing' WHERE group_id=?", room.id);
    const created = await api("POST", "/api/routines", {
      name: "Weekly report", prompt: "ROUTINE_REPORT write the weekly report", target: "room-goal", groupId: room.id, botId: worker.id,
      runOn: "ember", schedule: { type: "once", at: Date.now() + 60 * 60_000 }, durationMinutes: 30,
    });
    expect(created.status).toBe(201);
    expect((await api("POST", `/api/routines/${created.body.routine.id}/run`)).status).toBe(201);
    await expect.poll(() => rows<{ state: string; outcome_note: string }>("SELECT state, outcome_note FROM room_requests WHERE group_id=? AND verb='routine'", room.id)[0], { timeout: 30000 })
      .toMatchObject({ state: "done", outcome_note: "card run queued" });
    const card = rows<{ id: string; title: string; assignee_bot_id: string }>("SELECT id, title, assignee_bot_id FROM project_work_items WHERE group_id=?", room.id);
    expect(card).toEqual([expect.objectContaining({ title: "Weekly report", assignee_bot_id: worker.id })]);
    const routineRow = rows<{ id: string; root_id: string; root_thread_id: string }>("SELECT id, root_id, root_thread_id FROM room_requests WHERE group_id=? AND verb='routine'", room.id)[0];
    // the card's run is the routine's child: its lineage, nobody watching
    expect(rows<Record<string, unknown>>("SELECT verb, to_bot_id, parent_id, root_id, root_thread_id, unattended FROM room_requests WHERE group_id=? AND work_item_id=? AND verb='assign'", room.id, card[0].id))
      .toEqual([{ verb: "assign", to_bot_id: worker.id, parent_id: routineRow.id, root_id: routineRow.root_id, root_thread_id: room.threadId, unattended: 1 }]);
    await expect.poll(() => rows<{ state: string }>("SELECT state FROM project_work_items WHERE id=?", card[0].id)[0].state, { timeout: 45000 }).toBe("done");
    expect((await messages(room.threadId)).some((m) => m.from?.botId === worker.id && m.kind === "text" && m.copyOf?.threadId)).toBe(true);
  }, 60000);

  it("R3c C1: starting a goal wakes the unpartitioned lead once, in the project's chat", async () => {
    const lead = await bot("Nova", "verification"), worker = await bot("Kai", "verification");
    const room = await project(lead, worker);
    run("DELETE FROM project_goals WHERE group_id=?", room.id);
    const created = await api("POST", `/api/groups/${room.id}/project/goals`, { title: "Launch the FAQ", criteria: ["The FAQ is live", "It answers pricing"] });
    expect(created.status).toBe(200);
    const goal = created.body.goal as { id: string; revision: number };
    const started = await api("PATCH", `/api/groups/${room.id}/project/goals/${goal.id}`, { expectedRevision: goal.revision, action: "start" });
    expect(started.status).toBe(200);
    expect((await api("PATCH", `/api/groups/${room.id}/project/goals/${goal.id}`, { expectedRevision: started.body.goal.revision, action: "start" })).status).toBe(409);
    await expect.poll(() => rows<{ state: string; to_bot_id: string; target_thread_id: string }>("SELECT state, to_bot_id, target_thread_id FROM room_requests WHERE admission_key=?", `wake:goal-start:${goal.id}`), { timeout: 60000 })
      .toEqual([{ state: "done", to_bot_id: lead.id, target_thread_id: room.threadId }]);
    expect((await messages(room.threadId)).some((m) => m.from?.botId === lead.id && m.kind === "text")).toBe(true);
  }, 90000);

  it("control routes answer only for an open project, and check their bodies", async () => {
    const lead = await bot("Lead2", "verification"), worker = await bot("Worker2", "verification");
    const plain = (await api("POST", "/api/groups", { name: "Plain", memberIds: [lead.id, worker.id], setup: { bulletin: "", defaultResponder: { kind: "everyone" } } })).body.group;
    expect((await api("POST", `/api/groups/${plain.id}/project/control/pause`, {})).status).toBe(404);
    const room = await project(lead, worker);
    expect((await api("POST", `/api/groups/${room.id}/project/control/pause`, { extra: 1 })).status).toBe(400);
    expect((await api("POST", `/api/groups/${room.id}/project/control/redirect`, { clientId: "short", text: "x" })).status).toBe(400);
    // R refuses to resume the goal (goals are off): the project stays paused
    expect((await api("POST", `/api/groups/${room.id}/project/control/pause`, {})).status).toBe(200);
    expect((await api("PATCH", "/api/config", { features: { projectsGoals: false } })).status).toBe(200);
    try {
      expect((await api("POST", `/api/groups/${room.id}/project/control/resume`, {})).body).toEqual({ error: "not_allowed", reason: "Paused: goals are off" });
      expect(rows<{ run_state: string }>("SELECT run_state FROM project_settings WHERE group_id=?", room.id)[0].run_state).toBe("paused");
    } finally {
      await api("PATCH", "/api/config", { features: { projectsGoals: true } });
    }
    run("UPDATE project_settings SET closed_at=5 WHERE group_id=?", room.id);
    expect((await api("POST", `/api/groups/${room.id}/project/control/resume`, {})).body).toEqual({ error: "not_allowed", reason: "This project is closed." });
    run("UPDATE project_settings SET closed_at=NULL, lead_bot_id=NULL WHERE group_id=?", room.id);
    expect((await api("POST", `/api/groups/${room.id}/project/control/resume`, {})).body).toEqual({ error: "not_allowed", reason: "Pick a lead to resume." });
    // Round 16 (D3): a lead who is not a member cannot resume a working goal
    const outsider = await bot("Outsider2", "verification");
    run("UPDATE project_settings SET lead_bot_id=? WHERE group_id=?", outsider.id, room.id);
    run("UPDATE project_goals SET state='working' WHERE group_id=?", room.id);
    expect((await api("POST", `/api/groups/${room.id}/project/control/resume`, {})).body).toEqual({ error: "not_allowed", reason: "Pick a lead to resume." });
    expect(rows<{ run_state: string }>("SELECT run_state FROM project_settings WHERE group_id=?", room.id)[0].run_state).toBe("paused");
    // a caller with no proof gets nothing that confirms the route
    const bare = await fetch(`${fixture.info.url}/api/groups/${room.id}/project/control/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(bare.status).toBe(404);
  }, 60000);

  // Round 12 (L6): through the real settings route, a patch that sets no
  // lead queues no held review wake; a lead appearing queues it.
  it("queues a held review wake only when a lead appears on the settings route", async () => {
    const lead = await bot("Held lead", "verification"), worker = await bot("Held worker", "verification");
    const room = await project(lead, worker);
    const patch = async (body: Record<string, unknown>) => {
      const revision = (await api("GET", `/api/groups/${room.id}/project`)).body.settings.revision;
      return (await api("PATCH", `/api/groups/${room.id}/project/settings`, { expectedRevision: revision, ...body })).status;
    };
    expect(await patch({ leadBotId: null })).toBe(200);
    const card = `held-${room.id}`, runId = `held-run-${room.id}`;
    run(`INSERT INTO project_work_items (id, group_id, goal_id, number, title, state, position, assignee_bot_id, generation, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 90, 'Held card', 'review', 90, ?, 1, 'owner', 1, 1)`, card, room.id, `goal-${room.id}`, worker.id);
    run(`INSERT INTO room_requests (id, root_id, group_id, work_item_id, project_goal_id, card_generation, verb, from_kind, to_bot_id, origin, root_thread_id,
      audience_fingerprint, not_owner_audience, unattended, admission_key, state, created_at, finished_at)
      VALUES (?, ?, ?, ?, ?, 1, 'assign', 'owner', ?, 'desktop', ?, 'owner', 0, 0, ?, 'done', 1, 2)`, runId, runId, room.id, card, `goal-${room.id}`, worker.id, room.threadId, `assign:card:${card}:1:1`);
    const wakes = () => rows<{ to_bot_id: string }>("SELECT to_bot_id FROM room_requests WHERE admission_key LIKE ?", `wake:review:${runId}%`);
    expect(await patch({ parallelCards: 2 })).toBe(200);
    expect(wakes()).toEqual([]);
    expect(await patch({ leadBotId: lead.id })).toBe(200);
    expect(wakes()).toEqual([{ to_bot_id: lead.id }]);
  }, 60000);

  // Round 12 (L6, S2): deleting a project conversation through the routes
  // (a task thread, a member's desk, the member itself) marks the lead's
  // cards made after its messages stale, and the deletion still succeeds.
  describe("deleting a project conversation marks the lead's later cards stale", () => {
    const leadCard = (room: { id: string }, lead: { id: string }, id: string, number: number) => run(`INSERT INTO project_work_items
      (id, group_id, goal_id, number, title, state, position, source_message_ids, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'Lead card', 'todo', ?, '[]', ?, ?, ?)`,
      id, room.id, `goal-${room.id}`, number, number, lead.id, Date.now() + 60_000, Date.now() + 60_000);
    const stale = (id: string) => rows<{ stale: number }>("SELECT stale FROM project_work_items WHERE id=?", id)[0]?.stale;
    const deleted = async (path: string) => {
      let result = await api("DELETE", path);
      await expect.poll(async () => result.status === 409 ? (result = await api("DELETE", path)).status : result.status, { timeout: 20_000 }).toBe(200);
    };
    const deskOf = async (room: { id: string }, worker: { id: string }) => {
      run("UPDATE project_goals SET review=0 WHERE group_id=?", room.id);
      const created = await api("POST", `/api/groups/${room.id}/board/cards`, { clientId: `desk-${worker.id}`, goalId: `goal-${room.id}`, title: "Desk work", assigneeBotId: worker.id });
      expect(created.status).toBe(200);
      expect((await api("PATCH", `/api/groups/${room.id}/board/cards/${created.body.card.id}`, { action: "start", expectedRevision: created.body.card.revision })).status).toBe(200);
      await expect.poll(() => rows<{ state: string }>("SELECT state FROM project_work_items WHERE id=?", created.body.card.id)[0].state, { timeout: 30000 }).toBe("done");
      return rows<{ desk_thread_id: string }>("SELECT desk_thread_id FROM project_work_items WHERE id=?", created.body.card.id)[0].desk_thread_id;
    };

    it("a task thread of the project", async () => {
      const lead = await bot("Task lead", "verification"), worker = await bot("Task worker", "verification");
      const room = await project(lead, worker);
      const task = (await api("POST", `/api/groups/${room.id}/tasks`, {})).body.group.threadId as string;
      expect((await api("POST", `/api/groups/${room.id}/messages`, { threadId: task, text: "Plan around the 12 price." })).status).toBeLessThan(300);
      await expect.poll(async () => (await messages(task)).length, { timeout: 20_000 }).toBeGreaterThan(0);
      leadCard(room, lead, `task-card-${room.id}`, 91);
      await deleted(`/api/groups/${room.id}/tasks/${task}`);
      expect(stale(`task-card-${room.id}`)).toBe(1);
    }, 60000);

    it("a member's project desk conversation", async () => {
      const lead = await bot("Desk lead", "verification"), worker = await bot("Desk worker", "verification");
      const room = await project(lead, worker);
      const desk = await deskOf(room, worker);
      leadCard(room, lead, `desk-card-${room.id}`, 92);
      await deleted(`/api/bots/${worker.id}/tasks/${desk}`);
      expect(stale(`desk-card-${room.id}`)).toBe(1);
    }, 60000);

    it("a member with its desks", async () => {
      const lead = await bot("Gone lead", "verification"), worker = await bot("Gone worker", "verification");
      const room = await project(lead, worker);
      await deskOf(room, worker);
      leadCard(room, lead, `gone-card-${room.id}`, 93);
      await deleted(`/api/bots/${worker.id}`);
      expect(stale(`gone-card-${room.id}`)).toBe(1);
    }, 60000);
  });
});
