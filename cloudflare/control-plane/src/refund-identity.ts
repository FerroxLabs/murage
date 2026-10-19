// SPDX-License-Identifier: AGPL-3.0-or-later
// One voluntary 7-day first-month refund per person or payment method (Sean, 2026-10-10).
// The offer is for a customer's FIRST Murage Cloud payment. At that payment we record who paid as keyed hashes (refund_identity_keys,
// migration 0038): the card fingerprint, every normalized email, and the billing name plus address. A payment that shares any key with an
// earlier payment, or with a payment another account already got the offer for, is not eligible. Only the VOLUNTARY offer reads this:
// the EU/UK statutory withdrawal (legal-refunds.ts, kind "withdrawal") always refunds at least its pro-rata amount whatever it says.
//
// Personal data: only HMAC-SHA256 hashes under REFUND_KEY_SECRET (a Worker secret) are stored, never the fingerprint, email, name or
// address. Without the secret nothing is recorded and the offer fails closed with a plain explanation ("identity_check_unavailable").
//
// What Stripe gives us (docs cited in lanes/cloud-v2/checkout/REFUND-LIMIT-TERMS.md):
//  - card: card.fingerprint identifies the card number.
//  - Apple Pay / Google Pay: the fingerprint is of the device token (DPAN), so the same card on two devices has two fingerprints.
//  - Link (type "link") and Managed Payments checkouts paid with Link: no fingerprint; the Link email, billing details and the customer's
//    email are used instead.
import type { PaymentIdentity, StripeClient } from "./b5-stripe";
import { DB_NOW, fencedBatch, HomeBusy, LeaseLost, q, withHomeLease, type HomeLease, type Q } from "./billing-lease";

declare global {
  interface Env { REFUND_KEY_SECRET?: string; REFUND_KEY_VERSION?: string; REFUND_KEY_SECRET_PREVIOUS?: string; REFUND_KEY_VERSION_PREVIOUS?: string;
    REFUND_LIMIT_TERMS_VERSIONS?: string; REFUND_LIMIT_V2_LIVE?: string }
  namespace Cloudflare { interface Env { REFUND_KEY_SECRET?: string; REFUND_KEY_VERSION?: string; REFUND_KEY_SECRET_PREVIOUS?: string;
    REFUND_KEY_VERSION_PREVIOUS?: string; REFUND_LIMIT_TERMS_VERSIONS?: string; REFUND_LIMIT_V2_LIVE?: string } }
}

export type IdentityKind = "card" | "email" | "billing";
export type IdentityDenial = "not_first_payment" | "identity_check_unavailable";

/** Refund kinds whose payment was refunded in full and never started a plan: such a payment is not a customer's "first payment", so it
 *  never counts against a later checkout (the customer was asked to check out again, or we could not serve them). */
export const NOT_A_FIRST_PAYMENT_KINDS = ["duplicate", "price_mismatch", "late_payment", "no_capacity",
  // Cloud checkout WP3: the hosted checkout's whole-payment refunds of a plan that never started.
  "mismatch", "country_paused", "rejected_consent"] as const;

/** Plain words for every reason the 7-day offer does not apply. Sent to the customer; never a silent refusal. */
export const REFUND_DENIAL_TEXT: Record<string, string> = {
  not_first_payment: "Our 7-day first-month refund is a goodwill offer, given once per person or payment method. The card, email address, "
    + "or billing name and address on this payment was used for an earlier Murage Cloud payment, or for another account that already had "
    + "this refund, so this payment does not qualify.\n\n"
    + "This does not affect your legal rights. If you live in the EU, EEA or UK you can still withdraw from the contract within 14 days "
    + "of checkout, by email or from your Murage Cloud account page, and get the refund the law gives you. You can also cancel at any "
    + "time so you are not billed again.\n\n"
    + "If you think we got this wrong (for example, someone else in your home has their own account), reply to this email and a person "
    + "will look at it.",
  identity_check_unavailable: "We could not finish the checks for your refund just now. Nothing has been decided yet: we will try again "
    + "and email you the outcome. You do not need to do anything.",
  already_refunded: "You have already had our 7-day first-month refund once, and it is given once per person.",
  window_expired: "Our 7-day first-month refund can be asked for within 7 days of the day your server was ready (or of your first payment, if later), and that time has passed. You can "
    + "cancel at any time so you are not billed again.",
  // Unused since 2026-10-12: the 7-day refund pays back the whole fee, nothing is deducted for used credits. Kept for legacy denial rows.
  all_credit_used: "This refusal reason is no longer used. Our 7-day first-month refund pays back the whole first month's fee, whatever "
    + "Flux credits you used. Reply to this email and a person will look at it.",
  abuse_closure: "This account was closed for a breach of our terms, so the 7-day first-month refund does not apply.",
  no_first_payment: "We have no payment on record for this plan yet, so there is nothing to refund.",
};
export const denialText = (reason: string | null): string =>
  REFUND_DENIAL_TEXT[reason ?? ""] ?? "This payment does not qualify for our 7-day first-month refund. Reply to this email if you have a question.";

// ---- Which customers the limit binds (Astra ASTRA-REFUND1 P2-8, code side) ------------------------------------------------------

/** Murage Cloud terms versions (LEGAL_DOCS.cloudTerms.versionId) whose text carries the one-per-person limit and bind WITHOUT the launch
 *  flag. The limit binds only a customer who accepted one of them; anyone else gets the 7-day offer under the terms they agreed to (no
 *  identity check, though their payment is still recorded and, once refunded, claimed). EMPTY in production until the launch: the
 *  versions that carry the text are listed in REFUND_LIMIT_V2_CLOUD_TERMS_IDS, behind REFUND_LIMIT_V2_LIVE. REFUND_LIMIT_TERMS_VERSIONS
 *  (comma-separated env var) adds versions without a code change (staging, tests). */
export const REFUND_LIMIT_TERMS_VERSIONS: readonly string[] = [];
/** The GENERATED Cloud terms version ids (LEGAL_DOCS.cloudTerms.versionId, "cloud-terms-" + the first 12 hex of the text's sha256) whose
 *  text carries the one-per-person limit. These ids are what every writer stores in terms_acceptances.cloud_terms_version (checkout
 *  consent and /v1/account/terms/accept both store currentVersions().cloudTerms), so they are the only thing the limit can match on.
 *  NEVER put the site page's display label here (for example "2026-10-11.1"): no acceptance row ever carries it, and listing it made the
 *  limit bind nobody.
 *  cloud-terms-964155e36e8b: the copy regenerated from the site at 1dccaff, the first text with the limit (cloud-terms-d93024bde751,
 *  the copy before it, does not carry it).
 *  RULE: when legal-docs.generated.ts is regenerated and the Cloud terms id changes, APPEND the new id here if its text still carries
 *  the limit, and KEEP every earlier id that carried it (customers who accepted those versions stay bound). The guard test in
 *  test/refund-kinds.test.ts fails until the current id is listed.
 *  They bind customers only once the launch flag REFUND_LIMIT_V2_LIVE=1 is set, in the same release as the site text. */
export const REFUND_LIMIT_V2_CLOUD_TERMS_IDS: readonly string[] = ["cloud-terms-964155e36e8b"];
export const refundLimitVersions = (env: Env): string[] =>
  [...new Set([...REFUND_LIMIT_TERMS_VERSIONS, ...(env.REFUND_LIMIT_V2_LIVE === "1" ? REFUND_LIMIT_V2_CLOUD_TERMS_IDS : []),
    ...(env.REFUND_LIMIT_TERMS_VERSIONS ?? "").split(",").map((v) => v.trim()).filter(Boolean)])];
/** True when this customer accepted a terms version carrying the limit that binds THIS payment:
 *  - the acceptance made at the payment's OWN checkout (consentId: the checkout consent that produced the paid subscription and its first
 *    invoice; the order completed) binds it whatever the two Stripe event timestamps say. accepted_at comes from
 *    checkout.session.completed.created and paidAt from invoice.paid.created, and Stripe does not order those (an invoice.paid stamped one
 *    second before completion is normal), so comparing them would skip the limit (Astra LIMITVER-1);
 *  - any other acceptance (a re-acceptance, or an earlier completed checkout) binds it only when made no later than the payment, so a later
 *    re-acceptance never binds a payment made before it. */
export async function refundLimitAccepted(env: Env, userId: string, paidAt: number, consentId: string | null): Promise<boolean> {
  const versions = refundLimitVersions(env);
  if (versions.length === 0) return false;
  return (await env.DB.prepare(`SELECT 1 AS x FROM terms_acceptances WHERE user_id=? AND cloud_terms_version IN (${versions.map(() => "?").join(",")})
      AND (consent_id IS NULL OR EXISTS (SELECT 1 FROM checkout_consents ac WHERE ac.id=terms_acceptances.consent_id AND ac.completed_at IS NOT NULL))
      AND (accepted_at<=? OR (consent_id IS NOT NULL AND consent_id=?)) LIMIT 1`)
    .bind(userId, ...versions, paidAt, consentId).first()) !== null;
}

// ---- Normalization (pure; exported for tests) ----------------------------------------------------------------------------------

/** The normalization version written with every email and billing key (and part of its hashed input). See migration 0041. When it
 *  changes, list the old version in ACTIVE_NORMALIZATIONS until its records have aged out, and keep its functions. */
export const NORMALIZATION = 2;
export const ACTIVE_NORMALIZATIONS: readonly number[] = [NORMALIZATION];

/** Providers that document "+tag" subaddresses as the same mailbox (RFC 5233 leaves it to each provider). Gmail also ignores dots. */
const PLUS_TAG_DOMAINS = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com",
  "mac.com", "fastmail.com", "fastmail.fm", "proton.me", "protonmail.com", "pm.me"]);

/** An internationalized domain in its one ASCII (punycode) form, lowercase; null when it is not a domain. */
function asciiDomain(raw: string): string | null {
  try {
    const host = new URL(`http://${raw.normalize("NFC")}`).hostname;
    return host ? host.replace(/\.$/, "") : null;
  } catch { return null; }
}

/** Lowercase, trimmed, Unicode in one form; the domain in its ASCII form; the "+tag" dropped only where the provider documents it; Gmail
 *  ignores dots and googlemail.com is gmail.com. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const e = (raw ?? "").trim().normalize("NFC").toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0 || at === e.length - 1) return null;
  let local = e.slice(0, at); let domain = asciiDomain(e.slice(at + 1));
  if (!domain) return null;
  if (domain === "googlemail.com") domain = "gmail.com";
  if (PLUS_TAG_DOMAINS.has(domain)) { const plus = local.indexOf("+"); if (plus >= 0) local = local.slice(0, plus); }
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return local ? `${local}@${domain}` : null;
}
/** Every letter, mark and digit kept in any script (accents on Latin letters folded: "José" is "Jose"), lowercase, everything else a
 *  single space. */
export function normalizeText(raw: string | null | undefined): string {
  return (raw ?? "").normalize("NFKD").replace(/(?<=[A-Za-z])[\u0300-\u036f]+/g, "").normalize("NFC").toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim();
}
/** The billing identity: the name (word order ignored) and the address (country, postal code, both street lines). Null unless it is
 *  strong enough to refuse a refund on: a name, a country AND a street line. A name with only a country and postal code fits many
 *  unrelated people, so it is never a key (Astra P2-6). */
export function billingIdentity(id: Pick<PaymentIdentity, "name" | "address">): string | null {
  const name = normalizeText(id.name).split(" ").filter(Boolean).sort().join(" ");
  const a = id.address;
  const country = (a?.country ?? "").trim().toUpperCase();
  const postal = (a?.postal_code ?? "").normalize("NFKC").toUpperCase().replace(/[^\p{L}\p{N}]/gu, "");
  const line1 = normalizeText(a?.line1); const line2 = normalizeText(a?.line2);
  if (!name || !country || !line1) return null;
  return `${name}|${country}|${postal}|${line1}|${line2}`;
}

async function hmacHex(secret: string, input: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** The hashed input names the kind and, for normalized values, the normalization version: keys of different kinds or versions never meet. */
const hmac = (secret: string, kind: IdentityKind, norm: number | null, value: string): Promise<string> =>
  hmacHex(secret, `${norm === null ? `refund-identity:v1:${kind}` : `refund-identity:n${norm}:${kind}`}:${value}`);

// ---- Keyring (versioned HMAC keys; migration 0043) ------------------------------------------------------------------------------

export interface RingKey { version: number; secret: string }
const usableSecret = (v: unknown): string | null => (typeof v === "string" && v.length >= 32 ? v : null);
const versionOf = (v: unknown, fallback: number): number | null => {
  if (v === undefined || v === "") return fallback;
  return typeof v === "string" && /^[1-9][0-9]{0,5}$/.test(v) ? Number(v) : null;
};
/** Why the configured refund keys cannot be used, or null when they can (or none is set). billingConfig refuses live billing on it. */
export function refundKeyConfigError(env: Env): string | null {
  if (env.REFUND_KEY_SECRET === undefined || env.REFUND_KEY_SECRET === "") return null;
  if (!usableSecret(env.REFUND_KEY_SECRET)) return "refund_key_invalid";
  const v = versionOf(env.REFUND_KEY_VERSION, 1);
  if (v === null) return "refund_key_version_invalid";
  if (env.REFUND_KEY_SECRET_PREVIOUS !== undefined && env.REFUND_KEY_SECRET_PREVIOUS !== "") {
    if (!usableSecret(env.REFUND_KEY_SECRET_PREVIOUS)) return "refund_key_previous_invalid";
    const pv = versionOf(env.REFUND_KEY_VERSION_PREVIOUS, v - 1);
    if (pv === null || pv === v || pv < 1) return "refund_key_version_invalid";
    if (env.REFUND_KEY_SECRET_PREVIOUS === env.REFUND_KEY_SECRET) return "refund_key_previous_invalid";
  }
  return null;
}
/** The configured keys, current first; null when there is no usable current key. */
export function configuredKeys(env: Env): RingKey[] | null {
  if (refundKeyConfigError(env)) return null;
  const cur = usableSecret(env.REFUND_KEY_SECRET);
  if (!cur) return null;
  const v = versionOf(env.REFUND_KEY_VERSION, 1)!;
  const ring: RingKey[] = [{ version: v, secret: cur }];
  const prev = usableSecret(env.REFUND_KEY_SECRET_PREVIOUS);
  if (prev) ring.push({ version: versionOf(env.REFUND_KEY_VERSION_PREVIOUS, v - 1)!, secret: prev });
  return ring;
}
/** The keys to hash with, checked against what was used before: a key replaced under the same version, or a version stored records still
 *  use that is no longer configured, makes the keyring unusable (null) and alerts ops. Nothing is ever granted or forgotten silently. */
export async function keyring(env: Env, now: number): Promise<RingKey[] | null> {
  const configured = configuredKeys(env);
  if (!configured) return null;
  // A previous key that was retired (retireRedundantKeys) is no longer hashed with, even while it is still configured.
  const retired = new Set((await env.DB.prepare("SELECT version FROM refund_identity_keyring WHERE retired_at IS NOT NULL").all<{ version: number }>()).results.map((r) => r.version));
  const ring = configured.filter((k, i) => i === 0 || !retired.has(k.version));
  const fail = async (kind: string, detail: Record<string, unknown>) => {
    await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
      .bind(crypto.randomUUID(), "billing", kind, "high", JSON.stringify(detail), now).run();
    return null;
  };
  // A CURRENT key whose version was already retired (a Worker still running the configuration from before the rotation, or a rollback):
  // hashing with it would write keys nothing can match or retire again (Astra ASTRA-REFUND3 #2).
  if (retired.has(ring[0].version)) return fail("refund_key.retired_in_use", { version: ring[0].version });
  for (const k of ring) {
    const check = await hmacHex(k.secret, "refund-identity:keycheck");
    await env.DB.prepare("INSERT INTO refund_identity_keyring (version,check_hash,first_used_at) VALUES (?,?,?) ON CONFLICT(version) DO NOTHING")
      .bind(k.version, check, now).run();
    const row = await env.DB.prepare("SELECT check_hash FROM refund_identity_keyring WHERE version=?").bind(k.version).first<{ check_hash: string }>();
    if (row?.check_hash !== check) return fail("refund_key.replaced", { version: k.version });
  }
  const versions = ring.map((k) => k.version);
  const orphan = await env.DB.prepare(`SELECT key_version AS v FROM refund_identity_keys WHERE key_version NOT IN (${versions.map(() => "?").join(",")}) LIMIT 1`)
    .bind(...versions).first<{ v: number }>();
  if (orphan) return fail("refund_key.previous_missing", { version: orphan.v });
  return ring;
}

/** Billing sweep: retires previous-version keys once they are redundant (Astra ASTRA-REFUND2 #4). A previous version is redundant when no
 *  stored payment has more keys under it than under the current version (every payment hashed under it was also hashed under the current
 *  key: the old-only records have aged out). Then, in one batch that re-checks that condition, its claims are carried over to the current-
 *  version keys of the same payments, its keys and claims are deleted, and the version is marked retired, so nothing hashes with it again
 *  and the previous key can be removed from the Worker. Returns the versions retired. */
export async function retireRedundantKeys(env: Env, now: number): Promise<number[]> {
  const ring = configuredKeys(env);
  if (!ring) return [];
  const cur = ring[0].version;
  const old = (await env.DB.prepare(`SELECT DISTINCT key_version AS v FROM refund_identity_keys WHERE key_version<>?
    UNION SELECT version AS v FROM refund_identity_keyring WHERE version<>? AND retired_at IS NULL`).bind(cur, cur).all<{ v: number }>()).results.map((r) => r.v);
  const done: number[] = [];
  for (const v of old) {
    const oldOnly = `SELECT invoice_id FROM refund_identity_keys WHERE key_version IN (?,?) GROUP BY invoice_id
      HAVING SUM(key_version=?) > SUM(key_version=?) LIMIT 1`;
    if (await env.DB.prepare(oldOnly).bind(v, cur, v, cur).first()) continue; // still needed: a payment is known only under this key
    const g = `retire-${crypto.randomUUID()}`;
    const oldKeys = "SELECT kind,key_hash FROM refund_identity_keys WHERE key_version=?";
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO cloud_write_guards VALUES (?,NOT EXISTS (${oldOnly}))`).bind(g, v, cur, v, cur),
      env.DB.prepare(`INSERT INTO refund_identity_claims (kind,key_hash,invoice_id,user_id,op_id,claimed_at,refunded_at)
        SELECT k.kind,k.key_hash,c.invoice_id,c.user_id,c.op_id,c.claimed_at,c.refunded_at FROM refund_identity_keys k
        JOIN (SELECT invoice_id,MIN(user_id) AS user_id,MIN(op_id) AS op_id,MIN(claimed_at) AS claimed_at,MAX(refunded_at) AS refunded_at FROM refund_identity_claims
          WHERE (kind,key_hash) IN (${oldKeys}) GROUP BY invoice_id) c ON c.invoice_id=k.invoice_id
        WHERE k.key_version=? ON CONFLICT(kind,key_hash) DO NOTHING`).bind(v, cur),
      env.DB.prepare(`DELETE FROM refund_identity_claims WHERE (kind,key_hash) IN (${oldKeys})`).bind(v),
      env.DB.prepare("DELETE FROM refund_identity_keys WHERE key_version=?").bind(v),
      env.DB.prepare("UPDATE refund_identity_keyring SET retired_at=COALESCE(retired_at,?) WHERE version=?").bind(now, v),
      env.DB.prepare("DELETE FROM cloud_write_guards WHERE id=?").bind(g),
    ]);
    // Ops is told the previous key can now be removed (removing it earlier stops the check: refund_key.previous_missing).
    await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
      .bind(crypto.randomUUID(), "billing", "refund_key.previous_retired", "warning", JSON.stringify({ version: v }), now).run();
    done.push(v);
  }
  return done;
}

/** The keys of one payment, hashed under every configured key and for every active normalization. The Murage account email is one of the emails. A card fingerprint
 *  is Stripe's own value and needs no normalization. */
export async function identityKeys(ring: RingKey[], id: PaymentIdentity, accountEmail: string | null): Promise<IdentityKey[]> {
  const out: IdentityKey[] = [];
  for (const { version, secret } of ring) {
    if (id.fingerprint) out.push({ kind: "card", hash: await hmac(secret, "card", null, id.fingerprint), norm: 0, keyVersion: version });
    for (const norm of ACTIVE_NORMALIZATIONS) {
      const emails = new Set([...id.emails, accountEmail].map(normalizeEmail).filter((e): e is string => e !== null));
      for (const e of emails) out.push({ kind: "email", hash: await hmac(secret, "email", norm, e), norm, keyVersion: version });
      const b = billingIdentity(id);
      if (b) out.push({ kind: "billing", hash: await hmac(secret, "billing", norm, b), norm, keyVersion: version });
    }
  }
  return out;
}
export interface IdentityKey { kind: IdentityKind; hash: string; norm: number; keyVersion: number }

// ---- Capture and check -----------------------------------------------------------------------------------------------------------

export interface FirstPaymentRef { homeId: string; userId: string; invoiceId: string; paidAt: number; paymentIntent: string | null }

// ---- Retention ------------------------------------------------------------------------------------------------------------------

/** How long a payment's refund-identity records are kept: 24 calendar months from the payment (Sean, 2026-10-10), also after the account
 *  is closed. The privacy policy and the terms state the same period. */
export const REFUND_IDENTITY_RETENTION_MONTHS = 24;
/** The oldest payment time still kept at `now`: anything paid before it is purged and never captured again. */
export function retentionCutoff(now: number): number {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - REFUND_IDENTITY_RETENTION_MONTHS);
  return d.getTime();
}
/** Deletes every refund-identity record of payments older than the retention period: their keys, their capture rows and the claims made
 *  from them (all in one batch). Run by the billing sweep. Returns how many key rows were deleted. */
export async function purgeRefundIdentity(env: Env, now: number): Promise<number> {
  const cutoff = retentionCutoff(now);
  const res = await env.DB.batch([
    env.DB.prepare(`DELETE FROM refund_identity_claims WHERE invoice_id IN (SELECT invoice_id FROM refund_identity_captures WHERE paid_at<?)
      OR invoice_id IN (SELECT invoice_id FROM refund_identity_keys WHERE paid_at<?)`).bind(cutoff, cutoff),
    env.DB.prepare("DELETE FROM refund_identity_keys WHERE paid_at<?").bind(cutoff),
    env.DB.prepare("DELETE FROM refund_identity_captures WHERE paid_at<?").bind(cutoff),
    env.DB.prepare("DELETE FROM refund_identity_settled WHERE paid_at<?").bind(cutoff),
    env.DB.prepare("DELETE FROM refund_refusal_receipts WHERE received_at<?").bind(cutoff),
    env.DB.prepare("DELETE FROM refund_refusal_invalidations WHERE invoice_id NOT IN (SELECT invoice_id FROM refund_refusal_receipts)"),
  ]);
  return res[1].meta.changes ?? 0;
}

/** Records the keys of a plan's first payment once (append-only). Reads Stripe; a Stripe failure throws (the caller retries or reports
 *  the check unavailable). Returns false when nothing can be recorded (no secret configured). */
export async function captureRefundIdentity(env: Env, stripe: StripeClient, p: FirstPaymentRef, now: number, opts: { enrich?: boolean } = {}): Promise<boolean> {
  // Past the retention period a payment is never recorded (again): the purge removed it, and nothing brings it back.
  if (p.paidAt < retentionCutoff(now)) return false;
  // Codes erased after an objection (refund_identity_restrictions) are never recorded again for the payments the decision covered.
  if (erasedFor(await restrictionOf(env, p.userId), p.paidAt)) return false;
  if (!opts.enrich && await env.DB.prepare("SELECT 1 AS x FROM refund_identity_captures WHERE invoice_id=?").bind(p.invoiceId).first()) return true;
  let ring = await keyring(env, now);
  if (!ring) return false;
  const sub = await env.DB.prepare("SELECT customer_id FROM billing_subscriptions WHERE home_id=?").bind(p.homeId).first<{ customer_id: string | null }>();
  const user = await env.DB.prepare(`SELECT email FROM "user" WHERE id=?`).bind(p.userId).first<{ email: string | null }>();
  const id = await stripe.paymentIdentity(p.paymentIntent, sub?.customer_id ?? null);
  // The Stripe read can take a while, and the billing sweep may retire a previous key meanwhile (retireRedundantKeys). The write is
  // fenced against that in its own batch: if any key version this capture hashed with is retired by then, nothing is written and the
  // keys are hashed again with the active keyring (Astra ASTRA-REFUND3 #2). Without the fence, keys of a retired version would be
  // inserted after its retirement: the keyring would stop (previous_missing) and nothing could retire them again.
  for (let attempt = 0; ; attempt++) {
    try { return await writeCapture(env, p, now, ring, id, user?.email ?? null); }
    catch (e) {
      // The person's codes were erased while Stripe was being read (Astra ASTRA-REFUND4 #1): the fenced batch wrote nothing, and nothing is
      // recorded for this payment ever again.
      if (erasedFor(await restrictionOf(env, p.userId), p.paidAt)) return false;
      const versions = ring.map((k) => k.version);
      const stale = await env.DB.prepare(`SELECT 1 AS x FROM refund_identity_keyring WHERE retired_at IS NOT NULL AND version IN (${versions.map(() => "?").join(",")}) LIMIT 1`)
        .bind(...versions).first();
      if (!stale || attempt >= 2) throw e;
      ring = await keyring(env, now);
      if (!ring) return false; // this Worker's configuration is older than the retirement: nothing recorded, the sweep captures it later
    }
  }
}

async function writeCapture(env: Env, p: FirstPaymentRef, now: number, ring: RingKey[], id: PaymentIdentity, accountEmail: string | null): Promise<boolean> {
  const keys = await identityKeys(ring, id, accountEmail);
  // Nothing to compare: not a capture. The payment stays uncaptured (retried by the sweep) and its own check stays pending.
  if (keys.length === 0) throw new Error("refund_identity_empty");
  const complete = captureComplete(id, keys);
  const versions = ring.map((k) => k.version);
  const g = `capture-${crypto.randomUUID()}`;
  // Settled: Stripe showed the payment itself, or its keys are complete. Until then the payment is never judged on what is recorded
  // (firstPaymentCheck), however old it is (Astra ASTRA-REFUND3 #1). Durable: never undone, and kept until the retention purge.
  const settled = complete || id.source !== "unreadable";
  await env.DB.batch([
    // The fence: fails the whole batch when a version hashed with here was retired after the keyring was read.
    env.DB.prepare(`INSERT INTO cloud_write_guards VALUES (?,NOT EXISTS (SELECT 1 FROM refund_identity_keyring WHERE retired_at IS NOT NULL
      AND version IN (${versions.map(() => "?").join(",")})))`).bind(g, ...versions),
    // And against an erasure on an objection that ran after the check above (Astra ASTRA-REFUND4 #1): the erased_through cutoff endures,
    // so a capture or enrichment in flight never brings erased codes back.
    env.DB.prepare(`INSERT INTO cloud_write_guards VALUES (?,NOT EXISTS (SELECT 1 FROM refund_identity_restrictions WHERE user_id=?
      AND erased_through IS NOT NULL AND ?<=erased_through))`).bind(`${g}-e`, p.userId, p.paidAt),
    ...(settled ? [env.DB.prepare("INSERT INTO refund_identity_settled (invoice_id,paid_at,settled_at) VALUES (?,?,?) ON CONFLICT(invoice_id) DO NOTHING")
      .bind(p.invoiceId, p.paidAt, now)] : []),
    ...keys.map((k) => env.DB.prepare(`INSERT INTO refund_identity_keys (kind,key_hash,user_id,home_id,invoice_id,paid_at,created_at,norm,key_version)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(invoice_id,kind,key_hash) DO NOTHING`).bind(k.kind, k.hash, p.userId, p.homeId, p.invoiceId, p.paidAt, now, k.norm, k.keyVersion)),
    // Incomplete: read again later (the sweep, with backoff) until it is complete or nothing more can come. The completion guard (Astra
    // MAILRETRY-4 P2) is in the statement itself, ahead of the capture's own insert in this batch: enrichment is created only by the FIRST
    // capture of the payment (no capture row yet). A later incomplete read (an enrichment, or a late capture racing a complete one) never
    // inserts it: a row a complete capture deleted is never recreated, and a row still pending keeps its own claimed schedule.
    ...(complete ? [] : [env.DB.prepare(`INSERT INTO refund_identity_enrich (invoice_id,home_id,user_id,paid_at,payment_intent,attempts,next_attempt_at)
      SELECT ?,?,?,?,?,0,? WHERE NOT EXISTS (SELECT 1 FROM refund_identity_captures WHERE invoice_id=?) ON CONFLICT(invoice_id) DO NOTHING`)
      .bind(p.invoiceId, p.homeId, p.userId, p.paidAt, p.paymentIntent, now + ENRICH_BACKOFF_MS, p.invoiceId)]),
    env.DB.prepare(`INSERT INTO refund_identity_captures (invoice_id,home_id,user_id,paid_at,source,fingerprint,captured_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(invoice_id) DO NOTHING`).bind(p.invoiceId, p.homeId, p.userId, p.paidAt, id.source, keys.some((k) => k.kind === "card") ? 1 : 0, now),
    // Complete: nothing more to read.
    ...(complete ? [env.DB.prepare("DELETE FROM refund_identity_enrich WHERE invoice_id=?").bind(p.invoiceId)] : []),
    // Keys recovered for a payment that already got the 7-day offer join its claim (Astra ASTRA-REFUND2 #2): a card Stripe could only show
    // after the decision is claimed by that decision, so no other payment with the same card gets the offer again.
    env.DB.prepare(`INSERT INTO refund_identity_claims (kind,key_hash,invoice_id,user_id,op_id,claimed_at,refunded_at)
      SELECT k.kind,k.key_hash,k.invoice_id,c.user_id,c.op_id,c.claimed_at,c.refunded_at FROM refund_identity_keys k
      JOIN (SELECT user_id,op_id,claimed_at,refunded_at FROM refund_identity_claims WHERE invoice_id=? ORDER BY claimed_at LIMIT 1) c
      WHERE k.invoice_id=? ON CONFLICT(kind,key_hash) DO NOTHING`).bind(p.invoiceId, p.invoiceId),
    env.DB.prepare("DELETE FROM cloud_write_guards WHERE id IN (?,?)").bind(g, `${g}-e`),
  ]);
  return true;
}

/** Complete: the payment itself was read and gave a card, a billing identity or an email of its own. Otherwise (only the customer's or
 *  account's email, or Stripe could not show the payment) the capture is kept but read again later. */
export function captureComplete(id: PaymentIdentity, keys: { kind: IdentityKind }[]): boolean {
  if (keys.some((k) => k.kind === "card" || k.kind === "billing")) return true;
  return id.source !== "unreadable" && id.paymentEmails > 0;
}
const ENRICH_BACKOFF_MS = 15 * 60_000;
/** Incomplete captures are read again for this long after the payment; then nothing more will come. */
export const ENRICH_FOR_MS = 14 * 24 * 3_600_000;

/** An incomplete capture due to be read again, as selected (its attempts and due time are the snapshot its claim is conditional on). */
export interface EnrichRow { invoice_id: string; home_id: string; user_id: string; paid_at: number; payment_intent: string | null; attempts: number;
  next_attempt_at: number }
/** Billing sweep: the incomplete captures due to be read again (a few at a time), earliest due first; those past ENRICH_FOR_MS are dropped. */
export async function dueEnrichments(env: Env, now: number): Promise<EnrichRow[]> {
  await env.DB.prepare("DELETE FROM refund_identity_enrich WHERE paid_at<?").bind(now - ENRICH_FOR_MS).run();
  return (await env.DB.prepare("SELECT * FROM refund_identity_enrich WHERE next_attempt_at<=? ORDER BY next_attempt_at LIMIT 10").bind(now).all<EnrichRow>()).results;
}
/** Reads one incomplete capture again and adds what Stripe now shows. Claimed first, CONDITIONALLY on the row exactly as selected (Astra
 *  MAILRETRY-4 P2): the attempt is counted and the next read scheduled only while attempts and next_attempt_at are still the snapshot's,
 *  so a run that resumes an old selection (a step cut at its cap and carried on) never overwrites a newer run's attempt or schedule, and
 *  a row another run claimed, or a complete capture deleted, is skipped. Counted first: a payment Stripe keeps failing on is read less
 *  and less often, never in every sweep. Returns whether this call claimed (and read) it. */
export async function enrichOne(env: Env, stripe: StripeClient, r: EnrichRow, now: number): Promise<boolean> {
  const claim = await env.DB.prepare("UPDATE refund_identity_enrich SET attempts=attempts+1,next_attempt_at=? WHERE invoice_id=? AND attempts=? AND next_attempt_at=?")
    .bind(now + ENRICH_BACKOFF_MS * 2 ** Math.min(r.attempts + 1, 6), r.invoice_id, r.attempts, r.next_attempt_at).run();
  if (claim.meta.changes !== 1) return false;
  try {
    await captureRefundIdentity(env, stripe, { homeId: r.home_id, userId: r.user_id, invoiceId: r.invoice_id, paidAt: r.paid_at, paymentIntent: r.payment_intent },
      now, { enrich: true });
  } catch { /* tried again later */ }
  return true;
}
/** Every due incomplete capture, one after the other (the billing sweep runs each as its own bounded step instead). */
export async function enrichRefundIdentities(env: Env, stripe: StripeClient, now: number): Promise<void> {
  for (const r of await dueEnrichments(env, now)) await enrichOne(env, stripe, r, now);
}

/** A first payment captured less than this long ago may still be waiting for its keys (a Stripe hiccup at invoice.paid; the sweep retries
 *  within minutes). While such an EARLIER payment is uncaptured, a later payment cannot be judged "first": the check is pending, never a
 *  guess. Past this age a missing capture is a fault (alerted by the sweep) and no longer holds up anyone else's refund. */
export const CAPTURE_GRACE_MS = 3 * 24 * 3_600_000;

/** The rows of this payment's keys (bind: invoiceId, ...NOT_A_FIRST_PAYMENT_KINDS) that make it "not the customer's first": shared with an
 *  earlier payment, or claimed by another payment's offer. restricted=false counts only codes of people with no open objection (a final
 *  refusal); true only codes of people with one (pending); null every code, objections ignored. One text for the check and for the
 *  fence of the decision that refuses on it. */
function matchSql(restricted: boolean | null, invoice = "?"): string {
  const kinds = NOT_A_FIRST_PAYMENT_KINDS.map(() => "?").join(",");
  // null: every qualifying match, whoever's codes and whatever objection is open (an erasure's pre/post comparison, ASTRA-REFUND8).
  const open = (col: string) => restricted === null ? "1" : `${restricted ? "" : "NOT "}EXISTS (SELECT 1 FROM refund_identity_restrictions r WHERE r.user_id=${col} AND r.notice_sent_at IS NULL)`;
  return `SELECT 1 AS x FROM refund_identity_keys mine WHERE mine.invoice_id=${invoice} AND (
      EXISTS (SELECT 1 FROM refund_identity_claims c WHERE c.kind=mine.kind AND c.key_hash=mine.key_hash AND c.invoice_id<>mine.invoice_id AND ${open("c.user_id")})
      OR EXISTS (SELECT 1 FROM refund_identity_keys k WHERE k.key_hash=mine.key_hash AND k.kind=mine.kind AND k.invoice_id<>mine.invoice_id AND ${open("k.user_id")}
        AND NOT EXISTS (SELECT 1 FROM refund_ops o WHERE o.invoice_id=k.invoice_id AND o.kind IN (${kinds}))
        AND ((k.paid_at<mine.paid_at OR (k.paid_at=mine.paid_at AND k.invoice_id<mine.invoice_id))
          OR EXISTS (SELECT 1 FROM refund_ops o WHERE o.invoice_id=k.invoice_id AND o.decided_at IS NOT NULL AND o.basis='seven_day_offer' AND o.amount_cents>0))))`;
}

/** The SQL condition (and its binds) that a "not_first_payment" refusal of `invoiceId`, asked by `userId`, still stands on: the person
 *  has no open objection, and a key of the payment still matches codes nobody has an open objection to. An objection opened (or an
 *  erasure made) after the identity check, before the refusal is committed or sent, makes it false (Astra ASTRA-REFUND4 #2). */
export function refusalStands(invoiceId: string, userId: string): { sql: string; binds: unknown[] } {
  return {
    sql: `(NOT ${OPEN_RESTRICTION_SQL}
      AND EXISTS (${matchSql(false)}))`,
    binds: [userId, invoiceId, invoiceId, ...NOT_A_FIRST_PAYMENT_KINDS],
  };
}
/** An objection is open for the person asking or for the payer of the invoice (binds: userId, invoiceId; or SQL column expressions). */
const openRestrictionSql = (user = "?", invoice = "?") => `EXISTS (SELECT 1 FROM refund_identity_restrictions r WHERE r.notice_sent_at IS NULL AND (r.user_id=${user}
        OR r.user_id IN (SELECT user_id FROM refund_identity_keys WHERE invoice_id=${invoice})))`;
const OPEN_RESTRICTION_SQL = openRestrictionSql();

/** A queued refusal notice is withdrawn rather than sent: "refusal_held" (it rests on codes under an open objection; tried again later)
 *  or "refusal_obsolete" (its operation reopened or paid, or the codes it rested on are gone; never sent). Not a failed send. */
export class RefusalWithdrawn extends Error {}
/** How long a held refusal notice waits before it is looked at again (the objection may be decided at any time). */
export const REFUSAL_NOTICE_HOLD_MS = 60 * 60_000;
export interface RefusalRef { invoiceId: string; userId: string }
/** The payment and person a "not_first_payment" refusal notice is about, or null for every other notice. The notice id is
 *  refund_declined:<home>:not_first_payment:<invoice>; notices recorded from now on also carry both in their payload. */
export function refusalNoticeRef(notice: { id: string; kind: string; ownerId: string; data: Record<string, unknown> }): RefusalRef | null {
  if (notice.kind !== "refund_declined" || notice.data.reason !== "not_first_payment") return null;
  const invoiceId = typeof notice.data.invoiceId === "string" ? notice.data.invoiceId : notice.id.split(":")[3];
  const userId = typeof notice.data.userId === "string" ? notice.data.userId : notice.ownerId;
  return invoiceId ? { invoiceId, userId } : null;
}
/** The 7-day request for this payment was reopened (pending again) or pays: a refusal recorded earlier no longer describes it. */
const SUPERSEDED_SQL = `EXISTS (SELECT 1 FROM refund_ops o WHERE o.invoice_id=? AND o.kind='first_month'
      AND (o.decided_at IS NULL OR COALESCE(o.amount_cents,0)>0))`;
/** The condition (and binds) under which a queued refusal notice may be sent now: the refusal still stands and nothing superseded it.
 *  Checked in the same write that claims the notice for sending (Astra ASTRA-REFUND5 #1). */
export function refusalNoticeValid(r: RefusalRef): { sql: string; binds: unknown[] } {
  const s = refusalStands(r.invoiceId, r.userId);
  return { sql: `(${s.sql} AND NOT ${SUPERSEDED_SQL})`, binds: [...s.binds, r.invoiceId] };
}
/** How long a refusal send holds its dispatch before a takeover may reconcile it (the notice claim's own length). Passing it never
 *  ends the dispatch by itself: the takeover reconciles it first (reconcileRefusalDispatches). */
export const REFUSAL_SEND_LOCK_MS = 2 * 60_000;
/** How long after its handoff write was ISSUED a sender may still start EMAIL (Astra ASTRA-REFUND8 #3). The handoff renews the dispatch
 *  rows' `until` (and the home lease) to REFUSAL_SEND_LOCK_MS past its commit, on the database's clock, in the same write; the commit is no
 *  earlier than the issue, so no takeover can reconcile the dispatch before issue + REFUSAL_SEND_LOCK_MS. The sender measures elapsed time
 *  on its own clock only (no clock comparison) and, past this conservative quarter of that window, never calls EMAIL: a delayed database
 *  acknowledgement can no longer let a sender whose fence was revoked meanwhile send. */
export const REFUSAL_HANDOFF_DEADLINE_MS = REFUSAL_SEND_LOCK_MS / 4;
/** The refusal handoff, for one fenced batch: marks the dispatch 'handed_off' under this sender's fence and, only when that succeeded,
 *  renews this sender's dispatch rows and the home lease in the same transaction. The first statement's changes are 1 when it is ours. */
export function refusalHandoffStatements(noticeId: string, holder: string, lease: Q): Q[] {
  return [
    q("UPDATE billing_notices SET dispatch_state='handed_off' WHERE id=? AND dispatch_fence=? AND dispatch_state='dispatching'", noticeId, holder),
    q(`UPDATE refund_refusal_sends SET until=${DB_NOW}+? WHERE holder=? AND notice_id=?
        AND EXISTS (SELECT 1 FROM billing_notices WHERE id=? AND dispatch_fence=? AND dispatch_state='handed_off')`, REFUSAL_SEND_LOCK_MS, holder, noticeId, noticeId, holder),
    [`${lease[0]} AND EXISTS (SELECT 1 FROM billing_notices WHERE id=? AND dispatch_fence=? AND dispatch_state='handed_off')`, [...(lease[1] ?? []), noticeId, holder]],
  ];
}
/** For the SAME batch as the claim of a refusal notice (the claim is the statement just before): one lock row per person the refusal
 *  rests on, the asker and everyone whose codes or claims match the payment's keys, written only when the claim succeeded. */
export function refusalSendLock(r: RefusalRef, holder: string, noticeId: string): Q[] {
  return [q(`INSERT INTO refund_refusal_sends (user_id,holder,notice_id,until)
      SELECT u,?,?,${DB_NOW}+? FROM (SELECT ? AS u
        UNION SELECT k.user_id FROM refund_identity_keys mine JOIN refund_identity_keys k ON k.kind=mine.kind AND k.key_hash=mine.key_hash WHERE mine.invoice_id=?
        UNION SELECT c.user_id FROM refund_identity_keys mine JOIN refund_identity_claims c ON c.kind=mine.kind AND c.key_hash=mine.key_hash WHERE mine.invoice_id=?)
      WHERE changes()=1`, holder, noticeId, REFUSAL_SEND_LOCK_MS, r.userId, r.invoiceId, r.invoiceId)];
}
/** Ends a refusal send: this sender's rows only (a crashed sender's rows are reconciled by a takeover, never just dropped). An objection
 *  that arrived during the handoff ("pending_restriction") is finalised at once when nothing else names its person (ASTRA-REFUND6 #3). */
export async function releaseRefusalSendLock(env: Env, holder: string, now: number): Promise<void> {
  const gone = await env.DB.prepare("DELETE FROM refund_refusal_sends WHERE holder=? RETURNING user_id").bind(holder).all<{ user_id: string }>();
  await finalisePendingObjections(env, now, [...new Set(gone.results.map((r) => r.user_id))]);
}

/** Why a refusal notice that may not be sent now is not sent: held while it rests on codes under an open objection (the asker's, the
 *  payer's, or those of the person whose codes match, as firstPaymentCheck holds the request), otherwise obsolete for good. */
export async function refusalNoticeState(env: Env, r: RefusalRef): Promise<"send" | "hold" | "obsolete"> {
  const stands = refusalStands(r.invoiceId, r.userId);
  const row = await env.DB.prepare(`SELECT ${SUPERSEDED_SQL} AS superseded, ${stands.sql} AS stands,
      (${OPEN_RESTRICTION_SQL} OR EXISTS (${matchSql(true)})) AS restricted`)
    .bind(r.invoiceId, ...stands.binds, r.userId, r.invoiceId, r.invoiceId, ...NOT_A_FIRST_PAYMENT_KINDS)
    .first<{ superseded: number; restricted: number; stands: number }>();
  if (!row || row.superseded) return "obsolete";
  if (row.stands) return "send";
  return row.restricted ? "hold" : "obsolete";
}
// ---- Receipts of request-time refusals (migration 0078, Astra ASTRA-REFUND6 #4) ---------------------------------------------------

export interface RefusalReceipt { invoice_id: string; home_id: string; user_id: string; received_at: number; rested_on: string; checked_at: number | null;
  reopened_at: number | null; op_id: string | null }
/** Keeps the receipt of a 7-day request refused at request time as "not_first_payment" (the first one per payment stands), with the
 *  people whose codes the refusal rested on. Written under the request's lease BEFORE the refusal is claimed for sending (Astra
 *  ASTRA-REFUND7 #4), and only while the refusal still stands in that same statement: an erasure decided while the email is in flight
 *  then finds the receipt and its rested_on intact, and records its invalidation event. */
export function refusalReceiptStatement(r: { invoiceId: string; homeId: string; userId: string; receivedAt: number }): Q {
  const stands = refusalStands(r.invoiceId, r.userId);
  return q(`INSERT INTO refund_refusal_receipts (invoice_id,home_id,user_id,received_at,rested_on) SELECT ?,?,?,?,(SELECT json_group_array(u) FROM (
        SELECT k.user_id AS u FROM refund_identity_keys mine JOIN refund_identity_keys k ON k.kind=mine.kind AND k.key_hash=mine.key_hash WHERE mine.invoice_id=? AND k.invoice_id<>mine.invoice_id
        UNION SELECT c.user_id FROM refund_identity_keys mine JOIN refund_identity_claims c ON c.kind=mine.kind AND c.key_hash=mine.key_hash WHERE mine.invoice_id=? AND c.invoice_id<>mine.invoice_id))
      WHERE ${stands.sql}
      ON CONFLICT(invoice_id) DO NOTHING`, r.invoiceId, r.homeId, r.userId, r.receivedAt, r.invoiceId, r.invoiceId, ...stands.binds);
}
export const refusalReceiptFor = (env: Env, invoiceId: string) =>
  env.DB.prepare("SELECT * FROM refund_refusal_receipts WHERE invoice_id=? AND reopened_at IS NULL").bind(invoiceId).first<RefusalReceipt>();
/** The statements an "erase" decision runs about request-time refusals, for the SAME batch (Astra ASTRA-REFUND7 #3, ASTRA-REFUND8 #1
 *  and #2): `before` ahead of the deletes, `after` once they are done. An event is recorded only for an actual loss CAUSED by this
 *  erasure: a receipt whose refusal had a qualifying match right before the deletes (refund_refusal_erasure_scan, migration 0080, found
 *  from the CURRENT matching keys and claims, so a matching payment captured after the refusal is covered although rested_on never named
 *  it) and has none right after. Objections are ignored on both sides (an open objection masks codes, it does not remove them): a refusal
 *  that still has matches on someone else's codes was not invalidated by this erasure, whatever that person's objection decides (their
 *  own erasure is judged the same way). Events are due at once (held=0; held=1 is no longer written). Nothing else ever makes a receipt
 *  reopenable: codes that merely aged out or were purged are no grounds, before or after any decision. "keep" runs nothing. */
export function refusalInvalidationStatements(userId: string, decision: "keep" | "erase", now: number, scanId: string): { before: Q[]; after: Q[] } {
  if (decision !== "erase") return { before: [], after: [] };
  const K = NOT_A_FIRST_PAYMENT_KINDS;
  return {
    before: [q(`INSERT INTO refund_refusal_erasure_scan (scan_id,invoice_id) SELECT ?,rr.invoice_id FROM refund_refusal_receipts rr
        WHERE rr.reopened_at IS NULL AND EXISTS (${matchSql(null, "rr.invoice_id")})`, scanId, ...K)],
    after: [
      q(`INSERT INTO refund_refusal_invalidations (invoice_id,erased_user_id,erased_through,held,recorded_at)
          SELECT s.invoice_id,?,?,0,? FROM refund_refusal_erasure_scan s WHERE s.scan_id=? AND NOT EXISTS (${matchSql(null, "s.invoice_id")})
        ON CONFLICT(invoice_id,erased_user_id) DO UPDATE SET erased_through=excluded.erased_through,held=0,recorded_at=excluded.recorded_at`,
      userId, now, now, scanId, ...K),
      q("DELETE FROM refund_refusal_erasure_scan WHERE scan_id=?", scanId),
    ],
  };
}
/** A due invalidation event (an erasure that invalidated the refusal, not held) for the receipt of this payment. */
const INVALIDATED_SQL = "EXISTS (SELECT 1 FROM refund_refusal_invalidations v WHERE v.invoice_id=? AND v.held=0)";
/** Receipts the billing sweep reopens: open ones with a due invalidation event. */
export async function receiptsToRecheck(env: Env): Promise<RefusalReceipt[]> {
  return (await env.DB.prepare(`SELECT * FROM refund_refusal_receipts rr WHERE reopened_at IS NULL
      AND EXISTS (SELECT 1 FROM refund_refusal_invalidations v WHERE v.invoice_id=rr.invoice_id AND v.held=0) ORDER BY received_at LIMIT 50`).all<RefusalReceipt>()).results;
}
/** Whether a request refused at request time is to be reopened from its original receipt: an erasure was recorded as invalidating its
 *  refusal (refund_refusal_invalidations, held=0; Astra ASTRA-REFUND7 #3), never "some erasure happened and nothing matches today".
 *  Asked again by the customer (`askedAgain`), a refusal held under an open objection reopens too: the request then waits for that
 *  decision as of its receipt. */
export async function refusalReceiptReopenable(env: Env, r: RefusalReceipt, askedAgain: boolean): Promise<boolean> {
  if ((await env.DB.prepare(`SELECT ${INVALIDATED_SQL} AS x`).bind(r.invoice_id).first<{ x: number }>())?.x === 1) return true;
  return askedAgain && await refusalNoticeState(env, { invoiceId: r.invoice_id, userId: r.user_id }) === "hold";
}

/** For the SAME batch as a decision that refuses (or withholds) the 7-day offer as "not_first_payment": the guard fails the batch when
 *  the refusal no longer stands; the caller decides again, and the check then holds the request as pending. */
export function refusalFenceStatements(invoiceId: string, userId: string, guardId: string): Q[] {
  const c = refusalStands(invoiceId, userId);
  return [q(`INSERT INTO cloud_write_guards VALUES (?,${c.sql})`, guardId, ...c.binds)];
}

/** Null when this payment is the customer's first (by every key we hold), otherwise why the 7-day offer does not apply.
 *  With `stripe`, a payment whose keys were never recorded is captured now; without it, or when that fails, the check is unavailable
 *  (fails closed: the offer is never granted unchecked). `now` is when the check RUNS (processing time), never a request's receipt time:
 *  capture, retention and the grace periods are about today's records (Astra ASTRA-REFUND2 #7). */
export async function firstPaymentCheck(env: Env, stripe: StripeClient | null, p: FirstPaymentRef, now: number): Promise<IdentityDenial | null> {
  // A payment past the retention period is forgotten: it is never captured again, so it cannot be judged (pending; ops is alerted by the
  // refund sweep if a request still waits on it).
  if (p.paidAt < retentionCutoff(now)) return "identity_check_unavailable";
  if (!await keyring(env, now)) return "identity_check_unavailable";
  // An objection to keeping this person's codes (terms r11 section 5(2)): while it is being decided their codes are not used, so their own
  // request waits (receipt time intact) until the decision notice has been sent. Codes erased on that decision: nothing is left to
  // refuse on, and the payment is never captured again.
  const restriction = await restrictionOf(env, p.userId);
  if (restriction && restriction.notice_sent_at === null) return "identity_check_unavailable";
  if (erasedFor(restriction, p.paidAt)) return null;
  const cap = await env.DB.prepare(`SELECT EXISTS (SELECT 1 FROM refund_identity_settled s WHERE s.invoice_id=c.invoice_id) AS settled,
      EXISTS (SELECT 1 FROM refund_identity_enrich e WHERE e.invoice_id=c.invoice_id) AS enrich FROM refund_identity_captures c WHERE c.invoice_id=?`)
    .bind(p.invoiceId).first<{ settled: number; enrich: number }>();
  if (!cap) {
    if (!stripe) return "identity_check_unavailable";
    try { await captureRefundIdentity(env, stripe, p, now); } catch { return "identity_check_unavailable"; }
  } else if (stripe && (cap.enrich || !cap.settled)) {
    // This payment's own capture is incomplete: read it again BEFORE deciding, so every key Stripe can show now is judged, and claimed
    // with the decision (Astra ASTRA-REFUND2 #2). An unsettled capture is read again on every attempt, also after its enrichment period
    // ended (Astra ASTRA-REFUND3 #1): the waiting request is what keeps recovering it. A read that fails leaves it to the pending rule below.
    try { await captureRefundIdentity(env, stripe, p, now, { enrich: true }); } catch { /* judged on what is recorded, or pending */ }
  }
  // A payment with no key of its own cannot be judged: pending, never a guess.
  if (!await env.DB.prepare("SELECT 1 AS x FROM refund_identity_keys WHERE invoice_id=? LIMIT 1").bind(p.invoiceId).first()) return "identity_check_unavailable";
  const kinds = NOT_A_FIRST_PAYMENT_KINDS.map(() => "?").join(",");
  // (1) An earlier payment (by any account, this one included) shares a key: this is not the customer's first payment.
  // (2) A key is already claimed by another payment that got the 7-day offer (refund_identity_claims, written atomically with that
  //     decision), whichever was paid first. A decided offer from before claims existed counts the same way.
  // A match is final: keys still missing can only add matches, never take one away. So it is answered before any pending rule.
  // Codes of a person whose objection is still being decided are never used to refuse (restricted): a match on them alone holds the
  // request (pending) until that decision notice is sent; a match on anyone else's codes is final as before.
  const matchOn = (restricted: boolean) => env.DB.prepare(`${matchSql(restricted)} LIMIT 1`).bind(p.invoiceId, ...NOT_A_FIRST_PAYMENT_KINDS).first();
  if (await matchOn(false)) return "not_first_payment";
  if (await matchOn(true)) return "identity_check_unavailable";
  const graceFrom = now - CAPTURE_GRACE_MS;
  // No match yet, but this payment's own keys are still incomplete because Stripe could not show it (a 404 or hiccup at capture): its card
  // may still match. Pending until the read settles, never a guess (Astra ASTRA-REFUND2 #2). No grace or enrichment period ends this:
  // an unreadable payment never becomes eligible merely because time passed (Astra ASTRA-REFUND3 #1: two same-card payments, both
  // unreadable, would otherwise both be paid once the grace ran out).
  const ownPending = await env.DB.prepare(`SELECT 1 AS x FROM refund_identity_captures c WHERE c.invoice_id=?
    AND NOT EXISTS (SELECT 1 FROM refund_identity_settled s WHERE s.invoice_id=c.invoice_id) LIMIT 1`).bind(p.invoiceId).first();
  if (ownPending) return "identity_check_unavailable";
  // An earlier first payment whose keys are not recorded yet (its capture was delayed), or recorded only in part because Stripe could not
  // show it (pending enrichment), could be this person's: pending, not a guess.
  const uncaptured = await env.DB.prepare(`SELECT 1 AS x FROM billing_subscriptions s WHERE s.first_invoice_id IS NOT NULL AND s.first_invoice_id<>?
      AND s.first_paid_at IS NOT NULL AND (s.first_paid_at<? OR (s.first_paid_at=? AND s.first_invoice_id<?)) AND s.first_paid_at>?
      AND NOT EXISTS (SELECT 1 FROM refund_identity_captures c WHERE c.invoice_id=s.first_invoice_id)
      AND NOT EXISTS (SELECT 1 FROM refund_ops o WHERE o.invoice_id=s.first_invoice_id AND o.kind IN (${kinds})) LIMIT 1`)
    .bind(p.invoiceId, p.paidAt, p.paidAt, p.invoiceId, graceFrom, ...NOT_A_FIRST_PAYMENT_KINDS).first();
  if (uncaptured) return "identity_check_unavailable";
  const incomplete = await env.DB.prepare(`SELECT 1 AS x FROM refund_identity_captures c
      WHERE NOT EXISTS (SELECT 1 FROM refund_identity_settled s WHERE s.invoice_id=c.invoice_id) AND c.invoice_id<>? AND (c.paid_at<? OR (c.paid_at=? AND c.invoice_id<?)) AND c.paid_at>?
      AND NOT EXISTS (SELECT 1 FROM refund_ops o WHERE o.invoice_id=c.invoice_id AND o.kind IN (${kinds})) LIMIT 1`)
    .bind(p.invoiceId, p.paidAt, p.paidAt, p.invoiceId, graceFrom, ...NOT_A_FIRST_PAYMENT_KINDS).first();
  return incomplete ? "identity_check_unavailable" : null;
}

// ---- Objections (terms r11 section 5(2); migration 0046) ----------------------------------------------------------------------------

/** erased_through (migration 0066): the latest "erase" decision for this person. It is kept apart from the current objection's lifecycle,
 *  which a new objection reopens: an erasure is never forgotten (Astra ASTRA-REFUND4 #3). */
export interface Restriction { objected_at: number; decision: "keep" | "erase" | null; decided_at: number | null; notice_sent_at: number | null;
  erased_through: number | null; pending_since: number | null; restricted_at: number | null; dispatch_unknown_at: number | null }
export const restrictionOf = (env: Env, userId: string) =>
  env.DB.prepare("SELECT objected_at,decision,decided_at,notice_sent_at,erased_through,pending_since,restricted_at,dispatch_unknown_at FROM refund_identity_restrictions WHERE user_id=?").bind(userId).first<Restriction>();
/** True when this payment's codes were erased on an objection decision (the payment was made no later than the latest erasure). */
const erasedFor = (r: Restriction | null, paidAt: number): boolean =>
  r !== null && r.erased_through !== null && paidAt <= r.erased_through;
/** How long an objection may stay undecided before ops is reminded (the reply is due within one month, GDPR Art 12(3)). */
export const OBJECTION_REMIND_MS = 25 * 24 * 3_600_000;

/** Records an objection to keeping a person's refund codes: the restriction starts at once, in the same write (Art 18(1)(d)). An
 *  objection while one is already open changes nothing; one made after an earlier decision opens it again. Reopening never touches
 *  erased_through: codes erased on an earlier decision stay erased and are never captured again, whatever this objection's decision is
 *  (Astra ASTRA-REFUND4 #3).
 *  Never refused and never made to wait (Astra ASTRA-REFUND6 #3): one statement, whatever a refusal sender is doing. From this write on,
 *  every NEW refusal dispatch resting on the person's codes is held (its claim revalidates the refusal), so no sender can overtake it.
 *  A refusal already being handed off (a refund_refusal_sends row names the person) is ordered before the objection and finishes; the
 *  objection is then "pending_restriction" (pending_since) until that dispatch is resolved, and finalised by the sender's release or by
 *  the billing sweep (finalisePendingObjections). No lock wait, no 409, no dependence on database latency. */
export async function recordObjection(env: Env, userId: string, now: number): Promise<Restriction> {
  // Any dispatch row naming the person is unresolved, however old: only its sender's release or a reconciling takeover ends it (ASTRA-REFUND6 #2).
  const inFlight = `EXISTS (SELECT 1 FROM refund_refusal_sends WHERE user_id=?)`;
  await env.DB.prepare(`INSERT INTO refund_identity_restrictions (user_id,objected_at,pending_since,restricted_at)
      VALUES (?,?,CASE WHEN ${inFlight} THEN ? END,CASE WHEN ${inFlight} THEN NULL ELSE ? END)
    ON CONFLICT(user_id) DO UPDATE SET objected_at=excluded.objected_at,decision=NULL,decided_at=NULL,notice_sent_at=NULL,
      pending_since=excluded.pending_since,restricted_at=excluded.restricted_at WHERE refund_identity_restrictions.notice_sent_at IS NOT NULL`)
    .bind(userId, now, userId, now, userId, now).run();
  return (await restrictionOf(env, userId))!;
}

/** Finalises every "pending_restriction" objection whose in-flight refusal dispatches are all resolved (or only `userIds`'): the
 *  restriction is then complete (restricted_at). Called by a sender's release, and by the billing sweep (which first reconciles the
 *  dispatches whose `until` has passed: an expiry takeover never proceeds on the timer alone, ASTRA-REFUND6 #2). */
export async function finalisePendingObjections(env: Env, now: number, userIds?: string[]): Promise<void> {
  if (userIds && userIds.length === 0) return;
  if (!userIds) await reconcileRefusalDispatches(env, now);
  const only = userIds ? ` AND user_id IN (${userIds.map(() => "?").join(",")})` : "";
  await env.DB.prepare(`UPDATE refund_identity_restrictions SET pending_since=NULL,restricted_at=? WHERE pending_since IS NOT NULL${only}
      AND NOT EXISTS (SELECT 1 FROM refund_refusal_sends s WHERE s.user_id=refund_identity_restrictions.user_id)`)
    .bind(now, ...(userIds ?? [])).run();
}

/** The takeover of refusal dispatches whose sender held them past their `until` (all of them, or only `noticeId`'s). A timer cannot
 *  prove the sender stopped (an HTTP Worker has no duration bound), so each is reconciled in one write, under the notice's home lease
 *  (`lease` when the caller already holds it), before anyone proceeds: its fence is revoked (that sender's later handoff or finalise is
 *  refused), a dispatch already handed to EMAIL is recorded as 'unknown' (sent or not: the notice is revalidated like any queued
 *  refusal, so it is held while an objection is open and cancelled once obsolete), an objection pending on it records
 *  dispatch_unknown_at, and its rows go (Astra ASTRA-REFUND6 #2). A busy home is reconciled by a later sweep. */
export async function reconcileRefusalDispatches(env: Env, now: number, opts: { noticeId?: string; lease?: HomeLease } = {}): Promise<void> {
  const stale = await env.DB.prepare(`SELECT DISTINCT s.holder,s.notice_id,n.home_id FROM refund_refusal_sends s LEFT JOIN billing_notices n ON n.id=s.notice_id
      WHERE s.until<${DB_NOW}${opts.noticeId ? " AND s.notice_id=?" : ""} LIMIT 50`)
    .bind(...(opts.noticeId ? [opts.noticeId] : [])).all<{ holder: string; notice_id: string; home_id: string | null }>();
  for (const r of stale.results) {
    const expired = `SELECT user_id FROM refund_refusal_sends WHERE holder=? AND until<${DB_NOW}`;
    const drop = q(`DELETE FROM refund_refusal_sends WHERE holder=? AND until<${DB_NOW}`, r.holder);
    // No notice row any more: nothing to revoke or record.
    if (!r.home_id) { await env.DB.prepare(drop[0]).bind(...drop[1]!).run(); continue; }
    const work = (lease: HomeLease) => fencedBatch(env, lease, [
      q(`UPDATE billing_notices SET dispatch_state=CASE WHEN dispatch_state='handed_off' THEN 'unknown' END,dispatch_fence=NULL,claimed_until=NULL
        WHERE id=? AND dispatch_fence=? AND sent_at IS NULL AND EXISTS (${expired})`, r.notice_id, r.holder, r.holder),
      q(`UPDATE refund_identity_restrictions SET dispatch_unknown_at=COALESCE(dispatch_unknown_at,?) WHERE pending_since IS NOT NULL
        AND user_id IN (${expired}) AND EXISTS (SELECT 1 FROM billing_notices WHERE id=? AND dispatch_state='unknown')`, now, r.holder, r.notice_id),
      drop,
    ]);
    try { await (opts.lease && opts.lease.homeId === r.home_id ? work(opts.lease) : withHomeLease(env, r.home_id, work)); }
    catch (e) { if (!(e instanceof HomeBusy || e instanceof LeaseLost)) throw e; }
  }
}

/** The checkpoint that ends a restriction: the decision notice (keep or erase, with its reason) has been sent to the person. "erase"
 *  deletes the codes of every payment the person made up to now, and the claims made from them, in the same batch; they are never
 *  captured again. Requests that waited are then decided by the sweep, as of their receipt time. Null when no objection is open. */
export async function recordObjectionDecision(env: Env, userId: string, decision: "keep" | "erase", now: number): Promise<Restriction | null> {
  const g = `objection-${crypto.randomUUID()}`;
  const inval = refusalInvalidationStatements(userId, decision, now, g);
  // Only this person's own records: their keys, and the claims made for THEIR payments (a claim another person's offer holds on a matching
  // key is that person's record and stays).
  const mine = `SELECT invoice_id FROM refund_identity_keys WHERE user_id=? AND paid_at<=? UNION SELECT invoice_id FROM refund_identity_captures WHERE user_id=? AND paid_at<=?`;
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?,EXISTS (SELECT 1 FROM refund_identity_restrictions WHERE user_id=? AND notice_sent_at IS NULL))").bind(g, userId),
      // The receipts this erasure may affect, found from today's matches BEFORE the deletes (Astra ASTRA-REFUND8 #1).
      ...inval.before.map(([sql, binds]) => env.DB.prepare(sql).bind(...(binds ?? []))),
      ...(decision === "erase" ? [
        env.DB.prepare(`DELETE FROM refund_identity_claims WHERE invoice_id IN (${mine})`).bind(userId, now, userId, now),
        env.DB.prepare("DELETE FROM refund_identity_keys WHERE user_id=? AND paid_at<=?").bind(userId, now),
        env.DB.prepare("DELETE FROM refund_identity_enrich WHERE user_id=? AND paid_at<=?").bind(userId, now),
      ] : []),
      env.DB.prepare(`UPDATE refund_identity_restrictions SET decision=?,decided_at=?,notice_sent_at=?,pending_since=NULL,restricted_at=COALESCE(restricted_at,?),
        erased_through=CASE WHEN ?='erase' THEN MAX(COALESCE(erased_through,0),?) ELSE erased_through END WHERE user_id=?`).bind(decision, now, now, now, decision, now, userId),
      // Which request-time refusals this decision invalidated, judged in this same write (Astra ASTRA-REFUND7 #3).
      ...inval.after.map(([sql, binds]) => env.DB.prepare(sql).bind(...(binds ?? []))),
      env.DB.prepare("DELETE FROM cloud_write_guards WHERE id=?").bind(g),
    ]);
  } catch (e) {
    if (await env.DB.prepare("SELECT 1 AS x FROM refund_identity_restrictions WHERE user_id=? AND notice_sent_at IS NULL").bind(userId).first()) throw e;
    return null;
  }
  return restrictionOf(env, userId);
}

/** Billing sweep: ops is reminded while any objection is still undecided after OBJECTION_REMIND_MS (one open alert). The reminder is
 *  resolved once every objection it named has its decision notice sent (Astra ASTRA-REFUND4 #4); one still open keeps it. */
export async function remindOpenObjections(env: Env, now: number): Promise<void> {
  await env.DB.prepare(`UPDATE cloud_alerts SET resolved_at=? WHERE home_id='billing' AND kind='refund_identity.objection_due' AND resolved_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM json_each(cloud_alerts.detail,'$.userIds') j JOIN refund_identity_restrictions r ON r.user_id=j.value
      WHERE r.notice_sent_at IS NULL)`).bind(now).run();
  const due = await env.DB.prepare("SELECT user_id FROM refund_identity_restrictions WHERE notice_sent_at IS NULL AND objected_at<? LIMIT 50")
    .bind(now - OBJECTION_REMIND_MS).all<{ user_id: string }>();
  if (due.results.length === 0) return;
  await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
    .bind(crypto.randomUUID(), "billing", "refund_identity.objection_due", "high", JSON.stringify({ userIds: due.results.map((r) => r.user_id) }), now).run();
}

/** The statements that claim every key of `invoiceId` for a decision applying the 7-day offer, for the SAME batch as the decision. The
 *  guard fails the whole batch when any key is already claimed by another payment (a concurrent decision won): the caller decides again
 *  and the check above then refuses the offer. Idempotent for the same payment. */
export function claimOfferStatements(invoiceId: string, userId: string, opId: string, now: number, guardId: string, opts: { guard?: boolean } = {}): Q[] {
  const claim = q(`INSERT INTO refund_identity_claims (kind,key_hash,invoice_id,user_id,op_id,claimed_at)
      SELECT kind,key_hash,invoice_id,?,?,? FROM refund_identity_keys WHERE invoice_id=? ON CONFLICT(kind,key_hash) DO NOTHING`, userId, opId, now, invoiceId);
  // guard:false — a customer the limit does not bind (refundLimitAccepted) gets the offer whatever is claimed; the keys it can still claim
  // are claimed, so customers who ARE bound see it.
  if (opts.guard === false) return [claim];
  return [claim,
    q(`INSERT INTO cloud_write_guards VALUES (?,NOT EXISTS (SELECT 1 FROM refund_identity_keys k JOIN refund_identity_claims c ON c.kind=k.kind
      AND c.key_hash=k.key_hash WHERE k.invoice_id=? AND c.invoice_id<>?))`, guardId, invoiceId, invoiceId),
  ];
}
