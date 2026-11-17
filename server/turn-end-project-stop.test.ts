import { createTurnCardGate } from "./turn-card-gate.ts";
// Project interruption (interruptProjectTarget, extracted from index.ts) over the real createLedgerLease, reached through the real
// project routes on a real project database: an owner Stop or card action shows the card's own state and no refusal sentence;
// a bot's project tool, which shares the callback, keeps the ledger sentence.
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import ts from "typescript";
import vm from "node:vm";
import { DATA_DIR } from "./config.ts";
import { source } from "./decision-wiring/fixture.ts";
import { createLedgerLease } from "./ledger-refusal.ts";
import { LEDGER_REFUSAL_LINE, MCP_CLOUD_UNAVAILABLE_TEXT } from "./turn-end.ts";
import { sendNoticeLine } from "./send-store.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { channelToProjectRows } from "./project-settings.ts";
import { createProjectGoal, startProjectGoal } from "./project-goals.ts";
import { applyCardRunDispatched, createProjectCard, enqueueCardRun } from "./project-cards.ts";
import { insertRoomRequest, projectCardById, projectGoalById } from "./project-records.ts";
import { handleProjectRouteWithInterrupt, type ProjectInterrupt, type ProjectRouteInput } from "./project-routes.ts";
import { handleProjectToolWithInterrupt } from "./project-tool-routing.ts";
import { roomRequest } from "./room-requests.ts";

mkdirSync(DATA_DIR, { recursive: true });
const verdict = { state: "checking", reason: "not-built" } as const;
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const owner = { kind: "owner" as const, lineage: { origin: "desktop" as const, rootThreadId: "room", audienceFingerprint: "owner" } };

function fixture() {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  initializeProjectTables(db);
  channelToProjectRows(db, { groupId: "g", bulletin: "Rules", leadBotId: "lead", now: 1 });
  const group = { id: "g", memberIds: ["lead", "worker", "other"], threadId: "room" };
  const made = createProjectGoal(db, { groupId: "g", title: "Goal", now: 1 });
  if (!made.ok) throw new Error("goal setup");
  const goalId = made.goal.id;
  expect(startProjectGoal(db, { goalId, now: 2, tz: "UTC" }).ok).toBe(true);
  insertRoomRequest(db, { id: "lead-request", groupId: "g", verb: "wake", fromKind: "murage", toBotId: "lead", state: "running", admissionKey: "wake:fixture", now: 2 });
  const created = createProjectCard(db, { groupId: "g", goalId, title: "Card", assigneeBotId: "worker", actor: owner, memberIds: group.memberIds, now: 3 });
  if (!created.ok) throw new Error("card setup");
  const queued = enqueueCardRun(db, { cardId: created.card.id, actor: owner, now: 4 });
  if (!queued.ok) throw new Error("queue setup");
  expect(applyCardRunDispatched(db, { cardId: created.card.id, requestId: queued.requestId, deskThreadId: "desk", now: 5 }).ok).toBe(true);
  db.prepare("UPDATE room_requests SET target_thread_id='desk' WHERE id=?").run(queued.requestId);
  const route = (path: string, body: unknown): ProjectRouteInput => ({ origin: "desktop", method: "PATCH", path, body, group, query: new URLSearchParams(), now: 8 });

  // The worker's live turn on the card's desk thread: a real admitted lease, and the shipped interruptProjectTarget in front of it.
  const captured: string[] = [], appended: unknown[] = [], calls: string[] = [], interrupted: string[] = [];
  const leases = new Map<string, unknown>();
  const globals: Record<string, any> = {
    console, Date, Map, Set, Object, JSON, Promise, URL,
    bus: { admitNewTurn: () => ({}), refuseTurn: () => { calls.push("bus.refuseTurn"); return []; } },
    database: () => db, createLedgerLease, roomRequest,
    persistLedgerRefusal: (_db: unknown, work: () => void) => { work(); return Promise.resolve(); },
    transaction: (work: (db: unknown) => void) => work({}),
    captureSource: (_db: unknown, row: { text: string }) => { captured.push(row.text); },
    store: { appendMessage: (_thread: string, message: unknown) => { appended.push(message); }, markTurnToolsUnrecorded() {}, setTaskActivity() {} },
    murageLine: (line: unknown) => line, sendNoticeLine, randomUUID: () => "id",
    turnCardGate: createTurnCardGate(), admittedLedgerLeases: leases, ledgerCompletionSources: new Map(), ledgerLeasesByAdmission: new Map(), ledgerProviderInstances: new WeakMap(),
    refusedLeases: new Map(), internalTurnOwners: new Map(), memoryDispatches: new Map(), projectTurnLeases: { abandon() {} },
    watchdog: { settle: () => { calls.push("watchdog.settle"); } },
    revokeInternalGeneration() {}, retireProviderTurn() {}, closeTurnLineage() {}, retryDelegationsWaitingOn() {}, drainQueuedSends() {},
    replySpeakerTurns: { ended() {} }, stopCloseConfirmed: () => true, broadcast: () => {}, windowRuntimeEvent: (e: unknown) => e,
    directRuns: { get: (threadId: string) => (threadId === "desk" ? { generation: "G", botId: "worker", threadId: "desk" } : undefined), release() {} },
    turnRequestByGeneration: new Map([["G", queued.requestId]]),
    projectCardExecutor: { prepareBackoffCancellation: () => undefined },
    // the shared interrupt ends by revoking: the ledger seals the turn
    interruptDirectThread: async (_botId: string, threadId: string) => { interrupted.push(threadId); lease.onLedgerRefused(verdict); },
  };
  const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const text = ["admitLedgerLease", "noteOwnerStop", "interruptProjectTarget"].map(name => {
    const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!node) throw new Error(`Missing production wiring: ${name}`);
    return node.getText(ast);
  }).join("\n") + "\n;globalThis.result = { admitLedgerLease, interruptProjectTarget };";
  const context = vm.createContext(globals);
  vm.runInContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } }).outputText, context);
  const built = context.result as { admitLedgerLease: (...args: unknown[]) => ReturnType<typeof createLedgerLease>; interruptProjectTarget: ProjectInterrupt };
  const instance = { instanceId: "I", adapter: { interruptTurn: async () => ({}), awaitTurnTeardown: async () => ({ closeConfirmed: true }) } };
  const lease = built.admitLedgerLease("worker", "desk", "G", { turnId: "L" }, instance, { seal() {} });
  lease.attach("P");
  return { db, group, goalId, cardId: created.card.id, requestId: queued.requestId, route, lease, globals,
    interrupt: built.interruptProjectTarget, captured, appended, calls, interrupted };
}
type Rig = ReturnType<typeof fixture>;
const cardPath = (f: Rig) => `/api/groups/g/board/cards/${f.cardId}`;
const quiet = (f: Rig) => {
  expect(f.interrupted).toEqual(["desk"]);
  expect(f.captured).toEqual([]); expect(f.appended).toEqual([]); // no refusal sentence stored or shown
  expect(f.calls).toEqual(["watchdog.settle", "bus.refuseTurn"]); // the turn still settled once
};

describe("project interruption: an owner's Stop shows the stopped card and no refusal sentence", () => {
  it("owner cancels the live card: the card reads cancelled, the worker's turn ends with no refusal sentence", async () => {
    const f = fixture();
    const result = await handleProjectRouteWithInterrupt(f.db, f.route(cardPath(f), { action: "cancel", expectedRevision: projectCardById(f.db, f.cardId)!.revision, confirm: true }), f.interrupt);
    expect(result?.status).toBe(200); expect(projectCardById(f.db, f.cardId)!.state).toBe("cancelled"); quiet(f);
  });
  it("owner stops the goal: the goal reads stopped, no refusal sentence", async () => {
    const f = fixture();
    const result = await handleProjectRouteWithInterrupt(f.db, f.route(`/api/groups/g/project/goals/${f.goalId}`, { action: "stop", expectedRevision: projectGoalById(f.db, f.goalId)!.revision }), f.interrupt);
    expect(result?.status).toBe(200); expect(projectGoalById(f.db, f.goalId)!.state).toBe("stopped"); quiet(f);
  });
  it("owner ends the project: no refusal sentence", async () => {
    const f = fixture();
    const result = await handleProjectRouteWithInterrupt(f.db, f.route("/api/groups/g", { channelProject: null }), f.interrupt);
    expect(result?.status).toBe(200); quiet(f);
  });
  it("a sentence that was already recorded keeps its place: MCP first, then the owner cancels the card", async () => {
    const f = fixture();
    f.lease.noteCause("mcp-cloud-unavailable");
    const result = await handleProjectRouteWithInterrupt(f.db, f.route(cardPath(f), { action: "cancel", expectedRevision: projectCardById(f.db, f.cardId)!.revision, confirm: true }), f.interrupt);
    expect(result?.status).toBe(200);
    expect(f.captured).toEqual([MCP_CLOUD_UNAVAILABLE_TEXT]);
  });
  it("the lead bot's project tool cancels the card through the same callback: that is not the owner's Stop, the ledger sentence stays", async () => {
    const f = fixture();
    f.db.exec("UPDATE project_settings SET mode='ongoing'; UPDATE project_work_items SET created_by='lead'"); // the lead's own card
    const result = await handleProjectToolWithInterrupt("card-manage", { db: f.db, groupId: "g", botId: "lead", role: "lead", request: roomRequest(f.db, "lead-request")!,
      memberIds: f.group.memberIds, ownerAudience: true, now: 100 }, { cardId: f.cardId, action: "cancel" }, f.interrupt);
    expect(result.body).toMatchObject({ ok: true }); expect(result.status).toBe(200); expect(projectCardById(f.db, f.cardId)!.state).toBe("cancelled");
    expect(f.interrupted).toEqual(["desk"]);
    expect(f.captured).toEqual([LEDGER_REFUSAL_LINE]);
  });
  it("a turn that no longer runs this card's request is neither interrupted nor noted", async () => {
    const f = fixture();
    f.globals.turnRequestByGeneration.set("G", "another-request");
    const result = await handleProjectRouteWithInterrupt(f.db, f.route(cardPath(f), { action: "cancel", expectedRevision: projectCardById(f.db, f.cardId)!.revision, confirm: true }), f.interrupt);
    expect(result?.status).toBe(200); expect(f.interrupted).toEqual([]);
    f.lease.onLedgerRefused(verdict); expect(f.captured).toEqual([LEDGER_REFUSAL_LINE]);
  });
});
