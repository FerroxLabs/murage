// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { beforeEach, describe, expect, it } from "vitest";
import { createRoomDispatcher, ROOM_TURN_STATUS_AFTER_MS, type RoomDispatcherDeps } from "./room-dispatcher.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { startProjectClose, resumeProjectCloses } from "./project-close.ts";
import { channelToProjectRows } from "./project-settings.ts";
import { completeRequest, deferRetainedRoomRequest, dueRetainedRoomRequests, runnableRoomRequestIds } from "./room-requests.ts";
import { recordProjectRoutine } from "./project-routines.ts";
import { insertRoomRequest, roomRequest, type RoomRequest } from "./room-requests.ts";
import * as roomRequests from './room-requests.ts';
import { createSpendGate, credIdOf, describeHolds } from './spend-gate.ts';
import { fixtureFunctionSource } from './testing/runtime-source-fixture.ts';
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

it('the actual queue formatter shows a spend refusal even when the admission view cannot describe it', () => {
  const source = fixtureFunctionSource(readFileSync(new URL('./index.ts', import.meta.url), 'utf8'), 'roomRequestRefusalLine');
  const js = ts.transpile(source, {target:ts.ScriptTarget.ES2023});
  const format = new Function('store','projectCardRefusalLine','database','roomSpendHoldLine','describeHolds',js+';return roomRequestRefusalLine;')(
    {bot:() => null}, () => undefined, () => db, () => null, describeHolds);
  expect(format({refusal:'spend_limit',toBotId:'worker'})).toBe(describeHolds([{kind:'unknown'}]).lines.join(' '));
});

it('real admission and spend gate disagreement preserves the spend reason and backs off across dispatcher retries', async () => {
  const key = 'fixture-spend-credential';
  const gate = createSpendGate({ enabled:true, credentials:() => [{id:'account',kind:'account',key:() => key}], limitUsd:() => 10,
    loadAccount:() => ({accountId:'fixture-account',accountAsOf:null,capability:'on',capAsOf:null,capCredId:credIdOf(key)}),
    read:async () => ({kind:'failed'}), now:() => now, setTimer:() => 0 });
  const request = insertRoomRequest(db, {groupId:'g',verb:'room_turn',fromKind:'owner',toBotId:'worker',targetThreadId:'t',lineage,admissionKey:'spend-retry',now}).request;
  // The cloud-home admission view bypasses the local hold; the send gate still refuses its failed account read.
  const admissionSpendHold = () => null;
  const admission = createWorkAdmission(admissionDeps({spendHold:admissionSpendHold}));
  const turns = new Map(), claims = new Map();
  const dependencies = { replySpeakerTurns:{ended:() => {}}, roomTurnRequestKey:(thread:string,bot:string) => `${thread}:${bot}`,
    pendingRoomTurnRequests:new Map(), roomTurnRequests:turns, roomTurnClaims:claims, deferredRoomClaims:new Map(),
    database:() => db, roomRequest, requeueRoomRequest:roomRequests.requeueRoomRequest,
    requeueSpendHeldRoomRequest:roomRequests.requeueSpendHeldRoomRequest, roomSpendHoldLine:admissionSpendHold,
    roomRequestsChanged:() => {}, Date:{now:() => now} };
  const source = fixtureFunctionSource(readFileSync(new URL('./index.ts', import.meta.url), 'utf8'), 'settleRoomTurnRequest');
  const settle = new Function(...Object.keys(dependencies),ts.transpile(source,{target:ts.ScriptTarget.ES2023})+';return settleRoomTurnRequest;')(...Object.values(dependencies));
  let starts = 0, pending = Promise.resolve();
  const h = harness({startMemberTurn:(request,claim) => {
    starts++;
    pending = (async () => {
      const verdict = await gate.admitStart(key);
      expect(verdict.ok).toBe(false);
      turns.set('t:worker', request.id); claims.set('t:worker', claim);
      settle('t','worker',{ok:false,spendHold:true});
    })();
  }},admission);
  for (const [at, count] of [[1000,1],[30999,1],[31000,2],[61000,2],[91000,3],[150999,3],[211000,4]]) {
    now = at;
    for (let pump=0;pump<20;pump++) {h.dispatcher.pump();await pending;}
    expect(starts).toBe(count);
    expect(roomRequest(db,request.id)).toMatchObject({state:'queued',refusal:'spend_limit'});
  }
  const retry = db.prepare('SELECT attempts,retry_at FROM room_request_retry WHERE request_id=?').get(request.id);
  expect(retry).toEqual({attempts:4,retry_at:451000});
  completeRequest(db, request.id, {state:'cancelled',now});
  expect(db.prepare('SELECT request_id FROM room_request_retry WHERE request_id=?').get(request.id)).toBeUndefined();
});

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

  it("keeps the words of an owner send the room closes (audience changed, member left, expired), never only a line without them", () => {
    const kept: string[] = [];
    const keepOwnerWords = (request: RoomRequest) => { kept.push(`${request.id}:${request.payloadText}`); };
    const audience = insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: "ka", lineage, targetThreadId: "t", payloadText: "words a", now: 1 }).request;
    harness({ audienceStillValid: () => false, keepOwnerWords }).dispatcher.pump();
    const left = insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", toBotId: "gone", admissionKey: "kb", lineage, targetThreadId: "t2", payloadText: "words b", now: 2 }).request;
    harness({ roomUsable: (request) => request.id !== left.id, memberIds: () => ["other"], keepOwnerWords }).dispatcher.pump();
    const late = insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: "kc", lineage, targetThreadId: "t3", payloadText: "words c", deadlineAt: 50, now: 3 }).request;
    now = 10_000;
    const h = harness({ roomBusy: () => true, keepOwnerWords });
    h.dispatcher.tick();
    expect(kept).toEqual([`${audience.id}:words a`, `${left.id}:words b`, `${late.id}:words c`]);
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

// fprod4 C (r3 section 9 + M3): a spend park costs the dispatcher nothing until it is due, and a due one is re-parked or released.
describe("spend parks in the dispatcher", () => {
  let hold = true, speaking = false;
  const setup = () => {
    const root = insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: "r", lineage, now: 1 }).request;
    db.prepare("UPDATE room_requests SET state='done' WHERE id=?").run(root.id);
    const wake = (bot: string, n: number) => insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", toBotId: bot, targetThreadId: `t${n}`, parentId: root.id, admissionKey: `wake:${bot}:${n}`, now: 2 + n }).request;
    const admission = createWorkAdmission(admissionDeps({ spendHold: () => (hold ? { line: "held" } : null), speakingInRoom: () => speaking }));
    let admits = 0;
    const admit = admission.admit.bind(admission);
    admission.admit = (input) => { admits++; return admit(input); };
    const h = harness({}, admission);
    return { wake, h, admits: () => admits, reset: () => { admits = 0; } };
  };
  const parkRow = (id: string) => db.prepare("SELECT refusal, parked_refusal FROM room_requests WHERE id=?").get(id);
  const retryOf = (id: string) => db.prepare("SELECT retry_at, attempts FROM room_request_retry WHERE request_id=?").get(id);
  beforeEach(() => { hold = true; speaking = false; });
  // Row fetches by id (requestsByIds and every other single-row read of room_requests), counted on this connection only.
  const countRowFetches = () => {
    const fetched: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (!/^SELECT \* FROM room_requests WHERE id=\?$/.test(sql.trim())) return statement;
      const get = statement.get.bind(statement);
      statement.get = ((...args: Parameters<typeof get>) => { fetched.push(String(args[0])); return get(...args); }) as typeof statement.get;
      return statement;
    }) as typeof db.prepare;
    return fetched;
  };
  for (const parked of [0, 1000, 10_000]) {
    it(`C-W1 the dispatcher admits only the runnable rows each pump with ${parked} spend parks (not due)`, () => {
      const { wake, h, admits, reset } = setup();
      for (let i = 0; i < 3; i++) wake("lead", i);
      const fetched = countRowFetches();
      now = 5_000;
      h.dispatcher.pump();
      fetched.length = 0; reset();
      h.dispatcher.pump();
      const baseline = fetched.length;
      expect(admits()).toBe(3);
      expect(baseline).toBeGreaterThan(0);
      const parkedIds = new Set<string>();
      db.exec("BEGIN");
      for (let i = 0; i < parked; i++) { const id = wake("other", 100 + i).id; deferRetainedRoomRequest(db, id, now, "spend_limit"); parkedIds.add(id); }
      db.exec("COMMIT");
      for (let pump = 0; pump < 3; pump++) {
        reset(); fetched.length = 0;
        h.dispatcher.pump();
        expect(admits()).toBe(3);
        expect(fetched.length).toBe(baseline);
        expect(fetched.filter((id) => parkedIds.has(id))).toEqual([]);
      }
      expect(runnableRoomRequestIds(db)).toHaveLength(3);
    });
  }
  it("C-W3 a due spend park that is still held goes back to its wait: once, then not again before the next time", () => {
    const { wake, h, admits, reset } = setup();
    const id = wake("lead", 1).id;
    now = 1_000;
    deferRetainedRoomRequest(db, id, now, "spend_limit");
    expect(retryOf(id)).toEqual({ retry_at: 31_000, attempts: 1 });
    now = 31_000;
    for (let pump = 0; pump < 10; pump++) h.dispatcher.pump();
    expect(retryOf(id)).toEqual({ retry_at: 91_000, attempts: 2 });
    expect(dueRetainedRoomRequests(db, 90_999)).toEqual([]);
    expect(dueRetainedRoomRequests(db, 91_000).map((r) => r.id)).toEqual([id]);
    expect(roomRequest(db, id)).toMatchObject({ state: "queued", refusal: "spend_limit" });
    now = 50_000; reset();
    h.dispatcher.pump();
    expect(admits()).toBe(0);
  });
  it("C-W6 a due spend park refused for another reason is an ordinary queued row again, and the next pump starts it", () => {
    const { wake, h } = setup();
    const id = wake("lead", 1).id;
    deferRetainedRoomRequest(db, id, 1_000, "spend_limit");
    hold = false; speaking = true; now = 31_000;
    h.dispatcher.pump();
    expect(parkRow(id)).toEqual({ refusal: "speaking_in_room", parked_refusal: null });
    expect(retryOf(id)).toBeUndefined();
    expect(runnableRoomRequestIds(db)).toContain(id);
    expect(dueRetainedRoomRequests(db, 10 ** 9)).toEqual([]);
    expect(roomRequest(db, id)!.refusal).toBe("speaking_in_room");
    speaking = false;
    h.dispatcher.pump();
    expect(h.started).toEqual(["wake:lead"]);
  });
  it("C-W6 same for an authorize refusal that queues", () => {
    const root = insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: "r2", lineage, now: 1 }).request;
    db.prepare("UPDATE room_requests SET state='done' WHERE id=?").run(root.id);
    const id = insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", toBotId: "lead", targetThreadId: "t", parentId: root.id, admissionKey: "w", now: 2 }).request.id;
    deferRetainedRoomRequest(db, id, 1_000, "spend_limit");
    const h = harness({ authorize: () => ({ ok: false, retry: "queue", code: "not_authorized", line: "no" }) as never });
    now = 31_000;
    h.dispatcher.pump();
    expect(parkRow(id)).toEqual({ refusal: "not_authorized", parked_refusal: null });
    expect(retryOf(id)).toBeUndefined();
    expect(runnableRoomRequestIds(db)).toContain(id);
  });
  it("C-W6b a refusal recorded on an unresolved park leaves its marker (a due one is released by the dispatcher, never by the refusal)", () => {
    const { wake } = setup();
    const id = wake("lead", 1).id;
    deferRetainedRoomRequest(db, id, 1_000);
    roomRequests.recordRoomRequestRefusal(db, id, "speaking_in_room");
    expect(parkRow(id)).toEqual({ refusal: "retained_unresolved", parked_refusal: null });
    expect(retryOf(id)).toBeDefined();
  });
  it("C-W6c busy, then the spend hold again through a start the gate refused: parked again from attempt 1", () => {
    const { wake, h } = setup();
    const id = wake("lead", 1).id;
    deferRetainedRoomRequest(db, id, 1_000, "spend_limit");
    hold = false; speaking = true; now = 31_000;
    h.dispatcher.pump();
    speaking = false; now = 32_000;
    expect(roomRequests.markRequestDispatched(db, id, { now, targetThreadId: "t1" })).toBe(true);
    expect(roomRequests.requeueSpendHeldRoomRequest(db, id, now, false)).toBe(true);
    expect(retryOf(id)).toEqual({ retry_at: 62_000, attempts: 1 });
    expect(parkRow(id)).toEqual({ refusal: "retained_unresolved", parked_refusal: "spend_limit" });
    void h;
  });
});
