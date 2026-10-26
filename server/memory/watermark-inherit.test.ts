// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 104 High 01-A2: a reply written after a policy bump does not inherit the stale oldest-receipt value of the line before it, so an audience
// reader (a linked person's replay) keeps seeing the thread's later replies.
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage, closeMessageDb } from "../message-db.ts";
import type { Message } from "../store.ts";
import { denyLookup } from "./deny-read.ts";
import { closeTurnLineage, openTurnLineage } from "./lineage-write.ts";
import type { LineageReader } from "./lineage-types.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const msg = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text: id, at: Date.now(), ...extra });
const MEMBER: LineageReader = { audience: { owner: false, scopeIds: [] } };

beforeEach(() => { closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

it("a reply written after a policy change reads shown to an audience reader even though the reply before it is below the watermark", () => {
  const db = database();
  appendMessage("T", msg("o1", { role: "user" }));
  const t1 = openTurnLineage(db, { threadId: "T", turnId: "t1" });
  try { appendMessage("T", msg("a1", { parentId: "o1" })); } finally { closeTurnLineage(t1); }
  // a1 carried a memory receipt at lsn 1 (the oldest receipt in its ancestry)
  db.prepare("UPDATE memory_line_lineage SET mem_lsn=1 WHERE message_id='a1'").run();
  db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
  appendMessage("T", msg("o2", { role: "user", parentId: "a1" }));
  const t2 = openTurnLineage(db, { threadId: "T", turnId: "t2" });
  try { appendMessage("T", msg("a2", { parentId: "o2" })); } finally { closeTurnLineage(t2); }
  const read = (id: string) => denyLookup(db, { threadId: "T", lines: [{ messageId: id, author: "generated" }] }, MEMBER).get(id)!;
  expect(read("a1")).toEqual({ state: "withheld", reason: "watermark" });
  expect(read("a2")).toEqual({ state: "shown" });
});
