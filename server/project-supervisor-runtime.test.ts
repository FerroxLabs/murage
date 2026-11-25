// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// Execute the actual index seams with isolated dependencies, without booting a server.
import { readFileSync, realpathSync } from "node:fs";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import { dispatchProjectUsageTurn } from "./project-usage-dispatch.ts";
import { turnIsBackground } from "./message-automation.ts";
import { createSharedOwnerUsage } from "./shared-owner-usage.ts";
import { engineLimitLine, engineLimitText } from "./web-read-routing.ts";
import { murageLine } from "./murage-line.ts";
import { assertEngineInput, fencedTurnInput } from "./drivers/engine-input.ts";
import { assertConsumingBinding, bindConsumingTurn, refuseConsumingTurn } from "./consuming-turn-response.ts";
import { checkedOpenTurns, closeTurnLineage, openTurnLineage, refuseRetainedTurn } from "./memory/lineage-write.ts";
import { buildPrompt, noneRef, promptPart } from "./memory/prompt-parts.ts";
import { WritetimeFixture } from "./memory/testing/writetime-fixture.ts";
import { bindFixtureTurn } from "./testing/consuming-fixture.ts";
import { RuntimeAudienceCollector } from "./harness/audience-collector.ts";
import { isSharedWorkRow } from "./shared-work.ts";
import { initializeOwnerLimitStorage } from "./owner-limit-continuation.ts";
import { isFluxHost } from "./flux-usage-tags.ts";
import { isFluxModel } from "./flux-surface.ts";
import { assertRecallDispatch } from "./memory/recall-readiness.ts";
import { ShellSessionRegistry } from "./shell-session-state.ts";
import { latestIncarnation } from "./memory/session-incarnation.ts";
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
function seam(name: string, deps: Record<string, unknown>) {
  const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  if (!node) throw new Error(`Missing ${name}`);
  const js = ts.transpileModule(node.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(deps), `${js}; return ${name};`)(...Object.values(deps));
}
const closeFixtures: Array<() => void> = [];
afterEach(() => { for (const close of closeFixtures.splice(0)) close(); });
function admittedTurn(threadId = "thread", botId = "lead") {
  const fixture = new WritetimeFixture();
  // Use the real spend storage/index bootstrap alongside the retained-write schema.
  initializeOwnerLimitStorage(fixture.db);
  const turn = openTurnLineage(fixture.db, { threadId, turnId: "gen" });
  const { binding } = bindFixtureTurn(fixture.db, turn, botId, "gen");
  closeFixtures.push(() => { closeTurnLineage(turn); fixture.close(); });
  return { db: fixture.db, binding, fence: { retained: turn, reader: { audience: null }, db: fixture.db },
    // the real dispatch assertion runs: the turn carries a complete recall preparation (nothing recalled, no history to carry)
    built: { threadId, recall: "off", system: "Fixture persona", integrations: {}, recallPrepared: { system: "Fixture persona", integrations: [], historyPrepared: false, resumed: false },
      prompt: buildPrompt(turn, [promptPart("Fixture usage turn", [noneRef("static")])]) } };
}
// MAIN INT-CONFLICT-DEFAULT: int-train5 retains real consuming fences;
// salv-spend owns the native accounting route, with no backup application.
function nativeSpendDispatch(internalTurnOwners: Map<string, { generation: string }> = new Map()) {
  const claimOwnerLimitDispatch = seam("claimOwnerLimitDispatch", { limitActiveDispatches: new Map() });
  return seam("dispatchSpendTurn", {
    internalTurnOwners, isFluxHost, isFluxModel, claimOwnerLimitDispatch,
    fluxKey: () => { throw Error("native accounting turn requested a Flux key"); },
    spendGate: { dispatchStart: () => { throw Error("native accounting turn entered the Flux gate"); } },
  });
}
function usageFixture() {
  const admission = admittedTurn();
  const request = { id: "usage-request", groupId: "g", admissionKey: "usage:gen", state: "running", targetThreadId: "thread", dispatchedAt: 100, ownerWaitMs: 20, waitingSince: null };
  const owner = { botId: "lead", generation: "gen", notOwnerAudience: false };
  const internalTurnOwners = new Map([["thread", owner]]);
  const dispatchSpendTurn = nativeSpendDispatch(internalTurnOwners);
  const pending = new Map(); const turns = new Map(); const bindings = new Map();
  const internalResponseBindings = new Map();
  const settle = vi.fn(); const complete = vi.fn(); const insert = vi.fn((_db: unknown, _input: unknown) => ({ request }));
  const collector = new RuntimeAudienceCollector();
  const attachment = collector.attach("fixture");
  const completionSource = collector.source(collector.admitNewTurn({ attachment, instanceId: "fixture", threadId: "thread" }));
  const ledgerLease = { admissionNotLaunched: vi.fn() };
  // Local role: index.ts declares the home execution gate undefined.
  const deps = { ledgerCompletionSources: new WeakMap([[ledgerLease, completionSource]]), homeExecutionGate: undefined, fluxMemoryCapture: { begin() {}, observe() {} }, fluxFirstTokenProbe: { begin() {}, observe() {} }, internalTurnOwners, turnRequestByGeneration: bindings, delegationWatch: new Map(), syncAskRequests: new Map(),
    // Native accounting fixture has no backup limit turn; the real dispatch/fence still runs.
    limitTurns: Object.assign(new Map(), { bindProvider: vi.fn() }), dispatchProjectUsageTurn, dispatchSpendTurn, engineLimitLine, engineLimitText, murageLine,
    // Accounting runs behind the same retained input and consuming binding as a real dispatch.
    assertEngineInput, fencedTurnInput, checkedOpenTurns, bindConsumingTurn, refuseRetainedTurn, refuseConsumingTurn,
    // Execute the production generation/brand check at the same retained binding seam.
    internalResponseBindings, retainInternalResponseBinding: seam("retainInternalResponseBinding", { assertConsumingBinding, refuseConsumingTurn, internalResponseBindings }),
    internalCapabilities: { activeGeneration: () => "gen" }, providerRouteIsCurrent: () => true,
    admittedLedgerLeases: new Map([["gen", ledgerLease]]),
    createMcpMountAdmission: vi.fn(() => ({})), proxyReleaseAuthority: {}, PORT: 12345,
    bus: { admitNewTurn: vi.fn() }, isSharedWorkRow,
    sharedOwnerUsageTurn: seam("sharedOwnerUsageTurn", { dispatchSpendTurn, store: { taskByThread: () => undefined } }),
    abandonSharedOwnerUsageTurn: seam("abandonSharedOwnerUsageTurn", { sharedOwnerUsage: createSharedOwnerUsage(vi.fn()) }),
    roomRequest: () => request, database: () => admission.db, projectGroupForThread: () => ({ id: "g", channelProject: true }),
    store: { messagesFor: () => [], newestMatching: () => undefined, group: () => ({ id: "g" }), bot: () => undefined, appendMessage: vi.fn() }, insertRoomRequest: insert, activeRoomGoal: () => "goal",
    roomLineage: () => ({ notOwnerAudience: true }), projectUsagePending: pending, projectUsageTurns: turns,
    settleProjectUsage: settle, completeRequest: complete,
    // F3 (540bec1c0): a usage root's completion is handed to afterRoomCompletion (cancelled subtree, interrupts, wakes); its own subject is request-tree-f3.test.ts
    afterRoomCompletion: vi.fn(), projectFrames: { strip: vi.fn() }, projectBudgetGate: { evaluate: vi.fn() },
    // the warm-engine identity the usage turn now carries (mobile lane): no proven human here
    threadHumanPrincipal: () => undefined,
    // the Flux number hold (1.0.4): this thread holds no number
    fluxCaptureHeld: () => false,
    // background work is told by the dispatch's own request (a routine's): the real classifier
    turnIsBackground,
    assertRecallDispatch,
    // X3: the engine shell launch is registered only for the adapter call (the real registry, a fixed generation)
    randomUUID: () => "shell-generation", shellSessions: new ShellSessionRegistry(), latestIncarnation,
    spawnFolder: seam("spawnFolder", { realpathSync }),
  };
  return { request, owner, pending, turns, bindings, settle, complete, insert, deps, ...admission };
}
it("F3 refuses an ask from the lead reply at the project budget line", () => {
  const check = vi.fn(() => ({ ok: false, line: "Budget reached: raise it or stop." }));
  // F3 (540bec1c0): roomAskRefused first refuses under a cancelled ancestor; nothing above this reply is cancelled here
  const ask = seam("roomAskRefused", { cancelledAncestorOrSelf: () => false, roomAskParent: () => ({ id: "reply", groupId: "g", projectGoalId: "goal" }), database: () => ({}),
    askWouldDeadlock: () => false, store: { group: () => ({ id: "g", channelProject: true }) },
    roomProjectContext: () => ({ mode: "goal", goalId: "goal", goalState: "working" }), projectBudgetGate: { check }, cfg: { features: {} } });
  expect(ask("lead", "worker", "thread")).toBe("Budget reached: raise it or stop.");
  expect(check).toHaveBeenCalledWith(expect.objectContaining({ groupId: "g", goalId: "goal", kind: "ask" }));
});
it("F4 accounting lineage preserves a non-owner room audience", async () => {
  const f = usageFixture();
  await seam("sendProjectUsageTurn", f.deps)({ driverKind: "fake", adapter: { sendTurn: async () => ({ turnId: "turn" }) } }, f.built, f.fence);
  expect(f.insert.mock.calls[0]![1]).toMatchObject({ lineage: { notOwnerAudience: true } });
  expect(f.deps.store.appendMessage).toHaveBeenCalledWith("thread", expect.objectContaining({ murageLine: true, tool: { name: engineLimitLine("fake"), ok: false } }));
});
it("F5 a send failure finishes the synthetic request without continuation", async () => {
  const f = usageFixture();
  await expect(seam("sendProjectUsageTurn", f.deps)({ driverKind: "fake", adapter: { sendTurn: async () => { throw new Error("send failed"); } } }, f.built, f.fence)).rejects.toThrow("send failed");
  expect(f.complete).toHaveBeenCalledWith(expect.anything(), "usage-request", expect.objectContaining({ state: "failed" }), expect.anything(), { continuation: false });
  expect(f.pending.size).toBe(0);
});
it.each(["gen", "admission-generation"])("F6 immediate claims (%s) and usage runs count once, excluding owner wait", claimGeneration => {
  const f = usageFixture(); const now = Date.now(); f.request.dispatchedAt = now - 100; f.request.ownerWaitMs = 40;
  f.pending.set("thread", { request: f.request, generation: "gen", botId: "lead" });
  const begin = source.indexOf("  running:()=>{", source.indexOf("const projectBudgetGate ="));
  const end = source.indexOf("\n  line:", begin);
  const js = ts.transpileModule(`const opts={${source.slice(begin,end)}};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const deps = { ...f.deps, workAdmission: { liveTurns: () => [{ groupId: "g", botId: "lead", threadId: "thread", turnGeneration: claimGeneration, startedAt: now - 100 }] } };
  vi.spyOn(Date, "now").mockReturnValue(now);
  try { const running = new Function(...Object.keys(deps), `${js}; return opts.running();`)(...Object.values(deps)); expect(running).toHaveLength(1); expect(running[0].workMs).toBe(60); }
  finally { vi.restoreAllMocks(); }
});
it("F7 revoking a generation settles and removes a dead usage run", () => {
  const f = usageFixture(); const run = { request: f.request, generation: "gen", botId: "lead", engine: "fake" };
  f.pending.set("thread", run); f.turns.set(JSON.stringify(["thread", "turn"]), run);
  // phone tools (1.0.9 union-server): a revoked generation also drops its phone dispatch facts, phone authority and phone jobs
  const phoneDispatchFacts = new Map([["gen", {}], ["other", {}]]), phoneAuthorities = { revokeGeneration: vi.fn() }, phoneJobs = { turnEnded: vi.fn() };
  const botOutsideWrites = { release: vi.fn() }, botTurnOrigins = new Map([["gen", "owner"]]), taskAllowanceSuggestions = new Map([["gen", {}]]);
  const deps: Record<string, unknown> = { ...f.deps, botOutsideWrites, botTurnOrigins, taskAllowanceSuggestions, replyState: { invalidateGeneration: vi.fn() }, callSpeech: { invalidate: vi.fn() }, hostComputerThreads: new Map(), projectTurnLeases: { abandon: vi.fn() }, internalCapabilities: { revokeGeneration: vi.fn() }, turnOutputRoots: new Map(), phoneDispatchFacts, phoneAuthorities, phoneJobs,
    retireInternalTurn: vi.fn(), retireAttention: vi.fn(), recallWaits: new Map(), refusedLeases: new Map(), releaseDecisionProvenance: vi.fn(async () => {}), revokeGatewayTurnCredentials: vi.fn() }; // lineage: a revoked generation drops its turn output roots
  // The cleanup seam is injected only if the implementation uses one.
  if (source.includes("function abandonProjectUsageTurn(")) deps.abandonProjectUsageTurn = seam("abandonProjectUsageTurn", deps);
  seam("revokeInternalGeneration", deps)("thread", "gen");
  expect(f.settle).toHaveBeenCalledOnce(); expect(f.pending.size).toBe(0); expect(f.turns.size).toBe(0);
  expect(f.complete).toHaveBeenCalledWith(expect.anything(), "usage-request", expect.objectContaining({ state: "failed" }), expect.anything(), { continuation: false });
  expect([...phoneDispatchFacts.keys()]).toEqual(["other"]); expect(phoneAuthorities.revokeGeneration).toHaveBeenCalledWith("gen"); expect(phoneJobs.turnEnded).toHaveBeenCalledWith("gen");
  expect(botOutsideWrites.release).toHaveBeenCalledWith("gen");
  expect(botTurnOrigins.size).toBe(0); expect(taskAllowanceSuggestions.size).toBe(0);
});
it("shared-owner accounting holds asks and settles a failed send", async () => {
  const admission = admittedTurn("work", "bot");
  const settleSharedOwner = vi.fn(), sharedOwnerUsage = createSharedOwnerUsage(settleSharedOwner);
  const sendTurn = vi.fn(async () => { throw Error("shared send failed"); });
  const send = seam("sharedOwnerUsageTurn", { sharedOwnerUsage, assertConsumingBinding, refuseConsumingTurn,
    limitTurns: new Map(), dispatchSpendTurn: nativeSpendDispatch(new Map([["work", { generation: "gen" }]])),
    store: { taskByThread: () => ({ threadId: "work", sharedWork: { teamId: "sales" } }), newestMatching: () => ({ id: "message", role: "user" }) } });
  await expect(send({ driverKind: "fake", adapter: { sendTurn } }, { threadId: "work" }, { botId: "bot", generation: "gen" }, admission.fence, admission.binding)).rejects.toThrow("shared send failed");
  expect(sendTurn).toHaveBeenCalledWith({ threadId: "work" });
  expect(settleSharedOwner).toHaveBeenCalledTimes(1);
  expect(settleSharedOwner).toHaveBeenCalledWith("work", expect.objectContaining({ generation: "gen", teamId: "sales", messageId: "message" }), { ok: false });
  expect(sharedOwnerUsage.has("work")).toBe(false);
});
it("shared-owner abandonment settles only the revoked generation", () => {
  const settleSharedOwner = vi.fn(), sharedOwnerUsage = createSharedOwnerUsage(settleSharedOwner);
  sharedOwnerUsage.begin("work", { generation: "gen", botId: "bot", teamId: "sales", messageId: "message", engine: "fake", startedAt: 1, ownerWaitMs: 0, asks: new Set() });
  const abandon = seam("abandonSharedOwnerUsageTurn", { sharedOwnerUsage });
  abandon("work", "old"); expect(settleSharedOwner).not.toHaveBeenCalled();
  abandon("work", "gen"); expect(settleSharedOwner).toHaveBeenCalledWith("work", expect.objectContaining({ generation: "gen" }), { ok: false });
});

// arev-salv-x3restore-n4 Medium: launch admission through the actual usage dispatch. A launch left behind
// turns the next acceptance of that turn id into a live shell record (server/shell-launch-admission.test.ts).
function launchRetained(registry: ShellSessionRegistry): boolean {
  registry.accept("shell-generation", "T", "/proj");
  registry.started({ thread: "thread", provider: "inst", native: "n", incarnation: 1 }, "T");
  return registry.select("thread", "inst", "T") !== undefined;
}
it("F5s a spend refusal at the gate leaves no shell launch behind and never reaches the engine", async () => {
  const f = usageFixture();
  const refused = new Error("SPEND_REFUSED");
  // the real dispatchSpendTurn: a Flux-priced turn goes through the spend gate, which refuses it
  const dispatchSpendTurn = seam("dispatchSpendTurn", { internalTurnOwners: f.deps.internalTurnOwners, isFluxHost, isFluxModel: () => true,
    claimOwnerLimitDispatch: () => {}, fluxKey: () => "fixture-key", spendGate: { dispatchStart: () => { throw refused; } } });
  const deps = { ...f.deps, dispatchSpendTurn, sharedOwnerUsageTurn: seam("sharedOwnerUsageTurn", { dispatchSpendTurn, store: { taskByThread: () => undefined } }) };
  const sendTurn = vi.fn(async () => ({ turnId: "T" }));
  await expect(seam("sendProjectUsageTurn", deps)({ instanceId: "inst", driverKind: "fake", adapter: { sendTurn } }, f.built, f.fence)).rejects.toBe(refused);
  expect(sendTurn).not.toHaveBeenCalled();
  expect(launchRetained(f.deps.shellSessions)).toBe(false);
});
it("F5r an engine rejection through the usage dispatch leaves no shell launch behind", async () => {
  const f = usageFixture();
  await expect(seam("sendProjectUsageTurn", f.deps)({ instanceId: "inst", driverKind: "fake", adapter: { sendTurn: async () => { throw new Error("send failed"); } } }, f.built, f.fence)).rejects.toThrow("send failed");
  expect(launchRetained(f.deps.shellSessions)).toBe(false);
});
it("F5a an accepted usage turn is the shell record for its engine turn", async () => {
  const f = usageFixture();
  await seam("sendProjectUsageTurn", f.deps)({ instanceId: "inst", driverKind: "fake", adapter: { sendTurn: async () => ({ turnId: "T" }) } }, f.built, f.fence);
  f.deps.shellSessions.started({ thread: "thread", provider: "inst", native: "n", incarnation: 1 }, "T");
  expect(f.deps.shellSessions.select("thread", "inst", "T")).toBeDefined();
});
