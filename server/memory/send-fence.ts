// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The send fence (DESIGN-WRITETIME 3, "Prompt vs send race"), for the driver submission and the steer send. Kept apart from dispatch.ts so
// drivers/engine-input.ts reaches it without importing the bundle and search modules (that import closed a cycle through memory/index.ts
// and left a module constant uninitialised in the memory worker). Its database is handed in by dispatch.ts when it loads.
import type { DatabaseSync } from "node:sqlite";
import { fenceVerdict, refsLookup } from "./deny-read.ts";
import type { BuiltPrompt, LineageReader, LineageRef, LineageVerdict } from "./lineage-types.ts";

import type { SettleClass, SettleClassifier, SettleScope } from "./settle-target.ts";

let classifyPending: SettleClassifier | null = null;
let fenceDb: (() => DatabaseSync) | null = null;
/** dispatch.ts hands in the server database. */
export function setSendFenceDeps(deps: { db?: (() => DatabaseSync) | null; classify?: SettleClassifier | null }): void {
  if (deps.db !== undefined) fenceDb = deps.db;
  if (deps.classify !== undefined) classifyPending = deps.classify;
}

/** The same resolved handle serves the fence and its optional refusal classifier. */
export function fenceDatabase(db?: DatabaseSync): DatabaseSync | null { return db ?? fenceDb?.() ?? null; }
export function classifyRefusal(built: BuiltPrompt, reader: LineageReader, scope: SettleScope, db?: DatabaseSync): SettleClass {
  try {
    if (!classifyPending) return { kind: "incomplete", why: "no-classifier" };
    const file = fenceDatabase(db);
    if (!file) return { kind: "incomplete", why: "no-classifier" };
    return classifyPending(file, built, reader, scope);
  } catch { return { kind: "incomplete", why: "error" }; }
}

/** Recheck immediately before the engine write. Pending and withheld both refuse;
 * recovery rebuilds without waiting for the global marker queue. */
export function assertSendFence(built: BuiltPrompt, reader: LineageReader, db?: DatabaseSync): void {
  // a prompt resting only on none(reason) parts holds nothing stored that a revoke could reach (fenceVerdict says the same; asked first so
  // such a send never needs the database)
  if (built.parts.length && built.parts.every(part => part.lineageOf.length > 0 && part.lineageOf.every(ref => ref.kind === "none"))) return;
  const file = fenceDatabase(db);
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
const refLabel = (ref: LineageRef): string => ref.kind === "line" ? (ref.replay ? "own-replay-line" : ref.copyOfShown ? "own-copy-origin" : "line")
  : ref.kind === "prefix" ? (ref.content ? "own-prefix" : "prefix") : ref.kind;
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
    if (!part.lineageOf.length) { out.refusedParts++; add(out.refs, "unaccounted"); add(out.reasons, "checking:no-lineage"); continue; }
    const refs = part.lineageOf.filter(ref => ref.kind !== "none");
    if (!refs.length) continue;
    if (looked + refs.length > FENCE_DIAGNOSIS_REFS) { out.truncated = true; break; }
    looked += refs.length;
    if (refsLookup(db, refs, reader).state === "shown") continue;
    out.refusedParts++;
    for (const ref of refs) {
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
