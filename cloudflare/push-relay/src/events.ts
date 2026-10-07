// POST /v1/events and the drain. Admission enforces spec §3.5's abuse
// controls in this order: kill switch, publisher, exact shape, lifetime,
// dedupe (and staleness), bounded queue, per-binding daily quota, global
// daily cap. The queue comes before the quotas so a refusal spends none.
import { TOKEN_PATTERNS, parseRelayEvent, type RelayEvent } from "../../../shared/mobile-push";
import type { Db } from "./db";
import { HTTPError, bearer, json, readJson, sha256Hex } from "./http";
import { LIMITS, refund, spend } from "./limits";
import { NETWORK_RETRY_MS, type Providers } from "./providers";

const DAY = 24 * 3600_000;
const MAX_ATTEMPTS = 6;
/** Devices and bindings are forgotten after this interval without successful use. */
export const DEVICE_RETENTION_MS = 30 * DAY;
/** Each sweep delete takes at most this many rows, for at most this many rounds a run. */
export const SWEEP_LIMIT = 500;
export const SWEEP_ROUNDS = 4;

/** The kill switch: the RELAY_PAUSED var, or the `paused` row in relay_settings. */
export async function relayPaused(db: Db, flag: string | undefined): Promise<boolean> {
  if (flag === "1") return true;
  return (await db.prepare("SELECT value FROM relay_settings WHERE key='paused'").first<{ value: string }>())?.value === "1";
}

export function createEvents(o: { db: Db; providers: Providers; now: () => number; paused(): Promise<boolean>; globalDailyCap: number; flushOnAdmit?: boolean; sendTimeoutMs?: number;
  /** Platforms whose provider secret is set. Left out means both. */
  configured?: { ios: boolean; android: boolean } }) {
  const { db } = o;
  const sendTimeoutMs = o.sendTimeoutMs ?? 10_000;
  const configured = o.configured ?? { ios: true, android: true };
  // The platforms the drain may claim for (I-2): an event for a platform with
  // no provider secret is never claimed, so it cannot crowd out the others.
  const drainable = [configured.ios ? "ios" : "-", configured.android ? "android" : "-"];

  function activity(bindingId: string, now: number) {
    return [
      db.prepare("UPDATE relay_bindings SET last_active_at=MAX(last_active_at,?) WHERE id=?").bind(now, bindingId),
      db.prepare("UPDATE relay_devices SET last_seen_at=MAX(last_seen_at,?) WHERE id=(SELECT device_id FROM relay_bindings WHERE id=?)").bind(now, bindingId),
    ];
  }

  async function admit(request: Request, waitUntil: (p: Promise<unknown>) => void): Promise<Response> {
    if (await o.paused()) throw new HTTPError(503, "relay_paused");
    const token = bearer(request, TOKEN_PATTERNS.publisher);
    const binding = token ? await db.prepare("SELECT id FROM relay_bindings WHERE publisher_hash=?").bind(await sha256Hex(token)).first<{ id: string }>() : null;
    if (!binding) throw new HTTPError(401, "unauthorized");
    const event = parseRelayEvent(await readJson(request));
    if (!event) throw new HTTPError(400, "invalid_request");
    if (event.bindingId !== binding.id) throw new HTTPError(403, "forbidden");
    // A platform whose provider secret is missing is a fault of this
    // deployment (I-2): refuse with a retryable answer instead of holding the
    // event here, so the host keeps it and retries until it expires, and the
    // relay queue and the other platform are untouched.
    const platform = (await db.prepare("SELECT d.platform AS platform FROM relay_bindings b JOIN relay_devices d ON d.id=b.device_id WHERE b.id=?").bind(binding.id).first<{ platform: string }>())?.platform;
    if (platform === "ios" ? !configured.ios : platform === "android" ? !configured.android : false) {
      console.error("push-relay", JSON.stringify({ provider: platform === "ios" ? "apns" : "fcm", status: 503, reason: "not_configured" }));
      throw new HTTPError(503, "provider_unavailable");
    }
    const now = o.now();
    if (event.expiresAt <= now || event.expiresAt > now + LIMITS.maxEventLifetimeMs) throw new HTTPError(400, "event_expired");
    const duplicate = await db.prepare("SELECT 1 AS yes FROM relay_events WHERE binding_id=? AND event_ref=? AND revision=?").bind(event.bindingId, event.eventRef, event.revision).first();
    if (duplicate) { await db.batch(activity(binding.id, now)); return json({ status: "deduplicated" }, 202); }
    // A notification is replaced by a higher revision under the same collapse
    // key (a resolution). One arriving after its replacement is stale: sending
    // it would alert again for something already answered.
    const newer = await db.prepare("SELECT 1 AS yes FROM relay_events WHERE binding_id=? AND json_extract(payload,'$.collapseKey')=? AND revision>?")
      .bind(event.bindingId, event.collapseKey, event.revision).first();
    if (newer) { await db.batch(activity(binding.id, now)); return json({ status: "deduplicated" }, 202); }
    const queued = await db.prepare(`SELECT (SELECT COUNT(*) FROM relay_events WHERE binding_id=? AND accepted_at IS NULL AND attempts<? AND expires_at>?) AS mine,
      (SELECT COUNT(*) FROM relay_events WHERE accepted_at IS NULL AND attempts<? AND expires_at>?) AS total`).bind(binding.id, MAX_ATTEMPTS, now, MAX_ATTEMPTS, now).first<{ mine: number; total: number }>();
    if (!queued || queued.mine >= LIMITS.pendingPerBinding || queued.total >= LIMITS.pendingTotal) throw new HTTPError(429, "queue_full");
    const bindingScope = `binding-day:${binding.id}`;
    if (!(await spend(db, bindingScope, DAY, LIMITS.pushesPerBindingDay, now))) throw new HTTPError(429, "quota");
    if (!(await spend(db, "global-day", DAY, o.globalDailyCap, now))) {
      await refund(db, bindingScope, DAY, now);
      throw new HTTPError(429, "global_cap");
    }
    // The staleness check above is a separate statement, so the insert and
    // the badge repeat it: a lower revision racing a higher one on another
    // isolate is still never stored, and answers as a duplicate.
    const noNewer = "NOT EXISTS (SELECT 1 FROM relay_events WHERE binding_id=? AND revision>? AND json_extract(payload,'$.collapseKey')=?)";
    const [, inserted] = await db.batch([
      // Retire any undelivered lower revision under the same collapse key, in
      // the same batch as the insert, so it can never be sent after this one.
      db.prepare("UPDATE relay_events SET attempts=? WHERE binding_id=? AND accepted_at IS NULL AND revision<? AND json_extract(payload,'$.collapseKey')=?")
        .bind(MAX_ATTEMPTS, event.bindingId, event.revision, event.collapseKey),
      db.prepare(`INSERT OR IGNORE INTO relay_events (binding_id,event_ref,revision,payload,admitted_at,expires_at,next_attempt_at) SELECT ?,?,?,?,?,?,? WHERE ${noNewer}`)
        .bind(event.bindingId, event.eventRef, event.revision, JSON.stringify(event), now, event.expiresAt, now, event.bindingId, event.revision, event.collapseKey),
      db.prepare(`UPDATE relay_bindings SET badge=? WHERE id=? AND ${noNewer}`).bind(event.workspaceBadge, event.bindingId, event.bindingId, event.revision, event.collapseKey),
      ...activity(binding.id, now),
    ]);
    if (!inserted.meta.changes) {
      await refund(db, bindingScope, DAY, now);
      await refund(db, "global-day", DAY, now);
      return json({ status: "deduplicated" }, 202);
    }
    if (o.flushOnAdmit !== false) waitUntil(flush(5));
    return json({ status: "accepted" }, 202);
  }

  async function flush(limit: number): Promise<number> {
    if (await o.paused()) return 0;
    let sent = 0;
    for (let i = 0; i < Math.min(20, limit); i++) {
      const now = o.now();
      const lease = crypto.randomUUID();
      // The claim takes a lease and nothing else: an attempt is counted only
      // when its result is written, so an invocation cut off mid-send (the
      // lease simply lapses) never uses one up. A revision waits while a
      // lower one in its collapse group is mid-send, so the two can never
      // race to Apple and land in the wrong order.
      const claim = await db.prepare(`UPDATE relay_events SET lease_id=?, lease_until=?
        WHERE rowid=(SELECT rowid FROM relay_events WHERE accepted_at IS NULL AND attempts<? AND next_attempt_at<=? AND lease_until<=? AND expires_at>?
          AND (SELECT d.platform FROM relay_bindings b JOIN relay_devices d ON d.id=b.device_id WHERE b.id=relay_events.binding_id) IN (?, ?)
          AND NOT EXISTS (SELECT 1 FROM relay_events o WHERE o.binding_id=relay_events.binding_id AND o.revision<relay_events.revision AND o.lease_until>?
            AND json_extract(o.payload,'$.collapseKey')=json_extract(relay_events.payload,'$.collapseKey'))
          ORDER BY next_attempt_at, admitted_at LIMIT 1)
        RETURNING binding_id, event_ref, revision, payload, attempts, admitted_at`).bind(lease, now + sendTimeoutMs + 5_000, MAX_ATTEMPTS, now, now, now, drainable[0], drainable[1], now)
        .first<{ binding_id: string; event_ref: string; revision: number; payload: string; attempts: number; admitted_at: number }>();
      if (!claim) break;
      const event = JSON.parse(claim.payload) as RelayEvent;
      // A resolution replaces a notification the phone showed. If no lower
      // revision in its group was ever accepted, there is nothing on the
      // phone to replace, and "Answered on another device." would be a
      // notification about nothing: retire it unsent. The claim above has
      // already waited out any lower revision still mid-send.
      if (event.category === "resolved") {
        const retired = await db.prepare(`UPDATE relay_events SET attempts=?, lease_id=NULL, lease_until=0
          WHERE binding_id=? AND event_ref=? AND revision=? AND lease_id=?
            AND NOT EXISTS (SELECT 1 FROM relay_events o WHERE o.binding_id=? AND o.revision<? AND o.accepted_at IS NOT NULL
              AND json_extract(o.payload,'$.collapseKey')=?)`)
          .bind(MAX_ATTEMPTS, claim.binding_id, claim.event_ref, claim.revision, lease, claim.binding_id, claim.revision, event.collapseKey).run();
        if (retired.meta.changes) continue;
      }
      const device = await db.prepare(`SELECT d.id, d.platform, d.environment, d.push_token, d.token_hash,
        (SELECT COALESCE(SUM(badge),0) FROM relay_bindings WHERE device_id=d.id) AS badge
        FROM relay_devices d JOIN relay_bindings b ON b.device_id=d.id WHERE b.id=?`).bind(claim.binding_id)
        .first<{ id: string; platform: "ios" | "android"; environment: "development" | "production"; push_token: string; token_hash: string; badge: number }>();
      if (!device) continue;
      // Every send has its own deadline: Apple's servers have been seen to
      // leave a connection hanging, and one stuck send must not hold the drain.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException("send timed out", "TimeoutError")), sendTimeoutMs);
      let result: Awaited<ReturnType<Providers["send"]>>;
      try { result = await o.providers.send(device, event, Number(device.badge), controller.signal); }
      catch { result = { retryAfterMs: NETWORK_RETRY_MS, network: true }; }
      finally { clearTimeout(timer); }
      sent++;
      if (result === "invalid-token") {
        await db.prepare("DELETE FROM relay_devices WHERE id=? AND token_hash=?").bind(device.id, device.token_hash).run();
        continue;
      }
      const network = typeof result === "object" && result.network === true;
      // An unanswered send waits about as long as the event has been failing
      // (so the waits double), at most a minute, and counts no attempt:
      // only the event's own expiry ends it. The spike needed five tries.
      const delay = network ? Math.min(60_000, Math.max((result as { retryAfterMs: number }).retryAfterMs, now - claim.admitted_at))
        : typeof result === "object" ? result.retryAfterMs : 0;
      // Only a provider's own retry counts an attempt; a rejection ends the event.
      const completedAt = o.now();
      await db.batch([db.prepare(`UPDATE relay_events SET accepted_at=?, next_attempt_at=?,
        attempts=CASE WHEN ? THEN ? WHEN ? THEN attempts+1 ELSE attempts END, lease_id=NULL, lease_until=0
        WHERE binding_id=? AND event_ref=? AND revision=? AND lease_id=?`)
        .bind(result === "accepted" ? o.now() : null, o.now() + delay, result === "rejected" ? 1 : 0, MAX_ATTEMPTS, typeof result === "object" && !network ? 1 : 0,
          claim.binding_id, claim.event_ref, claim.revision, lease),
        ...(result === "accepted" ? activity(claim.binding_id, completedAt) : []),
      ]);
    }
    return sent;
  }

  /** Every delete is bounded; a backlog drains over later runs. */
  async function sweep(): Promise<void> {
    const now = o.now();
    const bounded = (table: string, where: string, ...values: unknown[]) =>
      db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${SWEEP_LIMIT})`).bind(...values);
    for (let round = 0; round < SWEEP_ROUNDS; round++) {
      const results = await db.batch([
        bounded("relay_events", "expires_at<=?", now),
        bounded("relay_challenges", "expires_at<=?", now),
        // last_active_at=0 is a row an older Worker inserted between migration and deploy: age it by created_at.
        bounded("relay_bindings", "(last_active_at>0 AND last_active_at<=?) OR (last_active_at=0 AND created_at<=?) OR (publisher_hash IS NULL AND grant_expires_at<=?)", now - DEVICE_RETENTION_MS, now - DEVICE_RETENTION_MS, now),
        bounded("relay_counters", "window_start<?", now - 2 * DAY),
        // IP counters are hourly: drop a digest once its window has closed. This
        // also removes any raw-IP scope an older Worker wrote after migration 0002.
        bounded("relay_counters", "(scope LIKE 'ip-%' OR scope LIKE 'install-approval:%') AND window_start<?", now - 3600_000),
        bounded("relay_provider_auth", "expires_at<=?", now),
        // After the lapsed grants above, so a device they were holding goes too.
        bounded("relay_devices", "last_seen_at<=? AND NOT EXISTS (SELECT 1 FROM relay_bindings WHERE device_id=relay_devices.id)", now - DEVICE_RETENTION_MS),
      ]);
      if (results.every((r) => r.meta.changes < SWEEP_LIMIT)) break;
    }
  }

  return { admit, flush, sweep };
}
