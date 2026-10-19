// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP4 r2-3 (ASTRA-WP4-2 P2-3): the disclosure the page showed is bound to the consent by a server token.
// GET /v1/legal/disclosure (with declaredCountry) returns disclosure.token: an HMAC-SHA256, under the Worker secret
// CHECKOUT_DISCLOSURE_TOKEN_SECRET and a domain-separation prefix, over exactly what was rendered: the screen version, the page language
// (siteLanguage), the declared country, the path (direct or managed), the Stripe locale, sha256(renewalText) and the issue time.
// MurageSite sends it back unchanged as consent.disclosureToken. POST /v1/billing/checkout verifies it against the submitted siteLanguage,
// declaredCountry, checkoutLanguage and renewalText before anything else: a missing, forged, expired (24 h) or mismatched token is
// 409 disclosure_stale, so a client cannot relabel a German page as English (or any other field) after the fact.
// Token shape: base64url(JSON payload) "." base64url(HMAC-SHA256(secret, DOMAIN + base64url(JSON payload))).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { HTTPError } from "./http";

export const DISCLOSURE_TOKEN_DOMAIN = "murage-cloud/checkout-disclosure-token/v1\n";
export const DISCLOSURE_TOKEN_TTL_MS = 24 * 60 * 60_000;
/** Clock skew tolerated for a token issued "in the future" by another isolate. */
const SKEW_MS = 5 * 60_000;

export interface DisclosureTokenFields {
  screenVersion: string; siteLanguage: string; declaredCountry: string; path: string; locale: string; renewalText: string;
}
export interface DisclosureTokenPayload {
  v: 1; screenVersion: string; siteLanguage: string; declaredCountry: string; path: string; locale: string; renewalSha256: string; issuedAt: number;
}

const secretOf = (env: unknown): string | null => {
  const s = (env as { CHECKOUT_DISCLOSURE_TOKEN_SECRET?: string } | null)?.CHECKOUT_DISCLOSURE_TOKEN_SECRET;
  return typeof s === "string" && s.length >= 32 ? s : null;
};
/** 503 disclosure_key_missing when the secret is unset or shorter than 32 characters: no token, no checkout (fails closed). */
export const disclosureKeyError = (env: unknown): string | null => secretOf(env) ? null : "disclosure_key_missing";

const b64url = (b: Buffer) => b.toString("base64url");
const mac = (secret: string, body: string) => createHmac("sha256", secret).update(DISCLOSURE_TOKEN_DOMAIN + body).digest();
export const renewalSha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export function issueDisclosureToken(env: unknown, f: DisclosureTokenFields, issuedAt: number): string {
  const secret = secretOf(env);
  if (!secret) throw new HTTPError(503, "disclosure_key_missing");
  const payload: DisclosureTokenPayload = { v: 1, screenVersion: f.screenVersion, siteLanguage: f.siteLanguage, declaredCountry: f.declaredCountry.toUpperCase(),
    path: f.path, locale: f.locale, renewalSha256: renewalSha256(f.renewalText), issuedAt };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${body}.${b64url(mac(secret, body))}`;
}

/** Throws 409 disclosure_stale unless `token` is a genuine, unexpired token for exactly these fields (503 without the secret). */
export function verifyDisclosureToken(env: unknown, token: string | undefined, expected: DisclosureTokenFields, now: number): DisclosureTokenPayload {
  const secret = secretOf(env);
  if (!secret) throw new HTTPError(503, "disclosure_key_missing");
  const stale = () => new HTTPError(409, "disclosure_stale");
  if (typeof token !== "string") throw stale();
  const m = /^([A-Za-z0-9_-]{1,2000})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) throw stale();
  const got = Buffer.from(m[2], "base64url");
  const want = mac(secret, m[1]);
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw stale();
  let p: DisclosureTokenPayload;
  try { p = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")) as DisclosureTokenPayload; } catch { throw stale(); }
  if (p?.v !== 1 || typeof p.issuedAt !== "number" || p.issuedAt > now + SKEW_MS || now - p.issuedAt > DISCLOSURE_TOKEN_TTL_MS) throw stale();
  if (p.screenVersion !== expected.screenVersion || p.siteLanguage !== expected.siteLanguage || p.declaredCountry !== expected.declaredCountry.toUpperCase()
    || p.path !== expected.path || p.locale !== expected.locale || p.renewalSha256 !== renewalSha256(expected.renewalText)) throw stale();
  return p;
}
