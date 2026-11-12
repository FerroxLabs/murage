// SPDX-License-Identifier: AGPL-3.0-or-later
// Dispatch review (KMS signing design 10.6, 13, 13.1). Two steps on the 5-minute cron:
//
//   trustDiff        FIRST act of the invocation. Compares the accepted trust sets (signing key fingerprints, image-release-check hashes, image ids) with the
//                    sets stored in image_policy and marks every image_dispatch_auth row that rests on something REMOVED as needs_review, advancing the
//                    stored sets in the SAME D1 batch (13.1 H2). It never reads image_readiness.config_hash.
//   sweepDispatchReview   takes up to 20 needs_review rows, oldest first, and looks for their provider server: by exact id, or by the murage/dispatch
//                    label when the POST was never answered. Absent: resolved_absent. Present: one persisted alert per server, then resolved_alerted.
//                    A provider error leaves the row for the next run. It only ever READS the provider: it never deletes, stops or rebuilds anything
//                    (an established customer home is a manual decision, and the alert names it).
import { hetznerAdapter, DISPATCH_LABEL, HostError, type HetznerPoolAdapter } from "./b5-provisioner";
import { provisionerConfig } from "./b5-config";
import { subjectAlertStatements } from "./ops-monitor";
import { DEFAULT_TRUST, alert as imageAlert, sha256Hex, type ImageTrust } from "./image-signature";

/** One run reads at most this many rows, so at most this many provider reads (a label lookup is one read too). */
export const SWEEP_ROWS = 20;
export const ALERT_PRESENT = "image.revoked_server_present";
export const ALERT_UNRESOLVED = "image.dispatch_unresolved";

// ---- trust diff -----------------------------------------------------------------------------------------------------------------------

interface Sets { fps: string[]; checks: string[]; images: string[] }
const uniqSorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
const parseSet = (raw: unknown): string[] | null => {
  if (typeof raw !== "string") return null;
  try { const v: unknown = JSON.parse(raw); return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null; } catch { return null; }
};

/** The sets this bundle accepts: DEFAULT_TRUST's key fingerprints and check hashes, and the image ids of config.images (provider) plus the keys of
 *  config.imageKinds, minus the revoked ids. Null when the config cannot be read (nothing is diffed then; readiness reports the fault). */
export function currentSets(env: Env, trust: ImageTrust): Sets | null {
  let config;
  try { config = provisionerConfig(env); } catch { return null; }
  const kinds: unknown = config.imageKinds;
  const ids = [config.images.hetzner.x86, config.images.hetzner.arm, ...(kinds !== null && typeof kinds === "object" && !Array.isArray(kinds) ? Object.keys(kinds) : [])]
    .filter((x): x is string => typeof x === "string" && x !== "");
  return { fps: uniqSorted(trust.fps), checks: uniqSorted(trust.checks), images: uniqSorted(ids.filter((x) => !trust.revoked.includes(x))) };
}
const hashOf = (s: Sets) => sha256Hex(JSON.stringify([s.fps, s.checks, s.images]));

/** Marks rows on the sets that were removed and advances the stored sets, in ONE batch. Every statement of it is guarded by the previous trust_hash
 *  (13.1 H2 and the Fable notes), so two Workers diffing at once mark and advance exactly once. Never throws: a failure leaves the stored sets, and
 *  the next run diffs again. */
export async function trustDiff(env: Env, now: number, deps: { trust?: ImageTrust } = {}): Promise<void> {
  try {
    const cur = currentSets(env, deps.trust ?? DEFAULT_TRUST);
    if (!cur) return;
    const hash = await hashOf(cur);
    const stored = await env.DB.prepare("SELECT accepted_fps,accepted_checks,accepted_images,trust_hash FROM image_policy WHERE id='current'")
      .first<{ accepted_fps: string | null; accepted_checks: string | null; accepted_images: string | null; trust_hash: string | null }>();
    if (!stored || stored.trust_hash === hash) return;
    const advance = env.DB.prepare("UPDATE image_policy SET accepted_fps=?,accepted_checks=?,accepted_images=?,trust_hash=? WHERE id='current' AND trust_hash IS ?")
      .bind(JSON.stringify(cur.fps), JSON.stringify(cur.checks), JSON.stringify(cur.images), hash, stored.trust_hash);
    const prev = stored.trust_hash === null ? null : { fps: parseSet(stored.accepted_fps), checks: parseSet(stored.accepted_checks), images: parseSet(stored.accepted_images) };
    if (prev === null) { await advance.run(); return; } // the first run: a baseline, nothing earlier to diff against (see migration 0125)
    if (prev.fps === null || prev.checks === null || prev.images === null) {
      // The stored sets are unreadable, so nothing can be diffed: take a new baseline and tell Sean (a row on a removed trust is then not marked).
      await advance.run();
      await imageAlert(env, "image.trust_unreadable", "high", "the stored image trust sets were unreadable and were reset; review image_dispatch_auth by hand", now);
      return;
    }
    const gone = (before: string[], after: string[]) => before.filter((x) => !after.includes(x));
    const removed = [["key", "key_fp", gone(prev.fps, cur.fps)], ["check", "check_sha256", gone(prev.checks, cur.checks)], ["image", "image", gone(prev.images, cur.images)]] as const;
    const marks = removed.filter(([, , list]) => list.length > 0).map(([reason, column, list]) =>
      env.DB.prepare(`UPDATE image_dispatch_auth SET state='needs_review',review_reason=?
        WHERE state NOT IN ('needs_review','resolved_absent','resolved_alerted') AND ${column} IN (SELECT value FROM json_each(?))
          AND (SELECT trust_hash FROM image_policy WHERE id='current') IS ?`).bind(reason, JSON.stringify(list), stored.trust_hash));
    await env.DB.batch([...marks, advance]); // the marks read trust_hash before the last statement advances it
  } catch { /* the stored sets are unchanged; the next run diffs again */ }
}

// ---- the sweep ------------------------------------------------------------------------------------------------------------------------

interface ReviewRow { dispatch_id: string; image: string; provider_server_id: string | null; review_reason: string | null; settled_at: number | null }
export interface SweepDeps { adapter?: HetznerPoolAdapter | null; deadline?: number; /** The clock the deadline is checked against (default Date.now); a test injects its own. */ clock?: () => number }

const unresolvedFor = `NOT EXISTS (SELECT 1 FROM cloud_alerts a WHERE a.kind='${ALERT_UNRESOLVED}' AND a.subject=image_dispatch_auth.dispatch_id)`; // any alert, open or resolved: a person has been told once (Fable verify 10.6 c)

/** Up to SWEEP_ROWS needs_review rows, oldest first, honouring the invocation's deadline. Never throws, never deletes, stops or rebuilds. */
export async function sweepDispatchReview(env: Env, now: number, deps: SweepDeps = {}): Promise<void> {
  try {
    // Belt and braces against a non-atomic deploy batch (Fable verify 10.6 a): idempotent, before anything else. Rows of a lower epoch still open are marked.
    await env.DB.prepare("UPDATE image_dispatch_auth SET state='needs_review',review_reason='epoch' WHERE state='open' AND epoch < (SELECT epoch FROM image_policy WHERE id='current')").run();
    const deadline = deps.deadline ?? Number.POSITIVE_INFINITY;
    const clock = deps.clock ?? Date.now;
    if (clock() >= deadline) return;
    const adapter = deps.adapter !== undefined ? deps.adapter : adapterOf(env);
    if (!adapter) return;
    // A row without a server id that predates the label (migration 0125, 'prelabel') and one already alerted as unresolved (the alert open or resolved) are manual: not picked.
    const rows = (await env.DB.prepare(`SELECT dispatch_id,image,provider_server_id,review_reason,settled_at FROM image_dispatch_auth
      WHERE state='needs_review' AND NOT (provider_server_id IS NULL AND review_reason='prelabel') AND ${unresolvedFor}
      ORDER BY created_at, dispatch_id LIMIT ?`).bind(SWEEP_ROWS).all<ReviewRow>()).results;
    if (rows.length === 0) return;
    const ids = rows.map((r) => r.provider_server_id).filter((x): x is string => x !== null);
    const owner = new Map<string, string>();
    if (ids.length > 0) {
      const found = await env.DB.prepare(`SELECT server_id,home_id FROM cloud_provision_intents WHERE server_id IN (SELECT value FROM json_each(?))`)
        .bind(JSON.stringify(ids)).all<{ server_id: string; home_id: string }>();
      for (const o of found.results) owner.set(o.server_id, o.home_id);
    }
    for (const row of rows) {
      if (clock() >= deadline) return;
      try { await review(env, adapter, row, owner, now); } catch { /* a provider or D1 error: the row stays needs_review for the next run */ }
    }
  } catch { /* the next run retries */ }
}

function adapterOf(env: Env): HetznerPoolAdapter | null {
  if (!env.HCLOUD_TOKEN) return null;
  try { return hetznerAdapter(env.HCLOUD_TOKEN, provisionerConfig(env)); } catch { return null; }
}

async function review(env: Env, adapter: HetznerPoolAdapter, row: ReviewRow, owner: Map<string, string>, now: number): Promise<void> {
  let servers: string[];
  if (row.provider_server_id !== null) {
    try { await adapter.getServerDetail(row.provider_server_id); servers = [row.provider_server_id]; }
    catch (e) {
      if (!(e instanceof HostError && e.status === 404)) throw e; // an error is never "absent"
      servers = [];
    }
  } else {
    servers = (await adapter.listByLabel(`${DISPATCH_LABEL}=${row.dispatch_id}`)).map((s) => s.id);
    // settled_at with no server id is a parsed provider refusal (settled_failed) that a later revocation marked: the provider said no AND no
    // server carries the label, so nothing was created and the row closes as absent. Only a row whose POST never got an answer is a person's call.
    const refused = row.settled_at !== null;
    if (servers.length === 0 && !refused) { // no id, no answer and no label match: never resolved_absent, a person decides (13.1 H1)
      await env.DB.batch(subjectAlertStatements(env.DB, { homeId: "platform", kind: ALERT_UNRESOLVED, severity: "high", subject: row.dispatch_id, earlier: { noun: "dispatch", verb: "is also unresolved" },
        detail: `dispatch ${row.dispatch_id} (image ${row.image}, reason ${row.review_reason ?? "?"}) has no server id and no server carries its label: decide by hand` },
        "(SELECT state FROM image_dispatch_auth WHERE dispatch_id=?)='needs_review'", [row.dispatch_id], now));
      return;
    }
  }
  if (servers.length === 0) {
    await env.DB.prepare("UPDATE image_dispatch_auth SET state='resolved_absent',settled_at=? WHERE dispatch_id=? AND state='needs_review'").bind(now, row.dispatch_id).run();
    return;
  }
  // One persisted alert per server (subject = the provider server id). The row closes in the same batch, and only while every one of those alerts is
  // open: the UPDATE cannot read how many rows an INSERT in its own batch changed, so it asks the table (Fable note 1).
  const statements = servers.flatMap((id) => subjectAlertStatements(env.DB,
    { homeId: owner.get(id) ?? "platform", kind: ALERT_PRESENT, severity: "high", subject: id, earlier: { noun: "server", verb: "is also present" },
      detail: `dispatch ${row.dispatch_id}: server ${id} (image ${row.image}, reviewed for ${row.review_reason ?? "?"}) exists; home ${owner.get(id) ?? "none"}. Nothing was stopped or deleted: decide by hand` },
    "(SELECT state FROM image_dispatch_auth WHERE dispatch_id=?)='needs_review'", [row.dispatch_id], now));
  const exists = servers.map(() => "EXISTS (SELECT 1 FROM cloud_alerts WHERE kind=? AND subject=? AND resolved_at IS NULL)").join(" AND ");
  statements.push(env.DB.prepare(`UPDATE image_dispatch_auth SET state='resolved_alerted',settled_at=? WHERE dispatch_id=? AND state='needs_review' AND ${exists}`)
    .bind(now, row.dispatch_id, ...servers.flatMap((id) => [ALERT_PRESENT, id])));
  await env.DB.batch(statements);
}
