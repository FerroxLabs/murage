// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// LINEAGE-DESIGN-S6 rule 23 (the anchor seek): one primary-key read, positive verdicts memoized, nothing written.
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { appendMessage, closeMessageDb } from "./message-db.ts";
import type { Message } from "./store.ts";
import { anyMurageAnchor, murageAnchor } from "./bot-read.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

beforeEach(() => { closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

const row = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text: `words ${id}`, at: Date.now(), from: { botId: "b", name: "B", color: "#000" }, ...extra });

it("reads Murage-voice anchors and anchors it cannot read (a missing row, a message id without its thread) as positive, a plain row or no message id as negative", () => {
  appendMessage("t", row("plain"));
  appendMessage("t", row("line", { murageLine: true } as Partial<Message>));
  appendMessage("t", row("actor", { actorKind: "murage" } as Partial<Message>));
  const db = database();
  expect(murageAnchor(db, "t", "plain")).toBe(false);
  expect(murageAnchor(db, "t", "line")).toBe(true);
  expect(murageAnchor(db, "t", "actor")).toBe(true);
  expect(murageAnchor(db, "t", "gone")).toBe(true);
  expect(murageAnchor(db, "other", "line")).toBe(true);
  expect(murageAnchor(db, null, "line")).toBe(true);
  expect(murageAnchor(db, "t", null)).toBe(false);
  expect(anyMurageAnchor(db, [{ threadId: "t", messageId: "plain" }, { threadId: "t", messageId: "actor" }])).toBe(true);
  expect(anyMurageAnchor(db, [{ threadId: "t", messageId: "plain" }])).toBe(false);
});

it("writes nothing, and a positive verdict holds even if the row is later rewritten (sticky classification)", () => {
  appendMessage("t", row("line", { murageLine: true } as Partial<Message>));
  const db = database();
  const before = db.prepare("SELECT total_changes() AS n").get()!.n;
  expect(murageAnchor(db, "t", "line")).toBe(true);
  expect(db.prepare("SELECT total_changes() AS n").get()!.n).toBe(before);
  // a forbidden rewrite outside the writers (rule 2 throws in them) does not release a remembered anchor
  db.prepare("UPDATE messages SET json=json_remove(json,'$.murageLine') WHERE id='line'").run();
  expect(murageAnchor(db, "t", "line")).toBe(true);
});

it("a negative verdict is not memoized", () => {
  appendMessage("t", row("plain"));
  const db = database();
  expect(murageAnchor(db, "t", "plain")).toBe(false);
  db.prepare("UPDATE messages SET json=json_set(json,'$.actorKind','murage') WHERE id='plain'").run();
  expect(murageAnchor(db, "t", "plain")).toBe(true);
});
