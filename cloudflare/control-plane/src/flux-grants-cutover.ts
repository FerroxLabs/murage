// SPDX-License-Identifier: AGPL-3.0-or-later
// Murage Cloud B4 WP5-P4: the STUB-ERA CUTOVER (design b4/GRANTS-DESIGN.md r9 section 7, "Stub-era cutover"). NOT a D1 migration: it runs
// by an operator, with Sean's go, against the live D1 (scripts/flux-grants-cutover.mjs). DRY RUN BY DEFAULT.
//
// Before it: (a) quiesce. The CP build with D1-D3 is deployed with FLUX_CLOUD_GRANTS_TOKEN ABSENT, so no ask reaches a stub or the router,
// and one sweep has passed. The operator asserts that with `quiesced: true`; apply refuses without it.
// It does: (b) identify claims with granted_at set and no frozen body (stub-era: the stub stamped them, the D1 build only stamps on the
// router's answer) and PERSIST them as the cohort (credit_grant_cutover, migration 0090) with the granted_at it saw; (c) populate each
// rebuildable claim's canonical body (write-once), and flag every claim that cannot be rebuilt pending_review (granted_at stays set, never
// cleared); (d) clear granted_at of the populated claims, fenced on BOTH granted_at (as seen) and body_sha256 (as written); (e) verify the
// WHOLE cohort against the table: every row cleared or pending_review, none left. Only then may FLUX_CLOUD_GRANTS_TOKEN be set.
// RESUMABLE: every step records its progress in the cohort row, so a run interrupted anywhere (between populate and clear included) is
// finished by the next run under the same fences; pending_review rows stay in every later report.
// Reversal receipts (credit_reversals), reversed_at and suppression rows are never touched.
import { composeFrozenBody, isHold, sha256Hex } from "./flux-grants.ts";

export interface CutoverDb { DB: D1Database; FLUX_B4_CONFIG?: string; CLOUD_CP0_STAGING?: string }
export interface CutoverOptions { apply: boolean; quiesced: boolean; now: number }
export type CutoverAction = "cleared" | "would_clear" | "pending_review" | "would_flag" | "skipped_changed";
export interface CutoverRow { grantId: string; action: CutoverAction; reason?: string }
export interface CutoverReport { apply: boolean; identified: number; populated: number; cleared: number; pendingReview: number; skipped: number;
  verified: boolean; /** true only when applied and the whole cohort is accounted for: the operator may now set FLUX_CLOUD_GRANTS_TOKEN */
  mayEnableToken: boolean; rows: CutoverRow[] }

interface Cohort { invoice_id: string; kind: string; granted_at_seen: number; state: "identified" | "populated" | "cleared" | "pending_review";
  body_sha256: string | null; reason: string | null }
interface Claim { invoice_id: string; kind: string; home_id: string; plan: string; granted_at: number | null; period_start: number | null;
  period_end: number | null; previous_plan: string | null; subscription_id: string | null; body_json: string | null; body_sha256: string | null;
  pending_review_at: number | null; pending_review_reason: string | null }

const CANDIDATES = `SELECT invoice_id,kind,granted_at FROM credit_grants WHERE granted_at IS NOT NULL AND body_sha256 IS NULL AND pending_review_at IS NULL`;
const claimOf = (env: CutoverDb, c: { invoice_id: string; kind: string }) => env.DB.prepare(`SELECT invoice_id,kind,home_id,plan,granted_at,period_start,
  period_end,previous_plan,subscription_id,body_json,body_sha256,pending_review_at,pending_review_reason FROM credit_grants WHERE invoice_id=? AND kind=?`).bind(c.invoice_id, c.kind).first<Claim>();
/** The stored body's own checksum holds (the bytes every attempt resends hash to the recorded body_sha256). */
const intact = async (g: Pick<Claim, "body_json" | "body_sha256">): Promise<boolean> =>
  g.body_json !== null && g.body_sha256 !== null && (await sha256Hex(g.body_json)) === g.body_sha256;
/** Records progress. The cohort's body_sha256 is WRITE-ONCE: the hash it populated is never replaced. */
const mark = (env: CutoverDb, c: Cohort, state: Cohort["state"], sha: string | null, reason: string | null, now: number) =>
  env.DB.prepare("UPDATE credit_grant_cutover SET state=?,body_sha256=COALESCE(body_sha256,?),reason=COALESCE(?,reason),updated_at=? WHERE invoice_id=? AND kind=?")
    .bind(state, sha, reason, now, c.invoice_id, c.kind).run();

async function rebuild(env: CutoverDb, g: Claim): Promise<{ json: string; sha256: string } | { reason: string }> {
  if (g.period_start === null || g.period_end === null || g.subscription_id === null) return { reason: "grant_input_missing" };
  if (g.kind !== "period" && g.kind !== "upgrade_delta") return { reason: "grant_kind_unknown" };
  const b = await composeFrozenBody(env as unknown as Env, { homeId: g.home_id, plan: g.plan, invoiceId: g.invoice_id, kind: g.kind,
    periodStart: g.period_start, periodEnd: g.period_end, ...(g.previous_plan ? { previousPlan: g.previous_plan } : {}) });
  return isHold(b) ? { reason: b.held } : b;
}

export async function runStubCutover(env: CutoverDb, opts: CutoverOptions): Promise<CutoverReport> {
  if (opts.apply && !opts.quiesced) throw new Error("cutover_requires_quiesced");
  const candidates = (await env.DB.prepare(`${CANDIDATES} ORDER BY claimed_at,invoice_id,kind`).all<{ invoice_id: string; kind: string; granted_at: number }>()).results;
  // (b) the cohort, persisted (apply) before anything else is written. A run never forgets a row an earlier run identified.
  if (opts.apply) {
    for (const c of candidates) {
      await env.DB.prepare(`INSERT INTO credit_grant_cutover (invoice_id,kind,granted_at_seen,state,identified_at,updated_at) VALUES (?,?,?,'identified',?,?)
        ON CONFLICT(invoice_id,kind) DO NOTHING`).bind(c.invoice_id, c.kind, c.granted_at, opts.now, opts.now).run();
    }
  }
  const stored = (await env.DB.prepare("SELECT invoice_id,kind,granted_at_seen,state,body_sha256,reason FROM credit_grant_cutover ORDER BY identified_at,invoice_id,kind")
    .all<Cohort>()).results;
  const cohort: Cohort[] = [...stored];
  if (!opts.apply) {
    const known = new Set(stored.map((c) => `${c.invoice_id}:${c.kind}`));
    for (const c of candidates) if (!known.has(`${c.invoice_id}:${c.kind}`)) cohort.push({ invoice_id: c.invoice_id, kind: c.kind, granted_at_seen: c.granted_at, state: "identified", body_sha256: null, reason: null });
  }
  const rows: CutoverRow[] = [];
  let populated = 0; let skipped = 0;
  for (const c of cohort) {
    const grantId = `${c.invoice_id}:${c.kind}`;
    const g = await claimOf(env, c);
    if (!g) { skipped++; rows.push({ grantId, action: "skipped_changed", reason: "claim_missing" }); continue; }
    if (c.state === "pending_review") { rows.push({ grantId, action: "pending_review", reason: c.reason ?? undefined }); continue; }
    if (c.state === "cleared") { populated++; rows.push({ grantId, action: "cleared" }); continue; }
    // The claim's own review stamp wins on every resume (an interrupted run may have stamped it before the cohort recorded it): it is
    // reconciled into the cohort and NEVER populated or cleared, even when its link has appeared since.
    if (g.pending_review_at !== null) {
      if (g.granted_at !== c.granted_at_seen) { skipped++; rows.push({ grantId, action: "skipped_changed" }); continue; }
      if (opts.apply) await mark(env, c, "pending_review", null, g.pending_review_reason ?? "pending_review", opts.now);
      rows.push({ grantId, action: "pending_review", ...(g.pending_review_reason ? { reason: g.pending_review_reason } : {}) });
      continue;
    }
    // The cohort KEEPS the hash it populated: a claim whose hash moved since is rejected, never adopted.
    if (c.body_sha256 !== null && g.body_sha256 !== c.body_sha256) { skipped++; rows.push({ grantId, action: "skipped_changed", reason: "body_hash_changed" }); continue; }
    // Interrupted after the clear landed but before the cohort recorded it: only this cutover nulls granted_at of a claim with a body, and
    // only of one whose hash the cohort recorded (populated) before clearing.
    if (g.granted_at === null && c.body_sha256 !== null) {
      if (!(await intact(g))) { skipped++; rows.push({ grantId, action: "skipped_changed", reason: "body_corrupt" }); continue; }
      if (opts.apply) await mark(env, c, "cleared", null, null, opts.now);
      populated++; rows.push({ grantId, action: "cleared" }); continue;
    }
    if (g.granted_at !== c.granted_at_seen) { skipped++; rows.push({ grantId, action: "skipped_changed" }); continue; }
    // (c) populate, unless a body is already there (an interrupted run wrote it): never overwritten.
    let sha = g.body_sha256;
    if (sha === null) {
      const b = await rebuild(env, g);
      if ("reason" in b) {
        if (!opts.apply) { rows.push({ grantId, action: "would_flag", reason: b.reason }); continue; }
        const r = await env.DB.prepare(`UPDATE credit_grants SET pending_review_at=?,pending_review_reason=? WHERE invoice_id=? AND kind=? AND granted_at=? AND body_sha256 IS NULL
          AND pending_review_at IS NULL`).bind(opts.now, b.reason, c.invoice_id, c.kind, c.granted_at_seen).run();
        const now = await claimOf(env, c);
        if (r.meta.changes === 1 || (now?.pending_review_at != null && now.granted_at === c.granted_at_seen)) {
          await mark(env, c, "pending_review", null, now?.pending_review_reason ?? b.reason, opts.now);
          rows.push({ grantId, action: "pending_review", reason: b.reason });
        } else { skipped++; rows.push({ grantId, action: "skipped_changed" }); }
        continue;
      }
      if (!opts.apply) { populated++; rows.push({ grantId, action: "would_clear" }); continue; }
      const put = await env.DB.prepare("UPDATE credit_grants SET body_json=?,body_sha256=? WHERE invoice_id=? AND kind=? AND granted_at=? AND body_sha256 IS NULL AND pending_review_at IS NULL")
        .bind(b.json, b.sha256, c.invoice_id, c.kind, c.granted_at_seen).run();
      if (put.meta.changes !== 1) { skipped++; rows.push({ grantId, action: "skipped_changed" }); continue; }
      sha = b.sha256;
    } else {
      // A body already there (an interrupted run wrote it): its stored checksum must hold before it is recorded or cleared.
      if (!(await intact(g))) { skipped++; rows.push({ grantId, action: "skipped_changed", reason: "body_corrupt" }); continue; }
      if (!opts.apply) { populated++; rows.push({ grantId, action: "would_clear" }); continue; }
    }
    await mark(env, c, "populated", sha, null, opts.now);
    populated++;
    // (d) clear, fenced on both.
    const clr = await env.DB.prepare("UPDATE credit_grants SET granted_at=NULL WHERE invoice_id=? AND kind=? AND granted_at=? AND body_sha256=? AND pending_review_at IS NULL")
      .bind(c.invoice_id, c.kind, c.granted_at_seen, sha).run();
    if (clr.meta.changes === 1) { await mark(env, c, "cleared", sha, null, opts.now); rows.push({ grantId, action: "cleared" }); }
    else { skipped++; rows.push({ grantId, action: "skipped_changed" }); }
  }
  const identified = cohort.length;
  if (!opts.apply) {
    return { apply: false, identified, populated, cleared: rows.filter((r) => r.action === "cleared").length,
      pendingReview: rows.filter((r) => r.action === "would_flag" || r.action === "pending_review").length, skipped, verified: false, mayEnableToken: false, rows };
  }
  // (e) verify the WHOLE persisted cohort against the table, not against the counters above, and that no stub-era claim is left outside it.
  const all = (await env.DB.prepare("SELECT invoice_id,kind,granted_at_seen,state,body_sha256,reason FROM credit_grant_cutover").all<Cohort>()).results;
  let cleared = 0; let pendingReview = 0;
  for (const c of all) {
    const g = await claimOf(env, c);
    if (!g) continue;
    if (c.state === "cleared" && g.granted_at === null && c.body_sha256 !== null && g.body_sha256 === c.body_sha256 && (await intact(g))) cleared++;
    else if (c.state === "pending_review" && g.granted_at !== null && g.pending_review_at !== null) pendingReview++;
  }
  const left = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM (${CANDIDATES})`).first<{ n: number }>())?.n ?? 1;
  const verified = all.length > 0 ? cleared + pendingReview === all.length && left === 0 : left === 0;
  return { apply: true, identified: all.length, populated, cleared, pendingReview, skipped, verified, mayEnableToken: verified, rows };
}
