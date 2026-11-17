import { afterEach, expect, it, vi } from "vitest";
import ts from "typescript";
import vm from "node:vm";
import { source, wiring } from "./decision-wiring/fixture.ts";
import { isOwnerOrigin } from "./store.ts";
import { RoomPendingStop } from "./room-turn-timeout.ts";
import { stopCloseConfirmed } from "./contracts.ts";

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

function stopFixture(observe = vi.fn(async (_thread: string, _turn: string) => ({ closeConfirmed: false }))) {
  const adapter = { interruptTurn: vi.fn(async (_thread: string, _turn: string) => ({ closeConfirmed: false })), awaitTurnTeardown: observe };
  const complete = vi.fn(), patchGroup = vi.fn(), speaker = {};
  const pendingRoomStops = new Map();
  const ledger = wiring(["admitLedgerLease"], {
    bus: { admitNewTurn: () => ({}) }, database: () => ({}),
    createLedgerLease: (_identity: unknown, deps: unknown) => deps,
    admittedLedgerLeases: new Map(), ledgerCompletionSources: new WeakMap(),
    retireProviderTurn: vi.fn(), stopCloseConfirmed, ledgerProviderInstances: new WeakMap(),
  }).admitLedgerLease;
  const room = roomWiring([
    "roomProviderStops", "interruptRoomTurn", "roomProviderCloses", "observeRoomTurn", "ledgerLease", "pendingStop", "beginRoomStop",
  ], {
    instance: { adapter }, threadId: "room", providerTurnId: "original-child", bot: { id: "member" }, group: { id: "group" },
    internalGeneration: "generation", roomTurnLineage: {}, submissionBoundary: {}, admitLedgerLease: ledger,
    RoomPendingStop, roomSpeaker: speaker, pendingRoomStops, roomStopRequests: new Map(), cancelRoomTurn: undefined, roomStopClosed: false, groupSpeakers: new Map([["room", speaker]]),
    store: { group: () => ({ busyBotId: "member" }), patchGroup, bot: () => ({ busy: false }) },
    projectTurnLeases: { complete, markStopRequested: vi.fn() }, releaseDeferredRoomClaim: vi.fn(),
    drainQueuedSends: vi.fn(), drainConnectorResumes: vi.fn(), drainSecretResumes: vi.fn(), drainTeamIncidents: vi.fn(),
    browserSetup: undefined, browserExtension: undefined,
  });
  return { beginRoomStop: room.beginRoomStop, ledgerLease: room.ledgerLease, observeRoomTurn: room.observeRoomTurn,
    adapter, complete, patchGroup, pendingRoomStops };
}

afterEach(() => vi.useRealTimers());

it("room watchdog and ledger share one exact-child interrupt and in-flight close; only that close releases the claim", async () => {
  vi.useFakeTimers();
  let confirm!: (value: { closeConfirmed: boolean }) => void;
  const observing = new Promise<{ closeConfirmed: boolean }>(resolve => { confirm = resolve; });
  const f = stopFixture(vi.fn(() => observing));
  await f.beginRoomStop();
  const ledger = f.ledgerLease.interrupt("original-child");
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
  }).stopRoomTurn();
  expect(order).toEqual(["retire", "stop", "cancelled"]);
  if (pending) await expect(request).rejects.toThrow("provider_stop_unconfirmed");
  else await expect(request).resolves.toEqual({ closeConfirmed: true });
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
  const resolved = vi.fn();
  const { finish } = roomWiring(["finish"], {
    done: false, spendGate: { endTurn: vi.fn() }, threadId: "room", ownerSend: undefined,
    roomStopRequests, cancelRoomTurn, pendingStop: pending ? pendingStop : undefined, pendingRoomStops,
    unsub: vi.fn(), unregisterStall: vi.fn(), resolve: resolved,
  });
  finish(outcome);
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
