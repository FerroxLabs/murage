import { afterEach, expect, it, vi } from "vitest";
import ts from "typescript";
import vm from "node:vm";
import { source, wiring } from "./decision-wiring/fixture.ts";
import { isOwnerOrigin } from "./store.ts";
import { PendingTurnKeys } from "./fold-steps.ts";
import { RoomPendingStop } from "./room-turn-timeout.ts";
import { stopCloseConfirmed, type ProviderInstance } from "./contracts.ts";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDirs } from "./config.ts";
import { ClaudeDriver } from "./drivers/claude.ts";
import { resetClaudeVersionGate } from "./drivers/claude-guards.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { fixtureBotFolder } from "./testing/bot-folder-fixture.ts";
import { recordEvents } from "./testing/events.ts";
import { heldProbeLauncher } from "./testing/held-probe-cli.ts";
import { admittedFixtureInstance } from "./testing/mcp-admission-fixture.ts";
import { useOutsideStoreFixture } from "./testing/outside-store-fixture.ts";
import { TurnSubmissionBoundary } from "./turn-dispatch-guard.ts";

// Execute the dispatch site's declarations, so bypassing a shared helper at
// either consumer is observable without starting the process-wide server.
function roomWiring(names: string[], globals: Record<string, unknown>) {
  const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  const dispatch = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "runGroupMemberTurnDispatch")!;
  const declarations = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && names.includes(declaration.name.text)) declarations.set(declaration.name.text, node.getText(ast));
    }
    ts.forEachChild(node, visit);
  };
  visit(dispatch);
  const body = names.map(name => {
    if (!declarations.has(name)) throw new Error(`Missing room dispatch declaration: ${name}`);
    return declarations.get(name);
  }).join("\n");
  const context = vm.createContext({ Map, Promise, ...globals });
  vm.runInContext(ts.transpileModule(`${body}\nglobalThis.result={${names.join(",")}};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None },
  }).outputText, context);
  return context.result as Record<string, any>;
}

it.each([
  ["owner readmission", "desktop", "desktop", true, { k: "owner-typed" }],
  ["unproven request after a new owner line", "unproven", "desktop", true, { k: "other-human" }],
  ["unproven source after a new owner line", "desktop", "unproven", true, { k: "other-human" }],
  ["shared audience", "desktop", "desktop", false, { k: "other-human" }],
] as const)("room request provenance: %s", (_name, origin, sourceOrigin, audience, expected) => {
  const request = { verb: "room_turn", fromKind: "owner", origin };
  const continuation = vi.fn(() => ({ k: "other-human" }));
  const result = roomWiring(["roomInitiator"], {
    ...wiring(["decisionInitiator", "decisionRoomRequestInitiator"], { isOwnerOrigin }),
    isOwnerOrigin, latestRoomUserMessage: () => ({ origin: "desktop" }),
    decisionContinuationInitiator: continuation, decisionRoomRequest: request,
    roomLineageSource: { origin: sourceOrigin }, roomOwnerAudience: audience,
    continuationPrompt: undefined, continuationKind: "card", continuationCardId: undefined,
    memoryRedispatch: 0, hop: 0, threadId: "room", bot: { id: "member" }, internalGeneration: "generation", roomRoutineRun: undefined,
  });
  expect(result.roomInitiator).toEqual(expected);
  expect(continuation).not.toHaveBeenCalled();
});

function stopFixture(observe = vi.fn(async (_thread: string, _turn: string) => ({ closeConfirmed: false })),
  adapter: { interruptTurn: ReturnType<typeof vi.fn<(thread: string, turn: string) => Promise<unknown>>>; awaitTurnTeardown: typeof observe } = { interruptTurn: vi.fn(async (_thread: string, _turn: string) => ({ closeConfirmed: false })), awaitTurnTeardown: observe },
  providerTurnId = "original-child") {
  const complete = vi.fn(), patchGroup = vi.fn(), speaker = {};
  const pendingRoomStops = new Map();
  const ledger = wiring(["admitLedgerLease"], {
    bus: { admitNewTurn: () => ({}) }, database: () => ({}),
    createLedgerLease: (_identity: unknown, deps: unknown) => deps,
    admittedLedgerLeases: new Map(), ledgerCompletionSources: new WeakMap(), confirmedStopGenerations: new PendingTurnKeys(),
    retireProviderTurn: vi.fn(), stopCloseConfirmed, ledgerProviderInstances: new WeakMap(),
  }).admitLedgerLease;
  const room = roomWiring([
    "roomProviderStops", "interruptRoomTurn", "roomProviderCloses", "observeRoomTurn", "ledgerLease", "pendingStop", "beginRoomStop", "stopRoomTurn",
  ], {
    instance: { adapter }, threadId: "room", providerTurnId, bot: { id: "member" }, group: { id: "group" },
    internalGeneration: "generation", roomTurnLineage: {}, submissionBoundary: {}, admitLedgerLease: ledger,
    RoomPendingStop, roomSpeaker: speaker, pendingRoomStops, roomStopRequests: new Map(), cancelRoomTurn: undefined, roomStopClosed: false, groupSpeakers: new Map([["room", speaker]]),
    store: { group: () => ({ busyBotId: "member" }), patchGroup, bot: () => ({ busy: false }) },
    projectTurnLeases: { complete, confirmClosed: vi.fn(), markStopRequested: vi.fn() }, releaseDeferredRoomClaim: vi.fn(),
    drainQueuedSends: vi.fn(), drainConnectorResumes: vi.fn(), drainSecretResumes: vi.fn(), drainTeamIncidents: vi.fn(),
    browserSetup: undefined, browserExtension: undefined, abandonProviderTurn: vi.fn(), finish: vi.fn(), stopCloseConfirmed,
  });
  return { beginRoomStop: room.beginRoomStop, ledgerLease: room.ledgerLease, observeRoomTurn: room.observeRoomTurn,
    interruptRoomTurn: room.interruptRoomTurn, stopRoomTurn: room.stopRoomTurn,
    adapter, complete, patchGroup, pendingRoomStops };
}

afterEach(() => vi.useRealTimers());

it("room watchdog and ledger share one exact-child interrupt and in-flight close; only that close releases the claim", async () => {
  vi.useFakeTimers();
  let confirm!: (value: { closeConfirmed: boolean }) => void;
  const observing = new Promise<{ closeConfirmed: boolean }>(resolve => { confirm = resolve; });
  const f = stopFixture(vi.fn(() => observing));
  // the ledger asks while the owner's interrupt is in flight: it shares that receipt (an unconfirmed one already settled is re-issued)
  let answer!: (value: { closeConfirmed: boolean }) => void;
  f.adapter.interruptTurn.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
  const owner = f.beginRoomStop();
  const ledger = f.ledgerLease.interrupt("original-child");
  await vi.advanceTimersByTimeAsync(0);
  answer({ closeConfirmed: false });
  await owner;
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.adapter.interruptTurn).toHaveBeenCalledExactlyOnceWith("room", "original-child");
  expect(f.adapter.awaitTurnTeardown).toHaveBeenCalledExactlyOnceWith("room", "original-child");
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.patchGroup).not.toHaveBeenCalled();
  f.pendingRoomStops.get("room").terminal("another-child");
  expect(f.complete).not.toHaveBeenCalled();
  confirm({ closeConfirmed: true });
  expect(await ledger).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.complete).toHaveBeenCalledExactlyOnceWith("room", "original-child");
  expect(f.patchGroup).toHaveBeenCalledExactlyOnceWith("group", { busyBotId: null, unread: true });
  expect(f.pendingRoomStops.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["unconfirmed", "rejected"])("room close observation retries an %s result and keeps other child receipts separate", async outcome => {
  const observe = vi.fn(async (_thread: string, turn: string) => ({ closeConfirmed: turn === "another-child" }));
  if (outcome === "rejected") observe.mockRejectedValueOnce(new Error("fixture close unavailable"));
  else observe.mockResolvedValueOnce({ closeConfirmed: false });
  const f = stopFixture(observe);
  const first = f.observeRoomTurn("original-child");
  if (outcome === "rejected") await expect(first).rejects.toThrow("fixture close unavailable");
  else await expect(first).resolves.toEqual({ closeConfirmed: false });
  await expect(f.observeRoomTurn("another-child")).resolves.toEqual({ closeConfirmed: true });
  await expect(f.observeRoomTurn("original-child")).resolves.toEqual({ closeConfirmed: false });
  expect(observe.mock.calls).toEqual([["room", "original-child"], ["room", "another-child"], ["room", "original-child"]]);
  observe.mockResolvedValue({ closeConfirmed: true });
  await expect(f.observeRoomTurn("original-child")).resolves.toEqual({ closeConfirmed: true });
  await expect(f.observeRoomTurn("original-child")).resolves.toEqual({ closeConfirmed: true });
  expect(observe).toHaveBeenCalledTimes(4);
});


it("owner cancellation reaches the room invocation after cancelling every queued operation", async () => {
  const operations = [0, 1].map(id => ({ id, threadId: "room", cancelled: false, cancellation: new AbortController(), providerHandshakePending: false }));
  const closed = Promise.resolve({ closeConfirmed: true });
  const stop = vi.fn(() => {
    expect(operations.every(operation => operation.cancelled && operation.cancellation.signal.aborted)).toBe(true);
    return closed;
  });
  const cancel = wiring(["cancelGroupTurnOperations"], {
    recordMemorySettlement: vi.fn(), revokeInternalThread: vi.fn(), store: { activeLeaf: () => "leaf" },
    groupTurnOperations: new Map([["group", new Set(operations)]]), finishGroupGoalRun: vi.fn(),
    roomStopRequests: new Map([["room", stop]]),
  }).cancelGroupTurnOperations;
  expect(cancel("group", "room")).toBe(closed);
  await expect(closed).resolves.toEqual({ closeConfirmed: true });
  expect(stop).toHaveBeenCalledExactlyOnceWith();
  expect(cancel("group", "another-room")).toBeUndefined();
  expect(stop).toHaveBeenCalledTimes(1);
});

it.each([false, true])("owner Stop settles the invocation but reports only an actual close; pending=%s", async pending => {
  const order: string[] = [], pendingStop = {}, pendingRoomStops = new Map(pending ? [["room", pendingStop]] : []);
  const request = roomWiring(["stopRoomTurn"], {
    abandonProviderTurn: () => order.push("retire"),
    beginRoomStop: () => { order.push("stop"); return Promise.resolve(); },
    finish: (outcome: string) => order.push(outcome), pendingRoomStops, pendingStop, roomStopClosed: !pending, threadId: "room",
    providerTurnId: undefined, roomProviderStops: new Map(), interruptRoomTurn: vi.fn(), stopCloseConfirmed,
  }).stopRoomTurn();
  expect(order).toEqual(["retire", "stop", "cancelled"]);
  if (pending) await expect(request).rejects.toThrow("provider_stop_unconfirmed");
  else await expect(request).resolves.toEqual({ closeConfirmed: true });
});


it("a repeat owner Stop re-issues the engine interrupt after the first receipt settled unconfirmed", async () => {
  const f = stopFixture(vi.fn(() => new Promise<{ closeConfirmed: boolean }>(() => {})));
  f.adapter.interruptTurn.mockResolvedValueOnce({ closeConfirmed: false }).mockResolvedValueOnce({ closeConfirmed: true });
  await expect(f.stopRoomTurn()).rejects.toThrow("provider_stop_unconfirmed");
  await expect(f.stopRoomTurn()).resolves.toEqual({ closeConfirmed: true });
  expect(f.adapter.interruptTurn.mock.calls).toEqual([["room", "original-child"], ["room", "original-child"]]);
});

// Each confirmed Stop must find the room already released (busy cleared once, claim and pending stop gone).
const releasedWhenConfirmed = (f: ReturnType<typeof stopFixture>) => (result: unknown) => ({
  result, released: f.patchGroup.mock.calls.length, completed: f.complete.mock.calls.length, pending: f.pendingRoomStops.size,
});

it("a confirmed retry releases the room through the pending stop; a third Stop sees it without a third interrupt", async () => {
  const f = stopFixture(vi.fn(() => new Promise<{ closeConfirmed: boolean }>(() => {})));
  f.adapter.interruptTurn.mockResolvedValueOnce({ closeConfirmed: false }).mockResolvedValueOnce({ closeConfirmed: true });
  const seen = releasedWhenConfirmed(f);
  await expect(f.stopRoomTurn()).rejects.toThrow("provider_stop_unconfirmed");
  expect(f.patchGroup).not.toHaveBeenCalled();
  const confirmed = { result: { closeConfirmed: true }, released: 1, completed: 1, pending: 0 };
  await expect(f.stopRoomTurn().then(seen)).resolves.toEqual(confirmed);
  await expect(f.stopRoomTurn().then(seen)).resolves.toEqual(confirmed);
  expect(f.adapter.interruptTurn).toHaveBeenCalledTimes(2);
  expect(f.patchGroup).toHaveBeenCalledExactlyOnceWith("group", { busyBotId: null, unread: true });
  expect(f.complete).toHaveBeenCalledExactlyOnceWith("room", "original-child");
});

it("concurrent Stops joining a retry share its confirmed result and its single release", async () => {
  let answer!: (value: { closeConfirmed: boolean }) => void;
  const f = stopFixture(vi.fn(() => new Promise<{ closeConfirmed: boolean }>(() => {})));
  f.adapter.interruptTurn.mockResolvedValueOnce({ closeConfirmed: false })
    .mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
  const seen = releasedWhenConfirmed(f);
  await expect(f.stopRoomTurn()).rejects.toThrow("provider_stop_unconfirmed");
  const joined = [f.stopRoomTurn().then(seen), f.stopRoomTurn().then(seen), f.stopRoomTurn().then(seen)];
  await Promise.resolve(); await Promise.resolve();
  expect(f.adapter.interruptTurn).toHaveBeenCalledTimes(2);
  answer({ closeConfirmed: true });
  const confirmed = { result: { closeConfirmed: true }, released: 1, completed: 1, pending: 0 };
  await expect(Promise.all(joined)).resolves.toEqual([confirmed, confirmed, confirmed]);
  expect(f.adapter.interruptTurn).toHaveBeenCalledTimes(2);
  expect(f.patchGroup).toHaveBeenCalledTimes(1);
});

it("a repeat Stop never reports closeConfirmed before the room is released", async () => {
  let answer!: (value: { closeConfirmed: boolean }) => void;
  const f = stopFixture(vi.fn(() => new Promise<{ closeConfirmed: boolean }>(() => {})));
  f.adapter.interruptTurn.mockResolvedValueOnce({ closeConfirmed: false })
    .mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
  await expect(f.stopRoomTurn()).rejects.toThrow("provider_stop_unconfirmed");
  const retry = f.stopRoomTurn().then(releasedWhenConfirmed(f));
  await Promise.resolve(); await Promise.resolve();
  expect(f.adapter.interruptTurn).toHaveBeenCalledTimes(2);
  answer({ closeConfirmed: true });
  await expect(retry).resolves.toEqual({ result: { closeConfirmed: true }, released: 1, completed: 1, pending: 0 });
  // A retry the engine still leaves unconfirmed reports that, and the claim stays held.
  const g = stopFixture(vi.fn(() => new Promise<{ closeConfirmed: boolean }>(() => {})));
  await expect(g.stopRoomTurn()).rejects.toThrow("provider_stop_unconfirmed");
  await expect(g.stopRoomTurn()).rejects.toThrow("provider_stop_unconfirmed");
  expect(g.adapter.interruptTurn).toHaveBeenCalledTimes(2);
  expect(g.patchGroup).not.toHaveBeenCalled();
  expect(g.pendingRoomStops.size).toBe(1);
});

it("an in-flight room interrupt stays shared by a repeat Stop and the ledger lease", async () => {
  let answer!: (value: { closeConfirmed: boolean }) => void;
  const f = stopFixture(vi.fn(() => new Promise<{ closeConfirmed: boolean }>(() => {})));
  f.adapter.interruptTurn.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
  const first = f.interruptRoomTurn("original-child"), second = f.interruptRoomTurn("original-child");
  expect(second).toBe(first);
  await Promise.resolve(); await Promise.resolve();
  expect(f.adapter.interruptTurn).toHaveBeenCalledTimes(1);
  answer({ closeConfirmed: true });
  await expect(first).resolves.toEqual({ closeConfirmed: true });
  expect(f.interruptRoomTurn("original-child")).toBe(first);
  expect(f.adapter.interruptTurn).toHaveBeenCalledTimes(1);
});

it.each([
  ["memory redispatch", "memory_revoked", false, false, false],
  ["normal completion", "settled", false, false, false],
  ["ledger teardown", "memory_refused", false, false, false],
  ["pending owner Stop", "cancelled", true, false, true],
  ["pending watchdog Stop", "stalled", true, false, true],
  ["replacement attempt", "settled", false, true, true],
] as const)("room stop registry releases at %s without waiting for a redispatch", (_name, outcome, pending, replaced, retained) => {
  const cancelRoomTurn = () => Promise.resolve(), replacement = () => Promise.resolve();
  const roomStopRequests = new Map([["room", replaced ? replacement : cancelRoomTurn]]);
  const pendingStop = {}, pendingRoomStops = new Map(pending ? [["room", pendingStop]] : []);
  const resolved = vi.fn(), roomLedgerRefusalNotes = new Map([["generation", vi.fn()], ["replacement", vi.fn()]]);
  const { finish } = roomWiring(["finish"], {
    roomLedgerRefusalNotes, internalGeneration: "generation",
    done: false, spendGate: { endTurn: vi.fn() }, threadId: "room", ownerSend: undefined,
    roomStopRequests, cancelRoomTurn, pendingStop: pending ? pendingStop : undefined, pendingRoomStops,
    unsub: vi.fn(), unregisterStall: vi.fn(), resolve: resolved,
  });
  finish(outcome);
  expect([...roomLedgerRefusalNotes.keys()]).toEqual(["replacement"]);
  expect(roomStopRequests.has("room")).toBe(retained);
  if (retained) expect(roomStopRequests.get("room")).toBe(replaced ? replacement : cancelRoomTurn);
  expect(resolved).toHaveBeenCalledExactlyOnceWith(outcome);
});

it.each([false, true])("generation cleanup deletes only its existing continuation, present=%s", async present => {
  const proof = { kind: "background-job", id: "service:retired", botId: "member", threadId: "room" };
  const readContinuation = vi.fn(() => present ? { threadId: "room", generation: "retired" } : undefined);
  const deleteContinuation = vi.fn(async () => {});
  const handle = { prepare: () => ({ get: () => ({ timeout: 1000 }) }), isOpen: true }, setBusy = vi.fn();
  const decisionProvenance = new Map([["retired", { botId: "member" }], ["replacement", { botId: "member" }]]);
  const { releaseDecisionProvenance } = wiring(["releaseDecisionProvenance"], {
    decisionSharedSaves: new Map(), completeDecisionGeneration: vi.fn(), cancelRequests: vi.fn(),
    decisionAuthorities: new Map(), decisionRequestTargets: new Map(), decisionQueuePorts: new Map(),
    decisionProvenance, readContinuation, deleteContinuation,
    database: () => handle, setBusy, BACKGROUND_BUSY_MS: 50,
  });
  await expect(releaseDecisionProvenance("room", "retired")).resolves.toBeUndefined();
  expect(setBusy.mock.calls).toEqual(present ? [[handle, 50], [handle, 1000]] : []);
  expect(readContinuation).toHaveBeenCalledExactlyOnceWith(proof);
  if (present) expect(deleteContinuation).toHaveBeenCalledExactlyOnceWith(proof);
  else expect(deleteContinuation).not.toHaveBeenCalled();
  expect(decisionProvenance.has("retired")).toBe(false);
  expect(decisionProvenance.has("replacement")).toBe(true);
});

// MAIN 15:56Z C2 (Q1=B): a room-bound Claude turn stopped while its setup waits
// on the version probe, before anything launched, hands the room over through
// RoomPendingStop exactly as a confirmed interrupt does: the claim is released
// once, nothing is retained, and a second Stop then reads confirmed. The
// adapter is the real Claude driver on the isolated fake CLI.
useOutsideStoreFixture();
it.skipIf(process.platform === "win32")("a room turn stopped before launch releases the room exactly once, and a second Stop sees confirmed", async () => {
  const root = mkdtempSync(join(tmpdir(), "room-setup-stop-"));
  const fakeCli = fileURLToPath(new URL("./testing/fake-claude-cli.ts", import.meta.url));
  const dump = join(root, "dump.json"), probe = heldProbeLauncher(root, fakeCli);
  ensureDirs();
  let instance: ProviderInstance | undefined;
  try {
    instance = await admittedFixtureInstance(ClaudeDriver.create({ instanceId: "room-setup-stop", displayName: "fixture", enabled: true,
      environment: { FAKE_CLAUDE_MCP_STATUS: "error", FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_DUMP: dump }, config: { cli: probe.cli, permissionMode: "bypassPermissions" } }));
    const adapter = instance.adapter;
    const events = recordEvents(adapter);
    try {
      writeFileSync(probe.hold, "hold");
      const sending = adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "room", text: "hello" });
      for (const at = Date.now(); !existsSync(probe.held);) {
        expect(Date.now() - at).toBeLessThan(30000);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      // The owner's Stop reaches the setup (the room's turn id is the dispatch's, known once it returns).
      const owner = adapter.interruptTurn("room");
      const { turnId } = await sending;
      await owner;
      await events.until(event => event.type === "turn.completed" && event.turnId === turnId, 30000);
      const interruptTurn = vi.fn((thread: string, turn: string) => adapter.interruptTurn(thread, turn));
      const observe = vi.fn((thread: string, turn: string) => adapter.awaitTurnTeardown!(thread, turn));
      const f = stopFixture(observe, { interruptTurn, awaitTurnTeardown: observe }, turnId);
      await f.beginRoomStop();
      expect(await f.ledgerLease.interrupt(turnId)).toBe(true);
      for (const at = Date.now(); f.complete.mock.calls.length === 0;) {
        expect(Date.now() - at).toBeLessThan(30000);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(interruptTurn).toHaveBeenCalledExactlyOnceWith("room", turnId);
      expect(f.complete).toHaveBeenCalledExactlyOnceWith("room", turnId);
      expect(f.patchGroup).toHaveBeenCalledExactlyOnceWith("group", { busyBotId: null, unread: true });
      expect(f.pendingRoomStops.size).toBe(0);
      // A second Stop reads the confirmed close; the room is not released again.
      await expect(f.observeRoomTurn(turnId)).resolves.toEqual({ closeConfirmed: true });
      expect(await adapter.interruptTurn("room", turnId)).toEqual({ closeConfirmed: true });
      expect(f.complete).toHaveBeenCalledTimes(1);
      expect(f.patchGroup).toHaveBeenCalledTimes(1);
      writeFileSync(probe.release, "answer");
      expect(existsSync(dump)).toBe(false);
    } finally { events.stop(); }
  } finally {
    writeFileSync(probe.release, "cleanup");
    await instance?.dispose(); resetClaudeVersionGate();
    await removeTempDir(root);
  }
}, 60000);


it.each([false, true])("ledger retry notification belongs only to a room rebuild, room=%s", room => {
  const boundary = new TurnSubmissionBoundary();
  boundary.started(true);
  const notified = vi.fn();
  boundary.acceptedBy(notified);
  const ledger = wiring(["admitLedgerLease"], {
    bus: { admitNewTurn: () => ({}) }, database: () => ({}),
    createLedgerLease: (_identity: unknown, deps: unknown) => deps,
    admittedLedgerLeases: new Map(), ledgerCompletionSources: new WeakMap(), ledgerProviderInstances: new WeakMap(),
    internalTurnOwners: new Map(), refusedLeases: new Map(), revokeInternalGeneration: vi.fn(),
    releasingEngineInput: () => false, confirmedStopGenerations: new PendingTurnKeys(),
  }).admitLedgerLease;
  const instance = { instanceId: "instance", adapter: { capabilities: { fencedWrites: true } } };
  const lease = room ? roomWiring(["ledgerLease"], {
    admitLedgerLease: ledger, bot: { id: "member" }, threadId: "room", internalGeneration: "generation",
    roomTurnLineage: {}, instance, submissionBoundary: boundary, interruptRoomTurn: vi.fn(), observeRoomTurn: undefined,
  }).ledgerLease : ledger("member", "direct", "generation", { turnId: "turn" }, instance, boundary);
  lease.seal();
  expect(notified).toHaveBeenCalledTimes(room ? 1 : 0);
  expect(boundary.canRetry).toBe(room);
  const validate = vi.fn();
  expect(() => boundary.beforeSubmit(validate)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(validate).not.toHaveBeenCalled();
});


it.each([
  ["memory_revoked", false, undefined],
  ["memory_revoked", true, "stopped"],
  ["settled", false, "completed"],
  ["cancelled", false, "stopped"],
  ["memory_refused", false, "failed"],
] as const)("pinned room finish %s, cancelled=%s settles only terminal sends", (outcome, cancelled, expected) => {
  const settle = vi.fn(), resolved = vi.fn();
  const { finish } = roomWiring(["finish"], {
    done: false, spendGate: { endTurn: vi.fn() }, threadId: "room", ownerSend: {},
    internalGeneration: "generation", isCancelled: () => cancelled, ownerSendOutcome: "completed", settleDirectAttempts: settle,
    roomLedgerRefusalNotes: new Map(),
    roomStopRequests: new Map(), cancelRoomTurn: vi.fn(), pendingStop: undefined, pendingRoomStops: new Map(),
    unsub: vi.fn(), unregisterStall: vi.fn(), resolve: resolved,
  });
  finish(outcome); finish(outcome);
  expect(settle.mock.calls).toEqual(expected ? [["generation", expected]] : []);
  expect(resolved).toHaveBeenCalledExactlyOnceWith(outcome);
});
