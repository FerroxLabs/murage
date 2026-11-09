// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 TURNSTART r14 1D + r15 sec. 2: the turn's FOOTPRINT F(turn), its hash, and the turn's ONE compare and record, at dispatch
// (server/index.ts, right after dispatchAccess). "warm" for a turn is a statement about ONE confirmed footprint at ONE head: the turn is
// covered only when it is a plain send (its user line U appended by this turn, no project card run, memory active, not the last
// resort) and the warmer's W3' holds for U (head is U, confirmedAt is the seq just below U, W1, W2', admitted, fp equal). Every other
// turn is a counted miss and checks exactly as today. The record (rec.footprint, rec.footprintHash, confirmedAt) belongs to the lineage
// warmer (lineage-warm.ts), which registers itself here (setLineageFootprintRecords); this module keeps no per-thread state, so the
// compare and the record are O(1) in the thread's history. Unregistered (no warmer): every compare is a miss of kind "not-covered".
import { createHash } from "node:crypto";
import { memoryAccessNotOwnerAudience, type MemoryAccess } from "./policy.ts";

/** r14.1 X1: the six kinds of the turn's userMessage (IX:12269-12291). Only APPENDED is ever covered. */
export type UserKind = "APPENDED" | "EXPLICIT" | "PROJECT" | "EDIT" | "HELD" | "SYNTHETIC";
export const USER_KINDS: readonly UserKind[] = ["APPENDED", "EXPLICIT", "PROJECT", "EDIT", "HELD", "SYNTHETIC"];
/** Why a turn's compare was a miss (r15 sec. 2): its footprint changed (APPENDED-changed: W3'(6)), a kind that is never covered, a
 * project card run, the memory floor (mode not active or last resort), or the warmer's W3'(2)-(5) did not hold (not-covered). */
export type FootprintMissKind = "APPENDED-changed" | Exclude<UserKind, "APPENDED"> | "projectCardRun" | "floor" | "not-covered";
export const FOOTPRINT_MISS_KINDS: readonly FootprintMissKind[] = ["APPENDED-changed", "EXPLICIT", "PROJECT", "EDIT", "HELD", "SYNTHETIC", "projectCardRun", "floor", "not-covered"];

/** F(turn): the mint inputs (never the MemoryAccess object: it carries a claim), the access stamp, the skip identity, the projection,
 * the replay options and the resumed cursor. Same shape as the r14 test surface's R14Footprint. */
export interface LineageFootprint {
  botId: string; threadId: string; accessStamp: string;
  userKind?: UserKind; userMessageId?: string; exclude: string[]; projectCardRun?: boolean;
  routeHasTools: boolean; externalUpdates: string; maxBytes: number; minLines?: number;
  cursor: { instanceId: string; nativeSession: string; incarnation: number } | null;
}

/** The hashed ACCESS STAMP (r14 1D, r15 sec. 2): the MemoryAccess fields E1/E2 read (the sessionHoldKey fields DI:129-130 plus scopeIds
 * DI:149) in one canonical string, not the claim or the generation. A refreshed access with the same fields stamps equal; a policy or
 * deletion move does not. */
export function accessStamp(access: MemoryAccess): string {
  return JSON.stringify([access.threadId, access.botId, access.humanPrincipal, memoryAccessNotOwnerAudience(access), access.policyRevision,
    access.deletionEpoch, [...access.scopeIds].sort()]);
}

/** The externalUpdates field: the task's queued external-update ids (promptRows' pending list), sorted, as one string. */
export function externalUpdatesKey(ids: readonly string[] | undefined): string { return JSON.stringify([...(ids ?? [])].sort()); }

/** Canonical JSON: object keys sorted, undefined fields left out (an absent optional field and an undefined one hash equal). */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item === undefined ? null : item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

/** fp(F) = sha1 of the canonical JSON. exclude is hashed sorted (its order is not an input). An APPENDED turn hashes its KIND and no
 * message id (r15 sec. 2: the next plain send's line does not exist when the warmer confirms); every other kind keeps its id, so two
 * of them never collide (they are never covered anyway). */
export function footprintHash(f: LineageFootprint): string {
  return createHash("sha1").update(canonical({ ...f, exclude: [...f.exclude].sort(),
    // MUTANT:appended-id-hashed
    userMessageId: f.userKind === "APPENDED" ? undefined : f.userMessageId,
  })).digest("hex");
}

/** The turn's own user line, as the dispatch compare names it. */
export interface TurnUserMessage { id: string; seq: number | undefined }

/** What the warmer exposes to the turn. */
export interface LineageFootprintRecords {
  /** W3'(2)-(6) for this turn (r15 sec. 2): "match" only when the thread's head is U, its seq is rec.confirmedAt + 1 after a clean
   * headSlot-1 confirm, W1 and W2' hold, rec is admitted with outcome null, and fp(F) === rec.footprintHash. */
  covered(thread: string, userMessage: TurnUserMessage, footprint: LineageFootprint): "match" | "APPENDED-changed" | "not-covered";
  /** noteLineageFootprint: rec.footprint := F; if fp changed, confirmedAt := none and a wake. O(1). */
  note(thread: string, footprint: LineageFootprint, hash: string): void;
}
let records: LineageFootprintRecords | null = null;
/** lineage-warm.ts registers its record here at load (null: unregister, tests). */
export function setLineageFootprintRecords(next: LineageFootprintRecords | null): void { records = next; }

const missByKind = (): Record<FootprintMissKind, number> => Object.fromEntries(FOOTPRINT_MISS_KINDS.map(kind => [kind, 0])) as Record<FootprintMissKind, number>;
const counts = { footprintMatch: 0, footprintMiss: 0, footprintMissByKind: missByKind(), warmAllowanceHit: 0 };
/** lineageFootprintMatch / lineageFootprintMiss (by kind) and lineageWarmAllowanceHit (R1). */
export function lineageFootprintCounters(): { footprintMatch: number; footprintMiss: number; footprintMissByKind: Record<FootprintMissKind, number>; warmAllowanceHit: number } {
  return { ...counts, footprintMissByKind: { ...counts.footprintMissByKind } };
}
export function resetLineageFootprintCountersForTest(): void {
  counts.footprintMatch = 0; counts.footprintMiss = 0; counts.footprintMissByKind = missByKind(); counts.warmAllowanceHit = 0;
}

/** The turn's ONE COMPARE (r15 sec. 2, at dispatch), counted, BEFORE the turn records F. `floor` is W3'(1)'s memory half: memory mode not
 * active, or the last resort. Changes nothing the turn does: it always runs E2 and E1 as today; on a match they are hit-only. */
export function compareLineageFootprint(thread: string, footprint: LineageFootprint, userMessage: TurnUserMessage, floor: boolean): "match" | FootprintMissKind {
  const kind = footprint.userKind;
  const verdict: "match" | FootprintMissKind =
    kind !== undefined && kind !== "APPENDED" ? kind
    : kind === undefined ? "not-covered"
    : footprint.projectCardRun ? "projectCardRun"
    : floor ? "floor"
    : records ? records.covered(thread, userMessage, footprint)
    : "not-covered";
  if (verdict === "match") counts.footprintMatch++;
  else { counts.footprintMiss++; counts.footprintMissByKind[verdict]++; }
  return verdict;
}

/** The turn's RECORD, after its compare: the record takes the actual F. */
export function noteLineageFootprint(thread: string, footprint: LineageFootprint): void {
  records?.note(thread, footprint, footprintHash(footprint));
}

/** A turn whose compare matched ended with its allowance hit (recall spent past the reserve): outside W''', counted for R1, not a gate
 * failure. */
export function noteWarmAllowanceHit(): void { counts.warmAllowanceHit++; }
