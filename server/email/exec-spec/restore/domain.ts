// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RESTORE-PARK model checker: FINITE DOMAINS and why they cover the behaviour.
//
// The checker explores a closed system: the home (reducer under test), FakeFlux, a trusted history recorder (ghost) and a scheduler
// that injects owner actions, faults and time. Everything is bounded as below. The argument is a small-scope one: each bound is the
// smallest value at which every distinct behaviour class of the property already occurs, plus one, and each bound is a field of
// Domain so a run can raise it.
//
// ADDRESSES / BOTS / INBOXES / KEYS.  One address (1 bot, 1 inbox, 2 keys: the live one and one rotation successor) is the unit of
//   every invariant: guard, park, key target and Keep are all per inbox/bot. Two addresses (adds a second bot, a second inbox and a
//   FOREIGN inbox and key owned by another home on the same account) is what cross-target mistakes need: a Keep or revoke that
//   touches the wrong target, a per-account listing that includes foreign entries, a park for bot A consuming bot B's authority.
//   A third address adds no new class: no rule relates three targets.
// GENERATIONS.  Generation.serial changes on any change of inbox/op/emailKeyRef. maxGenerations = 3 (initial, one rotation, one
//   re-provision): staleness needs "old" and "new" and a third rules out "old equals the one before last" confusions.
// OUTSTANDING REQUESTS PER KIND AND COPIES.  Requests live in FluxState and are never touched by a restore (A1). maxOutstanding is
//   2 per kind (a request that is stale plus the retry that superseded it), maxCopies 3 in flight per request (original, duplicate,
//   a duplicate of the duplicate: idempotence is established by the second copy, the third catches counters). Delivery order is free
//   (every held request can be applied next), so reordering is the scheduler's freedom, not a separate fault: see FAULT_SUBSUMPTION.
// LATE DELETEs (binding ruling 2026-11-10 20:36Z).  A DELETE is "held" and may be applied at ANY tick: before the Keep completes,
//   after it, after a restore, inside the 24 h guard window, between 24 h and 30 d, and well past 30 d. Behaviour depends on elapsed
//   time only through comparisons with four thresholds against a few anchors (keptAt, closingSince, tokenIssuedAt, lastCheck):
//   60 s poll, 10 min token TTL, 24 h guard poll window, 30 d Flux purge/restore window. So the delay classes after Keep at t0 are
//   d < 24 h, 24 h <= d < 30 d, 30 d <= d, and the DELETE then opens its OWN 30 d window at t0+d, whose purge/410 boundary sits at
//   t0+d+30d. maxNowMs = 95 d therefore reaches d = 31 d with its purge at 61 d and a second horizon at 91 d, which is one full
//   cycle beyond every class; any longer delay is equivalent to one of these (all comparisons are already stable). Clock jumps are
//   the four threshold sizes plus "deadline-1 ms" and "deadline" jumps computed from live anchors, so every boundary is hit from
//   both sides (just before, exactly at, just after).
// CLOCK.  Abstract ticks: the clock only moves by the explicit jumps above; a jump is followed (by the scheduler) by home ticks that
//   are obligations only when the reducer's wakeups() says one is due. 60 s polling inside 24 h is therefore modelled as the
//   reducer's own wake list, not as 1440 clock steps; recovery exploration reports truncation if a reducer asks for more.
// CRASHES.  Armed before or after any one of W1..W22 (44 points), at most 3 per trace (a crash during boot recovery of a crash,
//   then one more to show recovery is idempotent). RESTORES at most 2 (restore over a restore: the older-archive-twice case),
//   OWNER VIEWS at most 2 (a token minted before and one after a restore), BACKUPS at most 2.
// Provider contract (see the fixed fault model): see fakeflux.ts. Only the listing is a switch.
// ---------------------------------------------------------------------------------------------------------------------------------

import type { BotId, InboxId, KeyId, Principal, RemoteKind, RestoreRecord } from "./invariants.current.ts";
import { FLUX_PURGE_MS, GUARD_POLL_MS, GUARD_POLL_WINDOW_MS, TOKEN_TTL_MS } from "./invariants.current.ts";

export const DAY_MS = 24 * 3600_000;

export interface Domain {
  name: string;
  bots: readonly BotId[];
  /** inboxes owned by this home, by bot; foreign inbox/key ids belong to another home on the same account. */
  inboxes: readonly InboxId[];
  foreignInboxes: readonly InboxId[];
  keys: readonly KeyId[];
  maxGenerations: number;
  maxOutstandingPerKind: Record<RemoteKind, number>;
  maxCopies: number;
  maxCrashes: number;
  maxRestores: number;
  maxOwnerViews: number;
  maxBackups: number;
  maxFluxCloses: number;
  maxEventRedeliveries: number;
  maxNowMs: number;
  /** fixed clock jumps; boundary jumps are added from live deadlines by moves.ts. */
  clockJumps: readonly number[];
  principals: readonly Principal[];
  restoreSources: readonly RestoreRecord["source"][];
  /** also offer the restore whose outgoing live DB is unavailable (new machine, disk loss): archiveId + NO_LIVE_SUFFIX. */
  restoreNoOutgoing: boolean;
}

export const NO_LIVE_SUFFIX = "!nolive";

const perKind = (n: number): Record<RemoteKind, number> => ({
  DELETE_INBOX: n, REVOKE_KEY: n, RESTORE_INBOX: n, GET_INBOX: n, CREATE_INBOX: n, MINT_KEY: n, LIST_ACCOUNT: n,
});

export const DOMAIN_ONE: Domain = {
  name: "one-address", bots: ["b1"], inboxes: ["i1"], foreignInboxes: [], keys: ["k1", "k2"], maxGenerations: 3,
  maxOutstandingPerKind: perKind(2), maxCopies: 3, maxCrashes: 3, maxRestores: 2, maxOwnerViews: 2, maxBackups: 2, maxFluxCloses: 1,
  maxEventRedeliveries: 2, maxNowMs: 95 * DAY_MS,
  clockJumps: [GUARD_POLL_MS, TOKEN_TTL_MS + 1, GUARD_POLL_WINDOW_MS + 1, FLUX_PURGE_MS + 1],
  principals: ["owner_desktop"], restoreSources: ["desktop", "cloud_reset"], restoreNoOutgoing: true,
};

export const DOMAIN_TWO: Domain = {
  ...DOMAIN_ONE, name: "two-address", bots: ["b1", "b2"], inboxes: ["i1", "i2"], foreignInboxes: ["x1"], keys: ["k1", "k2", "k3", "kx"],
  maxOutstandingPerKind: perKind(1), maxCrashes: 1, maxRestores: 1, maxOwnerViews: 1, maxBackups: 1,
};

/** Fault-model entries that are not separate moves, and why (checked by coverage: no entry may silently vanish). */
export const FAULT_SUBSUMPTION: Record<string, string> = {
  "fault.reorder": "every held request/answer/event is independently deliverable next, so any permutation is reachable; no swap move needed",
  "fault.delayEvent": "events are delivered by a separate move (flux.emit then auto.applyEvent) that may be postponed indefinitely",
};
