// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createRoomDispatcher, ROOM_TURN_STATUS_AFTER_MS, type RoomDispatcherDeps } from "./room-dispatcher.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { startProjectClose, resumeProjectCloses } from "./project-close.ts";
import { channelToProjectRows } from "./project-settings.ts";
import { completeRequest } from "./room-requests.ts";
import { recordProjectRoutine } from "./project-routines.ts";
import { insertRoomRequest, roomRequest, type RoomRequest } from "./room-requests.ts";
import { createWorkAdmission as createUnconfiguredAdmission, type WorkAdmissionDeps } from "./work-admission.ts";

let db: DatabaseSync;
let now = 1_000;
const lineage = { rootThreadId: "t", origin: "desktop" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false };
const admissionDeps = (over: Partial<WorkAdmissionDeps> = {}): WorkAdmissionDeps => ({
  restoreReview: () => false, flags: () => ({ autonomy: true, budgets: true }), threadRunning: () => false, speakingInRoom: () => false,
  directThreads: () => 0, maxThreads: 3, installCardCap: 4, rootCounters: () => ({ wakes: 0, workMs: 0 }), askWouldDeadlock: () => false,
  reachable: () => true, dependencyOpen: () => false, claimWriterRoot: () => () => {}, now: () => now, ...over,
});

function createWorkAdmission(dependencies: WorkAdmissionDeps) {
  const admission=createUnconfiguredAdmission(dependencies);
  admission.setBudgetGate({check:()=>({ok:true})});return admission;
}
function harness(over: Partial<RoomDispatcherDeps> = {}, admission = createWorkAdmission(admissionDeps())) {
  const started: string[] = [], closed: string[] = [], waiting: string[] = [], busy = new Set<string>();
  const deps: RoomDispatcherDeps = {
    db: () => db, admission, now: () => now, open: () => true, roomUsable: () => true,
    roomBusy: (_g, thread) => busy.has(thread), projectContext: () => undefined, memberIds: () => [], audienceStillValid: () => true, ownerOrigin: () => true,
    startOwnerSend: (request) => { started.push(`send:${request.id}`); busy.add(request.targetThreadId!); },
    startMemberTurn: (request, claim) => { started.push(`${request.verb}:${request.toBotId}`); busy.add(request.targetThreadId!); claim.release(); },
    onClosed: (request, line) => { closed.push(`${request.id}:${line}`); },
    onStillWaiting: (request) => { waiting.push(request.id); },
    changed: () => {},
    ...over,
  };
  return { dispatcher: createRoomDispatcher(deps), started, closed, waiting, busy };
}

beforeEach(() => { db = new DatabaseSync(":memory:"); initializeProjectTables(db); now = 1_000; });

describe("room dispatcher", () => {
  it("runs one thing per room at a time, owner sends first, and waits while the room works", () => {
    const send = insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: "owner_send:g:1", lineage, targetThreadId: "t", priority: "owner", payloadText: "hi", now: 5 }).request;
    insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", toBotId: "lead", targetThreadId: "t", parentId: send.id, admissionKey: "wake:x", priority: "coordinator", now: 1 });
    const h = harness();
    h.busy.add("t");
    h.dispatcher.pump();
    expect(h.started).toEqual([]);
    h.busy.clear();
    h.dispatcher.pump();
    expect(h.started).toEqual([`send:${send.id}`]);
    h.busy.clear();
    h.dispatcher.pump();
    expect(h.started).toEqual([`send:${send.id}`, "wake:lead"]);
  });

  it("records a refusal once and cancels one that never clears, with its line", () => {
    const root = insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: "r", lineage, now: 1 }).request;
    db.prepare("UPDATE room_requests SET state='done' WHERE id=?").run(root.id);
    const wake = insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", toBotId: "lead", targetThreadId: "t", parentId: root.id, admissionKey: "wake:r", now: 2 }).request;
    const turn = insertRoomRequest(db, { groupId: "g", verb: "room_turn", fromKind: "owner", toBotId: "dax", targetThreadId: "t2", parentId: root.id, admissionKey: "rt", now: 3 }).request;
    const admission = createWorkAdmission(admissionDeps({ speakingInRoom: (bot) => bot === "lead", reachable: (input) => input.botId !== "dax" }));
    const h = harness({}, admission);
    h.dispatcher.pump();
    expect(roomRequest(db, wake.id)!.refusal).toBe("speaking_in_room");
    expect(roomRequest(db, wake.id)!.state).toBe("queued");
    expect(roomRequest(db, turn.id)!.state).toBe("cancelled");
    expect(h.closed).toEqual([`${turn.id}:dax cannot be reached from here`]);
  });

  it("cancels a request whose audience changed", () => {
    const send = insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: "a", lineage, targetThreadId: "t", now: 1 }).request;
    const h = harness({ audienceStillValid: () => false });
    h.dispatcher.pump();
    expect(roomRequest(db, send.id)!.state).toBe("cancelled");
    expect(h.closed[0]).toContain("audience changed");
  });

  it("runs a project routine lane R queued, as autonomous work the autonomy switch holds", () => {
    db.prepare("INSERT INTO project_settings (group_id, lead_bot_id, updated_at) VALUES ('g','lead',1)").run();
    const { requestId } = recordProjectRoutine(db, { groupId: "g", threadId: "t", memberIds: ["lead", "dax"], runId: "run-1", botId: "dax", name: "Daily notes", prompt: "Write the notes", now: 2 });
    let autonomy = false;
    const h = harness({}, createWorkAdmission(admissionDeps({ flags: () => ({ autonomy, budgets: true }) })));
    h.dispatcher.pump();
    expect(roomRequest(db, requestId)).toMatchObject({ state: "queued", refusal: "autonomy_off" });
    autonomy = true;
    h.dispatcher.pump();
    expect(h.started).toEqual(["routine:dax"]);
    expect(roomRequest(db, requestId)!.state).toBe("running");
  });

  it("does nothing while dispatch is closed", () => {
    insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: "a", lineage, targetThreadId: "t", now: 1 });
    const h = harness({ open: () => false });
    h.dispatcher.pump();
    expect(h.started).toEqual([]);
  });

  it("says once that a queued member turn is still waiting, and expires it at its deadline", () => {
    const root = insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: "r", lineage, now: 0 }).request;
    db.prepare("UPDATE room_requests SET state='done' WHERE id=?").run(root.id);
    const turn = insertRoomRequest(db, { groupId: "g", verb: "room_turn", fromKind: "owner", toBotId: "dax", targetThreadId: "t", parentId: root.id, admissionKey: "rt", now: 0, deadlineAt: 2 * ROOM_TURN_STATUS_AFTER_MS }).request;
    const h = harness({}, createWorkAdmission(admissionDeps({ directThreads: () => 3 })));
    now = ROOM_TURN_STATUS_AFTER_MS + 1;
    h.dispatcher.tick();
    h.dispatcher.tick();
    expect(h.waiting).toEqual([turn.id]);
    now = 2 * ROOM_TURN_STATUS_AFTER_MS + 1;
    h.dispatcher.tick();
    expect(roomRequest(db, turn.id)!.state).toBe("expired");
    expect(h.closed).toEqual([`${turn.id}:Not answered in time. Ask again.`]);
  });

  it("leaves asks, messages, card runs and reviews to their own executors", () => {
    const root = insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: "r", lineage, now: 0 }).request;
    db.prepare("UPDATE room_requests SET state='done' WHERE id=?").run(root.id);
    for (const verb of ["ask", "assign", "review", "message"] as const) {
      insertRoomRequest(db, { groupId: "g", verb, fromKind: "bot", toBotId: "x", targetThreadId: "t", parentId: root.id, admissionKey: verb, now: 1 });
    }
    const h = harness();
    h.dispatcher.pump();
    expect(h.started).toEqual([]);
    const all = db.prepare("SELECT state FROM room_requests WHERE verb<>'owner_send'").all() as Array<Pick<RoomRequest, "state">>;
    expect(all.every((row) => row.state === "queued")).toBe(true);
  });
});

it("admits only recorded Close work through a paused project, including lessons after closure", () => {
  channelToProjectRows(db,{groupId:"g",bulletin:"",leadBotId:"lead",now:1});
  const deps={groupId:"g",threadId:"t",memberIds:["lead"],now:10,lineage,deliverables:()=>[],routineNames:()=>[],pauseRoutines:()=>{},post:()=>{},summary:()=>"Done",sync:()=>{}};
  const closing=startProjectClose(db,deps);
  const forged=insertRoomRequest(db,{groupId:"g",verb:"wake",fromKind:"murage",toBotId:"worker",targetThreadId:"other",lineage,admissionKey:"close:g:forged",now:11}).request;
  const h=harness({projectContext:()=>({groupId:"g",isProject:true,closed:false,runState:"paused",mode:"conversation",boardOn:true,parallelCards:3,leadBotId:"lead"})});
  h.dispatcher.pump();expect(h.started).toEqual(["wake:lead"]);expect(roomRequest(db,forged.id)?.refusal).toBe("project_paused");
  completeRequest(db,closing.summaryRequestId!,{state:"done",now:12});resumeProjectCloses(db,deps);h.busy.clear();h.dispatcher.pump();
  expect(h.started).toEqual(["wake:lead","wake:lead"]);
});

it('C6 dispatcher-bound close summary and lesson requests cannot produce other work', async () => {
  const close=await import('./project-close.ts');
  channelToProjectRows(db,{groupId:'g',bulletin:'',leadBotId:'lead',now:1});
  const deps={groupId:'g',threadId:'t',memberIds:['lead'],now:10,lineage,deliverables:()=>[],routineNames:()=>[],pauseRoutines:()=>{},post:()=>{},summary:()=>"Done",sync:()=>{}};
  const closing=startProjectClose(db,deps);const visited:string[]=[];
  const h=harness({projectContext:()=>({groupId:'g',isProject:true,closed:false,runState:'paused',mode:'conversation',boardOn:true,parallelCards:3,leadBotId:'lead'}),startMemberTurn:(request,claim)=>{
    visited.push(request.id);claim.release();
    for(const path of ['ask-bot','delegate-bot','message-bot','create-bot','project/assign','project/card-create','routine-requests','connectors/mcp'])expect(close.projectCloseToolRefusal(db,request.id,'POST',`/api/internal/${path}`)).toEqual({error:'not_allowed',reason:'This turn can only summarise the project or save its lesson.'});
    expect(close.projectCloseToolRefusal(db,request.id,'POST','/api/internal/memory/search')).toBeNull();
    expect(close.projectCloseToolRefusal(db,request.id,'POST','/api/internal/memory/save')).toEqual(request.id===closing.summaryRequestId?{error:'not_allowed',reason:'This turn can only summarise the project or save its lesson.'}:null);
  }});
  h.dispatcher.pump();completeRequest(db,closing.summaryRequestId!,{state:'done',now:12});resumeProjectCloses(db,deps);h.dispatcher.pump();
  expect(visited).toHaveLength(2);
});

it('C6 close-only authority remains bound through completion and Reopen', async () => {
  const close=await import('./project-close.ts');
  channelToProjectRows(db,{groupId:'g',bulletin:'',leadBotId:'lead',now:1});
  const deps={groupId:'g',threadId:'t',memberIds:['lead'],now:10,lineage,deliverables:()=>[],routineNames:()=>[],pauseRoutines:()=>{},post:()=>{},summary:()=>"Done",sync:()=>{}};
  const {summaryRequestId}=startProjectClose(db,deps);completeRequest(db,summaryRequestId!,{state:'done',now:11});resumeProjectCloses(db,deps);
  const refusal={error:'not_allowed',reason:'This turn can only summarise the project or save its lesson.'};
  expect(close.projectCloseToolRefusal(db,summaryRequestId!,'POST','/api/internal/ask-bot')).toEqual(refusal);
  close.reopenProject(db,deps);
  expect(close.projectCloseToolRefusal(db,summaryRequestId!,'POST','/api/internal/ask-bot')).toEqual(refusal);
});

it("N6 held room work waits for retry readiness and revalidates its original audience", () => {
  const root = insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: "root", lineage, now: 1, state: "running" }).request;
  completeRequest(db, root.id, { state: "done", now: 2 });
  const request = insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", toBotId: "bot", targetThreadId: "t", parentId: root.id, admissionKey: "held-wake", now: 3 }).request;
  let ready = false, valid = true;
  const h = harness({ ready: () => ready, audienceStillValid: () => valid });
  h.dispatcher.pump(); expect(h.started).toEqual([]); expect(roomRequest(db, request.id)?.state).toBe("queued");
  valid = false; ready = true;
  h.dispatcher.pump(); expect(h.started).toEqual([]); expect(roomRequest(db, request.id)?.state).toBe("cancelled");
});

describe("a pinned owner send whose member has left", () => {
  const pinned = () => insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", toBotId: "gone", admissionKey: "owner_send:g:pin", lineage, targetThreadId: "t", priority: "owner", payloadText: "hi", now: 5 }).request;
  it("is closed with a member-specific note and a line, not 'the room is gone'", () => {
    const request = pinned();
    const h = harness({ roomUsable: () => false, memberIds: () => ["lead"] });
    h.dispatcher.pump();
    expect(h.started).toEqual([]);
    expect(roomRequest(db, request.id)?.outcomeNote).toMatch(/no longer in this room/);
    expect(h.closed).toHaveLength(1);
    expect(h.closed[0]).toMatch(/no longer in this room/);
  });
  it("a room that is really gone keeps its own note", () => {
    const request = pinned();
    const h = harness({ roomUsable: () => false, memberIds: () => [] });
    h.dispatcher.pump();
    expect(roomRequest(db, request.id)?.outcomeNote).toBe("the room is gone");
  });
});
