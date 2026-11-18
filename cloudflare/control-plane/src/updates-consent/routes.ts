// Updates consent B1 routes (design UPDATES-CONSENT-1020-CP-v5.md v5.6.1, 4.1 and 4.2) and the prove-mail outbox sender (3.3 O).
// D1 only: no route here calls Sendlane or Resend. Every request batch comes from ./gate; the statements from ./sql-design and ./sql-b1.
import { z } from "zod";

import { subjectKey, withinLimit } from "../announcements";
import { transactionalSender } from "../email";
import { HTTPError, json, readBoundedForm, readBoundedJSON } from "../http";
import { oneClickHeaders } from "../updates-send";
import { bindNumbered, desktopBatch, outcomeOf, rejectBatch, signupBatch, tokenKeyVersion, updatesSignupsOpen, type GateBinds,
  type RequestOutcome } from "./gate";
import * as B from "./sql-b1";
import * as Q from "./sql-design";
import { deriveToken, emailKeyOf, proveTokenId, sha256Hex, unsubTokenId } from "./tokens";

import { UPDATES_BASE } from "./paths";
export { UPDATES_BASE };
export const UNSUBSCRIBE_ROUTE = `${UPDATES_BASE}/unsubscribe`;
export const PROVE_ROUTE = `${UPDATES_BASE}/prove`;
/** The anonymous paths: exact match, no Server-Timing and no bookmark headers on any answer (4, `src/index.ts` fetch wrapper). */
export const UPDATES_PUBLIC_PATHS: ReadonlySet<string> = new Set(["email", "status", "withdraw", "export", "prove", "unsubscribe"].map((p) => `${UPDATES_BASE}/${p}`));

/** The consent text rows 0149 seeds (v5.6.2, append-only). The forwarder binds ?5 by the validated source (siteTextVersion). */
export const SITE_TEXT_VERSIONS = { guide: "site-guide", waitlist: "site-waitlist", news: "site-news" } as const;
/** The anonymous pre-1.0.7 path: those apps sent `{ email, name? }` and no words. */
export const LEGACY_TEXT_VERSION = "legacy-pre-1.0.7";
/** Source `app`: the received consentText matched no app row byte for byte. The words stay at ?22, as data only. */
export const APP_UNMATCHED_VERSION = "app-unmatched";
export const APP_TEXT_VERSIONS = ["app-1.0.7-hello", "app-1.0.12-hello", "app-settings"] as const;
/**
 * Held text rows (MurageMain 11-07): no consent may point at them. `2026-11-06` is the design's words for the 1.0.20 card, which is not
 * built; its row still holds "[field]". It stays held until the 1.0.20 build has a byte test on the rendered card (ledger row
 * UPDATES-CONSENT-1020-DESKTOP-CARD-BYTES), and 0149's triggers refuse it in SQL too. Lifting it is a new migration plus this list.
 */
export const HELD_TEXT_VERSIONS: ReadonlySet<string> = new Set(["2026-11-06"]);

/** A caller-chosen `textVersion` (desktop `/email`, members POST): well formed, seeded and not held, else 400 `bad_text_version`. */
export async function selectableTextVersion(db: D1Database, textVersion: string): Promise<string> {
  if (!textVersionSchema.safeParse(textVersion).success || HELD_TEXT_VERSIONS.has(textVersion)
    || !await db.prepare("SELECT 1 AS k FROM updates_consent_texts WHERE version=?").bind(textVersion).first()) {
    throw new HTTPError(400, "bad_text_version");
  }
  return textVersion;
}
const APP_MATCH = `SELECT version FROM updates_consent_texts WHERE version IN (${APP_TEXT_VERSIONS.map((v) => `'${v}'`).join(",")}) AND body=?1`;

/** ?5 for a signup (v5.6.2): legacy, the app's exact words (never the site news row), else the site form's own row. */
export async function signupTextVersion(db: D1Database, path: "forwarder" | "legacy", source: string, consentText: string | null): Promise<string> {
  if (path === "legacy") return LEGACY_TEXT_VERSION;
  if (source === "app") {
    if (consentText === null) return APP_UNMATCHED_VERSION;
    return (await db.prepare(APP_MATCH).bind(consentText).first<{ version: string }>())?.version ?? APP_UNMATCHED_VERSION;
  }
  return source === "guide" ? SITE_TEXT_VERSIONS.guide : source === "waitlist" ? SITE_TEXT_VERSIONS.waitlist : SITE_TEXT_VERSIONS.news;
}
const SITE_ORIGIN = "https://murage.ai";
const GUIDE_URL = `${SITE_ORIGIN}/setup-guide`;
const HOUR_MS = 60 * 60 * 1_000;
const LEGACY_BUCKET_MS = 10 * 60 * 1_000;
const ANSWER_AHEAD_MS = 5 * 60 * 1_000;
const OUTBOX_PER_TICK = 25;
const FROM = { email: "noreply@murage.ai", name: "Murage" };

const TOKEN_RE = /^[A-Za-z0-9_-]{43,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const receiptSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
const textVersionSchema = z.string().regex(/^[0-9a-z][0-9a-z.-]{0,39}$/);

const ok = (extra: Record<string, string> = {}) => json({ ok: true, ...extra, cloudContractVersion: 1 });
const nonce = () => crypto.randomUUID();
const cpOrigin = (env: Env) => new URL(env.BETTER_AUTH_URL).origin;
const callerIp = (request: Request) => request.headers.get("cf-connecting-ip") ?? "";

async function limited(env: Env, scope: string, value: string, windowMs: number, max: number, now: number): Promise<void> {
  const key = await subjectKey(scope, value, env.BETTER_AUTH_SECRET);
  if (!await withinLimit(env, key, windowMs, max, now)) throw new HTTPError(429, "rate_limited");
}

export async function proveBinds(env: Env, emailKey: string, keyVersion: number) {
  const outboxId = crypto.randomUUID();
  const { tokenHash } = await deriveToken(proveTokenId(outboxId), keyVersion, env.BETTER_AUTH_SECRET);
  const mailCapKey = await subjectKey("updates-prove-mail", emailKey, env.BETTER_AUTH_SECRET);
  return { outboxId, proveTokenHash: tokenHash, mailCapKey };
}

/** `answeredAt` (3.3 "Submission identity"): an integer not more than 5 minutes ahead of server time, else 400 `bad_answered_at`. */
export function validAnsweredAt(value: unknown, now: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > now + ANSWER_AHEAD_MS) {
    throw new HTTPError(400, "bad_answered_at");
  }
  return value;
}

// ---- POST /v1/updates-consent/email (desktop 1.0.20) ---------------------------------------------------------------------------------
const emailBody = z.strictObject({
  email: z.string().max(254), installId: z.string().min(1).max(128), textVersion: z.string().max(40), appVersion: z.string().min(1).max(40),
  answeredAt: z.unknown(), receiptHash: z.string().regex(HEX64), currentReceipt: receiptSchema.optional(),
});

export async function updatesEmail(request: Request, env: Env): Promise<Response> {
  const parsed = emailBody.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  const email = emailSchema.safeParse(parsed.data.email);
  if (!email.success) throw new HTTPError(400, "invalid_email");
  const now = Date.now();
  const answeredAt = validAnsweredAt(parsed.data.answeredAt, now);
  const textVersion = await selectableTextVersion(env.DB, parsed.data.textVersion);
  // T-C1 (test 67): with either flag off nothing is written, not even a limit charge (B1 r1: Astra High, Grok L5).
  if (!updatesSignupsOpen(env)) return ok();
  // 3.5: in code before the batch; they protect the Worker, not the outcome.
  await limited(env, "updates-install", parsed.data.installId, HOUR_MS, 5, now);
  await limited(env, "updates-ip", callerIp(request), HOUR_MS, 20, now);

  const receipt = parsed.data.receiptHash;
  const keyVersion = tokenKeyVersion(env);
  const emailKey = await emailKeyOf(email.data, env.BETTER_AUTH_SECRET);
  const b: GateBinds = {
    consentId: crypto.randomUUID(), subjectRef: receipt, email: email.data, emailKey, textVersion, installId: parsed.data.installId,
    appVersion: parsed.data.appVersion, answeredAt, now,
    currentReceipt: parsed.data.currentReceipt === undefined ? null : await sha256Hex(parsed.data.currentReceipt),
    keyVersion, ...await proveBinds(env, emailKey, keyVersion), nonce: nonce(), template: "prove", withGuide: false, forwarderSource: null,
    consentWords: null, source: "desktop", requestId: `desk:${receipt}:${answeredAt}`, path: "desktop", subjectId: `receipt:${receipt}`,
    payloadHash: await sha256Hex(JSON.stringify([receipt, email.data, answeredAt, textVersion, parsed.data.installId, parsed.data.appVersion,
      parsed.data.currentReceipt ?? null])),
  };
  await env.DB.batch(desktopBatch(env.DB, b));
  return ok();
}

// ---- /status, /withdraw, /export by receipt ------------------------------------------------------------------------------------------
const receiptBody = z.strictObject({ receipt: receiptSchema });
async function receiptSubject(request: Request): Promise<string> {
  const parsed = receiptBody.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  return `receipt:${await sha256Hex(parsed.data.receipt)}`;
}

export async function updatesStatus(request: Request, env: Env): Promise<Response> {
  await limited(env, "updates-status-ip", callerIp(request), HOUR_MS, 120, Date.now());
  const subject = await receiptSubject(request);
  const row = await env.DB.prepare(B.STATUS).bind(subject).first<{ status: string; proven: number; off_by: string | null }>();
  if (!row) return json({ status: null, cloudContractVersion: 1 });
  const offBy = row.off_by === null ? undefined : (row.off_by === "link" || row.off_by === "site")
    ? "Turned off from an email or murage.ai." : "Turned off";
  return json({ status: row.status, proven: row.proven === 1, ...(offBy ? { offBy } : {}), cloudContractVersion: 1 });
}

/** W1 to W4 for a subject (also AF, the members switch off, with actor 'account'). */
export function withdrawBatch(db: D1Database, subjectId: string, actor: "owner" | "account", now: number): D1PreparedStatement[] {
  const v = { 1: subjectId, 2: now, 3: nonce(), 4: actor };
  return [B.W1, B.W2, B.W3, B.W4].map((s) => bindNumbered(db, s, v));
}

export async function updatesWithdraw(request: Request, env: Env): Promise<Response> {
  const now = Date.now();
  await limited(env, "updates-anon-ip", callerIp(request), HOUR_MS, 20, now);
  const subject = await receiptSubject(request);
  await env.DB.batch(withdrawBatch(env.DB, subject, "owner", now));
  return new Response(null, { status: 204 });
}

export async function updatesExport(request: Request, env: Env): Promise<Response> {
  await limited(env, "updates-anon-ip", callerIp(request), HOUR_MS, 20, Date.now());
  const subject = await receiptSubject(request);
  const [consent, events] = await env.DB.batch([env.DB.prepare(B.EXPORT_CONSENT).bind(subject), env.DB.prepare(B.EXPORT_EVENTS_PROVEN).bind(subject)]);
  const row = consent?.results?.[0] as Record<string, unknown> | undefined;
  return json({
    consent: row ? {
      status: row.status as string, generation: row.generation as number, textVersion: row.text_version as string,
      answeredAt: row.answered_at as number, proven: row.proven_at !== null, provenAt: (row.proven_at as number | null) ?? null,
      offBy: (row.off_by as string | null) ?? null, source: row.source as string, appVersion: row.app_version as string,
      createdAt: row.created_at as number, statusChangedAt: row.status_changed_at as number,
    } : null,
    events: ((events?.results ?? []) as Record<string, unknown>[]).map((e) => ({
      at: e.at as number, fromStatus: (e.from_status as string | null) ?? null, toStatus: (e.to_status as string | null) ?? null,
      generation: e.generation as number, textVersion: (e.text_version as string | null) ?? null, actor: e.actor as string,
    })),
    cloudContractVersion: 1,
  });
}

// ---- Pages: prove (through the origin check and route()) and unsubscribe (dispatched early, before the origin check: 4.1) -------------
function page(title: string, body: string, status = 200, referrer = "no-referrer"): Response {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="robots" content="noindex"><meta name="referrer" content="${referrer}"><title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}`
    + `button{font:inherit;padding:.6rem 1.2rem;border-radius:.5rem;border:0;background:#111;color:#fff;cursor:pointer}</style></head><body>${body}</body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}
const escAttr = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "");

function goneUnsubscribe(): Response {
  return page("Link no longer works", `<h1>This unsubscribe link no longer works.</h1><p>To stop all Murage email, go to `
    + `<a href="${SITE_ORIGIN}/unsubscribe">murage.ai/unsubscribe</a>.</p>`, 404);
}

/** True for exactly the one-click unsubscribe path with GET or POST (4.1). Nothing else is answered before the origin check (B1 r1 Grok M3). */
export function isUpdatesEarlyRequest(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "POST") return false;
  return new URL(request.url).pathname === UNSUBSCRIBE_ROUTE;
}

export async function updatesEarly(request: Request, env: Env): Promise<Response> {
  return updatesUnsubscribe(request, env);
}

/** U (3.3): the token is the authorisation; the Origin header is not read. Not rate limited (3.5). */
export async function updatesUnsubscribe(request: Request, env: Env): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!TOKEN_RE.test(token)) return goneUnsubscribe();
  if (request.method === "GET") {
    return page("Unsubscribe from Murage updates", `<h1>Stop Murage updates?</h1><form method="post" action="${UNSUBSCRIBE_ROUTE}?token=${escAttr(token)}">`
      + `<input type="hidden" name="confirm" value="1"><button type="submit">Unsubscribe</button></form>`);
  }
  const form = await readBoundedForm(request);
  const source = form.get("List-Unsubscribe") === "One-Click" ? "one_click" : form.get("confirm") === "1" ? "link" : null;
  if (!source) throw new HTTPError(400, "invalid_request");
  const now = Date.now();
  const v = { 1: await sha256Hex(token), 2: now, 4: nonce(), 6: source };
  const results = await env.DB.batch([Q.U1, Q.U2, Q.U3, Q.U4, Q.U5, Q.U6, Q.UQ].map((s) => bindNumbered(env.DB, s, v)));
  const used = Object.values((results[6]?.results?.[0] ?? {}) as Record<string, unknown>)[0];
  if (used !== 1) return goneUnsubscribe();
  return page("Unsubscribed", "<h1>You won't get any more updates.</h1>");
}

/**
 * GET shows one button and changes nothing; POST runs PV and answers 303 to the site page (PV, 4.1). Both come through the origin check
 * (route()); POST also refuses any Origin but this Worker's own, so a site the CP otherwise allows cannot confirm (B1 r1 Grok M3). The page
 * sets `<meta name="referrer" content="same-origin">` (it overrides the `no-referrer` header secureResponse sets), so its form POST carries
 * this origin (under `no-referrer` a browser sends `Origin: null`) while a cross-origin hop still gets no Referer.
 */
export async function updatesProve(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    const token = new URL(request.url).searchParams.get("token") ?? "";
    if (!TOKEN_RE.test(token)) return Response.redirect(`${SITE_ORIGIN}/updates/link-expired`, 303);
    return page("Confirm Murage updates", `<h1>Confirm your email for Murage updates</h1><form method="post" action="${PROVE_ROUTE}">`
      + `<input type="hidden" name="token" value="${escAttr(token)}"><button type="submit">Confirm</button></form>`, 200, "same-origin");
  }
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== cpOrigin(env)) throw new HTTPError(403, "origin_not_allowed");
  await limited(env, "updates-anon-ip", callerIp(request), HOUR_MS, 20, Date.now());
  const token = (await readBoundedForm(request)).get("token") ?? "";
  if (!TOKEN_RE.test(token)) return Response.redirect(`${SITE_ORIGIN}/updates/link-expired`, 303);
  const tokenHash = await sha256Hex(token);
  // The expiry test (PV1 expires_at > ?2) uses the time read after the body and immediately before the batch (B1 r1 Astra M).
  const v = { 1: tokenHash, 2: Date.now(), 3: tokenKeyVersion(env), 4: nonce() };
  const results = await env.DB.batch([Q.PV1, Q.PV2, B.PV3, Q.PV4].map((s) => bindNumbered(env.DB, s, v)));
  const proved = (results[0]?.meta.changes ?? 0) === 1;
  return Response.redirect(`${SITE_ORIGIN}/updates/${proved ? "confirmed" : "link-expired"}`, 303);
}

// ---- The forwarder and 1.0.19 (POST /v1/announcements/subscribe) ---------------------------------------------------------------------
export interface SignupInput {
  path: "forwarder" | "legacy";
  email: string;
  name: string;
  source: string; // ?23
  forwarderSource: string | null; // ?21
  consentWords: string | null; // ?22
  withGuide: boolean;
  requestId: string;
  payloadHash: string;
  limits: { firstKey: string; firstWindowMs: number; firstMax: number; secondKey: string; secondWindowMs: number; secondMax: number };
}

/** Runs the signup batch (RQ ... RQQ) and returns the outcome and the text version bound at ?5; with the T-C1 gate closed, nothing is
 *  written and the answer is `noop` (no version). */
export async function runSignup(env: Env, s: SignupInput, now: number): Promise<{ outcome: RequestOutcome; textVersion: string | null }> {
  if (!updatesSignupsOpen(env)) return { outcome: "noop", textVersion: null };
  const textVersion = await signupTextVersion(env.DB, s.path, s.source, s.consentWords);
  const keyVersion = tokenKeyVersion(env);
  const emailKey = await emailKeyOf(s.email, env.BETTER_AUTH_SECRET);
  const b: GateBinds = {
    consentId: crypto.randomUUID(), subjectRef: null, email: s.email, emailKey,
    textVersion, installId: null,
    appVersion: s.path === "legacy" ? "1.0.19" : "site",
    // Difference 4: FS1, FS2 and FS2b write answered_at = ?8, so these paths bind the server's now.
    answeredAt: now, now, currentReceipt: null, keyVersion, ...await proveBinds(env, emailKey, keyVersion), nonce: nonce(),
    template: s.source === "waitlist" ? "prove_waitlist" : "prove", withGuide: s.withGuide, forwarderSource: s.forwarderSource,
    consentWords: s.consentWords, source: s.source, requestId: s.requestId, path: s.path,
    limits: {
      firstKey: s.limits.firstKey, firstCutoff: now - s.limits.firstWindowMs, firstMax: s.limits.firstMax,
      secondKey: s.limits.secondKey, secondCutoff: now - s.limits.secondWindowMs, secondMax: s.limits.secondMax,
    },
    subjectId: `signup:${emailKey}:${s.source}`, payloadHash: s.payloadHash,
  };
  const stmts = signupBatch(env.DB, b);
  const results = await env.DB.batch(stmts);
  return { outcome: outcomeOf(results, stmts.length - 1) ?? "noop", textVersion };
}

/** RJ then RJQ: true only when THIS id now holds `invalid` with this payload (the site may then send its own guide). With the T-C1 gate
 *  closed RJ never runs: no tombstone, and never `committed` (B1 r1: Astra High, Grok M2). */
export async function rejectSignup(env: Env, requestId: string, payloadHash: string, now: number): Promise<{ outcome: RequestOutcome | null; committed: boolean }> {
  if (!updatesSignupsOpen(env)) return { outcome: null, committed: false };
  const results = await env.DB.batch(rejectBatch(env.DB, { requestId, path: "forwarder", payloadHash, nonce: nonce(), now }));
  const row = results[1]?.results?.[0] as { outcome?: RequestOutcome; same_payload?: number } | undefined;
  return { outcome: row?.outcome ?? null, committed: row?.outcome === "invalid" && row.same_payload === 1 };
}

// ---- The outbox sender (cron; 3.3 O) -------------------------------------------------------------------------------------------------
function proveMail(template: string, proveUrl: string, unsubUrl: string): { subject: string; text: string; html: string } {
  const guide = template === "guide_prove";
  const lines = guide
    ? ["Here is your Murage setup guide:", GUIDE_URL, "", "You also asked for Murage updates. Confirm your email with this link:", proveUrl]
    : ["Confirm your email to get Murage updates:", proveUrl, "", "If you did not ask for this, ignore this email and nothing changes."];
  const text = [...lines, "", `Unsubscribe: ${unsubUrl}`].join("\n");
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = text.split("\n").map((l) => (/^https:\/\//.test(l) ? `<p><a href="${esc(l)}">${esc(l)}</a></p>` : `<p>${esc(l)}</p>`)).join("");
  return { subject: guide ? "Your Murage setup guide" : "Confirm your Murage updates", text, html };
}

/** One cron pass: O3, then for each queued row O1 (claim or drop), O1b, OQ, the send with the one-click headers, and O2. Each claim reads
 *  the clock afresh, so a slow earlier send cannot carry a stale time past a token's expiry (B1 r1 Astra M). */
export async function sendUpdatesOutbox(env: Env, clock: () => number = Date.now): Promise<{ sent: number; dropped: number; uncertain: number }> {
  const tally = { sent: 0, dropped: 0, uncertain: 0 };
  // T-C1 (test 67): with either flag off the outbox sends no CP mail.
  if (!updatesSignupsOpen(env)) return tally;
  const sender = transactionalSender(env);
  if (!sender) return tally;
  await env.DB.prepare(B.O3).bind(clock()).run();
  const keyVersion = tokenKeyVersion(env);
  const picked = await env.DB.prepare(B.OPICK).bind(OUTBOX_PER_TICK).all<{ id: string }>();
  for (const { id } of picked.results ?? []) {
    const claim = nonce();
    const unsub = await deriveToken(unsubTokenId(id), keyVersion, env.BETTER_AUTH_SECRET);
    const v = { 1: id, 2: claim, 3: clock(), 4: keyVersion, 5: unsub.tokenHash };
    const results = await env.DB.batch([Q.O1, Q.O1b, Q.OQ, B.OMAIL].map((s) => bindNumbered(env.DB, s, v)));
    const oq = Object.values((results[2]?.results?.[0] ?? {}) as Record<string, unknown>);
    const mail = results[3]?.results?.[0] as { template: string; email: string | null } | undefined;
    if (oq[0] !== "sending" || oq[1] !== 1 || !mail?.email) {
      if (oq[0] === "dropped") tally.dropped++;
      continue;
    }
    const prove = await deriveToken(proveTokenId(id), keyVersion, env.BETTER_AUTH_SECRET);
    const origin = cpOrigin(env);
    const proveUrl = `${origin}${PROVE_ROUTE}?token=${prove.token}`;
    const unsubUrl = `${origin}${UNSUBSCRIBE_ROUTE}?token=${unsub.token}`;
    let state: "sent" | "uncertain" = "sent";
    try {
      await sender.send({ to: mail.email, from: FROM, ...proveMail(mail.template, proveUrl, unsubUrl), headers: oneClickHeaders(unsubUrl) });
    } catch {
      state = "uncertain";
    }
    await bindNumbered(env.DB, B.O2, { 1: id, 2: claim, 3: state, 4: clock() }).run();
    tally[state]++;
  }
  return tally;
}
