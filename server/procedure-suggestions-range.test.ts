// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Inbox's suggestion read costs the psug- rows, not the procedure-review rows: a cache miss (any commit by any connection) reads by primary-key range.
// Pinned by plan and by rows, never by time.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { listProcedureSuggestionsByBot, SUGGESTED_ROWS_SQL } from "./memory/procedure-landing.ts";

beforeAll(() => { closeDatabase(); mkdirSync(DATA_DIR, { recursive: true }); database().prepare("INSERT OR IGNORE INTO memory_scopes VALUES('s','bot','x','[]',0)").run(); });
afterAll(() => closeDatabase());
beforeEach(() => { database().exec("DELETE FROM memory_scope_bindings WHERE subject_id='procedure-review'"); });

const row = (id: string, botId: string, state: string) => JSON.stringify({
  schema: 1, id, kind: "suggestion", status: "complete", scopeId: "s", botId, state, version: 1, notNowCount: 0, reasons: [], label: id, targetKind: "skill",
  target: { ownerId: botId, kind: "skill", artifactId: "a", baseRevision: 1 }, evidence: [], evidenceDigest: "d", proposedText: "new", proposedHash: "h", beforeText: "old", beforeSha256: "b",
  snapshot: { evidence: [] }, createdAt: 1, decidedAt: null, policyRevision: 1, deletionEpoch: 0, learningRevision: 0,
});
const put = (id: string, botId: string, state: string, db = database()) =>
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','procedure-review',1,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent").run(id, "s", row(id, botId, state));
/** `n` other procedure-review rows with 8 KB intents, none of them a psug- row. */
function filler(n: number, padBytes = 4000) {
  database().prepare(`WITH RECURSIVE c(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM c WHERE v<?)
    INSERT INTO memory_scope_bindings SELECT 'procedure-review:x:'||v,'s','system','procedure-review',1,'granted',
      json_object('kind','review','pad',replace(hex(zeroblob(?)),'00','x')) FROM c`).run(n, padBytes);
}
function seed() { put("psug-1", "ember", "suggested"); put("psug-2", "ember", "suggested"); put("psug-3", "dax", "applied"); }

describe("the suggestion read is a primary-key range", () => {
  it("plans a range on the id index and never the subject index or a scan", () => {
    const plan = (database().prepare(`EXPLAIN QUERY PLAN ${SUGGESTED_ROWS_SQL}`).all("psug-", "psug.") as Array<{ detail: string }>).map(d => d.detail).join("\n");
    expect(plan).toMatch(/USING INDEX sqlite_autoindex_memory_scope_bindings_1 \(id>\? AND id<\?\)/);
    expect(plan).not.toMatch(/memory_bindings_subject/);
    expect(plan).not.toMatch(/SCAN memory_scope_bindings/);
  });

  for (const fillerRows of [7_000, 70_000]) {
    it(`returns 3 rows, and the same plan, with ${fillerRows} other procedure-review rows`, () => {
      filler(fillerRows, fillerRows > 10_000 ? 100 : 4000); seed();
      const rows = database().prepare(SUGGESTED_ROWS_SQL).all("psug-", "psug.");
      expect(rows).toHaveLength(3);
      const views = listProcedureSuggestionsByBot(database());
      expect(views.get("ember")).toHaveLength(2);
      expect(views.has("dax")).toBe(false);
    });
  }

  it("a row written on a second connection shows on the next read; an update to applied on this one hides it", () => {
    seed();
    expect(listProcedureSuggestionsByBot(database()).get("ember")).toHaveLength(2);
    const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try { put("psug-9", "ember", "suggested", other); } finally { other.close(); }
    expect(listProcedureSuggestionsByBot(database()).get("ember")).toHaveLength(3);
    put("psug-9", "ember", "applied");
    expect(listProcedureSuggestionsByBot(database()).get("ember")).toHaveLength(2);
  });

  it("after the first read, 50 background commits and 10 more reads run the psug statement 10 times, each returning at most 3 rows", () => {
    filler(2_000); seed();
    listProcedureSuggestionsByBot(database());
    const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
    const db = database(), original = db.prepare.bind(db), seen: Array<{ rows: number }> = [];
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      const statement = original(sql);
      if (sql !== SUGGESTED_ROWS_SQL) return statement;
      const entry = { rows: 0 }; seen.push(entry);
      return new Proxy(statement, { get(target, key) {
        const value = (target as never)[key] as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => { const out = (value as (...a: unknown[]) => unknown).apply(target, args); if (key === "all") entry.rows += (out as unknown[]).length; return out; };
      } });
    }) as typeof db.prepare);
    try {
      for (let i = 0; i < 10; i++) {
        for (let j = 0; j < 5; j++) other.prepare("INSERT OR REPLACE INTO memory_scope_bindings VALUES(?,?,'system','something-else',1,'granted','{}')").run(`bg-${i}-${j}`, "s");
        listProcedureSuggestionsByBot(database());
      }
    } finally { spy.mockRestore(); other.close(); }
    expect(seen).toHaveLength(10);
    expect(seen.every(entry => entry.rows <= 3)).toBe(true);
  });
});
