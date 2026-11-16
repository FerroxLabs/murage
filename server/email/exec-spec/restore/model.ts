// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MODEL: the split between what the REDUCER may see (HomeState + HomeEvent) and the trusted ENVIRONMENT (FakeFlux, history recorder,
// scheduler bookkeeping). Astra finding 12: the reducer must never read World.flux or Ghost. toWorld() reassembles the full World only
// for predicates and the printer.

import type {
  Action, Archive, CarryRecord, ArchiveKind, AuthorityId, AuthorityKind, Bot, BotId, DurableWrite, EventId, FluxEvent, FluxInbox, FluxKey, FluxState,
  Ghost, HomeFs, InboxId, KeepMode, LocalDb, OpId, OpsLine, ProcessState, RemoteRequest, RequestId, RestoreRecord, SurfaceRow, TokenId, World,
  FluxInboxState, KeyId, RestoreJobPhase,
} from "./invariants.current.ts";

export interface HomeState { local: LocalDb; carry: CarryRecord | null; fs: HomeFs; proc: ProcessState; surface: SurfaceRow[]; ops: OpsLine[] }

/** FluxMain facts are fixed (fakeflux.ts). The one open switch: the per-account key/inbox listing (F-BACKFILL). */
export interface FluxConfig { listing: "off" | "per_account" }

export interface RequestResult { answer: "ok" | "accepted" | "not_found" | "refused" | "uncertain"; code: string | null; fluxStateSeen: FluxInboxState | null }

/** Harness-only bookkeeping; never given to the reducer. */
export interface Ext {
  cfg: FluxConfig;
  armed: { at: DurableWrite; when: "before" | "after" } | null;
  crashes: number; restores: number; views: number; backups: number; clockJumps: number; fluxCloses: number;
  nextReq: number; nextEvent: number; nextAuth: number; nextArchive: number;
  results: Record<RequestId, RequestResult>;
  emitted: Record<EventId, boolean>; deliveries: Record<EventId, number>;
  /** per inbox: did mail arrive while active (accepted) / while closing (dropped at intake, invisible). */
  mail: Record<InboxId, { accepted: boolean; dropped: boolean }>;
  lastTickMs: number | null; settledInProc: number | null; listingDelivered: boolean;
  /** botHint and DELETE reason supplied by the home when it sent the request (honest: the home knows what it asked). */
  /** archive contents the harness keeps for restore (the invariants Archive has no db field). */
  archiveDbs: Record<string, LocalDb | null>;
  reqMeta: Record<RequestId, { botHint: BotId | null; deleteReason: "owner" | "bot_deleted" }>;
  /** reducer-reported answers that violated the harness consistency check (state != last effect state, etc.). */
  harnessViolations: { name: string; why: string; step: number }[];
  /** r3.4d J2 (recorder only): the step of the owner request that armed the open job (null = a system arm), and how many archive fetches ran. */
  jobReq?: number | null; fetches?: number;
}

/** r3.4d J2: the open job's effective phase (the journal, or the database marks W27 / W28: the same rule as invariants jobOf). */
export const jobPhaseOf = (h: HomeState): RestoreJobPhase | null => {
  const j = h.fs.restoreJob ?? null; if (!j) return null;
  return h.local.preparedJobId === j.id ? "prepared" : h.local.swappedJobId === j.id ? "swapped" : j.phase;
};

export interface Env {
  step: number; nowMs: number; bots: Record<BotId, Bot>; flux: FluxState; archives: Archive[]; ghost: Ghost; ext: Ext;
}

export interface Model { home: HomeState; env: Env }

export function toWorld(m: Model): World {
  const e = m.env;
  return { step: e.step, nowMs: e.nowMs, bots: e.bots, local: m.home.local, carry: m.home.carry, fs: m.home.fs, proc: m.home.proc, flux: e.flux, surface: m.home.surface, archives: e.archives, ops: m.home.ops, ghost: e.ghost };
}

/** Moves = invariants Actions plus the one harness-only move. Predicates see net.listing as { t: "auto.tick" } (asPredicateAction). */
export type Move = Action | { t: "net.listing" } | { t: "auto.guardPoll"; inboxId: InboxId };
export const asPredicateAction = (m: Move): Action => (m.t === "net.listing" || m.t === "auto.guardPoll" ? { t: "auto.tick" } : m);

// ---------- Reducer interface -----------------------------------------------------------------------------------------------------

export type HomeEvent =
  | { e: "boot"; nowMs: number }
  | { e: "bootPrep"; nowMs: number; inject: "none" | "throw" }
  | { e: "emailOn"; nowMs: number }
  | { e: "settle"; nowMs: number }
  | { e: "tick"; nowMs: number }
  | { e: "guardPoll"; nowMs: number; inboxId: InboxId }
  | { e: "applyEvent"; nowMs: number; event: FluxEvent }
  | { e: "answer"; nowMs: number; requestId: RequestId; answer: RequestResult["answer"]; code: string | null; fluxStateSeen: FluxInboxState | null }
  | { e: "listing"; nowMs: number; inboxes: FluxInbox[]; keys: FluxKey[] }
  | { e: "owner"; nowMs: number; action: Action }
  | { e: "backup"; nowMs: number; kind: ArchiveKind }
  // r3.4d J1: the restore job steps that are the reducer's own (arm / capture / abort); `step` = the step the write lands in (journal `at`).
  | { e: "ownerRestore"; nowMs: number; step: number; action: Extract<Action, { t: "owner.restore" }> }
  | { e: "captureOutgoing"; nowMs: number; step: number }
  | { e: "restoreAbort"; nowMs: number; step: number; reason: Extract<Action, { t: "auto.restoreAbort" }>["reason"] }
  // r3.4d J2: swap (own step: stage the incoming DB with swappedJobId W27, then W3), prepare (own step: W4 with preparedJobId W28), clear (carry W24, journal W30), system arm, archive fetch.
  | { e: "restoreSwap"; nowMs: number; step: number; source: RestoreRecord["source"]; archiveId: string; blind: boolean; archiveDb: LocalDb | null; archiveTopLevelNames: string[]; outgoingDb: LocalDb | null }
  | { e: "restorePrepare"; nowMs: number; step: number }
  | { e: "restoreJobClear"; nowMs: number; step: number }
  | { e: "restoreArm"; nowMs: number; step: number; source: RestoreRecord["source"]; archiveId: string }
  | { e: "archiveFetch"; nowMs: number; step: number; archiveId: string; outcome: "verified" | "download_failed"; forOwner: boolean };

export const HOME_EVENT_TYPES = ["boot", "bootPrep", "emailOn", "settle", "tick", "guardPoll", "applyEvent", "answer", "listing", "owner", "backup", "ownerRestore", "captureOutgoing", "restoreAbort", "restoreSwap", "restorePrepare", "restoreJobClear", "restoreArm", "archiveFetch"] as const;

export type SendRequest = Omit<RemoteRequest, "requestId" | "copyOf" | "sentAtStep" | "sentAtMs" | "sentInProcess" | "sentInEpoch" | "flux" | "appliedAtMs" | "answer" | "answerSeen"> & {
  botHint?: BotId | null; deleteReason?: "owner" | "bot_deleted";
};

/** Ordered effects. Durable effects carry the whole home state after the write, so a crash can cut the list anywhere (W1..W22). */
export type Effect =
  | { k: "durable"; write: DurableWrite; after: HomeState }
  | { k: "send"; request: SendRequest }
  | { k: "authorize"; authorityId: AuthorityId; kind: AuthorityKind; tokenId: TokenId | null; botId: BotId | null; inboxId: InboxId | null; keyIds: KeyId[] }
  | { k: "keep"; keepOp: OpId; botId: BotId; inboxId: InboxId | null; mode: KeepMode; authorityId: AuthorityId; phase: "claimed" | "succeeded"; confirmedBy?: { requestId: RequestId; state: FluxInboxState } }
  | { k: "ownerResult"; ok: boolean; code?: string }
  | { k: "archive"; kind: ArchiveKind; topLevelNames: string[]; db: LocalDb | null };

export interface ReduceResult { actions: Effect[]; state: HomeState }

/** Branch coverage hook: the reducer calls ctx.hit("R12-keep-flux-closing") on every branch; ids must be declared in BRANCH_IDS. */
export interface ReduceCtx { hit(id: string): void }
export const NOOP_CTX: ReduceCtx = { hit: () => undefined };

export interface Reducer {
  name: string;
  reduce(state: HomeState, event: HomeEvent, ctx: ReduceCtx): ReduceResult;
  /** Absolute times at which the home wants a tick (durable timers: guard polls, expiries). Used for the fair-recovery clock. */
  wakeups?(state: HomeState, nowMs: number): number[];
  /** The surface the owner sees before any step (seed time). Optional: a reducer without it starts with an empty surface. */
  renderSeedSurface?(state: HomeState, nowMs: number): HomeState["surface"];
}
