// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud door v2 (CLOUD-DOOR-V2-DESIGN.md r4 4B): migration 0107 applied over a POPULATED 0106-era database shaped like staging (live and
// deleted homes, armed/unarmed/sent door notices, step-up events, pair holds). Plain SQLite (node:sqlite), the same SQL D1 runs.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const dir = new URL("../migrations/", import.meta.url);
const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const num = (f) => Number(f.slice(0, 4));
const sql = (f) => readFileSync(new URL(f, dir), "utf8");
const rows = (db, q, ...a) => db.prepare(q).all(...a).map((r) => ({ ...r }));

/** One row of `table` with every NOT NULL column without a default filled (text 'x', numbers 1), then `values`. */
function insert(db, table, values) {
  const cols = rows(db, `SELECT name,type,"notnull" AS nn,dflt_value AS d,pk FROM pragma_table_info('${table}')`);
  const row = {};
  for (const c of cols) if (c.nn && c.d === null) row[c.name] = /INT|REAL|NUM/i.test(c.type) ? 1 : "x";
  Object.assign(row, values);
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((k) => row[k]));
}

function at106() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=OFF");
  for (const f of files.filter((f) => num(f) <= 106)) db.exec(sql(f));
  insert(db, "cloud_homes", { id: "home-live", owner_id: "acct-1", desired_state: "ready", observed_state: "ready", generation: 3 });
  insert(db, "cloud_homes", { id: "home-old", owner_id: "acct-2", desired_state: "deleted", observed_state: "deleted", generation: 1 });
  const notice = (account, home, v) => db.prepare(`INSERT INTO cloud_door_notices (account_id,home_id,created_at,sent_at,attempts,next_attempt_at,armed,handouts,armed_by,delivered)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(account, home, v.created, v.sent, v.attempts, v.next, v.armed, v.handouts, v.armedBy, v.delivered);
  notice("acct-1", "home-live", { created: 100, sent: null, attempts: 2, next: 500, armed: 1, handouts: 3, armedBy: 1, delivered: 1 }); // legacy armed, unsent
  notice("acct-3", "home-live", { created: 110, sent: 200, attempts: 1, next: 120, armed: 1, handouts: 1, armedBy: 1, delivered: 1 }); // sent
  notice("acct-4", "home-live", { created: 130, sent: null, attempts: 0, next: 140, armed: 0, handouts: 1, armedBy: 1, delivered: 0 }); // withdrawn
  db.prepare("INSERT INTO cloud_stepup_events (id,user_id,session_id,kind,intent_id,challenge_id,at) VALUES ('e1','acct-1','sess-a','granted','i1','c1',1000)").run();
  insert(db, "cloud_recovery_holds", { id: "hold-1", home_id: "home-live", action: "pair", generation: 3, started_at: 1, completes_at: 2, completed_at: 2 });
  return db;
}
function migrated() {
  const db = at106();
  assert.deepEqual(files.filter((f) => num(f) > 106).map(num)[0], 107); // later lanes (0109 Flux fence) follow 0107
  db.exec(`BEGIN; ${sql("0107_door_v2.sql")}; COMMIT;`); // one transaction, as D1 applies a migration
  return db;
}

test("D1 migration 0107: legacy notice rows are kept with session_id '' and bind '', unchanged otherwise", () => {
  const db = migrated();
  assert.deepEqual(rows(db, "SELECT * FROM cloud_door_notices ORDER BY account_id"), [
    { account_id: "acct-1", home_id: "home-live", session_id: "", bind: "", created_at: 100, sent_at: null, attempts: 2, next_attempt_at: 500, armed: 1, handouts: 3, armed_by: 1, delivered: 1, claim_id: null },
    { account_id: "acct-3", home_id: "home-live", session_id: "", bind: "", created_at: 110, sent_at: 200, attempts: 1, next_attempt_at: 120, armed: 1, handouts: 1, armed_by: 1, delivered: 1, claim_id: null },
    { account_id: "acct-4", home_id: "home-live", session_id: "", bind: "", created_at: 130, sent_at: null, attempts: 0, next_attempt_at: 140, armed: 0, handouts: 1, armed_by: 1, delivered: 0, claim_id: null },
  ]);
  assert.deepEqual(rows(db, "SELECT name FROM pragma_index_list('cloud_door_notices') WHERE origin='c' ORDER BY name").map((r) => r.name),
    ["cloud_door_notices_due", "cloud_door_notices_home", "cloud_door_notices_unarmed"]);
  assert.deepEqual(rows(db, "SELECT name FROM pragma_index_info('sqlite_autoindex_cloud_door_notices_1') ORDER BY seqno").map((r) => r.name),
    ["account_id", "home_id", "session_id", "bind"]);
});

test("D1 migration 0107: the legacy armed unsent row is what the notice claim takes (no predicate excludes '')", () => {
  const db = migrated();
  const claimed = rows(db, `UPDATE cloud_door_notices SET claim_id=?, next_attempt_at=? WHERE account_id=? AND home_id=? AND armed=1 AND sent_at IS NULL
    AND next_attempt_at<=? RETURNING session_id, bind, delivered`, "c-1", 9999, "acct-1", "home-live", 600);
  assert.deepEqual(claimed, [{ session_id: "", bind: "", delivered: 1 }]);
  // A second key for the same (account, home) is a separate row.
  db.prepare(`INSERT INTO cloud_door_notices (account_id,home_id,session_id,bind,created_at,next_attempt_at,armed) VALUES ('acct-1','home-live','sess-a',?,1,1,1)`).run("ab".repeat(32));
  assert.equal(rows(db, "SELECT COUNT(*) AS n FROM cloud_door_notices WHERE account_id='acct-1'")[0].n, 2);
});

test("D1 migration 0107: slots, the step-up session index, door_version and the hold reservation columns", () => {
  const db = migrated();
  const slot = db.prepare("INSERT OR IGNORE INTO cloud_door_notice_slots (account_id,home_id,hour,n,at) VALUES ('a','h',7,?,1)");
  assert.equal(slot.run(1).changes, 1);
  assert.equal(slot.run(1).changes, 0);
  assert.throws(() => db.prepare("INSERT INTO cloud_door_notice_slots (account_id,home_id,hour,n,at) VALUES ('a','h',7,4,1)").run()); // n is 1..3
  assert.deepEqual(rows(db, "SELECT name FROM pragma_index_info('cloud_stepup_events_session') ORDER BY seqno").map((r) => r.name), ["user_id", "session_id", "kind", "at"]);
  assert.deepEqual(rows(db, "SELECT id,door_version FROM cloud_homes ORDER BY id"), [{ id: "home-live", door_version: null }, { id: "home-old", door_version: null }]);
  assert.deepEqual(rows(db, "SELECT id,reserved_by,reserved_until,spent_device_digest FROM cloud_recovery_holds"), [{ id: "hold-1", reserved_by: null, reserved_until: null, spent_device_digest: null }]);
  assert.deepEqual(rows(db, "SELECT session_id FROM cloud_stepup_events"), [{ session_id: "sess-a" }]);
});
