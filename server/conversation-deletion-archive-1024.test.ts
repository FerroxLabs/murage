// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A conversation that holds an uploaded archive named <uuid>.tar.gz (or .tar.zst, .tar) must lose that file with the conversation,
// and keep it when another conversation still shows it. Entered through runConversationDeletion over a real messages table.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, expect, it } from "vitest";
import { ConversationDeletions, runConversationDeletion } from "./conversation-deletion.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-delete-archive-")));
afterAll(() => removeTempDirSync(scratch));
const THREAD = "2e9018ee-1f45-46be-8ed1-7a02fc022807";
const OTHER = "9b0e3c1a-0000-4000-8000-000000000001";

it.each(["tar.gz", "tar.zst", "tar"])("removes a stored .%s archive with its conversation and keeps one another conversation shows", async (suffix) => {
  const data = join(scratch, suffix);
  mkdirSync(join(data, "attachments"), { recursive: true });
  const db = new DatabaseSync(join(data, "messages.db"));
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  const own = `0b7c1f2e-1111-4222-8333-444455556666.${suffix}`, shared = `0b7c1f2e-1111-4222-8333-777788889999.${suffix}`;
  for (const name of [own, shared]) writeFileSync(join(data, "attachments", name), "archive");
  const row = (thread: string, id: string, names: string[]) => db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)")
    .run(thread, id, 1, "user", "text", "files", JSON.stringify({ attachments: names.map((name) => ({ kind: "file", path: join(data, "attachments", name) })) }));
  row(THREAD, "m1", [own, shared]);
  row(OTHER, "m2", [shared]);
  const deletions = new ConversationDeletions({ dataDir: data, database: () => db });
  const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineKinds: [], engineHomes: [] }, () => {
    db.prepare("DELETE FROM messages WHERE thread_id=?").run(THREAD);
    return true;
  }, async () => {});
  expect(report.failed).toEqual([]);
  expect(existsSync(join(data, "attachments", own))).toBe(false);
  expect(existsSync(join(data, "attachments", shared))).toBe(true);
  db.close();
});
