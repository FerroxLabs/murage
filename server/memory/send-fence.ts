// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The send fence (DESIGN-WRITETIME 3, "Prompt vs send race"), for the driver submission and the steer send. Kept apart from dispatch.ts so
// drivers/engine-input.ts reaches it without importing the bundle and search modules (that import closed a cycle through memory/index.ts
// and left a module constant uninitialised in the memory worker). Its database and its marker drain are handed in by the modules that own
// them (dispatch.ts, memory-revocation.ts) when they load.
import type { DatabaseSync } from "node:sqlite";
import { fenceVerdict, refsLookup } from "./deny-read.ts";
import type { BuiltPrompt, LineageReader, LineageRef, LineageVerdict } from "./lineage-types.ts";

let fenceDb: (() => DatabaseSync) | null = null;
let drainPending: ((db: DatabaseSync) => void) | null = null;
/** dispatch.ts hands in the server database, memory-revocation.ts its bounded marker drain. */
export function setSendFenceDeps(deps: { db?: () => DatabaseSync; drain?: (db: DatabaseSync) => void }): void {
  if (deps.db) fenceDb = deps.db;
  if (deps.drain) drainPending = deps.drain;
}

/** At a turn's start (memory-bundle build): a revoke the owner just made is walked inline within the bounded drain, so the turn's memory,
 * transcript and send read it settled rather than "checking" (the runner yields to the owner's live turn). Never inside a transaction;
 * a large revoke is left to the runner and its window reads "checking" as before. */
export function drainMarkerForTurn(db: DatabaseSync): void {
  if (!drainPending || db.isTransaction) return;
  try { drainPending(db); } catch { /* the runner finishes it; readers hold its window "checking" */ }
}

/** When deny_generation moved since the prompt was built, its parts are looked up again, and a part now denied or pending refuses the send
 * with MEMORY_CONTEXT_REVOKED (the turn is re-dispatched once and rebuilds its prompt). Shown otherwise. A part reading "checking: pending"
 * (a revoke committed moments ago whose marker the runner has not walked: it yields to a live owner turn, and this send is one) first gets
 * a bounded inline drain of the marker (memory-revocation.ts SEND_FENCE_DRAIN) and is asked again; a large revoke stays pending and the
 * send is refused as before. Fail closed: no database, or a lookup that throws, refuses. */
export function assertSendFence(built: BuiltPrompt, reader: LineageReader, db?: DatabaseSync): void {
  // a prompt resting only on none(reason) parts holds nothing stored that a revoke could reach (fenceVerdict says the same; asked first so
  // such a send never needs the database)
  if (built.parts.length && built.parts.every(part => part.lineageOf.length > 0 && part.lineageOf.every(ref => ref.kind === "none"))) return;
  const file = db ?? fenceDb?.() ?? null;
  let verdict: LineageVerdict;
  try { verdict = file ? fenceVerdict(file, built, reader) : { state: "checking", reason: "lookup-error" }; }
  catch { verdict = { state: "checking", reason: "lookup-error" }; }
  if (file && drainPending && verdict.state === "checking" && verdict.reason === "pending") {
    try { drainPending(file); verdict = fenceVerdict(file, built, reader); } catch { verdict = { state: "checking", reason: "lookup-error" }; }
  }
  if (verdict.state !== "shown") {
    if (file) logFenceRefusal(file, built, reader, verdict);
    throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { fence: verdict });
  }
}

/** The most refs one refusal's diagnosis looks up again. */
const FENCE_DIAGNOSIS_REFS = 256;
const refLabel = (ref: LineageRef): string => ref.kind === "line" ? (ref.replay ? "own-replay-line" : ref.copyOfShown ? "own-copy-origin" : "line")
  : ref.kind === "prefix" ? (ref.content ? "own-prefix" : "prefix") : ref.kind;
export type FenceRefusalCounts = { reader: "content" | "audience"; parts: number; refusedParts: number; refs: Record<string, number>; reasons: Record<string, number>; truncated: boolean };
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
function logFenceRefusal(db: DatabaseSync, built: BuiltPrompt, reader: LineageReader, verdict: LineageVerdict): void {
  try {
    const counts = fenceRefusalCounts(db, built, reader);
    const list = (map: Record<string, number>) => Object.entries(map).map(([key, n]) => `${key} ${n}`).join(", ") || "none";
    console.warn(`[memory] send fence refused (${verdict.state === "shown" ? "shown" : `${verdict.state}:${verdict.reason}`}, ${counts.reader} reader): ${counts.refusedParts} of ${counts.parts} parts; refused refs: ${list(counts.refs)}; verdicts: ${list(counts.reasons)}${counts.truncated ? "; more not looked up" : ""}`);
  } catch { /* the diagnosis never changes the refusal */ }
}
