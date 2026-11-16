// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The send fence (DESIGN-WRITETIME 3, "Prompt vs send race"), for the driver submission and the steer send. Kept apart from dispatch.ts so
// drivers/engine-input.ts reaches it without importing the bundle and search modules (that import closed a cycle through memory/index.ts
// and left a module constant uninitialised in the memory worker). Its database is handed in by dispatch.ts when it loads.
import type { DatabaseSync } from "node:sqlite";
import { denyGeneration, fenceVerdict, preparedWindowIdentity, prepareWindowMemory, refsLookup } from "./deny-read.ts";
import type { BuiltPrompt, LineageReader, LineageRef, LineageVerdict, TurnLineage } from "./lineage-types.ts";
import { bindRetainedTurn, checkedOpenTurns, refuseRetainedTurn, retainedTurnDatabase, type OpenTurn } from "./lineage-write.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { sendFenceDeps } from "./send-fence-deps.ts";
import { withReleaseBudgets, chargeReleaseWork, reserveRelease } from "./release-budget.ts";

import type { SettleClass, SettleScope } from "./settle-target.ts";

export { setSendFenceDeps } from "./send-fence-deps.ts";

/** The same resolved handle serves the fence and its optional refusal classifier. */
export function fenceDatabase(db?: DatabaseSync): DatabaseSync | null { return db ?? sendFenceDeps.db?.() ?? null; }
export function classifyRefusal(built: BuiltPrompt, reader: LineageReader, scope: SettleScope, db?: DatabaseSync): SettleClass {
  try {
    if (!sendFenceDeps.classify) return { kind: "incomplete", why: "no-classifier" };
    const file = fenceDatabase(db);
    if (!file) return { kind: "incomplete", why: "no-classifier" };
    return sendFenceDeps.classify(file, built, reader, scope);
  } catch { return { kind: "incomplete", why: "error" }; }
}
/** At a turn start (memory-bundle build): a revoke the owner just made is walked inline within the bounded drain, so the turn memory,
 * transcript and send read it settled rather than "checking" (the runner yields to the owner live turn). Never inside a transaction;
 * a large revoke is left to the runner and its window reads "checking" as before. */
export function drainMarkerForTurn(db: DatabaseSync): void {
  if (!sendFenceDeps.drain || db.isTransaction) return;
  try { sendFenceDeps.drain(db); } catch { /* the runner finishes it; readers hold its window "checking" */ }
}

/** Recheck immediately before the engine write. Pending and withheld both refuse;
 * recovery rebuilds without waiting for the global marker queue. */
export function assertSendFence(built: BuiltPrompt, reader: LineageReader, db?: DatabaseSync): void {
  chargeReleaseWork();
  // a prompt resting only on none(reason) parts holds nothing stored that a revoke could reach (fenceVerdict says the same; asked first so
  // such a send never needs the database)
  if (built.parts.length && built.parts.every(part => part.lineageOf.length > 0 && part.lineageOf.every(ref => ref.kind === "none"))) return;
  const file = db ?? sendFenceDeps.db?.() ?? null;
  let verdict: LineageVerdict;
  try { verdict = file ? fenceVerdict(file, built, reader) : { state: "checking", reason: "lookup-error" }; }
  catch { verdict = { state: "checking", reason: "lookup-error" }; }
  if (verdict.state !== "shown") {
    const counts = file ? logFenceRefusal(file, built, reader, verdict) : undefined;
    if (counts) refusalCountsByVerdict.set(verdict, counts);
    throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { fence: verdict, counts });
  }
}

/** The most refs one refusal's diagnosis looks up again. */
const FENCE_DIAGNOSIS_REFS = 256;
const refLabel = (ref: LineageRef): string => ref.kind === "line" ? (ref.replay ? ref.judge === "content" ? "own-replay-line-content" : "own-replay-line-audience" : ref.copyOfShown ? "own-copy-origin" : "line")
  : ref.kind === "prefix" ? (ref.shown !== undefined ? "prefix-shown" : ref.content ? "own-prefix" : "prefix") : ref.kind;

/** Final reader and prospective validation belong to the concrete generation. */
export function prepareRetainedFence(turn: TurnLineage, reader: LineageReader, onRefused: (verdict: LineageVerdict) => void, db?: DatabaseSync): LineageReader {
  const authority = retainedTurnDatabase(turn);
  const frozen = bindRetainedTurn(turn, reader, onRefused, refs => assertRetainedFence(turn, db, 0, refs));
  const file = db ?? authority;
  if (file !== authority) retainedRefusal(checkedOpenTurns(turn)[0]!, turn.parents, { state: "checking", reason: "not-built" });
  if (file) {
    const open = checkedOpenTurns(turn)[0]!;
    try { open.preparedWindow = { reader: frozen, generation: denyGeneration(file), identity: preparedWindowIdentity(file), memoryKeys: new Set(), open: true }; }
    catch { retainedRefusal(open, open.parents, { state: "checking", reason: "lookup-error" }); }
  }
  return frozen;
}

function retainedRefusal(open: OpenTurn, refs: readonly LineageRef[], verdict: LineageVerdict): never {
  refuseRetainedTurn(open, verdict);
  const counts: Record<string, number> = {};
  for (const ref of refs) { chargeReleaseWork(); const label = refLabel(ref); counts[label] = (counts[label] ?? 0) + 1; }
  if (open.over) counts["retained-over"] = 1;
  console.warn("[memory] retained fence refused", { refs: counts, refusedMembers: 1 });
  throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED", fence: verdict, members: [open] });
}

/** Rechecks the live ledger on every release, independently of deny_generation.
 * Synchronous, bounded and never memoized. Composed engine validation uses
 * check-only: all work stays metered, event/bytes belong to its final wire gate. */
export function assertRetainedFence(turn: TurnLineage, db?: DatabaseSync, bytes = 0, prospective?: readonly LineageRef[],
  accounting: "release" | "check-only" = "check-only"): void {
  const members = checkedOpenTurns(turn);
  const authority = retainedTurnDatabase(turn);
  if (db && db !== authority) {
    for (const open of members) refuseRetainedTurn(open, { state: "checking", reason: "not-built" });
    throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED", fence: { state: "checking", reason: "not-built" } });
  }
  reserveRelease(members.map(open => open.budget!), { attempts: accounting === "release" ? 1 : 0, bytes: accounting === "release" ? bytes : 0, work: 1 });
  for (const open of members) {
    const refs = prospective ?? open.parents;
    if (open.over) retainedRefusal(open, refs, { state: "checking", reason: "retained-over" });
    const allowance = LineageAllowance.tool();
    try {
      const verdict = withReleaseBudgets([open.budget!], () => allowance.timed(() => {
        const file = db ?? authority;
        if (!file) return { state: "checking", reason: "lookup-error" } as const;
        if (open.preparedWindow) {
          if (prospective) prepareWindowMemory(file, refs, open.preparedWindow);
          else open.preparedWindow.open = false;
        }
        // Final release only reads. Pending work belongs to turn preparation or
        // the marker runner; settling it here would change the evidence checked.
        return refsLookup(file, refs, open.reader!, true, open.preparedWindow);
      }));
      if (verdict.state !== "shown") withReleaseBudgets([open.budget!], () => retainedRefusal(open, refs, verdict));
    } catch (error) {
      if ((error as { code?: string })?.code === "MEMORY_CONTEXT_REVOKED") throw error;
      retainedRefusal(open, refs, { state: "checking", reason: "lookup-error" });
    } finally { allowance.close(); }
  }
}
export type FenceRefusalCounts = { reader: "content" | "audience"; parts: number; refusedParts: number; refs: Record<string, number>; reasons: Record<string, number>; truncated: boolean };
// The adapter wraps a refusal but keeps the verdict object. Preserve diagnostic
// counts across that boundary without changing the driver's authority contract.
const refusalCountsByVerdict = new WeakMap<object, FenceRefusalCounts>();
const diagnosisReasons = new Set(["own-flag", "tombstone", "thread-deny", "deny-line", "deny-range", "watermark", "footprint", "deny-session", "session-forgotten", "deny-memory", "scope-deny", "murage-anchor", "door-epoch", "pack-ineligible", "no-lineage", "thread-not-ready", "pending", "footprint-wide", "lookup-error", "not-built"]);
export type FenceRefusalDiagnosis = { refused: string; parts?: number };
export function fenceRefusalDiagnosis(error: unknown): FenceRefusalDiagnosis {
  if (!error || typeof error !== "object") return { refused: "unknown" };
  const tags = error as { fence?: LineageVerdict; verdict?: LineageVerdict };
  const verdict = tags.fence ?? tags.verdict;
  if (!verdict || (verdict.state !== "checking" && verdict.state !== "withheld") || !diagnosisReasons.has(verdict.reason)) return { refused: "unknown" };
  const counts = refusalCountsByVerdict.get(verdict);
  return { refused: `${verdict.state}:${verdict.reason}`, ...(counts ? { parts: counts.refusedParts } : {}) };
}
/** Which parts of a refused prompt the fence refused, as counts only (1.0.3 revoke drain: the re-prepare diagnosis): per refused part, each
 * of its refs judged alone, counted by kind (own-prefix and own-replay-line are the prompt's own thread read by content; prefix and line
 * another thread's, or the own thread for an audience reader) and by verdict. Never a thread, a message, an id or any text. */
export function fenceRefusalCounts(db: DatabaseSync, built: BuiltPrompt, reader: LineageReader): FenceRefusalCounts {
  const out: FenceRefusalCounts = { reader: reader.audience === null ? "content" : "audience", parts: built.parts.length, refusedParts: 0, refs: {}, reasons: {}, truncated: false };
  let looked = 0;
  const add = (map: Record<string, number>, key: string) => { map[key] = (map[key] ?? 0) + 1; };
  for (const part of built.parts) {
    chargeReleaseWork();
    if (!part.lineageOf.length) { out.refusedParts++; add(out.refs, "unaccounted"); add(out.reasons, "checking:no-lineage"); continue; }
    const refs = part.lineageOf.filter(ref => ref.kind !== "none");
    if (!refs.length) continue;
    if (looked + refs.length > FENCE_DIAGNOSIS_REFS) { out.truncated = true; break; }
    looked += refs.length;
    if (refsLookup(db, refs, reader).state === "shown") continue;
    out.refusedParts++;
    for (const ref of refs) {
      chargeReleaseWork();
      const verdict = refsLookup(db, [ref], reader);
      if (verdict.state === "shown") continue;
      add(out.refs, refLabel(ref));
      add(out.reasons, `${verdict.state}:${verdict.reason}`);
    }
  }
  return out;
}
function logFenceRefusal(db: DatabaseSync, built: BuiltPrompt, reader: LineageReader, verdict: LineageVerdict): FenceRefusalCounts | undefined {
  try {
    const counts = fenceRefusalCounts(db, built, reader);
    const list = (map: Record<string, number>) => Object.entries(map).map(([key, n]) => `${key} ${n}`).join(", ") || "none";
    console.warn(`[memory] send fence refused (${verdict.state === "shown" ? "shown" : `${verdict.state}:${verdict.reason}`}, ${counts.reader} reader): ${counts.refusedParts} of ${counts.parts} parts; refused refs: ${list(counts.refs)}; verdicts: ${list(counts.reasons)}${counts.truncated ? "; more not looked up" : ""}`);
    return counts;
  } catch { return undefined; /* the diagnosis never changes the refusal */ }
}
