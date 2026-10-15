// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Inbox asks for the waiting procedure suggestions on every call. The parsed rows are kept per connection and dropped by any write to the
// procedure-review rows, so a call with nothing changed reads and parses nothing, however many settled rows the history holds.
import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { listProcedureSuggestionsByBot } from "./memory/procedure-landing.ts";

beforeAll(() => { closeDatabase(); mkdirSync(DATA_DIR, { recursive: true }); database().prepare("INSERT OR IGNORE INTO memory_scopes VALUES('s','bot','x','[]',0)").run(); });
afterAll(() => closeDatabase());

const row = (id: string, botId: string, state: string) => JSON.stringify({
  schema: 1, id, kind: "suggestion", status: "complete", scopeId: "s", botId, state, version: 1, notNowCount: 0, reasons: [], label: id, targetKind: "skill",
  target: { ownerId: botId, kind: "skill", artifactId: "a", baseRevision: 1 }, evidence: [], evidenceDigest: "d", proposedText: "new", proposedHash: "h", beforeText: "old", beforeSha256: "b",
  snapshot: { evidence: [] }, createdAt: 1, decidedAt: null, policyRevision: 1, deletionEpoch: 0, learningRevision: 0,
});
const put = (id: string, botId: string, state: string) =>
  database().prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','procedure-review',1,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent").run(id, "s", row(id, botId, state));
const reads = (call: () => unknown) => {
  const db = database(), original = db.prepare.bind(db);
  let n = 0;
  const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => { if (/FROM memory_scope_bindings/.test(sql)) n++; return original(sql); }) as typeof db.prepare);
  try { call(); } finally { spy.mockRestore(); }
  return n;
};

describe("procedure suggestions are cached until a procedure-review row changes", () => {
  it("a repeat call costs no read, with 3 settled rows or 3,000", () => {
    for (const settled of [3, 3000]) {
      database().exec("DELETE FROM memory_scope_bindings WHERE subject_id='procedure-review'");
      database().exec("BEGIN");
      for (let i = 0; i < settled; i++) put(`psug-old-${i}`, "ember", "applied");
      database().exec("COMMIT");
      put("psug-live", "ember", "suggested");
      expect(listProcedureSuggestionsByBot(database()).get("ember")?.map(v => v.id)).toEqual(["psug-live"]);
      expect(reads(() => listProcedureSuggestionsByBot(database()))).toBe(0);
      expect(reads(() => listProcedureSuggestionsByBot(database(), ["ember"]))).toBe(0);
    }
  });

  it("an insert, an update and a delete each drop the cache; other rows do not", () => {
    database().exec("DELETE FROM memory_scope_bindings WHERE subject_id='procedure-review'");
    listProcedureSuggestionsByBot(database());
    put("psug-a", "ember", "suggested");
    expect(reads(() => listProcedureSuggestionsByBot(database()))).toBe(1);
    expect([...listProcedureSuggestionsByBot(database()).keys()]).toEqual(["ember"]);
    put("psug-a", "ember", "applied");
    expect(listProcedureSuggestionsByBot(database()).size).toBe(0);
    put("psug-b", "dax", "suggested");
    expect(listProcedureSuggestionsByBot(database()).get("dax")).toHaveLength(1);
    database().prepare("DELETE FROM memory_scope_bindings WHERE id='psug-b'").run();
    expect(listProcedureSuggestionsByBot(database()).size).toBe(0);
    expect(reads(() => listProcedureSuggestionsByBot(database()))).toBe(0);
    database().prepare("INSERT INTO memory_scope_bindings VALUES('other','s','system','something-else',1,'granted','{}')").run();
    expect(reads(() => listProcedureSuggestionsByBot(database()))).toBe(0);
  });
});
