// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A used install with long threads under receipts, as a memory v5 file (the
// shape 1.0.0's upgrade started from): `threads` bot chats, each with one
// memory receipt that lists every one of its `replies` bot replies as an
// output. Upgrading it backfills one root set per reply, each the outputs
// before it: the growth that made 1.0.0's lineage quadratic.
import { closeSync, copyFileSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "../../config.ts";
import { closeDatabase, database } from "../../database.ts";
import { InternalCapabilities } from "../../internal-capabilities.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "../policy.ts";
import { captureSource } from "../capture.ts";
import { saveMemoryCandidate } from "../authority.ts";
import { buildMemoryBundle } from "../bundle.ts";
import { MemoryDispatchReceipt } from "../dispatch.ts";
import { setMemoryMode } from "../repository.ts";
import { downgradeMemorySchema } from "../schema.ts";

export const fixtureThread = (index: number) => `t${index}-direct`;
export const fixtureReply = (index: number, reply: number) => `t${index}-r${reply}`;
export function fixtureRoster(threads: number): MemoryRoster {
  return { bots: Array.from({ length: threads }, (_, index) => ({ id: `b${index}`, threadId: fixtureThread(index) })), groups: [] };
}
const empty = { async search() { return { hits: [], vectorRows: 0, coverageComplete: false }; } };

/** Builds the fixture in DATA_DIR, closes it, and copies it to `target`. */
export async function longThreadsV5(target: string, threads: number, replies: number): Promise<string> {
  const roster = fixtureRoster(threads);
  // an install made before 1.0.2 (no incremental vacuum): the file exists before the first open
  closeSync(openSync(join(DATA_DIR, "messages.db"), "a", 0o600));
  setMemoryMode("active"); reconcileMemoryRoster(roster);
  database().exec("PRAGMA synchronous=OFF");
  const insert = database().prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,'text',?,?)");
  const message = (thread: string, id: string, at: number, role: "user" | "bot", text: string) => insert.run(thread, id, at, role, text, JSON.stringify({ id, at, role, kind: "text", text }));
  for (let index = 0; index < threads; index++) {
    const thread = fixtureThread(index), bot = `b${index}`, text = `The vault code for ${thread} is ${7000 + index}.`;
    message(thread, `${thread}-ask`, 10, "user", text);
    captureSource(database(), { id: `src-${index}`, threadId: thread, messageId: `${thread}-ask`, kind: "text", speaker: "owner", outcome: "recorded", text });
    const registry = new InternalCapabilities(); registry.begin(bot, thread, "g");
    const access = () => memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: bot, threadId: thread, generation: "g", depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
    const id = saveMemoryCandidate(text, [{ sourceId: `src-${index}`, revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], `k-${index}`, access());
    database().prepare("UPDATE memory_records SET state='active', owner_pinned=1 WHERE id=?").run(id);
    const a = access();
    const receipt = new MemoryDispatchReceipt(await buildMemoryBundle("vault", a, empty), a, "claude");
    receipt.sessionStarted(`s-${index}`); receipt.accepted(); receipt.output(fixtureReply(index, 0));
    database().exec("BEGIN");
    for (let reply = 0; reply < replies; reply++) message(thread, fixtureReply(index, reply), 100 + reply, "bot", `Reply ${reply} about the vault.`);
    database().exec("COMMIT");
  }
  database().exec("PRAGMA wal_checkpoint(TRUNCATE)");
  closeDatabase();
  // back to the v5 shape, on a plain connection (no lineage cache triggers)
  const raw = new DatabaseSync(join(DATA_DIR, "messages.db"));
  try {
    downgradeMemorySchema(raw, 5);
    // every reply was made under the thread's receipt (the upgrade rebuilds the v5 output index)
    for (let index = 0; index < threads; index++) {
      raw.prepare("UPDATE memory_disclosures SET output_message_ids=? WHERE thread_id=?")
        .run(JSON.stringify(Array.from({ length: replies }, (_, reply) => fixtureReply(index, reply))), fixtureThread(index));
    }
    raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { raw.close(); }
  copyFileSync(join(DATA_DIR, "messages.db"), target);
  return target;
}
