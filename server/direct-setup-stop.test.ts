// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture owner: r7orph-fx3. Retirement contract owner: MAIN G17.
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { expect, it, vi } from "vitest";
import { stopCloseConfirmed } from "./contracts.ts";
import { PendingTurnKeys } from "./fold-steps.ts";
import { IndependentThreadRuns } from "./independent-thread-runs.ts";
import { ENGINE_CLOSED_LATE_NOTE, PROVIDER_STOP_UNCONFIRMED_LINE, releaseOnLateClose } from "./direct-late-close.ts";
import { TurnSubmissionBoundary, guardTurnDispatch, PendingTurnCancellations, RetiredTurnRegistry, isTurnEventQuarantined } from "./turn-dispatch-guard.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const section = (start: string, end: string) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
};
const acceptStart = source.includes("const stopAcceptedSetup = async") ? "stopAcceptedSetup,(accepted)=>{" : "      },(accepted)=>{";
const acceptCode = source.includes("acceptedDirectTurn = directRuns.accepted")
  ? section(acceptStart, "\n      });\n      releaseEngineStart();").slice(acceptStart.length) : "";
const cancelledCode = section('      if (dispatch.cancelled) {\n        retireProviderTurn(dispatch.value.turnId);', '      bindProviderTurn(turnLineage, dispatch.value.turnId);').split('      if (!acceptedDirectTurn) return;')[0];
const cleanupCode = source.includes("const stopAcceptedSetup = async")
  ? section("      const stopAcceptedSetup = async (accepted: { turnId: string }) => {", "      const dispatch = await guardTurnDispatch")
    .slice("      const stopAcceptedSetup = async (accepted: { turnId: string }) => {".length).replace(/      };\s*$/, "")
  : section("        acceptedTurnId=accepted.turnId;\n        retireProviderTurn", "      },(accepted)=>{");
// Execute the production owner, Stop and catch with fake external ports; no server bootstrap or provider.
function fixture() {
  const directRuns = new IndependentThreadRuns<object>();
  let task = { busy: true };
  const bot = { id: "fixture-bot", threadId: "fixture-thread", modelSelection: { instanceId: "fixture" } };
  const threadId = bot.threadId;
  const resources = ["workspace:/fixture", "computer:fixture", "browser:fixture"];
  const run = directRuns.admit(bot.id, threadId, {}, resources);
  const submissionBoundary = new TurnSubmissionBoundary();
  const directTurnDispatchClaims = new Map([[threadId, { id: run.generation, botId: bot.id, threadId, phase: "setup", get canRetry() { return submissionBoundary.canRetry; } }]]);
  const store = {
    bot: () => bot,
    taskByThread: () => task,
    setTaskActivity: vi.fn((_botId: string, _threadId: string, activity: string) => { task.busy = activity !== "idle"; }),
    appendMessage: vi.fn(),
  };
  const noop = () => {};
  const stopped = vi.fn(async () => ({ closeConfirmed: true }));
  const instance = { adapter: { interruptTurn: stopped, sendTurn: vi.fn(), awaitTurnTeardown: vi.fn(async () => ({ closeConfirmed: false })) } };
  const ports = {
    releaseOnLateClose, ENGINE_CLOSED_LATE_NOTE, PROVIDER_STOP_UNCONFIRMED_LINE,
    PendingTurnCancellations, RetiredTurnRegistry, isTurnEventQuarantined, PendingTurnKeys,
    stopInterrupts: new Map(), refusedTurnOf: () => undefined,
    generatedImagesByTurn: new Map(), refusedLeases: new Map(), chiefProposals: { ignores: () => false },
    isPipReflectThread: () => false, isMemoryLearningThread: () => false,
    murageLine: (line: unknown) => line, lateMemoryRedispatches: new Map(), turnRefusalNotes: new Map(),
    endOutsideTurn: noop, turnSucceeded: () => false,
    // The ledger-lease lookup is its own contract; this fixture pins the run and quarantine routing around it.
    terminalDispatchFor: () => ({ identity: { dispatchGeneration: run.generation } }),

    retirementSpy: vi.fn, guardTurnDispatch, directRuns, store, directTurnDispatchClaims, submissionBoundary, instance, bot, threadId, run,
    releaseDecisionProvenance: async () => {}, successfulDecisionGenerations: new Set(), browserExecutions: { forget: noop },
    botOutsideWrites: { release: noop }, botTurnOrigins: new Map(), taskAllowanceSuggestions: new Map(),
    ownerStartedRuns: new Set(), highlevelProvenRuns: new Set(), highlevelDesktopRuns: new Set(), highlevelOwnerStartedAt: new Map(),
    sharedThreadFreed: noop, sharedBotFreed: noop,
    directConversationGenerations: new WeakMap(),
    console: { warn: vi.fn() },
    internalTurnOwners: new Map(), turnRequestByGeneration: new Map(), workAdmission: { liveTurns: () => [] },
    projectCardExecutor: { requestStop: noop }, revokeInternalGeneration: noop, recordMemorySettlement: vi.fn(),
    closeOpenApprovals: noop,
    ownerLimitContinuations: { cancel: noop }, limitApplications: { cancel: noop }, sealDirectAttempts: noop,
    ownWriteHolds: { stop: noop }, bus: { cancelTurn: noop }, callSpeech: { invalidate: noop }, replyState: { invalidate: noop },
    botForDirectThread: () => bot, randomUUID: () => "fixture-stop", stopEmailForTurn: noop, emailRuntime: {}, emailGeneration: {},
    releaseBrowserCapabilityForThread: async () => {}, registry: new Map([["fixture", instance]]),
    stopCloseConfirmed,
    unconfirmedDirectStop: () => new Error("unconfirmed"), screenPollers: new Map(), finalScreenFrame: noop,
    settleDirectAttempts: noop, watchdog: { settle: noop, settleSetup: noop },
    replySpeakerTurns: { ended: vi.fn() }, finishDirectAttemptEffects: noop, projectTurnLeases: { markStopRequested: noop, releaseClosed: vi.fn(), complete: vi.fn() },
    handbackToken: undefined, awaitingHandback: new Map(), releaseEngineStart: noop, releaseTurnHold: noop,
    earlyBundle: undefined, ledgerLease: { completed: vi.fn(), attach: noop }, admittedLedgerLeases: new Map([[run.generation, {}]]), closeTurnLineage: vi.fn(),
    turnLineage: {}, turnAttribution: { ended: noop }, askTurnDevices: { drop: noop }, acceptedTurnCleanupFailed: false, acceptedTurnTeardownConfirmed: false, acceptedTurnId: undefined,
    acceptedTurnLateClose: undefined, acceptedDirectTurn: false,
    activeProviderSelections: new Map(), providerRoute: {},
    memoryRefusalCauses: new Map(), userMessage: { id: "fixture-message" }, isMemoryContextRevoked: () => false,
    nextMemoryRebuild: noop, recordMemoryRefusal: noop, turnRefused: noop, endTurnTrace: vi.fn(), releaseLocalVmThread: vi.fn(),
    activeVpsThreads: new Map(), turnUsage: new Map(), retryDelegationsWaitingOn: vi.fn(), drainQueuedSends: vi.fn(),
    drainConnectorResumes: vi.fn(), drainSecretResumes: vi.fn(), browserSetup: { drain: vi.fn() }, browserExtension: { approvals: { drain: vi.fn(async () => {}) } },
    drainTeamIncidents: vi.fn(), routineToken: undefined,
  };
  const catchCode = section("      const ownsRejectedConversation = admitted.rejectionOwner.current();", "      if (!ownsLatestGeneration) {");
  const code = section("type DirectTurnCancellationProof", "/** Direct turns refused at a submission")
    + section("const retiredProviderTurns = new RetiredTurnRegistry();", "function directTurnClaimIsCurrent(")
    + section("class DirectTurnSetupCancelled", "const isMemoryContextRevoked")
    + section("function directTurnRejectionOwner(", "type DirectRejectionOwner")
    + section("function clearDirectTurnDispatch(", "/** The browser is an optional tool")
    + section("async function interruptDirectThread(", "/** Provider turns whose direct run a Stop released")
    + section("const releasedStoppedTurns=new PendingTurnKeys();", "/** One visible notice per retained generation")
    + section("/** One visible notice per retained generation", "function unconfirmedDirectStop")
    + section("function terminalDirectContext(", "const foldRuntimeEvent")
    + section("directRuns.onReleased =", "// Owner first (owner-first.ts)")
    + `\n
retireStoppedDirectGeneration = retirementSpy(retireStoppedDirectGeneration);
return { retireHelper: retireStoppedDirectGeneration, owner: directTurnRejectionOwner, stop: interruptDirectThread, cancel: cancelDirectTurnDispatch,
      take: takeDirectTurnCancellationProof, remember: rememberDirectTurnCancellationProof,
      proofs: directTurnCancellationProofs,
      routing: turnId => ({ quarantined: pendingCancelledProviderHandshakes.has(threadId), retired: retiredProviderTurns.has(turnId) }),
      retire: admitted => retireStoppedDirectGeneration(run, bot.id, threadId, admitted.rejectionOwner.sameConversationGeneration),
      dispatch: async (started, cancelled) => { const dispatchClaimId = run.generation;
        const dispatch = await guardTurnDispatch(started, cancelled, async accepted => {
          ${cleanupCode}
        }, accepted => {
          ${acceptCode}
        });
        ${cancelledCode}
        ${source.match(/^      directRuns.accepted\(run,dispatch.value.turnId\);$/m)?.[0] ?? ''}
        clearDirectTurnDispatch(threadId, run.generation);
        return dispatch;
      },
      fold: event => {
        ${section("  if (shouldIgnoreProviderEvent(event)) return;\n  const attemptRun =", "\n")}
        const executionEvent = event, prepared = undefined;
        ${section('      const { threadRun, directRun, releasedStop } = terminalDirectContext(executionEvent);', '      const terminal = prepared')}
        const toolStartedThisTurn = false;
        ${section('        const decideOwedNone=()=>', '        const routineReportThread =')}
        settleDirect();
      },
      cleanup: async (accepted) => {
        ${cleanupCode}
      },
      settle: async (admitted, opts = {}) => { const dispatchClaimId = run.generation; const e = new DirectTurnSetupCancelled('stopped'); ${catchCode} } };`;
  const make = new Function("ports", `with (ports) { ${stripTypeScriptTypes(`function build() { ${code} }`)} return build(); }`);
  const implementation = make(ports);
  const admitted = { rejectionOwner: implementation.owner(run, task), reported: false };
  return {
    ...ports, resources, admitted, stopped, retireHelper: implementation.retireHelper, take: implementation.take, remember: implementation.remember, proofs: implementation.proofs, cleanup: implementation.cleanup, fold: implementation.fold, send: implementation.dispatch, routing: (turnId: string) => implementation.routing(turnId), retire: () => implementation.retire(admitted),
    task: () => task,
    replaceConversation: () => { task = { busy: true }; },
    dispatch: () => {
      directRuns.dispatch(run);
      directTurnDispatchClaims.get(threadId)!.phase = "dispatching";
    },
    cancel: () => implementation.cancel(bot.id, threadId),
    stop: () => implementation.stop(bot.id, threadId),
    settle: (onDispatchError?: () => void) => implementation.settle(admitted, { onDispatchError }),
  };
}

it("W1: retires a stopped dispatching setup with proven zero submission and keeps rejection authority off", async () => {
  const f = fixture();
  f.dispatch(); f.cancel();
  expect(f.directRuns.get(f.threadId)?.phase).toBe("stopping");
  expect(f.run.phase).toBe("setup");
  expect(f.directTurnDispatchClaims.size).toBe(0);
  expect(f.proofs.get(f.run.generation)?.get(f.run.generation)).toMatchObject({ phase: "dispatching", canRetry: true });
  await f.settle();
  expect(f.endTurnTrace).not.toHaveBeenCalled();
  expect(f.store.appendMessage).not.toHaveBeenCalled();
  expect(f.instance.adapter.sendTurn).not.toHaveBeenCalled();
  expect(f.task().busy).toBe(false);
  expect(f.directRuns.get(f.threadId)).toBeUndefined();
  expect(f.admitted.rejectionOwner.current()).toBe(false);
  expect(f.take(f.run.generation, f.run.generation)).toBeUndefined();
  expect(f.proofs.size).toBe(0);
  expect(f.drainQueuedSends).toHaveBeenCalledTimes(1);
  expect(f.ledgerLease.completed).toHaveBeenCalledTimes(1);
  expect(f.admittedLedgerLeases.has(f.run.generation)).toBe(false);
  expect(f.closeTurnLineage).toHaveBeenCalledTimes(1);
  expect(f.directRuns.admit(f.bot.id, f.threadId, {})).toMatchObject({ phase: "setup" });
});

it("W2: late cancelled setup settlement leaves a successor generation running and busy", async () => {
  const f = fixture();
  f.dispatch(); f.cancel(); await f.settle();
  const next = f.directRuns.admit(f.bot.id, f.threadId, {}, f.resources);
  f.task().busy = true;
  f.directRuns.dispatch(next); f.directRuns.accepted(next, "successor-turn");
  await f.settle();
  expect(f.directRuns.get(f.threadId)).toMatchObject({ generation: next.generation, phase: "running" });
  expect(f.task().busy).toBe(true);
  expect(f.directRuns.heldBy(next)).toEqual(f.resources);
  expect(f.take(f.run.generation, f.run.generation)).toBeUndefined();
});

it.each(["conversation", "generation"])("W3: callback changes the %s before retirement; current leases and busy remain untouched", async change => {
  const f = fixture();
  f.dispatch(); f.cancel();
  await f.settle(() => {
    if (change === "conversation") f.replaceConversation();
    else f.directConversationGenerations.set(f.task(), "newer-generation");
  });
  expect(f.directRuns.current(f.run)).toBe(true);
  expect(f.task().busy).toBe(true);
  expect(f.directRuns.heldBy(f.run)).toEqual(f.resources);
  expect(f.replySpeakerTurns.ended).not.toHaveBeenCalled();
  expect(f.proofs.size).toBe(0);
});

it.each(["provider", "empty-provider", "unknown-submission", "unknown-claim", "foreign-claim", "frozen-false", "catch-false"])("W4: %s with unconfirmed close retains folder, computer and browser leases", async state => {
  const f = fixture();
  f.dispatch();
  if (state === "provider" || state === "empty-provider") f.directRuns.accepted(f.run, state === "provider" ? "provider-turn" : "");
  if (state === "frozen-false") Object.defineProperty(f.submissionBoundary, "canRetry", { configurable: true, value: false });
  if (state === "unknown-submission") f.submissionBoundary.invoke(() => {});
  if (state === "unknown-claim") f.directTurnDispatchClaims.clear();
  if (state === "foreign-claim") f.directTurnDispatchClaims.get(f.threadId)!.id = "foreign-generation";
  f.stopped.mockResolvedValue({ closeConfirmed: false });
  await expect(f.stop()).rejects.toThrow("unconfirmed");
  if (state === "frozen-false" || state === "catch-false") Object.defineProperty(f.submissionBoundary, "canRetry", { value: state === "frozen-false" });
  await f.settle();
  expect(f.directRuns.heldBy(f.run)).toEqual(f.resources);
  expect(f.task().busy).toBe(true);
  expect(f.replySpeakerTurns.ended).not.toHaveBeenCalled();
  expect(f.drainQueuedSends).not.toHaveBeenCalled();
});

it("a confirmed Stop releases the folder lease of the released run, an unconfirmed Stop keeps it", async () => {
  const confirmed = fixture();
  await confirmed.stop();
  expect(confirmed.projectTurnLeases.releaseClosed).toHaveBeenCalledWith(confirmed.run.generation);
  const unconfirmed = fixture();
  unconfirmed.stopped.mockResolvedValue({ closeConfirmed: false });
  await expect(unconfirmed.stop()).rejects.toThrow("unconfirmed");
  expect(unconfirmed.projectTurnLeases.releaseClosed).not.toHaveBeenCalled();
});

it("W5: Stop holds an in-flight dispatch until confirmed cleanup after handback", async () => {
  const f = fixture();
  f.dispatch();
  let handback!: (value: { turnId: string }) => void;
  const pending = new Promise<{ turnId: string }>(resolve => { handback = resolve; });
  f.instance.adapter.sendTurn.mockReturnValue(pending);
  const send = guardTurnDispatch<{ turnId: string }>(f.instance.adapter.sendTurn({ threadId: f.threadId }), () => !f.admitted.rejectionOwner.current(), f.cleanup,
    value => f.directRuns.accepted(f.run, value.turnId));
  await f.stop();
  expect(f.task().busy).toBe(true);
  expect(f.directRuns.heldBy(f.run)).toEqual(f.resources);
  expect(() => f.directRuns.admit(f.bot.id, f.threadId, {})).toThrow("already running or stopping");
  handback({ turnId: "stopping-provider" });
  expect(await send).toMatchObject({ cancelled: true });
  await f.settle();
  const next = f.directRuns.admit(f.bot.id, f.threadId, {});
  f.task().busy = true;
  await f.settle();
  expect(f.directRuns.current(next)).toBe(true);
  expect(f.task().busy).toBe(true);
});

it("W5x: an exact close receipt keeps a dispatch awaiting its provider id held", async () => {
  const f = fixture();
  f.dispatch();
  await f.stop();
  expect(f.task().busy).toBe(true);
  expect(f.directRuns.current(f.run)).toBe(true);
  expect(f.directRuns.heldBy(f.run)).toEqual(f.resources);
});

it("W1 order: a synchronous onReleased admission stays busy", async () => {
  const f = fixture();
  f.dispatch(); f.cancel();
  let next: ReturnType<typeof f.directRuns.admit> | undefined;
  const released = f.directRuns.onReleased;
  f.directRuns.onReleased = (...args) => {
    released?.(...args);
    next = f.directRuns.admit(f.bot.id, f.threadId, {});
    f.task().busy = true;
  };
  await f.settle();
  expect(next).toBeDefined();
  expect(f.directRuns.current(next!)).toBe(true);
  expect(f.task().busy).toBe(true);
});

it("proofs are frozen, never overwritten, taken once, and discarded on any release", () => {
  const f = fixture();
  f.dispatch(); f.cancel();
  const proof = f.proofs.get(f.run.generation).get(f.run.generation);
  expect(Object.isFrozen(proof)).toBe(true);
  f.remember({ ...proof, canRetry: false });
  expect(f.take(proof.claimId, proof.generation)).toBe(proof);
  expect(f.take(proof.claimId, proof.generation)).toBeUndefined();
  f.remember(proof);
  f.remember({ ...proof, claimId: "other-claim" });
  f.remember({ ...proof, generation: "other-generation" });
  f.directRuns.release(f.run);
  expect(f.proofs.size).toBe(1);
  expect(f.take(proof.claimId, proof.generation)).toBeUndefined();
  expect(f.take("other-claim", proof.generation)).toBeUndefined();
  expect(f.take(proof.claimId, "other-generation")).toMatchObject({ generation: "other-generation" });
  expect(f.proofs.size).toBe(0);
});

it("setup proof does not need canRetry", async () => {
  const f = fixture();
  Object.defineProperty(f.submissionBoundary, "canRetry", { value: false });
  f.cancel();
  await f.settle();
  expect(f.task().busy).toBe(false);
  expect(f.directRuns.get(f.threadId)).toBeUndefined();
  expect(f.ledgerLease.completed).toHaveBeenCalledTimes(1);
  expect(f.admittedLedgerLeases.has(f.run.generation)).toBe(false);
  expect(f.closeTurnLineage).toHaveBeenCalledTimes(1);
});

it.each(["providerTurnId", "phase", "generation", "botId", "threadId"])("fresh get after idle refuses changed %s", async field => {
  const f = fixture();
  f.dispatch(); f.cancel();
  const live = f.directRuns.get(f.threadId)!;
  f.store.setTaskActivity.mockImplementation(() => {
    f.task().busy = false;
    vi.spyOn(f.directRuns, "get").mockReturnValue({ ...live, [field]: field === "phase" ? "running" : "changed" });
  });
  await f.settle();
  expect(f.directRuns.current(f.run)).toBe(true);
  expect(f.directRuns.heldBy(f.run)).toEqual(f.resources);
  expect(f.replySpeakerTurns.ended).not.toHaveBeenCalled();
  expect(f.ledgerLease.completed).not.toHaveBeenCalled();
  expect(f.admittedLedgerLeases.has(f.run.generation)).toBe(true);
  expect(f.closeTurnLineage).not.toHaveBeenCalled();
});

it("W3: late settlement leaves a replacement conversation's run and busy bit untouched", async () => {
  const f = fixture();
  f.dispatch(); f.cancel(); await f.settle();
  f.replaceConversation();
  const next = f.directRuns.admit(f.bot.id, f.threadId, {}, f.resources);
  f.directRuns.dispatch(next);
  f.directRuns.accepted(next, "replacement-turn");
  await f.settle();
  expect(f.directRuns.current(next)).toBe(true);
  expect(f.task().busy).toBe(true);
  expect(f.directRuns.heldBy(next)).toEqual(f.resources);
});


it.each(["confirmed", "unconfirmed", "unconfirmed-no-close", "missing", "rejected"])("G17: exact-turn %s teardown after a void interrupt", async state => {
  const f = fixture();
  f.dispatch();
  f.submissionBoundary.invoke(() => {});
  f.cancel();
  expect(f.proofs.get(f.run.generation)?.get(f.run.generation)?.canRetry).toBe(false);
  f.stopped.mockResolvedValue(undefined as any);
  let closed!: (proof: { closeConfirmed: boolean }) => void;
  f.instance.adapter.awaitTurnTeardown.mockImplementation(() => new Promise(resolve => { closed = resolve; }));
  if (state === "missing") f.instance.adapter.awaitTurnTeardown = undefined as any;
  if (state === "rejected") f.instance.adapter.awaitTurnTeardown.mockRejectedValue(new Error("teardown failed"));
  let confirmLateClose!: () => void;
  const lateClose = state === "unconfirmed" ? new Promise<void>(resolve => { confirmLateClose = resolve; }) : undefined;
  if (lateClose) Object.assign(f.instance.adapter, { awaitTurnClose: vi.fn(() => lateClose) });
  const cleanup = f.cleanup({ turnId: "stopping-provider" });
  const outcome = cleanup.then(() => undefined, (error: Error) => error);
  if (state === "confirmed" || state.startsWith("unconfirmed")) {
    await expect.poll(() => f.instance.adapter.awaitTurnTeardown.mock.calls.length).toBe(1);
    expect(f.instance.adapter.awaitTurnTeardown).toHaveBeenCalledWith(f.threadId, "stopping-provider");
    expect(f.task().busy).toBe(true);
    expect(f.directRuns.heldBy(f.run)).toEqual(f.resources);
    closed({ closeConfirmed: state === "confirmed" });
  }
  const error = await outcome;
  if (state === "confirmed") expect(error).toBeUndefined();
  else expect(error).toBeInstanceOf(Error);
  await f.settle();
  expect(f.ledgerLease.completed).toHaveBeenCalledTimes(state === "confirmed" ? 1 : 0);
  expect(f.admittedLedgerLeases.has(f.run.generation)).toBe(state !== "confirmed");
  expect(f.closeTurnLineage).toHaveBeenCalledTimes(state === "confirmed" ? 1 : 0);
  expect(f.task().busy).toBe(state !== "confirmed");
  expect(f.directRuns.heldBy(f.run)).toEqual(state === "confirmed" ? [] : f.resources);
  expect(f.store.appendMessage.mock.calls).toEqual(state === "confirmed" ? [] : [
    [f.threadId, { role: "bot", kind: "activity", tool: { name: PROVIDER_STOP_UNCONFIRMED_LINE, ok: false } }],
  ]);
  expect(f.endTurnTrace).not.toHaveBeenCalled();
  if (state !== "confirmed") {
    expect(f.retireHelper).not.toHaveBeenCalled();
    expect(f.drainQueuedSends).not.toHaveBeenCalled();
  }
  if (lateClose) {
    confirmLateClose();
    await lateClose;
    expect(f.task().busy).toBe(false);
    expect(f.directRuns.heldBy(f.run)).toEqual([]);
    expect(f.ledgerLease.completed).toHaveBeenCalledTimes(1);
    expect(f.admittedLedgerLeases.has(f.run.generation)).toBe(false);
    expect(f.closeTurnLineage).toHaveBeenCalledTimes(1);
    expect(f.projectTurnLeases.releaseClosed).toHaveBeenCalledWith(f.run.generation);
    expect(f.drainQueuedSends).toHaveBeenCalledTimes(1);
    expect(f.store.appendMessage.mock.calls).toEqual([
      [f.threadId, { role: "bot", kind: "activity", tool: { name: PROVIDER_STOP_UNCONFIRMED_LINE, ok: false } }],
      [f.threadId, { role: "bot", kind: "activity", tool: { name: ENGINE_CLOSED_LATE_NOTE, ok: true } }],
    ]);
    expect(f.directRuns.admit(f.bot.id, f.threadId, {}, f.resources).phase).toBe("setup");
  }
});

it.each(["conversation", "generation", "missing-proof", "provider"])("G17: confirmed teardown still refuses changed %s", async state => {
  const f = fixture();
  f.dispatch();
  f.submissionBoundary.invoke(() => {});
  if (state === "provider") f.directRuns.accepted(f.run, "provider-turn");
  f.cancel();
  await f.cleanup({ turnId: "provider-turn" });
  await f.settle(() => {
    if (state === "conversation") f.replaceConversation();
    if (state === "generation") f.directConversationGenerations.set(f.task(), "newer-generation");
    if (state === "missing-proof") f.proofs.clear();
  });
  expect(f.task().busy).toBe(true);
  expect(f.directRuns.current(f.run)).toBe(true);
  expect(f.directRuns.heldBy(f.run)).toEqual(f.resources);
});

it("G17: confirmed teardown idles before a synchronous successor admission", async () => {
  const f = fixture();
  f.dispatch(); f.submissionBoundary.invoke(() => {}); f.cancel();
  await f.cleanup({ turnId: "provider-turn" });
  let next: ReturnType<typeof f.directRuns.admit> | undefined;
  const released = f.directRuns.onReleased;
  f.directRuns.onReleased = (...args) => {
    released?.(...args);
    next = f.directRuns.admit(f.bot.id, f.threadId, {}, f.resources);
    f.task().busy = true;
  };
  await f.settle();
  expect(next).toBeDefined();
  expect(f.directRuns.current(next!)).toBe(true);
  expect(f.task().busy).toBe(true);
  expect(f.proofs.size).toBe(0);
  await f.settle();
  expect(f.directRuns.current(next!)).toBe(true);
  expect(f.task().busy).toBe(true);
});

it("W10: thenable job ordering puts Stop between guard acceptance and the outer continuation", async () => {
  const f = fixture();
  f.dispatch();
  f.submissionBoundary.invoke(() => {});
  f.stopped.mockResolvedValue(undefined as any);
  f.instance.adapter.awaitTurnTeardown.mockResolvedValue({ closeConfirmed: true });
  const order: string[] = [];
  let stop!: Promise<void>;
  let stopRun: ReturnType<typeof f.directRuns.get>;
  const started = { then(resolve: (value: { turnId: string }) => void) {
    resolve({ turnId: "gap-turn" });
    queueMicrotask(() => { order.push("stop"); stopRun = f.directRuns.get(f.threadId); stop = f.stop(); });
  } };
  try {
    await f.send(started, () => { order.push("cancelled-check"); return !f.admitted.rejectionOwner.current(); });
    order.push("outer");
  } catch (error) { expect((error as Error).message).toBe("turn stopped during provider setup"); await f.settle(); }
  await stop;
  expect(order).toEqual(["cancelled-check", "stop", "outer"]);
  expect(stopRun).toMatchObject({ phase: "running", providerTurnId: "gap-turn" });
  expect(f.routing("gap-turn")).toEqual({ quarantined: false, retired: false });
  // Production matching, releaseDirect and settleDirect, using the exact provider completion.
  f.fold({ type: "turn.completed", threadId: f.threadId, turnId: "gap-turn", providerInstanceId: "fixture", ok: true, stopReason: "cancelled" });
  await Promise.resolve(); await Promise.resolve();
  expect(f.task().busy, JSON.stringify({ ...f.routing("gap-turn"), run: f.directRuns.get(f.threadId), busy: f.task().busy, leases: f.directRuns.heldBy(f.run) })).toBe(false);
  expect(f.instance.adapter.awaitTurnTeardown).toHaveBeenCalledWith(f.threadId, "gap-turn");
  expect(f.directRuns.current(f.run)).toBe(false);
  expect(f.directRuns.heldBy(f.run)).toEqual([]);
  expect(f.store.appendMessage).not.toHaveBeenCalled();
  expect(f.directRuns.admit(f.bot.id, f.threadId, {})).toMatchObject({ phase: "setup" });
});

it("W10q: a Stop before any provider id keeps the pre-id quarantine and the fold does not release", async () => {
  const f = fixture();
  f.dispatch();
  f.submissionBoundary.invoke(() => {});
  f.stopped.mockResolvedValue(undefined as any);
  f.instance.adapter.awaitTurnTeardown.mockResolvedValue({ closeConfirmed: true });
  let resolve!: (value: { turnId: string }) => void;
  const started = new Promise<{ turnId: string }>(r => { resolve = r; });
  const sent = f.send(started, () => !f.admitted.rejectionOwner.current());
  await f.stop();
  expect(f.routing("pre-id-turn").quarantined).toBe(true);
  f.fold({ type: "turn.completed", threadId: f.threadId, turnId: "pre-id-turn", providerInstanceId: "fixture", ok: true, stopReason: "cancelled" });
  await Promise.resolve(); await Promise.resolve();
  expect(f.routing("pre-id-turn").retired).toBe(true);
  expect(f.task().busy).toBe(true);
  expect(f.directRuns.current(f.run)).toBe(true);
  resolve({ turnId: "pre-id-turn" });
  await sent.catch(() => {});
  await f.settle();
  const next = f.directRuns.admit(f.bot.id, f.threadId, {}, f.resources);
  f.task().busy = true;
  f.fold({ type: "turn.completed", threadId: f.threadId, turnId: "pre-id-turn", providerInstanceId: "fixture", ok: true, stopReason: "end_turn" });
  await Promise.resolve(); await Promise.resolve();
  expect(f.directRuns.current(next)).toBe(true);
  expect(f.task().busy).toBe(true);
});

it("W10e: an empty accepted provider id stays quarantined and busy", async () => {
  const f = fixture();
  f.dispatch();
  f.submissionBoundary.invoke(() => {});
  f.stopped.mockResolvedValue(undefined as any);
  f.instance.adapter.awaitTurnTeardown.mockResolvedValue({ closeConfirmed: true });
  let stop!: Promise<void>;
  const started = { then(resolve: (value: { turnId: string }) => void) {
    resolve({ turnId: "" });
    queueMicrotask(() => { stop = f.stop(); });
  } };
  try { await f.send(started, () => !f.admitted.rejectionOwner.current()); }
  catch { /* the accept fence may refuse an empty id */ }
  await stop;
  expect(f.routing("").quarantined).toBe(true);
  expect(f.task().busy).toBe(true);
});

it("W14: a setup cancel that is not an owner Stop idles the thread and drains once", async () => {
  const f = fixture();
  f.dispatch();
  expect(f.admitted.rejectionOwner.current()).toBe(true);
  expect(f.task().busy).toBe(true);
  await f.settle();
  expect(f.task().busy).toBe(false);
  expect(f.retireHelper).not.toHaveBeenCalled();
  expect(f.browserSetup.drain).toHaveBeenCalledTimes(1);
  expect(f.browserExtension.approvals.drain).toHaveBeenCalledTimes(1);
  expect(f.retryDelegationsWaitingOn).toHaveBeenCalledTimes(1);
  expect(f.drainQueuedSends).toHaveBeenCalledTimes(1);
  expect(f.drainConnectorResumes).toHaveBeenCalledTimes(1);
  expect(f.drainSecretResumes).toHaveBeenCalledTimes(1);
  expect(f.drainTeamIncidents).toHaveBeenCalledTimes(1);
});

it("W14b: an owner-Stop setup cancel retires through the helper and drains exactly once", async () => {
  const f = fixture();
  f.dispatch(); f.cancel();
  await f.settle();
  expect(f.task().busy).toBe(false);
  expect(f.directRuns.current(f.run)).toBe(false);
  expect(f.drainQueuedSends).toHaveBeenCalledTimes(1);
  expect(f.retryDelegationsWaitingOn).toHaveBeenCalledTimes(1);
  expect(f.ledgerLease.completed).toHaveBeenCalledTimes(1);
  expect(f.admittedLedgerLeases.has(f.run.generation)).toBe(false);
  expect(f.closeTurnLineage).toHaveBeenCalledTimes(1);
});

it("retirement is synchronous, drains once, and refuses an already released or replaced owner", () => {
  const f = fixture();
  f.dispatch(); f.cancel();
  const retired = f.retire();
  expect(f.directRuns.current(f.run)).toBe(false);
  expect(retired).toBe(true);
  expect(f.task().busy).toBe(false);
  expect(f.retire()).toBe(false);
  expect(f.drainQueuedSends).toHaveBeenCalledTimes(1);
  const next = f.directRuns.admit(f.bot.id, f.threadId, {}, f.resources);
  f.task().busy = true;
  expect(f.retire()).toBe(false);
  expect(f.task().busy).toBe(true);
  expect(f.directRuns.current(next)).toBe(true);
  expect(f.drainQueuedSends).toHaveBeenCalledTimes(1);
});

it.each(["conversation", "generation"])("the release helper independently refuses a changed %s", state => {
  const f = fixture();
  f.dispatch(); f.cancel();
  if (state === "conversation") f.replaceConversation();
  else f.directConversationGenerations.set(f.task(), "newer-generation");
  expect(f.retire()).toBe(false);
  expect(f.task().busy).toBe(true);
  expect(f.directRuns.heldBy(f.run)).toEqual(f.resources);
  expect(f.drainQueuedSends).not.toHaveBeenCalled();
});
