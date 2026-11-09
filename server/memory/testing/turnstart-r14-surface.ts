// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 TURNSTART r14 + r14.1 + flagfold + r15: the ONE test seam the r14/r15 tests read (lineage-warm.ts exports `lineageWarmTestSurface()`).
// Test-only: it adds no behaviour. Types live here (not in a .test.ts) so every r14/r15 test file imports one contract. Builders L1-L3 implement
// it; changing a name here is a contract change and goes through the TURNSTART lead.
// r15 (no prediction): send() appends the user line and runs NO warm step; dispatch() is the turn from IX:13283 on (one compare, then record, then
// E2 -> recall -> E1 on the turn's own inputs, then the bot reply). compareFootprint is retired.
import * as LW from "../lineage-warm.ts";

/** r14.1 X1: the six kinds of the turn's userMessage (IX:12269-12291). Only APPENDED is ever covered (r15 W3'). */
export type UserKind = "APPENDED" | "EXPLICIT" | "PROJECT" | "EDIT" | "HELD" | "SYNTHETIC";
/** F(turn), r14 1D + r14.1 X1 + r15 sec. 2: mint inputs (never the MemoryAccess object). userMessageId only for non-APPENDED kinds. */
export interface R14Footprint {
  botId: string; threadId: string; accessStamp: string;
  userKind: UserKind; userMessageId?: string; exclude: string[]; projectCardRun: boolean;
  routeHasTools: boolean; externalUpdates: string; maxBytes: number; minLines?: number;
  cursor: { instanceId: string; nativeSession: string; incarnation: number } | null;
}
/** C5'(2) as amended by r14.1 X2 (unfinished restored, memo misses, merges). */
export interface R14ConfirmCounts {
  misses: number; listings: number; remember: number; holdWrites: number; handleMisses: number; memoMisses: number; merges: number;
  deferred: number; unfinished: number; hit: boolean; nodes: number; clean: boolean;
  /** what the probe answered, for the oracle's legacy comparison */
  revoked: boolean; withheld: string[];
}
/** flagfold F2: one E1 pass of the confirm and the producers branch each room-dependent decision took. */
export interface R14Pass { room: "least" | "most"; clean: boolean; branches: Record<string, "listing" | "groups" | "pairs"> }
export type Outcome = "OVERSIZE" | "RECOVERING" | "SHARED" | null;
export interface R14Record {
  outcome: Outcome; reason: string | null; confirmRounds: number; recoverSlices: number; admitted: boolean; traceSize: number;
  closureEdges: number; usedHandles: boolean; footprintHash: string | null; confirmedAt: number | null;
  /** r15.1 Y2: the transcript anchor of the clean confirm (newest row of t on the active branch at h) */ anchor: { rowid: number; id: string } | null;
  /** F6: the record's remaining proof-scheduler activations this send */
  activations: number;
  lastConfirm: (R14ConfirmCounts & { order: Array<"E2" | "E1">; headSlot: number; passes: R14Pass[] }) | null;
}
export interface R14Limits {
  verdictLimit: number; edgeBound: number; judgeBudget: number; sessionHoldsMax: number; maxHandles: number; threadForgetsMax: number;
  cEdges: boolean; cGroup: boolean; budgets: boolean;
}
/** r15 sec. 2: the IX:13283 compare's answer; a miss names its kind. */
export type TurnVerdict = "match" | `miss:${"changed" | "kind" | "floor" | "not-covered"}`;
/** r15.1 Y4 T15(h4): the work units of one replay pass, per window, for confirm vs turn equality. */
export interface R15WindowTrace { window: number; loaded: string[]; hasMore: boolean; skip: string[]; held: string[]; asked: string[][] }
export interface R15Dispatch { verdict: TurnVerdict; counts: R14ConfirmCounts; legacy: { revoked: boolean; withheld: string[] };
  /** the turn's own replay pass and the confirm's pass it was covered by. turnWindows are reported AFTER removing U from `loaded` and `skip`
   * (raw equality is impossible: the turn's window holds U), so the two arrays compare field by field (Astra ts151 FLAG). */
  turnWindows: R15WindowTrace[]; confirmWindows: R15WindowTrace[] | null }
export interface R14Surface {
  setLimits(limits: Partial<R14Limits> | null): void;
  record(thread: string): R14Record | null;
  counters(): {
    footprintMatch: number; footprintMiss: number; footprintMissByKind: Record<string, number>; warmAllowanceHit: number;
    warmerCausedClears: number; judgeStatements: number; forcedClears: number; pinnedGroupDeletes: number; pinnedEvictions: number;
    confirmsPerStepMax: number; confirmsPerRecordPerStepMax: number; handleEpoch: number;
    /** r15 (d): warm steps that ran between a send() and its dispatch(); must stay 0 */ warmStepsBetweenSendAndDispatch: number;
    /** F8 / r14.1 X6 T10(n4): holds lost by an owner (counted at the DI:193 site) */ ownerHoldLoss: number;
    /** T11(g): owner() answered UNKNOWN for a removed key; any non-zero fails the test that caused it */ unknownOwners: number;
    /** T10(r) "refused before any clear": every whole-store clear since the surface reset, test clears included (forcedClears reads a 32-entry log) */ storeClears: number;
    /** T10(r): clears raised while a confirm pass's trace was open (uncounted by the ring); a confirm pass refuses before any, so 0 */ confirmPassClears: number;
  };
  /** T14(c): demotions in order (thread ids), oldest first. */
  demotions(): string[];
  /** T14(c): the threadGroupStore entries a record's trace names, and the entries pinned in all. */
  traceGroups(thread: string): string[];
  pinnedGroups(): number;
  /** T11(b): every per-key removal through the store's private loss(map, key, why), in order; reset clears it. */
  storeLog(reset?: boolean): Array<{ map: "verdicts" | "sessionSound" | "threadGroupStore" | "sessionHolds" | "gen"; key?: string; why: string }>;
  footprintHash(footprint: R14Footprint): string;
  /** T12 revoked arm (S2, lead + MurageMain 11-07): a cold E2 on the task row's cursor and the cursor receipts' policy revision vs the current. */
  coldE2(thread: string): { revoked: boolean; why: string | null; session: string | null; receiptRevision: number | null; policyRevision: number };
  /** The footprint a plain APPENDED send on `thread` would carry with these overrides (no userMessageId). */
  turnFootprint(thread: string, over?: Partial<R14Footprint>): R14Footprint;
  fixture(kind: "plain" | "gate" | "endless-unclean" | "lost-window-key" | "edges-over" | "two-alternating" | "seven-foreign" | "spend" | "room-30k"
    | "window-boundary" | "byte-bound" | "reply-withheld" | "room-switch" | "recency-admitted" | "proof-restarts" | "merge-foreign" | "seven-foreign-unkept" | "rootless"
    | "tail-reply-widened" | "fresh-session" | "uncertain-branch" | "stale-receipt",
    options?: Record<string, number>): string[];
  /** IX:12292 + IX:12659: append a user line of `kind` (default APPENDED; replyTo optional) and bump. Runs NO warm step, advances NO timer. */
  send(thread: string, kind?: UserKind, options?: { replyTo?: string }): string;
  /** The turn from IX:12707 on: catchUpRecentMemory as the turn runs it (with `workerBehind`, the previous bot reply is still uncaptured, so
   * the catch-up captures it and leaves its notes pending; Fable r15 M1), then the IX:13283 compare (counted) on the turn's actual F (default
   * turnFootprint(thread)), record, then E2 -> recall spending `recallNodes` -> E1 on the turn's own inputs (head = the sent line, skip {it} +
   * exclude), the cold legacy verdict on the same inputs, then the bot reply. `tracedNote` leaves a pending note on a key in the record's trace. */
  dispatch(thread: string, options?: { recallNodes?: number; over?: Partial<R14Footprint>; tracedNote?: boolean; workerBehind?: boolean;
    /** r15.1 T15(i2): delete an unrelated message row (epoch-only, no dirty row) AFTER the early E2 (IX:12708) and before the compare, so the
     * epoch is still unapplied at IX:13283 and every other W3' predicate passes (Astra ts151 FLAG) */ epochOnlyWrite?: boolean;
    /** r15.1 T15(k): this many log writes on other threads between the confirm and the send */ otherThreadWrites?: number;
    /** r15.1 T15(k): a second row of t appended before U (not a plain adjacent send) */ secondRow?: boolean;
    /** r15.1 T15(l): the turn's resume eligibility differs from the confirm's */ resumeFlip?: boolean;
    /** L2 S1 (lead-accepted): raw lineage_dirty rows left pending at the compare */ pendingRows?: string[] }): R15Dispatch;
  /** The clock rule's driver: advance fake time to each scheduled timer up to `ms`, running only scheduled callbacks. Called only AFTER a
   * dispatch returned (its reply appended and the turn hold released, as production releases at IX:13747 / :13981; Fable r15 L3). */
  advance(ms: number): void;
  /** One scheduled warmer step (the same scheduling as advance): false when none is due. T10(r) looks at the store between steps. */
  stepOnce(): boolean;
  /** Store hooks for T11(c)/(g) (verdictStore's own names, L1). */
  store(): {
    supersede(oldKey: string, newKey: string): boolean; proofLossOf(bucket: number): number; proofBucket(id: string): number;
    owner(map: "verdicts" | "sessionSound" | "threadGroupStore" | "sessionHolds", key: string): string;
    /** one real key per builder site of T11(g), built by the real builder (RL:585, :653, :715, :1290, :2097, :2128, :2611-2613) */
    builderKeys(): Array<{ site: string; map: "verdicts" | "sessionSound" | "threadGroupStore" | "sessionHolds"; key: string; expect: string }>;
    /** the awaited dependency key RL:2615 (never a store key) */ awaitedKey(): string;
  };
  /** Test-only sources (L2 (b)/(c)): the access mint, the line source and the task row the confirm reads; null restores production.
   * A source not given defaults to a reader of the current test DB (messages rows for lines; no cursor for the task row). */
  useSources(sources: { mint?: (botId: string, threadId: string) => unknown; lines?: unknown; task?: unknown } | null): void;
}
export function r14Surface(): R14Surface {
  const make = (LW as unknown as Record<string, unknown>).lineageWarmTestSurface;
  if (typeof make !== "function") throw new Error("RB b13e: lineage-warm.ts has no lineageWarmTestSurface (the r14 confirm, record and footprint do not exist)");
  return (make as () => R14Surface)();
}
export const lineageThreadState = (thread: string): string => {
  const read = (LW as unknown as { lineageThreadState?: (t: string) => string }).lineageThreadState;
  if (typeof read !== "function") throw new Error("RB b13e: no lineageThreadState");
  return read(thread);
};
export const HOT_DEADLINE = 2_000;
export const RECALL_RESERVE = 1_500;
/** The hit-only shape every covered dispatch must have. */
export const HIT_ONLY = { misses: 0, listings: 0, remember: 0, holdWrites: 0, handleMisses: 0, memoMisses: 0, merges: 0, deferred: 0, unfinished: 0, hit: false };
export const hitOnly = (c: R14ConfirmCounts) => ({ misses: c.misses, listings: c.listings, remember: c.remember, holdWrites: c.holdWrites,
  handleMisses: c.handleMisses, memoMisses: c.memoMisses, merges: c.merges, deferred: c.deferred, unfinished: c.unfinished, hit: c.hit });
/** Small deterministic PRNG (mulberry32): a seed reproduces a sequence exactly. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
