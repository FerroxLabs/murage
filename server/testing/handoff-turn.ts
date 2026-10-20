// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test support for the hand-off dispatch (server/handoff-dispatch.ts). The server's startTurn is replaced by a fake that does what the real one does for a
// hand-off: it writes the prompt under the run's key and records the start in the same commit (the run's `within`), or, when the prompt is already in the
// conversation, records the held re-dispatch. The fake then calls the test's `runTarget`, which sees the same arguments the old drain handed its runner.
import type { ExecutionAudience } from "../work-admission.ts";
import type { CoordinationTrace } from "../coordination-budget.ts";
import type { RoutinePeerSource } from "../routine-permissions.ts";
import type { CommsBus } from "../comms-visibility.ts";
import type { ApprovalBus } from "../peer-approval.ts";
import { audienceTask } from "../execution-audience.ts";
import { threadHumanPrincipal } from "../human-principals.ts";
import { storedMessage } from "../message-db.ts";
import { getOrCreateChannel } from "../comms-visibility.ts";
import { drainDelegations as drainReal, handoffRow, onOwedHandoffReply } from "../delegations.ts";
import { replayOwedReply } from "../handoff-reply.ts";
import type { Store } from "../store.ts";
import type { DatabaseSync } from "node:sqlite";
import { database } from "../database.ts";
import { configureHandoffDispatch, dispatchHandoff, type HandoffHost, type HandoffRun, type HandoffTurnOptions } from "../handoff-dispatch.ts";
import type { GroupRecord } from "../store.ts";
import type { HeldDelegation } from "../delegations.ts";

export type TestRunTarget = (
  toBotId: string, message: string, commsDepth: number, sourceThreadId: string, channel: GroupRecord | undefined, taskId: string, fromBotId: string,
  eventId?: string, coordination?: CoordinationTrace, notOwnerAudience?: boolean, unattended?: boolean, executionAudience?: ExecutionAudience, routineAuthority?: RoutinePeerSource,
) => void | Promise<void>;

/** The run each hand-off's turn was last started with, by hand-off id: what a test's fake provider uses to record a submit or an acceptance. */
const runs = new Map<string, HandoffRun>();
export function rememberRun(run: HandoffRun): void { runs.set(run.id, run); }
export function runOf(taskId: string): HandoffRun {
  const run = runs.get(taskId);
  if (!run) throw new Error(`no turn was started for hand-off ${taskId}`);
  return run;
}
/** What startTurn does for a hand-off's prompt in the conversation it runs in. */
export function writePrompt(bus: CommsBus, run: HandoffRun, threadId: string, text = "prompt"): void {
  if (storedMessage(threadId, run.turnKey)) { run.start(threadId, { held: true }); return; }
  bus.store.appendMessage(threadId, { role: "user", kind: "text", text }, run.turnKey, run.within(threadId, () => { /* the start is recorded by the stamp */ }));
}

/** The server's writer of the line a receipt owes its source conversation (index.ts onOwedHandoffReply), registered with every fake host as the server
 * registers it at every start: a boot receipt that owes a line (a restart's "interrupted") settles here as it does there, never through a bare status. */
function useOwedReplyWriter(bus: CommsBus): void {
  onOwedHandoffReply((receipt) => replayOwedReply(bus.store as unknown as Store, receipt));
}
export const heldNotices: HeldDelegation[] = [];
export interface FakeHostOptions { stamp?: boolean; refuse?: (botId: string) => Error | undefined }
export function fakeHost(bus: CommsBus, runTarget: TestRunTarget, options: FakeHostOptions = {}): HandoffHost {
  useOwedReplyWriter(bus);
  const stamp = options.stamp ?? true;
  return {
    startTurn: async (botId: string, text: string, turn: HandoffTurnOptions) => {
      const run = turn.delegationRun;
      runs.set(run.id, run);
      const refused = options.refuse?.(botId);
      if (refused) throw refused;
      const fromBotId = handoffRow(run.id)?.from_bot_id ?? "";
      const sender = bus.store.bot(fromBotId), target = bus.store.bot(botId), source = String(turn.chainRootThreadId ?? "");
      let channel: GroupRecord | undefined;
      try { channel = sender && target ? getOrCreateChannel(bus.store, sender, target, source) : undefined; } catch { channel = undefined; }
      await runTarget(
        botId, text, turn.commsDepth, source, channel, run.id, fromBotId,
        turn.eventId as string | undefined, turn.coordination as CoordinationTrace | undefined, turn.chainNotOwner === true, turn.unattended === true,
        undefined, turn.routineAuthority as RoutinePeerSource | undefined,
      );
      // the real startTurn records the start before it returns; a fake that throws (the turn was refused) leaves the hand-off unstarted
      if (stamp) writePrompt(bus, run, turn.threadId, text);
    },
    destinationFor: ({ toBotId, sourceThreadId, executionAudience }) => audienceTask(bus.store, toBotId, threadHumanPrincipal(sourceThreadId), executionAudience ?? null)?.threadId,
    reserveSlot: () => () => {},
    watch: { begin: () => {}, end: () => {} },
    peerOptions: (_peer, _source, _from, queued) => (queued ? { routineAuthority: queued } : {}),
    isUnattended: () => false,
    noticeHeld: (held) => { heldNotices.push(held); },
  };
}
/** Attaches the fake server to the dispatch and returns the drain with the old four-argument shape. */
export function useFakeTurns(bus: CommsBus, approvalBus: ApprovalBus, runTarget: TestRunTarget, options: FakeHostOptions = {}): void {
  configureHandoffDispatch(fakeHost(bus, runTarget, options), { bus, approvalBus });
}
/** drainDelegations as the tests have always called it: the last argument is the fake provider's runner. The fake records the hand-off's start itself. */
export function drainDelegations(bus: CommsBus, approvalBus: ApprovalBus, threadId: string, runTarget: TestRunTarget): void {
  useFakeTurns(bus, approvalBus, runTarget);
  drainReal(bus, approvalBus, threadId);
}
/** The same, for a fake provider that records the start (and the submit and the acceptance) itself, as the real startTurn does. */
export function drainDelegationsRaw(bus: CommsBus, approvalBus: ApprovalBus, threadId: string, runTarget: TestRunTarget, hostOverrides: Partial<HandoffHost> = {}): void {
  configureHandoffDispatch({ ...fakeHost(bus, runTarget, { stamp: false }), ...hostOverrides }, { bus, approvalBus });
  drainReal(bus, approvalBus, threadId);
}

/** Starts a queued hand-off's turn the way the server does: through the dispatch, with a fake provider that writes the prompt and records the start in one commit
 * (and, when asked, the submit and the acceptance), then returns. The start is recorded when this returns. A start the store refuses is thrown, as startTurn would
 * reject. For a test that needs a row in a started state without a drain around it. */
export async function startLikeIndex(bus: CommsBus, approvalBus: ApprovalBus, id: string, steps: { thread?: string; submit?: boolean; accept?: string } = {}): Promise<void> {
  let failure: unknown;
  const base = fakeHost(bus, () => {}, { stamp: false });
  configureHandoffDispatch({
    ...base,
    startTurn: async (_botId: string, text: string, turn: HandoffTurnOptions) => {
      const run = turn.delegationRun;
      runs.set(run.id, run);
      try {
        writePrompt(bus, run, steps.thread ?? turn.threadId, text);
        if (steps.submit || steps.accept) run.submitted();
        if (steps.accept) run.accepted(steps.accept);
      } catch (error) { failure = error; throw error; }
    },
  }, { bus, approvalBus });
  try { await dispatchHandoff(id, { bus, approvalBus }); } catch { /* a failure of the dispatch's own follow-up is the test's to see in the rows */ }
  if (failure) throw failure;
}

/** A row as an earlier process left it started (a test fixture: the dispatch is the only code that starts a hand-off, so a fixture writes the state itself). */
/** A request marked running the way the dispatch marks a hand-off's own request (queued to running). A fixture cannot hold the dispatch's token (only the dispatcher
 * makes one), so it writes the state itself; the real function refuses a request that has a hand-off row. */
export function dispatchHandoffRequest(db: DatabaseSync, id: string, input: { now: number; targetThreadId?: string }): boolean {
  return Number(db.prepare("UPDATE room_requests SET state='running', dispatched_at=?, refusal=NULL, target_thread_id=COALESCE(?, target_thread_id) WHERE id=? AND state='queued'").run(input.now, input.targetThreadId ?? null, id).changes) === 1;
}
export function forceStarted(id: string, threadId: string): void {
  const db = database();
  const row = db.prepare("SELECT origin FROM pending_delegations WHERE id=?").get(id) as { origin: string } | undefined;
  const now = Date.now();
  db.prepare("UPDATE pending_delegations SET phase='started', started_at=?, target_thread_id=?, retry_at=NULL, start_attempts=COALESCE(start_attempts,0)+1 WHERE id=?").run(now, threadId, id);
  if (row?.origin === "room") dispatchHandoffRequest(db, id, { now, targetThreadId: threadId });
}
