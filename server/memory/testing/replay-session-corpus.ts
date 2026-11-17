// SPDX-License-Identifier: AGPL-3.0-or-later
// Corpus producer and replay consumer owner: new3-g5.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { database, closeDatabase } from "../../database.ts";
import { SEND_ATTEMPT_SCHEMA_SQL, SendAttemptStore } from "../../send-attempt-state.ts";
import * as replay from "../replay-lineage.ts";
import { updateReceiptReplayProof } from "../receipt-replay-proof.ts";

export function proofJson(p: replay.SendReplayProof) {
  return { threadId: p.threadId, messageIds: [...p.messageIds], ancestry: p.ancestry,
    excludedIds: [...p.excludedIds].sort(), epochs: p.epochs, revision: p.revision };
}
function mulberry32(seed: number) {
  return () => { let t = seed += 0x6d2b79f5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function corpusHeader() {
  return { source: "b8f51043227526ec63aad2b6d70943d2b87bbf27", hashes: Object.fromEntries([
    "server/memory/replay-lineage.ts", "server/memory/receipt-replay-proof.ts", "server/send-attempt-state.ts",
  ].map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")])) };
}
export function recordSeed(seed: number) {
  const random = mulberry32(seed), steps: unknown[] = [], sessions: string[] = [];
  const roots = new Map([["probe", [{ threadId: "source", messageId: "base" }]]]);
  const row = (id: string, thread = "conversation", extra: object = {}) => {
    const m = { id, at: 1, role: "user", kind: "text", text: "Fixture", ...extra };
    database().prepare("INSERT OR REPLACE INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,1,'user',?,'Fixture',?)").run(thread, id, m.kind, JSON.stringify(m));
  };
  const bump = (thread = "conversation") => database().prepare("INSERT INTO send_replay_epochs VALUES(?,1) ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1").run(thread);
  database().exec(SEND_ATTEMPT_SCHEMA_SQL);
  row("base"); row("base", "source"); row("probe");
  row("image", "conversation", { kind: "image", copyOf: { threadId: "source", messageIds: ["base"] } });
  const probes = ["base", "probe", "image", "missing-copy", "invalid", "local-copy", "cross-copy"];
  const confirm = () => {
    const id = `session-${sessions.length}`;
    replay.confirmFreshReplaySession("conversation", `engine-${sessions.length % 2}`, id, replay.captureSendReplayProof("conversation", probes, roots));
    sessions.push(id);
  };
  confirm();
  for (let step = 0; step < 300; step++) {
    const op = Math.floor(random() * 15), store = new SendAttemptStore(database());
    let outcome: unknown = null;
    if (op === 0) row(`plain-${step}`);
    if (op === 1) { row("local-copy", "conversation", { copyOf: { threadId: "conversation", messageIds: ["base"] } }); bump(); }
    if (op === 2) { row("cross-copy", "conversation", { copyOf: { threadId: "source", messageIds: ["base"] } }); bump(); }
    if (op === 3) { row("missing-copy", "conversation", { copyOf: { threadId: "source", messageIds: [`absent-${step}`] } }); bump(); }
    if (op === 4) { row("invalid"); database().exec("UPDATE messages SET json='invalid' WHERE id='invalid'"); bump(); }
    // Model the durable writer contract explicitly; T4 separately exercises the
    // real updateMessage writer's R3 repair, absent from this recorded runtime.
    if (op === 5) { row("image", "conversation", { kind: "image" }); bump(); }
    if (op === 6) { database().exec("UPDATE messages SET json=json_set(json,'$.dispatchedIn','fixture','$.turnTerminal',1) WHERE id='base'"); }
    if (op >= 7 && op <= 10) {
      const id = `input-${step}`; row(id);
      const attempt = store.create({ ownerId: "owner", botId: "fixture", threadId: "conversation", sendId: id, fingerprint: "fixture" });
      store.link(attempt.attemptId, id);
      let key = store.bind([attempt.attemptId], { generation: id, providerInstanceId: "engine" })[0]!;
      const state = { proof: replay.captureSendReplayProof("conversation", [...probes, id], roots) };
      try {
        store.transaction(() => updateReceiptReplayProof(database(), state, [id], () => {
          if (op !== 9) store.releaseWrite(key, store.byId(attempt.attemptId)!.revision, 1);
          if (op === 7) { key = store.allocateProvider(key, store.byId(attempt.attemptId)!.revision, id); store.acknowledge(key, store.byId(attempt.attemptId)!.revision); }
          if (op === 10) { const sealed = store.seal(key, store.byId(attempt.attemptId)!.revision); store.settleAttempt(sealed, store.byId(attempt.attemptId)!.revision, "abandoned_uncertain", { binding: sealed, delivery: "uncertain" }); }
        }));
        outcome = { result: "ok", proof: proofJson(state.proof) };
      } catch (error) { outcome = { result: (error as Error).message, proof: proofJson(state.proof) }; }
    }
    if (op === 11) confirm();
    if (op === 12) store.retireThread({ ownerId: "owner", botId: "fixture", threadId: "conversation" }, () => {}, () => database().exec("DELETE FROM messages WHERE thread_id='conversation'"));
    if (op === 13) {
      try { store.transaction(() => { row("rolled-back", "source"); bump("source"); throw new Error("fixture rollback"); }); } catch { /* intentional rollback */ }
    }
    if (op === 14) { closeDatabase(); database(); }
    const currency = sessions.map((id, i) => {
      const current = replay.sendReplaySessionCurrent("conversation", `engine-${i % 2}`, id);
      const reason = (replay as unknown as { lastReplaySessionConservativeForTest?: () => string | null }).lastReplaySessionConservativeForTest?.() ?? null;
      return { current, reason };
    });
    steps.push({ op, currency, captures: [proofJson(replay.captureSendReplayProof("conversation", probes, roots)), proofJson(replay.captureSendReplayProof("source", ["base", "absent"]))], outcome });
  }
  return { seed, steps };
}
