// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it } from "vitest";
import { denyLookup } from "./deny-read.ts";
import { CONTENT } from "./testing/writetime-fixture.ts";
import { inheritMarks } from "./revoke-commit.ts";
import { writeRecordLineage } from "./lineage-write.ts";
import { LINEAGE_TURN } from "./schema.ts";
import { stopMemoryRevocation } from "./memory-revocation.ts";
import { testThreadNo, WritetimeFixture } from "./testing/writetime-fixture.ts";
const fixtures: WritetimeFixture[] = [];
afterEach(() => { stopMemoryRevocation(); for (const f of fixtures.splice(0)) f.close(); });

function recordWrite(n: number, indexed = true) {
  const f = new WritetimeFixture(); fixtures.push(f); if (indexed) f.db.exec(LINEAGE_TURN.sql);
  f.cert(true).ready("fresh", true);
  for (let r = 1; r <= 4; r++) {
    f.job(r, 50).pending("*", 1, r);
    f.db.prepare("UPDATE memory_revoke_jobs SET root=? WHERE revoke_id=?").run(JSON.stringify({kind:"line",threadId:"unrelated"}), r);
  }
  const no = testThreadNo(f.db, "fresh");
  f.db.prepare(`WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<?)
    INSERT INTO memory_line_lineage(thread_no,lsn,message_id,turn_lsn)
    SELECT ?,100+i,'m'||i,100 FROM c`).run(n, no);
  f.db.prepare("UPDATE memory_lsn SET next=? WHERE id=1").run(n + 200);
  let examined = 0;
  // Non-deterministic predicate runs on every candidate visited after B-tree
  // bounds, before residual turn/root predicates. Counts examined, not returned.
  f.db.function("examined", (_lsn: unknown) => { examined++; return 1; });
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = sql => prepare(sql.replace(/FROM memory_line_lineage (\w+)( INDEXED BY \w+)?\s+WHERE\s+/g, "FROM memory_line_lineage $1$2 WHERE examined($1.lsn) AND "));
  try {
    writeRecordLineage(f.db, {kind:"record",id:"child",version:1,scopeId:"s-room"},
      {threadId:"fresh",turnId:"writer",turnLsn:n+150,parents:[],denyGeneration:0});
  } finally { f.db.prepare = prepare; }
  const held = f.db.prepare("SELECT 1 FROM memory_deny_pending_scope WHERE scope_id='s-room'").get();
  if (indexed) expect(held).toBeUndefined();
  else expect(held).toBeDefined();
  return examined;
}
it("record inheritance examines bounded rows with four unrelated revokes at 1k and 20k history", () => {
  const small = recordWrite(1000), large = recordWrite(20000);
  console.log(JSON.stringify({small,large}));
  expect(large).toBeLessThanOrEqual(1100);
  expect(large).toBeLessThanOrEqual(small + 16);
});

it("a failed index build bounds the position fallback and conservatively holds overflow", () => {
  const small = recordWrite(1000, false), large = recordWrite(20000, false);
  expect(large).toBeLessThanOrEqual(1100);
  expect(large).toBeLessThanOrEqual(small + 16);
});

const indexedCases: Array<[string, (f: WritetimeFixture) => unknown, boolean]> = [
  ["generated before cap", f => f.reply("fresh", "parent", 150, { turnLsn: 40 }), true],
  ["generated after cap", f => f.reply("fresh", "parent", 150, { turnLsn: 60 }), false],
  ["generated at cap", f => f.reply("fresh", "parent", 150, { turnLsn: 50 }), false],
  ["old generated outside range", f => f.reply("fresh", "old", 80, { turnLsn: 40 }).reply("fresh", "parent", 150, { turnLsn: 60 }), false],
  ["unrelated owner root", f => f.owner("fresh", "parent", 150), false],
  ["targeted owner root", f => f.owner("fresh", "parent", 150).pending("fresh", 1), true],
  ["unknown global root", f => { f.owner("fresh", "parent", 150); f.db.prepare("UPDATE memory_revoke_jobs SET root='{}'").run(); }, true],
  ["seeding", f => { f.reply("fresh", "parent", 150, { turnLsn: 60 }); f.db.prepare("UPDATE memory_revoke_jobs SET state='seeding'").run(); }, true],
  ["orphan line visibility", f => { f.reply("fresh", "parent", 150, { turnLsn: 60 }); f.db.prepare("DELETE FROM memory_revoke_jobs").run(); }, true],
  ["missing lineage", () => {}, true],
  ["candidate overflow", f => { for (let i = 1; i <= 257; i++) f.reply("fresh", `old${i}`, 200 + i, { turnLsn: 40 }); f.reply("fresh", "parent", 150, { turnLsn: 60 }); }, true],
];
it.each(indexedCases)("indexed range privacy: %s", (_name, setup, expected) => {
  const f = new WritetimeFixture(); fixtures.push(f); f.db.exec(LINEAGE_TURN.sql);
  f.cert(true).ready("fresh", true).job(1, 50).pending("*", 1);
  f.db.prepare("UPDATE memory_revoke_jobs SET root=?").run(JSON.stringify({ kind: "line", threadId: "unrelated" }));
  setup(f); f.db.prepare("UPDATE memory_lsn SET next=1000").run();
  if (_name === "orphan line visibility") {
    // A missing job cannot receive a new per-scope hold. Its surviving global
    // pending row must still hold the real generated output at the read gate.
    f.reply("fresh", "result", 999, { turnLsn: 900 });
    f.db.exec("BEGIN");
    inheritMarks(f.db, { kind: "line", threadId: "fresh", lsn: 999 }, [], [{ threadId: "fresh", from: 100, to: 200 }]);
    f.db.exec("COMMIT");
    expect(denyLookup(f.db, { threadId: "fresh", lines: [{ messageId: "result", author: "generated" }] }, CONTENT).get("result")).toMatchObject({ state: "checking", reason: "pending" });
    return;
  }
  f.db.exec("BEGIN");
  inheritMarks(f.db, { kind: "record", ref: { kind: "record", id: "child", version: 1, scopeId: "s-room" }, lsn: 999 }, [], [{ threadId: "fresh", from: 100, to: 200 }]);
  f.db.exec("COMMIT");
  expect(Boolean(f.db.prepare("SELECT 1 FROM memory_deny_pending_scope WHERE scope_id='s-room'").get())).toBe(expected);
});

// Exercise the positional-denial path through the real record writer, including
// candidates outside the carried span. LIMIT on the outer denial rows cannot
// bound a correlated lineage scan.
function positionalRecordWrite(n: number, indexed: boolean, matching = false) {
  const f = new WritetimeFixture(); fixtures.push(f);
  if (indexed) f.db.exec(LINEAGE_TURN.sql);
  f.cert(true).ready("fresh", true);
  for (let r = 1; r <= 4; r++) f.job(r, 50, "done").denyRange("fresh", r, 50, r);
  const no = testThreadNo(f.db, "fresh");
  f.db.prepare(`WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<?)
    INSERT INTO memory_line_lineage(thread_no,lsn,message_id,turn_lsn)
    SELECT ?,100+i,'m'||i,100 FROM c`).run(n, no);
  if (matching) f.db.prepare("UPDATE memory_line_lineage SET turn_lsn=40 WHERE thread_no=? AND lsn=?").run(no, n+100);
  f.db.prepare("UPDATE memory_lsn SET next=? WHERE id=1").run(n + 200);
  let examined = 0;
  f.db.function("examined", (_lsn: unknown) => { examined++; return 1; });
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = sql => prepare(sql.replace(/FROM memory_line_lineage (\w+)( INDEXED BY \w+)?\s+WHERE\s+/g, "FROM memory_line_lineage $1$2 WHERE examined($1.lsn) AND "));
  try {
    writeRecordLineage(f.db, {kind:"record",id:"child",version:1,scopeId:"s-room"},
      {threadId:"fresh",turnId:"writer",turnLsn:n+150,parents:[],denyGeneration:0});
  } finally { f.db.prepare = prepare; }
  const held = Boolean(f.db.prepare("SELECT 1 FROM memory_deny_pending_scope WHERE scope_id='s-room'").get());
  if (!indexed) expect(examined).toBeGreaterThan(0);
  expect(examined, `positional writer examined ${examined} rows for ${n} lines`).toBeLessThanOrEqual(1100);
  expect(held).toBe(matching || !indexed && n > 256);
  return examined;
}
it.each([true, false])("positional denial bounds real writer rows at 1k and 20k history, index=%s", indexed => {
  const small = positionalRecordWrite(1000, indexed), large = positionalRecordWrite(20000, indexed);
  console.log(JSON.stringify({positional:true,indexed,small,large}));
  expect(large).toBeLessThanOrEqual(1100);
  expect(large).toBeLessThanOrEqual(small + 16);
});
it.each([true, false])("positional denial still withholds a matching late generated parent, index=%s", indexed => {
  positionalRecordWrite(200, indexed, true);
});
