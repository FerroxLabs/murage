// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fixtures for the hand-off dispatch tests: an owner or room world (one bot hands to another) and a shared-work world (a team's bot hands work to a shared
// teammate), each with the server's side of the dispatch replaced by a fake provider that records every turn it is started for.
import { database } from "../database.ts";
import type { CommsBus } from "../comms-visibility.ts";
import { configureHandoffDispatch, configureSharedHandoffs, type CouldNotStart, type HandoffTurnOptions } from "../handoff-dispatch.ts";
import { insertRoomRequest, markRequestDispatched } from "../room-requests.ts";
import { configureSharedDrain, enqueueSharedWork } from "../shared-work.ts";
import { delegationTurnKey } from "../pending-delegations-schema.ts";
import { createWorkAdmission } from "../work-admission.ts";
import { Store } from "../store.ts";
import { audienceTask } from "../execution-audience.ts";
import { threadHumanPrincipal } from "../human-principals.ts";
import { fakeHost, rememberRun, writePrompt } from "./handoff-turn.ts";

export const LINEAGE = (thread: string) => ({ rootThreadId: thread, origin: "desktop" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false });

export interface Knobs {
  /** the conversations a fake target cannot take a hand-off in right now (the dispatch asks about the STORED one) */
  busyThreads: Set<string>;
  /** the admission capacity of the coordination layer */
  capacity: boolean;
  /** where a hand-off with no stored destination is resolved to (the target's selected conversation) */
  destination: string | undefined;
  /** a hand-off id whose turn the fake provider also marks submitted */
  submit: Set<string>;
  /** runs just before the fake provider records a start (a deletion landing in the last instant) */
  beforeStamp: (() => void) | undefined;
  /** when set, the fake provider refuses to start the turn with this message (no such engine), before it is handed the prompt */
  failStart?: string;
  /** the refusal code the failed start carries (Murage's own refusals do: not_reachable, archived, ...) */
  failStartCode?: string;
}

export type Origin = "owner" | "room";
/** An owner (or room) world: `from` hands to `target`, over a bus whose busy and capacity questions the test controls. */
export function ownerWorld(origin: Origin = "owner") {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const from = store.createBot(), target = store.createBot();
  store.patchBot(target.id, { name: "Helper" });
  const knobs: Knobs = { busyThreads: new Set(), capacity: true, destination: undefined, submit: new Set(), beforeStamp: undefined };
  let extra: Partial<CommsBus> = {};
  if (origin === "room") {
    insertRoomRequest(database(), { id: "root", groupId: "g", verb: "owner_send", fromKind: "owner", toBotId: from.id, targetThreadId: from.threadId, admissionKey: "root", now: 1, lineage: LINEAGE(from.threadId) });
    markRequestDispatched(database(), "root", { now: 1 });
    extra = { prepareDelegation: (fromBotId: string, to: string, source: string, _m: string, id: string) => {
      insertRoomRequest(database(), { id, groupId: "g", verb: "ask", fromKind: "bot", fromBotId, toBotId: to, parentId: "root", returnThreadId: source, returnBotId: fromBotId, admissionKey: `ask:delegation:${id}`, now: 2 });
      return "room" as const;
    } };
  }
  const bus = { store, broadcast: () => {}, canDispatch: () => knobs.capacity, canStartHandoff: (_bot: string, _source: string, destination?: string) => !(destination && knobs.busyThreads.has(destination)), ...extra } as unknown as CommsBus;
  const approvalBus = { store, broadcast: () => {} } as never;
  const turns: Array<{ id: string; thread: string; handoffOf?: unknown }> = [];
  const held: Array<{ id: string; text: string }> = [];
  const couldNotStart: CouldNotStart[] = [];
  const attach = () => configureHandoffDispatch({
    ...fakeHost(bus, () => {}, { stamp: false }),
    destinationFor: ({ toBotId, sourceThreadId, executionAudience }) => knobs.destination ?? audienceTask(store, toBotId, threadHumanPrincipal(sourceThreadId), executionAudience ?? null)?.threadId,
    startTurn: async (_botId: string, text: string, turn: HandoffTurnOptions) => {
      if (knobs.failStart) throw Object.assign(new Error(knobs.failStart), knobs.failStartCode ? { code: knobs.failStartCode } : {});
      const run = turn.delegationRun;
      rememberRun(run);
      knobs.beforeStamp?.();
      writePrompt(bus, run, turn.threadId, text);
      turns.push({ id: run.id, thread: turn.threadId, ...(turn.handoffOf ? { handoffOf: turn.handoffOf } : {}) });
      if (knobs.submit.has(run.id)) run.submitted();
    },
    noticeHeld: (notice) => { held.push({ id: notice.id, text: notice.text }); },
    couldNotStart: (info) => { couldNotStart.push(info); },
  }, { bus, approvalBus });
  attach();
  return { store, from, target, bus, approvalBus, knobs, turns, held, couldNotStart, attach };
}
export type OwnerWorld = ReturnType<typeof ownerWorld>;

/** A shared-work world: Iris is shared with the teams, Sales and Support hand work to her; the fake provider records the turns, a shared run records how a request ended. */
export function sharedWorld() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const iris = store.createBot(); store.patchBot(iris.id, { name: "Iris", section: "Design", sharedWith: { mode: "all", teams: [] } });
  const sales = store.createBot(); store.patchBot(sales.id, { name: "Sales", section: "Sales", chiefOfStaff: true });
  const support = store.createBot(); store.patchBot(support.id, { name: "Support", section: "Support", chiefOfStaff: true });
  const knobs: Knobs & { approval: Promise<"allow" | "deny" | "expired" | "cancelled"> | undefined } = { busyThreads: new Set(), capacity: true, destination: undefined, submit: new Set(), beforeStamp: undefined, approval: undefined };
  const started: string[] = [];
  const closed: string[] = [];
  const turns: Array<{ id: string; thread: string }> = [];
  const finished: string[] = [];
  const abandoned: string[] = [];
  const claims: Array<{ release(): void }> = [];
  const admission = createWorkAdmission({ restoreReview: () => false, flags: () => ({ autonomy: true, budgets: false }), threadRunning: () => false, speakingInRoom: () => false, directThreads: () => 0, maxThreads: 3, installCardCap: 3,
    rootCounters: () => ({ wakes: 0, workMs: 0 }), askWouldDeadlock: () => false, reachable: () => true, dependencyOpen: () => false, claimWriterRoot: () => () => {}, now: () => 10 });
  const open = { value: true };
  configureSharedDrain({ admission, open: () => open.value, now: () => 10, changed: () => {}, closed: (row, line) => { closed.push(`${row.id}:${line}`); }, start: (row, claim) => { started.push(row.id); claim.release(); } });
  const handoff = (id: string, sender = sales) => {
    const inserted = enqueueSharedWork(store, { fromBotId: sender.id, sourceThreadId: sender.threadId, toBotId: iris.id, message: "shared hand-off", admissionKey: `ask:delegation:${id}`, ownerAudience: true, now: 1, id });
    if (!inserted.ok) throw new Error(inserted.code);
    database().prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key, target_thread_id) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(id, sender.threadId, iris.id, sender.id, "fresh", null, JSON.stringify({ message: "shared hand-off", depth: 0, attempts: 0 }), "shared", delegationTurnKey(id), inserted.request.targetThreadId);
    return inserted.request;
  };
  const bus = { store, broadcast: () => {}, canStartHandoff: (_bot: string, _source: string, destination?: string) => !(destination && knobs.busyThreads.has(destination)),
    // a hand-off Send again queues in this world is shared work too
    prepareDelegation: (fromBotId: string, to: string, source: string, message: string, id: string) => {
      const sender = store.bot(fromBotId)!;
      const inserted = enqueueSharedWork(store, { fromBotId, sourceThreadId: source, toBotId: to, message, admissionKey: `ask:delegation:${id}`, ownerAudience: true, now: 1, id });
      if (!inserted.ok) throw new Error(inserted.code);
      void sender;
      return "shared" as const;
    } } as unknown as CommsBus;
  const approvalBus = { store, broadcast: () => {} } as never;
  const attach = () => {
    configureHandoffDispatch({
      ...fakeHost(bus, () => {}, { stamp: false }),
      startTurn: async (_botId: string, text: string, turn: HandoffTurnOptions) => {
        const run = turn.delegationRun;
        rememberRun(run);
        knobs.beforeStamp?.();
        writePrompt(bus, run, turn.threadId, text);
        turns.push({ id: run.id, thread: turn.threadId });
        if (knobs.submit.has(run.id)) run.submitted();
      },
    }, { bus, approvalBus });
    configureSharedHandoffs({
      begin: (request, claim) => { if (claim) claims.push(claim); return { sharedWorkRun: {}, finish: (_event, note) => { finished.push(`${request.id}:${note}`); claim?.release(); }, abandon: () => { abandoned.push(request.id); claim?.release(); } }; },
      needsApproval: () => knobs.approval !== undefined,
      requestApproval: () => knobs.approval!,
      mirror: () => {},
      turnOptions: () => ({}),
      text: (request) => request.payloadText ?? "",
    });
  };
  attach();
  /** the process dies: what only it held (the arbiter's claims) goes with it */
  const crash = () => { for (const claim of claims.splice(0)) claim.release(); };
  return { store, iris, sales, support, knobs, started, closed, turns, finished, abandoned, handoff, bus, approvalBus, crash, open, attach };
}
export type SharedWorld = ReturnType<typeof sharedWorld>;
