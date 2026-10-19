// SPDX-License-Identifier: AGPL-3.0-or-later
// Astra INTEGRATED-10: the unapplied migrations 0102 -> 0103 -> 0105 -> 0106 applied over a POPULATED 0101-era database (confirmed and
// unconfirmed reversals, active delivery claims, expired debt, historical cancellations, lost disputes with and without a known payment
// amount). Plain SQLite (node:sqlite), the same SQL D1 runs; run with `node --test test-node/`.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const dir = new URL("../migrations/", import.meta.url);
const fixtures = new URL("../test/fixtures/migration-0106/", import.meta.url);
const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const num = (f) => Number(f.slice(0, 4));
const sql = (u) => readFileSync(u, "utf8");

function migrated() {
  const db = new DatabaseSync(":memory:");
  for (const f of files.filter((f) => num(f) <= 101)) db.exec(sql(new URL(f, dir)));
  db.exec(sql(new URL("0101-populated.sql", fixtures)));
  const pending = files.filter((f) => num(f) > 101); // applied in staging/prod order; 0107 is also covered by test-node/door-v2-migration.test.mjs
  assert.deepEqual(pending.map(num), [102, 103, 105, 106, 107, 109]); // 0104 reserved, never present; 0108 reserved; 0107 door v2; 0109 lane H1
  for (const f of pending) {
    db.exec(`BEGIN; ${sql(new URL(f, dir))}; COMMIT;`); // one transaction each, as D1 applies a migration
    if (num(f) === 105) db.exec(sql(new URL("0105-disputes.sql", fixtures)));
  }
  return db;
}
const rows = (db, q) => db.prepare(q).all().map((r) => ({ ...r }));

test("INTEGRATED-10 migration: accounts backfilled from the dropped flags, never inventing a confirmation", () => {
  const db = migrated();
  const acct = Object.fromEntries(rows(db, "SELECT * FROM flux_grant_accounts").map((r) => [r.grant_id, r]));
  const pick = (id) => { const a = acct[id]; return [a.router_state, a.applied_microcents, a.desired_microcents, a.sized, a.paid_cents, a.paid_source, a.debt_since]; };
  assert.deepEqual(pick("g1_delivered"), ["delivered", 10000000, 10000000, 1, null, null, null]);
  assert.deepEqual(pick("g2_confirmed"), ["revoked", 0, 0, 1, 4900, "refund_coverage", null]); // status reversed: the confirmed revoke
  assert.deepEqual(pick("g3_unconfirmed"), ["revoking", 10000000, 0, 1, 4900, "refund_coverage", 100]); // 'done' + attempts is NOT revoked
  assert.deepEqual(pick("g4_folded"), ["delivered", 10000000, 10000000, 1, null, null, null]); // done without an attempt: nothing removed
  assert.deepEqual(pick("g5_claim"), ["maybe", 0, 10000000, 1, null, null, 100]);
  assert.deepEqual(pick("g6_expired_debt"), ["none", 0, 10000000 - Math.floor(10000000 * 1000 / 4900), 1, 4900, "refund_coverage", 100]); // expired: still owed
  assert.deepEqual(pick("g8_lost_ops"), ["delivered", 10000000, 0, 1, 4900, "refund_ops", 100]); // sized from the refund operation's payment
  assert.deepEqual(pick("g9_lost_unsized"), ["delivered", 10000000, 10000000, 0, null, null, 100]); // unknown amount: held unsized, alerted
  assert.deepEqual(pick("g10_claim_and_revoke"), ["revoking", 0, 10000000, 1, null, null, 100]);
  // The dropped columns are gone; every grant has its account.
  assert.equal(rows(db, "SELECT name FROM pragma_table_info('flux_grants') WHERE name LIKE 'reversal%'").length, 0);
  assert.equal(rows(db, "SELECT COUNT(*) AS n FROM flux_grants g WHERE NOT EXISTS (SELECT 1 FROM flux_grant_accounts a WHERE a.grant_id=g.grant_id)")[0].n, 0);
});

test("INTEGRATED-10 migration: outstanding ownership becomes open dispatches; causes and provenance kept", () => {
  const db = migrated();
  assert.deepEqual(rows(db, "SELECT dispatch_id,grant_id,kind,state FROM flux_grant_dispatches ORDER BY dispatch_id"), [
    { dispatch_id: "migration:revoke:g10_claim_and_revoke", grant_id: "g10_claim_and_revoke", kind: "revoke", state: "open" },
    { dispatch_id: "migration:revoke:g3_unconfirmed", grant_id: "g3_unconfirmed", kind: "revoke", state: "open" },
    { dispatch_id: "tok10", grant_id: "g10_claim_and_revoke", kind: "deliver", state: "superseded" },
    { dispatch_id: "tok5", grant_id: "g5_claim", kind: "deliver", state: "open" },
  ]);
  assert.deepEqual(rows(db, "SELECT grant_id,cause,ref,returned_cents,retained_microcents FROM flux_grant_causes ORDER BY grant_id,cause"), [
    { grant_id: "g10_claim_and_revoke", cause: "legacy_reversal", ref: "migration:0106", returned_cents: 0, retained_microcents: null },
    { grant_id: "g2_confirmed", cause: "legacy_reversal", ref: "migration:0106", returned_cents: 0, retained_microcents: null },
    { grant_id: "g2_confirmed", cause: "refund", ref: "pi_2", returned_cents: 4900, retained_microcents: null },
    { grant_id: "g3_unconfirmed", cause: "legacy_reversal", ref: "migration:0106", returned_cents: 0, retained_microcents: null },
    { grant_id: "g3_unconfirmed", cause: "refund", ref: "pi_3", returned_cents: 4900, retained_microcents: null },
    { grant_id: "g4_folded", cause: "legacy_reversal", ref: "migration:0106", returned_cents: 0, retained_microcents: null },
    { grant_id: "g6_expired_debt", cause: "refund", ref: "pi_6", returned_cents: 1000, retained_microcents: null },
    { grant_id: "g7_cancelled", cause: "cancellation", ref: "migration:0106", returned_cents: 0, retained_microcents: 10000000 },
    { grant_id: "g8_lost_ops", cause: "dispute_loss", ref: "dp8", returned_cents: 4900, retained_microcents: null },
    { grant_id: "g9_lost_unsized", cause: "dispute_loss", ref: "dp9", returned_cents: 4900, retained_microcents: null },
  ]);
  const prov = rows(db, "SELECT evidence FROM flux_grant_causes WHERE grant_id='g3_unconfirmed' AND cause='legacy_reversal'")[0].evidence;
  assert.match(prov, /reversal_state=done;reason=refund;attempts=2;last_attempt_at=300;status=done;unconfirmed/);
});

test("INTEGRATED-10 migration: acknowledged cancellations are history from the start; unacknowledged ones are not", () => {
  const db = migrated();
  assert.deepEqual(rows(db, "SELECT home_id,event_id,line,version,recorded_at FROM cloud_payment_cancellations ORDER BY event_id"), [
    { home_id: "h1", event_id: "ev_c1", line: "sub_a", version: 300, recorded_at: 20 },
    { home_id: "h2", event_id: "ev_c2", line: "", version: 310, recorded_at: 21 },
  ]);
});

test("INTEGRATED-10 migration: the CHECKs hold the ledger to its rules", () => {
  const db = migrated();
  const fails = (q) => assert.throws(() => db.exec(q), /CHECK|constraint/i, q);
  fails("UPDATE flux_grant_accounts SET desired_microcents=5 WHERE grant_id='g2_confirmed'"); // a sized D is the formula
  fails("UPDATE flux_grant_accounts SET sized=0 WHERE grant_id='g1_delivered'"); // unsized only with money returned and no amount
  fails("UPDATE flux_grant_accounts SET paid_cents=4900,paid_source='operator',sized=1,desired_microcents=0 WHERE grant_id='g9_lost_unsized'"); // sizing needs evidence
  db.exec("UPDATE flux_grant_accounts SET paid_cents=4900,paid_source='operator',sizing_evidence='Stripe invoice in_9: 49.00',sized_by='ops',sized=1,desired_microcents=0 WHERE grant_id='g9_lost_unsized'");
  fails("INSERT INTO flux_grant_dispatches (dispatch_id,grant_id,kind,revision,target_microcents,claimed_at,expires_at,state,applied_microcents,evidence,by) VALUES ('x','g1_delivered','operator',1,0,1,2,'applied',0,'e','ops')"); // a receipt names its adjustment
  assert.throws(() => db.exec("INSERT INTO flux_grant_dispatches (dispatch_id,grant_id,kind,revision,target_microcents,claimed_at,expires_at) VALUES ('y','g5_claim','deliver',1,0,1,2)"), /UNIQUE/); // one open dispatch per grant
});

// ── Astra INTEGRATED-11: the B4 ledger itself (b4-flux-ledger.ts, loaded with Node's type stripping) over the migrated database, through a
// minimal D1 shim (prepare/bind/first/all/run, batch = one transaction). No router exists here: nothing can be sent.
register("data:text/javascript," + encodeURIComponent(`export async function resolve(s, c, n) {
  if ((s.startsWith("./") || s.startsWith("../")) && !/\\.[cm]?[jt]s$/.test(s)) { try { return await n(s + ".ts", c); } catch {} }
  return n(s, c);
}`));
const ledger = await import("../src/b4-flux-ledger.ts");
function d1(raw) {
  const exec = (sql, binds) => raw.prepare(sql);
  const stmt = (sql, binds = []) => ({
    sql, binds,
    bind: (...b) => stmt(sql, b),
    first: async () => { const r = exec(sql).get(...binds); return r ? { ...r } : null; },
    all: async () => ({ results: exec(sql).all(...binds).map((r) => ({ ...r })) }),
    run: async () => ({ meta: { changes: Number(exec(sql).run(...binds).changes) } }),
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (stmts) => {
      raw.exec("BEGIN");
      try {
        // D1 returns a statement's RETURNING rows as its results.
        const out = stmts.map((s) => {
          if (/\bRETURNING\b/i.test(s.sql)) { const r = raw.prepare(s.sql).all(...s.binds).map((x) => ({ ...x })); return { results: r, meta: { changes: r.length } }; }
          return { results: [], meta: { changes: Number(raw.prepare(s.sql).run(...s.binds).changes) } };
        });
        raw.exec("COMMIT");
        return out;
      } catch (e) { raw.exec("ROLLBACK"); throw e; }
    },
  };
}
const ledgerAlerts = (raw) => Object.fromEntries(rows(raw, `SELECT subject,kind,resolved_at IS NULL AS open,json_extract(detail,'$.blockedBy') AS blocked
  FROM cloud_alerts WHERE kind IN ('credit.delivery_owed','credit.removal_owed')`).map((r) => [r.subject, [r.kind, r.open, r.blocked]]));
async function offSweep(db, now) { await db.batch([...ledger.refreshStatements(db, ledger.allScope, now), ...ledger.syncAlertStatements(db, ledger.allScope, now, false)]); }

test("INTEGRATED-11 Flux off: migrated revoking and open-delivery rows are blocked debts with their alerts kept across sweeps (before: suppressed as automatic work)", async () => {
  const raw = migrated(); const db = d1(raw);
  await offSweep(db, 1_000_000);
  await offSweep(db, 2_000_000);
  const a = ledgerAlerts(raw);
  assert.deepEqual(a.g3_unconfirmed, ["credit.removal_owed", 1, "flux_off"]); // the migrated unconfirmed revoke (open revoke dispatch)
  assert.deepEqual(a.g5_claim, ["credit.delivery_owed", 1, "flux_off"]); // the migrated delivery claim (open delivery dispatch)
  assert.deepEqual(a.g8_lost_ops, ["credit.removal_owed", 1, "flux_off"]); // fully returned, revocable: nothing automatic while off
  assert.deepEqual(a.g10_claim_and_revoke, ["credit.delivery_owed", 1, "flux_off"]);
  assert.deepEqual(a.g9_lost_unsized, ["credit.removal_owed", 1, "unsized_return"]);
  assert.equal(a.g1_delivered, undefined); // nothing owed: no alert
  assert.equal(a.g2_confirmed, undefined);
});

test("INTEGRATED-11/12 Flux off: the operator's receipts of migrated obligations stay PENDING VERIFICATION (no stored balance moves, alerts kept) with no router call; a contradicting receipt, a restoration after an unconfirmed revoke (R10) and a foreign reference (R8b) are refused; only Flux's matching record applies one", async () => {
  const raw = migrated(); const db = d1(raw);
  await offSweep(db, 1_000_000);
  const autoBefore = rows(raw, "SELECT dispatch_id,state FROM flux_grant_dispatches WHERE kind<>'operator' ORDER BY dispatch_id");
  // The open migrated revoke may still execute: no plain claim; a WRITTEN tombstone (with evidence) supersedes it.
  const plain = await ledger.operatorClaim(db, { grantId: "g3_unconfirmed", by: "ops", now: 1_000_100 });
  assert.equal(plain.claimed, false);
  const c3 = await ledger.operatorClaim(db, { grantId: "g3_unconfirmed", by: "ops", evidence: "wrote the tombstone of g3 in the Flux admin", tombstone: true, now: 1_000_200 });
  assert.equal(c3.claimed, true);
  const c5 = await ledger.operatorClaim(db, { grantId: "g5_claim", by: "ops", evidence: "wrote the tombstone of g5 in the Flux admin", tombstone: true, now: 1_000_300 });
  const c10 = await ledger.operatorClaim(db, { grantId: "g10_claim_and_revoke", by: "ops", evidence: "wrote the tombstone of g10 in the Flux admin", tombstone: true, now: 1_000_400 });
  const receipt = (c, grantId, applied, ref = c.adjustmentRef) => ledger.operatorApplied(db, { grantId, token: c.token, revision: c.account.revision, wireRevision: c.wireRevision ?? undefined, appliedMicrocents: applied,
    adjustmentRef: ref, evidence: "Flux admin adjustment, memo = the issued reference", by: "ops", now: 1_000_500, live: false });
  assert.equal(await receipt(c3, "g3_unconfirmed", 0, c5.adjustmentRef), "adjustment_ref_mismatch"); // another claim's reference
  const balances = () => rows(raw, "SELECT grant_id,applied_microcents,desired_microcents,router_state FROM flux_grant_accounts ORDER BY grant_id");
  const balancesBefore = balances();
  // INTEGRATED-12 (R8c): no Flux read while off: every receipt is PENDING VERIFICATION and moves no stored balance.
  assert.equal(await receipt(c3, "g3_unconfirmed", 0), "pending_verification"); // fully refunded: nothing held
  assert.equal(await receipt(c5, "g5_claim", 1), "pending_verification"); // a WRONG amount (10,000,000 was credited by hand)
  assert.equal(await receipt(c5, "g5_claim", 1), "pending_verification"); // the same receipt again
  assert.equal(await receipt(c5, "g5_claim", 10000000), "receipt_conflict"); // contradicts the pending one
  assert.equal(await receipt(c10, "g10_claim_and_revoke", 10000000), "termination_unconfirmed"); // its revoke may still execute
  assert.equal(await receipt(c10, "g10_claim_and_revoke", 0), "pending_verification");
  await offSweep(db, 2_000_000);
  assert.deepEqual(balances(), balancesBefore);
  const a = ledgerAlerts(raw);
  assert.deepEqual(a.g3_unconfirmed, ["credit.removal_owed", 1, "pending_verification"]); // kept, showing the pending receipt
  assert.deepEqual(a.g5_claim, ["credit.delivery_owed", 1, "pending_verification"]);
  assert.deepEqual(a.g10_claim_and_revoke.slice(0, 2), ["credit.delivery_owed", 1]); // the restoration stays owed, alerted
  const pending = JSON.parse(rows(raw, "SELECT detail FROM cloud_alerts WHERE subject='g5_claim'")[0].detail).pendingReceipt;
  assert.equal(pending.appliedMicrocents, 1); assert.equal(pending.adjustmentRef, c5.adjustmentRef); assert.equal(pending.state, "pending_verification");
  // Only Flux's own record of the adjustment, with the SAME amount, applies a receipt (read by the route only while Flux is on).
  const verify = (c, grantId, applied, held) => ledger.operatorApplied(db, { grantId, token: c.token, revision: c.account.revision, wireRevision: c.wireRevision ?? undefined, appliedMicrocents: applied,
    adjustmentRef: c.adjustmentRef, evidence: "Flux admin adjustment, memo = the issued reference", by: "ops", now: 2_000_100, live: false, verified: { appliedMicrocents: held } });
  assert.equal(await verify(c5, "g5_claim", 1, 10000000), "verification_mismatch");
  assert.deepEqual(balances(), balancesBefore);
  assert.equal(await verify(c3, "g3_unconfirmed", 0, 0), "applied");
  await offSweep(db, 2_000_200);
  assert.deepEqual(ledgerAlerts(raw).g3_unconfirmed.slice(0, 2), ["credit.removal_owed", 0]); // settled once verified
  // No automatic dispatch was opened or completed: the migrated ones were only superseded by the operator's tombstone claims.
  const autoAfter = rows(raw, "SELECT dispatch_id,state FROM flux_grant_dispatches WHERE kind<>'operator' ORDER BY dispatch_id");
  assert.deepEqual(autoAfter.map((r) => r.dispatch_id), autoBefore.map((r) => r.dispatch_id));
  assert.equal(autoAfter.filter((r) => r.state === "open").length, 0);
  assert.equal(rows(raw, "SELECT COUNT(*) AS n FROM flux_grant_dispatches WHERE kind<>'operator' AND state='applied'")[0].n, 0);
});

// ── Astra INTEGRATED-13 P1 (reachable with Flux off): a PENDING receipt keeps its obligation open whatever the balances say. No router exists
// here (nothing can be sent); the stored applied balance (what Flux holds: the customer's prepaid and spent credit are never in it) never moves.
test("INTEGRATED-13 P1 pending receipts stay in operational accounting: a reinstatement, a refund failure or a sizing that brings desired back to the stored applied balance never resolves the alert while a receipt is pending", async () => {
  const raw = migrated(); const db = d1(raw);
  await offSweep(db, 1_000_000);
  const claim = async (grantId) => { const c = await ledger.operatorClaim(db, { grantId, by: "ops", now: 1_000_100 }); assert.equal(c.claimed, true); return c; };
  const receipt = (c, grantId, applied, sizing) => ledger.operatorApplied(db, { grantId, token: c.token, revision: c.account.revision, wireRevision: c.wireRevision ?? undefined, appliedMicrocents: applied,
    adjustmentRef: c.adjustmentRef, evidence: "Flux admin adjustment, memo = the issued reference", by: "ops", now: 1_000_200, live: false, ...(sizing ? { sizing } : {}) });
  const applied = () => Object.fromEntries(rows(raw, "SELECT grant_id,applied_microcents FROM flux_grant_accounts").map((r) => [r.grant_id, r.applied_microcents]));
  const appliedBefore = applied();
  // 1. The reproduced sequence: g8 (lost dispute, fully returned) has its REMOVAL receipt pending; the dispute is then reinstated (won).
  const c8 = await claim("g8_lost_ops");
  assert.equal(await receipt(c8, "g8_lost_ops", 0), "pending_verification");
  // 2. A restoration receipt pending on g2 (its refund failed: credit owed back), then the refund succeeds again.
  raw.exec("UPDATE refund_coverage SET covered_cents=0 WHERE payment_intent='pi_2'");
  await offSweep(db, 1_000_300);
  const c2 = await claim("g2_confirmed");
  assert.equal(await receipt(c2, "g2_confirmed", 10000000), "pending_verification");
  // 3. A sizing with a pending removal receipt on g9 (unsized lost dispute), then that dispute is reinstated too.
  const c9 = await claim("g9_lost_unsized");
  assert.equal(await receipt(c9, "g9_lost_unsized", 0, { paidCents: 4900, evidence: "Stripe invoice in_9: 49.00" }), "pending_verification");
  raw.exec("UPDATE payment_disputes SET outcome='won',returned_cents=0 WHERE dispute_id IN ('dp8','dp9')");
  raw.exec("UPDATE refund_coverage SET covered_cents=4900 WHERE payment_intent='pi_2'");
  for (const t of [2_000_000, 3_000_000]) await offSweep(db, t);
  const acct = Object.fromEntries(rows(raw, "SELECT grant_id,desired_microcents AS d,applied_microcents AS a FROM flux_grant_accounts").map((r) => [r.grant_id, [r.d, r.a]]));
  // desired == the stored applied balance on all three: before the fix the off-state sweep resolved each alert, hiding the unverified receipt.
  assert.deepEqual([acct.g8_lost_ops, acct.g2_confirmed, acct.g9_lost_unsized], [[10000000, 10000000], [0, 0], [10000000, 10000000]]);
  const a = ledgerAlerts(raw);
  assert.deepEqual(a.g8_lost_ops.slice(1), [1, "pending_verification"]);
  assert.deepEqual(a.g2_confirmed.slice(1), [1, "pending_verification"]);
  assert.deepEqual(a.g9_lost_unsized.slice(1), [1, "pending_verification"]);
  const pending = JSON.parse(rows(raw, "SELECT detail FROM cloud_alerts WHERE subject='g8_lost_ops'")[0].detail).pendingReceipt;
  assert.deepEqual([pending.state, pending.appliedMicrocents, pending.adjustmentRef], ["pending_verification", 0, c8.adjustmentRef]);
  // Nothing moved the stored balances, and no automatic dispatch exists or was completed.
  assert.deepEqual(applied(), appliedBefore);
  assert.equal(rows(raw, "SELECT COUNT(*) AS n FROM flux_grant_dispatches WHERE kind<>'operator' AND state='applied'")[0].n, 0);
  // Verification (Flux's own record of the adjustment, same amount) is what ends it: g8's verified receipt says Flux holds 10,000,000.
  const v = await ledger.operatorApplied(db, { grantId: "g8_lost_ops", token: c8.token, revision: c8.account.revision, wireRevision: c8.wireRevision ?? undefined, appliedMicrocents: 0, adjustmentRef: c8.adjustmentRef,
    evidence: "Flux admin adjustment", by: "ops", now: 3_000_100, live: false, verified: { appliedMicrocents: 0 } });
  assert.equal(v, "applied");
  await offSweep(db, 3_000_200);
  // Applied 0 by evidence now, desired 10,000,000 after the reinstatement: the restoration is owed and stays alerted (no longer pending).
  assert.deepEqual(ledgerAlerts(raw).g8_lost_ops.slice(0, 2), ["credit.delivery_owed", 1]);
  assert.notEqual(ledgerAlerts(raw).g8_lost_ops[2], "pending_verification");
});

test("INTEGRATED-13 migration delta: refund_ops.wake_gen (the hold-release generation) defaults to 0 on existing rows; the frontier carries its lap horizon", () => {
  const db = migrated();
  assert.deepEqual(rows(db, "SELECT id,wake_gen FROM refund_ops"), [{ id: "op8", wake_gen: 0 }]);
  assert.deepEqual(rows(db, "SELECT name FROM pragma_table_info('cloud_payment_frontier') ORDER BY cid").map((r) => r.name),
    ["name", "received_at", "entry_id", "updated_at", "lap_horizon"]);
});

test("INTEGRATED-15 migration delta: customer_owners is backfilled from every ownership record that exists (ledger, previous, orphan, create journal), then kept by triggers, insert-only; the pointer is never copied (read directly)", () => {
  const db = new DatabaseSync(":memory:");
  for (const f of files.filter((f) => num(f) <= 101)) db.exec(sql(new URL(f, dir)));
  db.exec(sql(new URL("0101-populated.sql", fixtures)));
  db.exec(`INSERT INTO cloud_ops_state (key,value) VALUES ('customer_home:cus_l15','{"homeId":"home-l15","customerId":"cus_l15","role":"first"}'),
    ('customer_previous:home-p15:cus_p15','{"homeId":"home-p15","customerId":"cus_p15"}'), ('customer_previous:home-q15:cus_q15','not json'),
    ('customer_orphan:home-o15:att_1','{"homeId":"home-o15","customerId":"cus_o15"}'), ('tax_customer:home-t15:key_1','{"homeId":"home-t15","customerId":"cus_t15"}'),
    ('tax_customer:home-t15:key_2','{"homeId":"home-t15"}'), ('customer_orphan:home-n15:att_2','{"homeId":"home-n15","customerId":null}'), ('other:x','{"customerId":"cus_x"}')`);
  for (const f of files.filter((f) => num(f) > 101)) {
    db.exec(`BEGIN; ${sql(new URL(f, dir))}; COMMIT;`);
    if (num(f) === 105) db.exec(sql(new URL("0105-disputes.sql", fixtures)));
  }
  const owners = () => rows(db, "SELECT customer_id,home_id FROM customer_owners ORDER BY customer_id,home_id");
  const expected = [{ customer_id: "cus_l15", home_id: "home-l15" }, { customer_id: "cus_o15", home_id: "home-o15" }, { customer_id: "cus_p15", home_id: "home-p15" },
    { customer_id: "cus_q15", home_id: "home-q15" }, { customer_id: "cus_t15", home_id: "home-t15" }]
    .sort((a, b) => (a.customer_id !== b.customer_id ? (a.customer_id < b.customer_id ? -1 : 1) : a.home_id < b.home_id ? -1 : 1));
  assert.deepEqual(owners(), expected);
  // Triggers: a create journal row learns its customer later (UPDATE); an upsert and an INSERT OR REPLACE of a known record never abort the
  // writer (the outer conflict policy governs the trigger); a pointer write adds nothing; deleting a record never removes ownership.
  db.exec(`UPDATE cloud_ops_state SET value=json_set(value,'$.customerId','cus_t15b') WHERE key='tax_customer:home-t15:key_2'`);
  db.exec(`INSERT INTO cloud_ops_state (key,value) VALUES ('customer_home:cus_l15','{"homeId":"home-l15"}') ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  db.exec(`INSERT OR REPLACE INTO cloud_ops_state (key,value) VALUES ('customer_home:cus_l15','{"homeId":"home-l15"}')`);
  db.exec(`INSERT INTO billing_subscriptions (home_id,customer_id,plan,status,created_at,updated_at) VALUES ('home-b15','cus_b15','solo','checkout_created',1,1)`);
  assert.equal(db.prepare(`UPDATE billing_subscriptions SET customer_id='cus_b15n' WHERE home_id='home-b15'`).run().changes, 1);
  db.exec(`DELETE FROM cloud_ops_state WHERE key LIKE 'tax_customer:home-t15:%' OR key='customer_home:cus_l15'`);
  const has = (c, h) => rows(db, `SELECT COUNT(*) AS n FROM customer_owners WHERE customer_id='${c}' AND home_id='${h}'`)[0].n;
  assert.deepEqual([has("cus_t15b", "home-t15"), has("cus_b15", "home-b15"), has("cus_b15n", "home-b15"), has("cus_t15", "home-t15"), has("cus_l15", "home-l15")], [1, 0, 0, 1, 1]);
});

test("H3 (Astra H2 #2) 0109 supersedes every open operator claim of an invoice-backed grant opened before it (no fence, no wire revision): its receipt is refused and a re-claim takes the fence", async () => {
  const raw = new DatabaseSync(":memory:");
  for (const f of files.filter((f) => num(f) <= 101)) raw.exec(sql(new URL(f, dir)));
  raw.exec(sql(new URL("0101-populated.sql", fixtures)));
  for (const f of files.filter((f) => num(f) > 101)) {
    if (num(f) === 109) {
      // A live 0106-era operator claim on an invoice-backed grant (pending its receipt), opened just before the fence cutover.
      raw.exec(`INSERT INTO flux_grant_dispatches (dispatch_id,grant_id,kind,revision,target_microcents,claimed_at,expires_at,by,adjustment_ref)
        SELECT 'legacy-op',grant_id,'operator',revision,desired_microcents,1,9999999999999,'ops-old','murage:g1_delivered:legacy' FROM flux_grant_accounts WHERE grant_id='g1_delivered'`);
    }
    raw.exec(`BEGIN; ${sql(new URL(f, dir))}; COMMIT;`);
    if (num(f) === 105) raw.exec(sql(new URL("0105-disputes.sql", fixtures)));
  }
  assert.deepEqual(rows(raw, "SELECT state,outcome,wire_grant_id FROM flux_grant_dispatches WHERE dispatch_id='legacy-op'"),
    [{ state: "superseded", outcome: "superseded_at_fence_cutover:reclaim", wire_grant_id: null }]);
  const db = d1(raw);
  const rev = rows(raw, "SELECT revision,applied_microcents FROM flux_grant_accounts WHERE grant_id='g1_delivered'")[0];
  const legacy = await ledger.operatorApplied(db, { grantId: "g1_delivered", token: "legacy-op", revision: rev.revision, appliedMicrocents: 0,
    adjustmentRef: "murage:g1_delivered:legacy", evidence: "old hand adjustment", by: "ops-old", now: 1_000_100, verified: { appliedMicrocents: 0 } });
  assert.equal(legacy, "claim_required");
  assert.equal(rows(raw, "SELECT applied_microcents FROM flux_grant_accounts WHERE grant_id='g1_delivered'")[0].applied_microcents, rev.applied_microcents);
  // The re-claim holds the grant's fence and a wire revision.
  const c = await ledger.operatorClaim(db, { grantId: "g1_delivered", by: "ops", now: 1_000_200 });
  assert.equal(c.claimed, true);
  assert.equal(c.wireGrantId, "in_1:period");
  assert.equal(c.wireRevision, 1);
  assert.equal(rows(raw, "SELECT owner_token FROM flux_grant_fence WHERE grant_id='in_1:period'")[0].owner_token, c.token);
});

test("H4 (Astra H3 #7, reachable with Flux off) 0109 never drops a PENDING receipt from obligation accounting: operator removal, receipt awaiting verification, dispute reinstatement, migrate, Flux-off sweep: the 10,000,000-microcent obligation stays open until a fenced re-claim reconciles it", async () => {
  const raw = new DatabaseSync(":memory:");
  for (const f of files.filter((f) => num(f) <= 101)) raw.exec(sql(new URL(f, dir)));
  raw.exec(sql(new URL("0101-populated.sql", fixtures)));
  for (const f of files.filter((f) => num(f) > 101)) {
    if (num(f) === 109) {
      // 1. A 0106-era operator claim REMOVED g8's credit by hand (lost dispute, fully returned): its receipt (Flux holds 0) awaits verification.
      raw.exec(`INSERT INTO flux_grant_dispatches (dispatch_id,grant_id,kind,revision,target_microcents,claimed_at,expires_at,by,adjustment_ref,
          receipt_microcents,receipt_evidence,receipt_by,receipt_at)
        SELECT 'legacy-rm',grant_id,'operator',revision,desired_microcents,1,9999999999999,'ops-old','murage:g8_lost_ops:legacy',0,'removed by hand','ops-old',2
        FROM flux_grant_accounts WHERE grant_id='g8_lost_ops'`);
      // 2. The dispute is then reinstated (won): desired comes back to the old stored applied balance (10,000,000).
      raw.exec("UPDATE payment_disputes SET outcome='won',returned_cents=0 WHERE dispute_id='dp8'");
    }
    raw.exec(`BEGIN; ${sql(new URL(f, dir))}; COMMIT;`); // 3. migrate
    if (num(f) === 105) raw.exec(sql(new URL("0105-disputes.sql", fixtures)));
  }
  // The old authorization is gone (superseded), the pending receipt is kept as a verification obligation.
  assert.deepEqual(rows(raw, "SELECT state,outcome,receipt_microcents FROM flux_grant_dispatches WHERE dispatch_id='legacy-rm'"),
    [{ state: "superseded", outcome: "superseded_at_fence_cutover:pending_receipt", receipt_microcents: 0 }]);
  const db = d1(raw);
  // 4. Flux-off sweeps: before the fix the alert resolved (desired = stored applied, the receipt no longer counted): zero open obligations.
  for (const t of [1_000_000, 2_000_000]) await offSweep(db, t);
  const acct = rows(raw, "SELECT revision,desired_microcents AS d,applied_microcents AS a FROM flux_grant_accounts WHERE grant_id='g8_lost_ops'")[0];
  assert.deepEqual([acct.d, acct.a], [10000000, 10000000]);
  assert.deepEqual(ledgerAlerts(raw).g8_lost_ops, ["credit.delivery_owed", 1, "pending_verification"]);
  const detail = JSON.parse(rows(raw, "SELECT detail FROM cloud_alerts WHERE subject='g8_lost_ops'")[0].detail);
  assert.deepEqual([detail.pendingReceipt.state, detail.pendingReceipt.appliedMicrocents, detail.pendingReceipt.adjustmentRef, detail.pendingReceipt.claimState],
    ["pending_verification", 0, "murage:g8_lost_ops:legacy", "superseded"]);
  assert.equal(detail.desiredMicrocents - detail.pendingReceipt.appliedMicrocents, 10_000_000); // the restoration Flux may owe
  // The superseded claim can adjust, receive or verify nothing.
  const legacy = await ledger.operatorApplied(db, { grantId: "g8_lost_ops", token: "legacy-rm", revision: acct.revision, appliedMicrocents: 0,
    adjustmentRef: "murage:g8_lost_ops:legacy", evidence: "old hand removal", by: "ops-old", now: 2_000_100, live: false, verified: { appliedMicrocents: 0 } });
  assert.equal(legacy, "claim_required");
  await offSweep(db, 2_000_200);
  assert.deepEqual(ledgerAlerts(raw).g8_lost_ops, ["credit.delivery_owed", 1, "pending_verification"]);
  assert.deepEqual(rows(raw, "SELECT applied_microcents FROM flux_grant_accounts WHERE grant_id='g8_lost_ops'")[0], { applied_microcents: 10000000 });
  // A fenced re-claim reconciles it: Flux's own record says the removal happened (0 held): the stored balance follows, and the 10,000,000
  // restoration stays owed and alerted, no longer pending.
  const c = await ledger.operatorClaim(db, { grantId: "g8_lost_ops", by: "ops", now: 2_000_300 });
  assert.equal(c.claimed, true);
  assert.equal(c.wireGrantId, "in_8:period");
  assert.equal(await ledger.operatorApplied(db, { grantId: "g8_lost_ops", token: c.token, revision: c.account.revision, wireRevision: c.wireRevision, appliedMicrocents: 0,
    adjustmentRef: c.adjustmentRef, evidence: "Flux record of the hand removal", by: "ops", now: 2_000_400, live: false, verified: { appliedMicrocents: 0 } }), "applied");
  await offSweep(db, 2_000_500);
  const after = ledgerAlerts(raw).g8_lost_ops;
  assert.deepEqual(after.slice(0, 2), ["credit.delivery_owed", 1]);
  assert.notEqual(after[2], "pending_verification");
  const settled = JSON.parse(rows(raw, "SELECT detail FROM cloud_alerts WHERE subject='g8_lost_ops'")[0].detail);
  assert.equal(settled.debtMicrocents, 10_000_000);
  assert.equal(settled.pendingReceipt, null);
});
