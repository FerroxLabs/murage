// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fix round for the sixth upgrade-ui review (lanes/upgui-review/r6/REPORT.md and FABLE-REPORT.md): a filed proof checks its stamp on every use and ends
// with the sources its members rest on; a proof outlives the ordinary writes of a conversation and a restart; recovery looks at a bounded number of proof
// rows and resumes member reads by key; the scope lookup is an index and the retired approvals of old runs are not in the open-card list.
// The client half is in src/state/open-cards.test.ts.
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { insertMessage } from "../message-db.ts";
import { ensureOpenCardIndex, isOpenCardJson } from "../transcript-backfill.ts";
import { SCOPE_OWNER_INDEX, ensureScopeOwnerIndex, validateMemorySchema } from "./schema.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

// The persisted root-set proofs this round tested were removed in round 8 (upgrade-fix-r8.test.ts): their reproductions are kept there against the
// in-memory proofs that replaced them.

// ── P2-3: the scope lookup is an index, orphaned approvals are not open cards ──────────────────────────────────────────────────
it("r7-P2-3: scope lookup by (kind, owner) is an index search at 20,000 and 200,000 scopes; the index is optional, exact, and built after the start", () => {
  for (const n of [20_000, 200_000]) {
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    const db = database();
    db.prepare("WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<?) INSERT INTO memory_scopes SELECT 'c'||i,'conversation','conv'||i,'[]',0 FROM k").run(n);
    db.exec(`DROP INDEX IF EXISTS ${SCOPE_OWNER_INDEX}`); // an upgraded file: the schema step did not build it
    const plan = () => db.prepare("EXPLAIN QUERY PLAN SELECT id FROM memory_scopes WHERE kind=? AND owner_key=?").all("conversation", "conv5").map((row) => String(row.detail)).join(" | ");
    expect(plan()).toMatch(/SCAN memory_scopes/);
    expect(() => validateMemorySchema(db)).not.toThrow(); // optional: absent is accepted
    ensureScopeOwnerIndex(db); // the recovery scheduler's first pass
    expect(plan()).toMatch(new RegExp(`SEARCH memory_scopes USING (COVERING )?INDEX ${SCOPE_OWNER_INDEX}`));
    expect(() => validateMemorySchema(db)).not.toThrow(); // and exact when present
  }
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  expect(Boolean(database().prepare(`SELECT 1 FROM sqlite_schema WHERE type='index' AND name='${SCOPE_OWNER_INDEX}'`).get())).toBe(true); // a fresh installation has it
});
it("r7-P2-3: a retired (orphaned) approval is not an open card, so the list stays the size of the really open cards at 20,000 and 200,000 old approvals", { timeout: 120_000 }, () => {
  expect(isOpenCardJson({ kind: "options", card: { requestId: "r", orphaned: true } })).toBe(false);
  expect(isOpenCardJson({ kind: "options", card: { requestId: "r" } })).toBe(true);
  for (const n of [20_000, 200_000]) {
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    const db = database();
    const put = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
    db.exec("BEGIN");
    for (let i = 1; i <= n; i++) {
      const message = { id: `a${i}`, at: i, role: "bot", kind: "options", text: "x", parentId: null, card: { title: "c", options: [], requestId: `r${i}`, tool: "Bash", orphaned: true } };
      put.run("t", message.id, i, "bot", "options", "x", JSON.stringify(message));
    }
    db.exec("COMMIT");
    db.exec("DELETE FROM open_card; DELETE FROM transcript_index_state WHERE name='open_card'");
    // the real backfill builds the list
    ensureOpenCardIndex(db);
    expect(Number(db.prepare("SELECT count(*) AS n FROM open_card").get()!.n)).toBe(0);
    // a live card is listed, and leaves the list when the start retires it
    insertMessage("t", { id: "live", at: n + 1, role: "bot", kind: "options", text: "ask", parentId: null, card: { title: "c", options: [], requestId: "live", tool: "Bash" } } as never);
    expect(Number(db.prepare("SELECT count(*) AS n FROM open_card").get()!.n)).toBe(1);
  }
});
