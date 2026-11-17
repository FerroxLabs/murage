// SPDX-License-Identifier: AGPL-3.0-or-later
// Durable snapshot producer: tri3-g2-e. Incremental receipt persistence and cold reader owner: new3-g5.
import type { DatabaseSync } from "node:sqlite";
import type { SendReplayProof, ReplayCopyRoots } from "./replay-lineage.ts";
import { replayStatement as stmt, captureSendReplayProof } from "./replay-lineage.ts";
import type { ReplayWalk } from "./replay-walk.ts";
export interface SendReplayWriteReceipt { generation: string; turnId: string }
const parts = (key: string) => JSON.parse(key) as [string, string, string];
const encode = (proof: SendReplayProof) => JSON.stringify({ version: 1, threadId: proof.threadId, messageIds: proof.messageIds,
  copyRoots: [...proof.copyRoots], epochs: proof.epochs, revision: proof.revision, ancestry: proof.ancestry, excludedIds: [...proof.excludedIds] });
function decode(text: string, thread: string): SendReplayProof {
  const row = JSON.parse(text), id = (s: unknown) => typeof s === "string" && s.length > 0 && s.length <= 4096;
  if (row?.version !== 1 || row.threadId !== thread || !Array.isArray(row.messageIds) || row.messageIds.length > 65_536 || !row.messageIds.every(id)
    || !Array.isArray(row.copyRoots) || row.copyRoots.length > 65_536 || !row.copyRoots.every((e: any) => Array.isArray(e) && e.length === 2 && id(e[0]) && Array.isArray(e[1]) && e[1].length <= 256 && e[1].every((r: any) => r && id(r.threadId) && id(r.messageId)))
    || !Array.isArray(row.epochs) || row.epochs.length > 64 || !row.epochs.every((e: any) => Array.isArray(e) && id(e[0]) && Number.isSafeInteger(e[1]) && e[1] >= 0)
    || !Number.isSafeInteger(row.revision) || typeof row.ancestry !== "string" || !Array.isArray(row.excludedIds) || !row.excludedIds.every(id)) throw new Error("SEND_REPLAY_INVALID");
  return { ...row, copyRoots: new Map(row.copyRoots), excludedIds: new Set(row.excludedIds) };
}
export function durableReplayAlive(db: DatabaseSync, key: string, written: SendReplayWriteReceipt): boolean {
  const row = stmt(db, "SELECT generation,provider_turn_id FROM send_replay_sessions WHERE thread_id=? AND driver_instance=? AND native_session=?").get(...parts(key));
  return row?.generation === written.generation && row.provider_turn_id === written.turnId;
}
/** Full materialisation is confined to a positively fresh confirmation. */
export function saveDurableReplayBase(db: DatabaseSync, key: string, proof: SendReplayProof, written: SendReplayWriteReceipt): void {
  if (!written.generation || !written.turnId) throw new Error("SEND_REPLAY_SCOPE");
  db.exec(`DELETE FROM send_replay_sessions WHERE (thread_id,driver_instance,native_session) IN
    (SELECT thread_id,driver_instance,native_session FROM send_replay_sessions LIMIT -1 OFFSET 511)`);
  stmt(db, "DELETE FROM send_replay_session_nodes WHERE thread_id=? AND driver_instance=? AND native_session=?").run(...parts(key));
  stmt(db, `INSERT INTO send_replay_sessions VALUES(?,?,?,?,?,?) ON CONFLICT(thread_id,driver_instance,native_session)
    DO UPDATE SET generation=excluded.generation,provider_turn_id=excluded.provider_turn_id,proof=excluded.proof`).run(...parts(key), written.generation, written.turnId, encode(proof));
  // Eviction cleanup runs only on the fresh path. A receipt never cascades an
  // H-row deletion under its writer lock.
  db.exec("DELETE FROM send_replay_session_nodes WHERE NOT EXISTS(SELECT 1 FROM send_replay_sessions s WHERE s.thread_id=send_replay_session_nodes.thread_id AND s.driver_instance=send_replay_session_nodes.driver_instance AND s.native_session=send_replay_session_nodes.native_session)");
}
/** Normalized deltas overwrite keyed cells, never the history-sized base JSON.
 * At most 64 epoch cells and one bounded candidate walk are written per receipt. */
export function advanceDurableReplay(db: DatabaseSync, key: string, walk: ReplayWalk, ids: readonly string[], blocked: boolean, invalid = false): void {
  const put = stmt(db, "INSERT INTO send_replay_session_nodes VALUES(?,?,?,?,?,?) ON CONFLICT(thread_id,driver_instance,native_session,kind,node_key) DO UPDATE SET json=excluded.json");
  const cell = (kind: string, node: string, value: unknown) => put.run(...parts(key), kind, node, JSON.stringify(value));
  cell("blocked", "", blocked || invalid);
  if (invalid) return;
  for (const [thread, epoch] of walk.epochs) cell("epoch", thread, epoch);
  for (const id of ids) {
    cell("candidate", id, walk.candidateOrdinal(id));
    const roots = walk.copyRoots.get(id); if (roots) cell("roots", id, roots);
    for (const ancestry of walk.ancestryForCandidate(id)) cell("ancestry", ancestry, true);
  }
}
export function invalidateDurableReplay(db: DatabaseSync, key: string): void {
  stmt(db, "INSERT INTO send_replay_session_nodes VALUES(?,?,?,'blocked','','true') ON CONFLICT(thread_id,driver_instance,native_session,kind,node_key) DO UPDATE SET json='true'").run(...parts(key));
}
export function loadDurableReplay(db: DatabaseSync, key: string): { proof: SendReplayProof; written: SendReplayWriteReceipt } | undefined {
  const [thread] = parts(key);
  if (!stmt(db, "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='send_replay_sessions'").get()) return;
  const row = stmt(db, "SELECT generation,provider_turn_id,proof FROM send_replay_sessions WHERE thread_id=? AND driver_instance=? AND native_session=?").get(...parts(key));
  if (!row) return;
  if (typeof row.generation !== "string" || !row.generation || typeof row.provider_turn_id !== "string" || !row.provider_turn_id) throw new Error("SEND_REPLAY_INVALID");
  const base = decode(String(row.proof), thread), ids = [...base.messageIds], roots = new Map(base.copyRoots), epochs = new Map(base.epochs), ancestry = new Set<string>(JSON.parse(base.ancestry));
  const candidates: [string, number][] = [];
  for (const node of stmt(db, "SELECT kind,node_key,json FROM send_replay_session_nodes WHERE thread_id=? AND driver_instance=? AND native_session=?").iterate(...parts(key))) {
    const kind = String(node.kind), key = String(node.node_key), value = JSON.parse(String(node.json));
    if (kind === "blocked") { if (value !== false) throw new Error("SEND_REPLAY_CHANGED"); }
    else if (kind === "epoch" && Number.isSafeInteger(value) && value >= 0) epochs.set(key, value);
    else if (kind === "candidate" && Number.isSafeInteger(value) && value >= 0 && value < 65_536) candidates.push([key, value]);
    else if (kind === "roots" && Array.isArray(value) && value.length <= 256 && value.every(r => typeof r?.threadId === "string" && typeof r?.messageId === "string")) roots.set(key, value);
    else if (kind === "ancestry" && value === true) { JSON.parse(key); ancestry.add(key); }
    else throw new Error("SEND_REPLAY_INVALID");
  }
  // Keyed rows have no visitation order. Only the persisted append ordinal
  // may order a replay: budget and memo outcomes depend on that order.
  const membership = new Set(ids);
  for (const [id, ordinal] of candidates.sort((a, b) => a[1] - b[1])) {
    if (ordinal < ids.length) { if (ids[ordinal] !== id) throw new Error("SEND_REPLAY_INVALID"); }
    else {
      if (ordinal !== ids.length || membership.has(id)) throw new Error("SEND_REPLAY_INVALID");
      ids.push(id); membership.add(id);
    }
  }
  const proof = captureSendReplayProof(thread, ids, roots as ReplayCopyRoots, db);
  if (JSON.stringify(proof.epochs) !== JSON.stringify([...epochs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    || proof.ancestry !== JSON.stringify([...ancestry].sort()) || JSON.stringify([...proof.excludedIds].sort()) !== JSON.stringify([...base.excludedIds].sort())) throw new Error("SEND_REPLAY_CHANGED");
  return { proof, written: { generation: row.generation, turnId: row.provider_turn_id } };
}
