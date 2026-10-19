// SPDX-License-Identifier: AGPL-3.0-or-later
// WP5-P4 stub-era cutover (design b4/GRANTS-DESIGN.md r9 section 7): dry run by default, steps b-e, fenced UPDATEs, the cohort persisted
// and verified as a whole, resumable after an interruption, and the REAL CLI adapter (scripts/flux-grants-cutover.mjs) driven end to end
// over a wrangler stand-in that runs each inlined statement against this D1.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runStubCutover, type CutoverDb } from "../src/flux-grants-cutover";
import { sha256Hex } from "../src/flux-grants";
import { d1Adapter, main } from "../scripts/flux-grants-cutover.mjs";

const NOW = 1_800_000_000_000;
const P_START = Date.UTC(2027, 0, 15, 12);
const P_END = Date.UTC(2027, 1, 15, 12);
const cfg: CutoverDb = { DB: env.DB };
const claim = (id: string, over: { ps: number | null; pe: number | null; sub: string | null }) => env.DB.prepare(
  `INSERT INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at,granted_at,period_start,period_end,subscription_id) VALUES (?,'period','home-1','starter',?,?,?,?,?)`)
  .bind(id, NOW - 1000, NOW - 500, over.ps, over.pe, over.sub).run();
const get = (id: string) => env.DB.prepare("SELECT granted_at AS g,body_json AS b,body_sha256 AS s,pending_review_at AS p,pending_review_reason AS why FROM credit_grants WHERE invoice_id=?").bind(id)
  .first<{ g: number | null; b: string | null; s: string | null; p: number | null; why: string | null }>();
/** A D1 whose prepared statements behave as D1's, with `hook(sql)` run before a statement executes (bound or not). */
const hooked = (hook: (sql: string) => Promise<void>): D1Database => ({ prepare: (sql: string) => {
  const wrap = (st: D1PreparedStatement): D1PreparedStatement => ({
    bind: (...b: unknown[]) => wrap(st.bind(...b)),
    all: async () => { await hook(sql); return st.all(); }, first: async (c?: string) => { await hook(sql); return c === undefined ? st.first() : st.first(c); },
    run: async () => { await hook(sql); return st.run(); } } as unknown as D1PreparedStatement);
  return wrap(env.DB.prepare(sql));
} } as unknown as D1Database);
/** wrangler d1 execute --json stand-in: runs the inlined --command against this D1 and prints wrangler's JSON shape. */
const commands: string[] = [];
const wrangler = async (_cmd: string, args: string[]) => {
  const sql = args[args.indexOf("--command") + 1];
  commands.push(sql);
  const r = await env.DB.prepare(sql).all();
  return JSON.stringify([{ results: r.results, success: true, meta: { changes: r.meta.changes } }]);
};

beforeEach(async () => {
  commands.length = 0;
  await env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
    VALUES ('home-1','inst-1','user-1','running','running','sha256:x','k',1,1)`).run();
  await env.DB.prepare("INSERT INTO flux_links (owner_user_id,flux_account_id,linked_at,link_id,link_version,fenced) VALUES ('user-1','flux-acct-9',1,'l',1,0)").run();
  await claim("in_ok", { ps: P_START, pe: P_END, sub: "sub_1" });
  await claim("in_bad", { ps: null, pe: null, sub: null }); // a claim from before migration 0082: no period to rebuild from
  await env.DB.prepare("INSERT INTO credit_reversals (invoice_id,kind,home_id,reason,op_id,requested_at,reversed_at) VALUES ('in_ok','period','home-1','refunded',NULL,5,6)").run();
});
const CLEAN = ["credit_grant_cutover", "credit_grants", "credit_reversals", "cloud_alerts", "plan_changes", "plan_quotes", "flux_links", "billing_subscriptions",
  "flux_hook_stub_log", "cloud_homes"];
afterEach(async () => { for (const t of CLEAN) await env.DB.prepare(`DELETE FROM ${t}`).run(); });

describe("stub-era cutover", () => {
  it("is a dry run by default: it reports what it would do and writes nothing (not even the cohort)", async () => {
    const r = await runStubCutover(cfg, { apply: false, quiesced: false, now: NOW });
    expect(r).toMatchObject({ apply: false, identified: 2, populated: 1, cleared: 0, pendingReview: 1, verified: false, mayEnableToken: false });
    expect(r.rows.map((x) => x.action).sort()).toEqual(["would_clear", "would_flag"]);
    expect(await get("in_ok")).toEqual({ g: NOW - 500, b: null, s: null, p: null, why: null });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM credit_grant_cutover").first<{ n: number }>())!.n).toBe(0);
  });
  it("refuses to apply unless the operator asserts the quiesced state", async () => {
    await expect(runStubCutover(cfg, { apply: true, quiesced: false, now: NOW })).rejects.toThrow("cutover_requires_quiesced");
  });
  it("applies: the rebuildable claim gets its body (the linked Flux account) and is cleared, the other is flagged pending_review", async () => {
    const r = await runStubCutover(cfg, { apply: true, quiesced: true, now: NOW });
    expect(r).toMatchObject({ apply: true, identified: 2, populated: 1, cleared: 1, pendingReview: 1, skipped: 0, verified: true, mayEnableToken: true });
    const ok = (await get("in_ok"))!;
    expect(ok.g).toBeNull();
    expect(JSON.parse(ok.b!)).toMatchObject({ grant_id: "in_ok:period", account_id: "flux-acct-9", amount_microcents: 10_000_000, expires_at: "2027-03-15T12:00:00+00:00" });
    expect(ok.s).toBe(await sha256Hex(ok.b!));
    expect(await get("in_bad")).toEqual({ g: NOW - 500, b: null, s: null, p: NOW, why: "grant_input_missing" });
    expect(await env.DB.prepare("SELECT requested_at AS q,reversed_at AS r FROM credit_reversals").first()).toEqual({ q: 5, r: 6 });
  });
  it("a later run keeps the whole cohort in its report (pending_review rows included) and still verifies", async () => {
    await runStubCutover(cfg, { apply: true, quiesced: true, now: NOW });
    const again = await runStubCutover(cfg, { apply: true, quiesced: true, now: NOW + 1 });
    expect(again).toMatchObject({ identified: 2, cleared: 1, pendingReview: 1, verified: true, mayEnableToken: true });
    expect(again.rows).toEqual(expect.arrayContaining([{ grantId: "in_bad:period", action: "pending_review", reason: "grant_input_missing" }]));
    const dry = await runStubCutover(cfg, { apply: false, quiesced: false, now: NOW + 2 });
    expect(dry.rows.map((x) => x.action).sort()).toEqual(["cleared", "pending_review"]);
  });
  it("INTERRUPTED between populate and clear: the report never claims readiness, and the next run clears the row under both fences", async () => {
    let crash = true;
    const interrupted: CutoverDb = { DB: hooked(async (sql) => {
      if (crash && sql.startsWith("UPDATE credit_grants SET granted_at=NULL")) { crash = false; throw new Error("worker killed"); }
    }) };
    await expect(runStubCutover(interrupted, { apply: true, quiesced: true, now: NOW })).rejects.toThrow("worker killed");
    const mid = (await get("in_ok"))!;
    expect(mid.g).toBe(NOW - 500); // populated, not cleared
    expect(mid.s).not.toBeNull();
    const dry = await runStubCutover(cfg, { apply: false, quiesced: false, now: NOW + 1 });
    expect(dry).toMatchObject({ verified: false, mayEnableToken: false });
    const r = await runStubCutover(cfg, { apply: true, quiesced: true, now: NOW + 2 });
    expect(r).toMatchObject({ identified: 2, cleared: 1, pendingReview: 1, skipped: 0, verified: true, mayEnableToken: true });
    expect((await get("in_ok"))!).toMatchObject({ g: null, s: mid.s, b: mid.b });
  });
  it("interrupted before verify (after clear): a rerun accounts for the cleared row and verifies", async () => {
    let crash = true;
    const interrupted: CutoverDb = { DB: hooked(async (sql) => {
      if (crash && sql.startsWith("UPDATE credit_grant_cutover SET state=?") && (await get("in_ok"))!.g === null) { crash = false; throw new Error("worker killed"); }
    }) };
    await expect(runStubCutover(interrupted, { apply: true, quiesced: true, now: NOW })).rejects.toThrow("worker killed");
    expect(await runStubCutover(cfg, { apply: true, quiesced: true, now: NOW + 1 })).toMatchObject({ cleared: 1, pendingReview: 1, verified: true });
  });
  it("is fenced on granted_at and body_sha256: a claim that moved between populate and clear is never cleared, and verification fails", async () => {
    const racing: CutoverDb = { DB: hooked(async (sql) => {
      if (sql.startsWith("UPDATE credit_grants SET granted_at=NULL")) await env.DB.prepare("UPDATE credit_grants SET granted_at=granted_at+7 WHERE invoice_id='in_ok'").run();
    }) };
    const r = await runStubCutover(racing, { apply: true, quiesced: true, now: NOW });
    expect(r).toMatchObject({ identified: 2, cleared: 0, pendingReview: 1, skipped: 1, verified: false, mayEnableToken: false });
    expect((await get("in_ok"))!.g).toBe(NOW - 500 + 7);
    expect(await runStubCutover(cfg, { apply: true, quiesced: true, now: NOW + 1 })).toMatchObject({ verified: false, mayEnableToken: false });
  });
  it("keeps the hash it populated: a concurrent hash change refuses the clear, and a rerun rejects it (never adopts or overwrites it)", async () => {
    const forged = "f".repeat(64);
    let once = true;
    const racing: CutoverDb = { DB: hooked(async (sql) => {
      if (once && sql.startsWith("UPDATE credit_grants SET granted_at=NULL")) {
        once = false; await env.DB.prepare("UPDATE credit_grants SET body_sha256=? WHERE invoice_id='in_ok'").bind(forged).run();
      }
    }) };
    const first = await runStubCutover(racing, { apply: true, quiesced: true, now: NOW });
    expect(first).toMatchObject({ cleared: 0, skipped: 1, verified: false, mayEnableToken: false });
    const cohortSha = (await env.DB.prepare("SELECT body_sha256 AS s FROM credit_grant_cutover WHERE invoice_id='in_ok'").first<{ s: string }>())!.s;
    expect(cohortSha).not.toBe(forged);
    const again = await runStubCutover(cfg, { apply: true, quiesced: true, now: NOW + 1 });
    expect(again).toMatchObject({ cleared: 0, skipped: 1, verified: false, mayEnableToken: false });
    expect(again.rows).toEqual(expect.arrayContaining([{ grantId: "in_ok:period", action: "skipped_changed", reason: "body_hash_changed" }]));
    expect((await get("in_ok"))!).toMatchObject({ g: NOW - 500, s: forged }); // clear refused, the claim untouched
    expect((await env.DB.prepare("SELECT body_sha256 AS s,state FROM credit_grant_cutover WHERE invoice_id='in_ok'").first())).toEqual({ s: cohortSha, state: "populated" });
  });
  it("verifies the stored body's checksum: a body changed under its hash is never cleared on resume nor counted verified", async () => {
    let crash = true;
    const interrupted: CutoverDb = { DB: hooked(async (sql) => {
      if (crash && sql.startsWith("UPDATE credit_grants SET granted_at=NULL")) { crash = false; throw new Error("worker killed"); }
    }) };
    await expect(runStubCutover(interrupted, { apply: true, quiesced: true, now: NOW })).rejects.toThrow("worker killed");
    await env.DB.prepare("UPDATE credit_grants SET body_json=body_json||' ' WHERE invoice_id='in_ok'").run();
    const r = await runStubCutover(cfg, { apply: true, quiesced: true, now: NOW + 1 });
    expect(r).toMatchObject({ cleared: 0, skipped: 1, verified: false, mayEnableToken: false });
    expect(r.rows).toEqual(expect.arrayContaining([{ grantId: "in_ok:period", action: "skipped_changed", reason: "body_corrupt" }]));
    expect((await get("in_ok"))!.g).toBe(NOW - 500);
    // and a cleared row whose body was changed afterwards no longer verifies
    await env.DB.prepare("UPDATE credit_grants SET body_json=TRIM(body_json) WHERE invoice_id='in_ok'").run();
    expect(await runStubCutover(cfg, { apply: true, quiesced: true, now: NOW + 2 })).toMatchObject({ cleared: 1, verified: true });
    await env.DB.prepare("UPDATE credit_grants SET body_json=body_json||' ' WHERE invoice_id='in_ok'").run();
    expect(await runStubCutover(cfg, { apply: true, quiesced: true, now: NOW + 3 })).toMatchObject({ cleared: 0, verified: false, mayEnableToken: false });
  });
  it("INTERRUPTED after the review stamp, before the cohort recorded it: once the link appears a rerun still honours the stamp", async () => {
    await env.DB.prepare("DELETE FROM credit_grants WHERE invoice_id='in_bad'").run();
    await env.DB.prepare("DELETE FROM flux_links").run(); // in_ok is held: recipient_unlinked
    let crash = true;
    const interrupted: CutoverDb = { DB: hooked(async (sql) => {
      if (crash && sql.startsWith("UPDATE credit_grant_cutover SET state=?") && (await get("in_ok"))!.p !== null) { crash = false; throw new Error("worker killed"); }
    }) };
    await expect(runStubCutover(interrupted, { apply: true, quiesced: true, now: NOW })).rejects.toThrow("worker killed");
    expect((await env.DB.prepare("SELECT state FROM credit_grant_cutover WHERE invoice_id='in_ok'").first<{ state: string }>())!.state).toBe("identified");
    await env.DB.prepare("INSERT INTO flux_links (owner_user_id,flux_account_id,linked_at,link_id,link_version,fenced) VALUES ('user-1','flux-acct-9',1,'l',1,0)").run();
    const r = await runStubCutover(cfg, { apply: true, quiesced: true, now: NOW + 1 });
    expect(r).toMatchObject({ identified: 1, cleared: 0, pendingReview: 1, skipped: 0 });
    expect(r.rows).toEqual([{ grantId: "in_ok:period", action: "pending_review", reason: "recipient_unlinked" }]);
    expect(await get("in_ok")).toEqual({ g: NOW - 500, b: null, s: null, p: NOW, why: "recipient_unlinked" });
    expect((await env.DB.prepare("SELECT state FROM credit_grant_cutover WHERE invoice_id='in_ok'").first<{ state: string }>())!.state).toBe("pending_review");
    expect((await runStubCutover(cfg, { apply: false, quiesced: false, now: NOW + 2 })).rows).toEqual([{ grantId: "in_ok:period", action: "pending_review", reason: "recipient_unlinked" }]);
  });
});

describe("the CLI (scripts/flux-grants-cutover.mjs) and its D1 adapter", () => {
  it("the adapter supports unbound and bound statements, as D1 does", async () => {
    const db = d1Adapter("murage", undefined, wrangler);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM credit_grants").all<{ n: number }>()).results).toEqual([{ n: 2 }]);
    expect(await db.prepare("SELECT invoice_id AS i FROM credit_grants ORDER BY invoice_id").first<{ i: string }>()).toEqual({ i: "in_bad" });
    expect(await db.prepare("SELECT ? AS v").bind("it's").first("v")).toBe("it's");
    expect((await db.prepare("UPDATE credit_grants SET last_error=? WHERE invoice_id=?").bind("x", "in_ok").run()).meta.changes).toBe(1);
    expect((await db.prepare("UPDATE credit_grants SET last_error=NULL").run()).meta.changes).toBe(2);
  });
  it("dry run (the default): exit 3 (rows need review), nothing written, the report printed", async () => {
    const out: string[] = [];
    expect(await main(["--db", "murage"], { exec: wrangler, env: {}, now: NOW, log: (s) => out.push(s) })).toBe(3);
    expect(JSON.parse(out[0])).toMatchObject({ apply: false, identified: 2, mayEnableToken: false });
    expect(commands.every((c) => c.startsWith("SELECT"))).toBe(true);
    expect((await get("in_ok"))!.g).toBe(NOW - 500);
  });
  it("apply needs --quiesced; with it the real adapter runs the cutover end to end and verifies", async () => {
    await expect(main(["--db", "murage", "--apply"], { exec: wrangler, env: {}, now: NOW, log: () => undefined })).rejects.toThrow("cutover_requires_quiesced");
    const out: string[] = [];
    expect(await main(["--db", "murage", "--apply", "--quiesced"], { exec: wrangler, env: {}, now: NOW, log: (s) => out.push(s) })).toBe(3); // in_bad needs review
    expect(JSON.parse(out[0])).toMatchObject({ apply: true, verified: true, mayEnableToken: true, cleared: 1, pendingReview: 1 });
    expect((await get("in_ok"))!.g).toBeNull();
    expect(await main([], { exec: wrangler, error: () => undefined })).toBe(64);
  });
});
