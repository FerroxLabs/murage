// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// T-WRITE-STMT: every write to messages fires its triggers (the card and rowid guards), and SQLite compiles each trigger
// program into every statement that fires it. The two per-write statements are compiled once per connection, so a streamed line pays only for
// running the triggers, never for compiling them again.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { database } from "./database.ts";
import { closeMessageDb, insertMessage, readThread, updateMessage } from "./message-db.ts";
import type { Message } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const msg = (id: string, text: string): Message => ({ id, role: "user", kind: "text", text, at: Date.now() });
const REPLACE = /^\s*INSERT OR REPLACE INTO messages \(/;
const PATCH = /^\s*UPDATE messages SET at=\?, role=\?, kind=\?, text=\?, json=\? WHERE thread_id=\? AND id=\?/;

describe("message write statements", () => {
  beforeEach(() => {
    closeMessageDb();
    removeTempDirSync(DATA_DIR);
    mkdirSync(DATA_DIR, { recursive: true });
  });

  it("T-WRITE-STMT: the insert and patch statements on messages are compiled once per connection, not once per write", () => {
    insertMessage("w1", msg("m0", "warm"));
    updateMessage("w1", msg("m0", "warm, grown"));
    const db = database();
    const prepare = vi.spyOn(db, "prepare");
    try {
      for (let i = 1; i <= 5; i++) insertMessage("w1", msg(`m${i}`, `line ${i}`));
      for (let i = 1; i <= 5; i++) updateMessage("w1", msg(`m${i}`, `line ${i}, grown`));
      const compiled = prepare.mock.calls.map(call => String(call[0]));
      expect(compiled.filter(sql => REPLACE.test(sql))).toEqual([]);
      expect(compiled.filter(sql => PATCH.test(sql))).toEqual([]);
    } finally { prepare.mockRestore(); }
    expect(readThread("w1", join(DATA_DIR, "messages-w1.json")).messages.map(m => m.text)).toEqual(["warm, grown", "line 1, grown", "line 2, grown", "line 3, grown", "line 4, grown", "line 5, grown"]);
  });

  it("T-WRITE-STMT reopen: a reopened database compiles its own statements and writes through them", () => {
    insertMessage("w2", msg("a", "before"));
    closeMessageDb();
    const db = database();
    const prepare = vi.spyOn(db, "prepare");
    try {
      insertMessage("w2", msg("b", "after"));
      insertMessage("w2", msg("c", "again"));
      expect(prepare.mock.calls.map(call => String(call[0])).filter(sql => REPLACE.test(sql))).toHaveLength(1);
    } finally { prepare.mockRestore(); }
    expect(readThread("w2", join(DATA_DIR, "messages-w2.json")).messages.map(m => m.text)).toEqual(["before", "after", "again"]);
  });
});
