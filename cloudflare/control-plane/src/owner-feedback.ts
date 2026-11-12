// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tester feedback: "Tell us what was confusing" in the Murage "?" panel (UX overhaul, lane L-FB).
//
//   POST   /v1/owner-feedback             public: the desktop relay (server/feedback-relay.ts) sends one item
//   GET    /v1/owner-feedback?status=new  operator (CLOUD_ADMIN_TOKEN): the triage read
//   PATCH  /v1/owner-feedback/:id         operator: {status} new | seen | fixed | answered
//   DELETE /v1/owner-feedback/:id         operator: remove one row (the deploy check's test row)
//
// WHAT IT NEVER CARRIES. Messages, files, keys, memory, connected-app data, logs, an email. Enforced by an allowlist: every
// object in the body is strict, so an unknown field (say, a message body under a new name) is a 400, never silently
// dropped. Every text field must equal a value in feedback-fixed.json, a copy of the app's shared/feedback-fixed.json, so
// owner text, a name, a record id, a path, a key or an email has no field to travel in, whoever posts here. The table only
// ever grows: a report from a screen this table does not know is refused, so a release that adds a screen or changes a
// label needs this table deployed first.
//
// WHERE IT GOES. The private D1 table owner_feedback (install id kept only as an HMAC under the FEEDBACK_PEPPER Worker
// secret), then one Discord message per item (the masterclass runs on Discord; Sean, 10-30) through the
// FEEDBACK_DISCORD_WEBHOOK_URL Worker secret: the screen's name and the sentence only.
// No item id, envelope, version or OS there. No webhook set: the row is stored and the post is skipped.
//
// LIMITS (designs/UX-FEEDBACK-LIMITS-1012.md). No unauthenticated request can cause unbounded D1 writes:
//   1. The edge limiter (edge-limits.ts) keys this POST by the caller's /64 (IPv6) or address (IPv4), before the body is read.
//   2. One read-only SELECT: 400 a UTC day for everyone, 1 a minute and 20 a day per install. Any of them full: 429, no write.
//   3. One INSERT that re-checks the UTC day's 400 itself. Each write adds a row or loses the race for the last slot; the
//      day's count only grows, so once it is full every request is read-only until 00:00 UTC.
// No per-caller state is kept in D1. The 16 KB body cap is the Worker's own (http.ts). Rows go after 90 days (the sweep).
import { z } from "zod";

import { admin } from "./b3-control";
import fixed from "./feedback-fixed.json";
import { maskFinancialIdentifiers } from "./financial-ids";
import { HTTPError, json, readBoundedJSON, type JSONValue } from "./http";

declare global {
  interface Env {
    FEEDBACK_PEPPER?: string;
    FEEDBACK_DISCORD_WEBHOOK_URL?: string;
  }
  namespace Cloudflare {
    interface Env {
      FEEDBACK_PEPPER?: string;
      FEEDBACK_DISCORD_WEBHOOK_URL?: string;
    }
  }
}

export const FEEDBACK_PATH = "/v1/owner-feedback";
const ITEM_PATH = /^\/v1\/owner-feedback\/([0-9a-f-]{36})$/;
/** Names only, never values. */
export const FEEDBACK_SECRET_NAMES = ["FEEDBACK_PEPPER", "FEEDBACK_DISCORD_WEBHOOK_URL"] as const;

export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * 60_000;
export const PER_MINUTE = 1;
export const PER_DAY = 20;
/** Everything together, per UTC day: the beta cohort sends tens; past this the endpoint is being flooded (rotating addresses
 *  and install ids), so it stops storing, posting and writing until 00:00 UTC. A calendar day, not a rolling one: a rolling
 *  window would reopen a slot each time a row ages out. */
export const GLOBAL_PER_DAY = 400;
export const RETENTION_MS = 90 * DAY_MS;
/** The start of the UTC day holding `now`. */
export const utcDayStart = (now: number): number => now - (((now % DAY_MS) + DAY_MS) % DAY_MS);
const CHAT_TIMEOUT_MS = 5_000;
export const STATUSES = ["new", "seen", "fixed", "answered"] as const;

export const RATE_LIMITED_LINE = "You sent one a moment ago. Wait a minute, then press Send again.";
export const DAILY_LIMIT_LINE = "That is a lot for one day. Thank you. Send more tomorrow.";
export const BUSY_LINE = "We have had a lot of feedback today. Please send this one tomorrow.";

// ── the allowlist ────────────────────────────────────────────────────
const id = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9:._-]+$/);
const oneOf = (values: readonly string[]) => z.string().refine((value) => values.includes(value));
const FIXED_TITLES = new Map(Object.entries(fixed.titles));
const FIXED_GATES = new Map(Object.entries(fixed.gates));
const FIXED_CONTROLS = new Map(Object.entries(fixed.controls));

export const envelopeStateSchema = z.strictObject({
  page: oneOf(fixed.pages).optional(),
  gates: z.array(
    z.strictObject({ id: id(80), reason: z.string() }).refine((gate) => FIXED_GATES.get(gate.id) === gate.reason),
  ).max(20).optional(),
});
export const controlSchema = z.strictObject({ id: id(80), label: z.string(), address: z.string() }).refine((control) => {
  const known = FIXED_CONTROLS.get(control.id);
  return known?.label === control.label && known.address === control.address;
});

export const feedbackSchema = z.strictObject({
  installId: z.uuid(),
  appVersion: z.string().regex(/^(?:dev|\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-z]{1,8}\.?\d{0,4})?)$/),
  os: z.enum(["macos", "windows", "linux"]),
  surface: z.enum(["desktop", "phone", "cloud"]),
  screen: id(80),
  title: z.string(),
  state: envelopeStateSchema,
  controls: z.array(controlSchema).max(60),
  words: oneOf(fixed.words),
  createdAt: z.iso.datetime(),
}).refine((item) => FIXED_TITLES.get(item.screen) === item.title);
export type OwnerFeedback = z.infer<typeof feedbackSchema>;

// ── the scrubber (ported from server/redact.ts TEXT_RULES; same shapes, "[removed]" in place of the value) ──
export const REMOVED = "[removed]";
const KEY_PREFIXES: RegExp[] = [
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, // anthropic / openai / stripe
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // github classic
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // github fine-grained
  /\bxox[abposr]-[A-Za-z0-9-]{20,}/g, // slack
  /\bAKIA[0-9A-Z]{16}\b/g, // aws access key id
  /\bAIza[0-9A-Za-z_-]{30,}/g, // google api key
  /\bnpm_[A-Za-z0-9]{20,}/g, // npm
  /\bxai-[A-Za-z0-9_-]{20,}/g, // xAI
  /\bgsk_[A-Za-z0-9]{40,}/g, // Groq
  /\bhf_[A-Za-z0-9]{30,}/g, // Hugging Face
];
const JWT =
  /(?<!:\/\/)(?<!@)(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)([A-Za-z0-9_-]*?)\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)/g;
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})/g;
const PEM_OPEN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const PEM_CLOSE = /-----END [A-Z ]*PRIVATE KEY-----/g;
const NAME = String.raw`(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key)s?`;
const KEY_VALUE = new RegExp(
  String.raw`(?<![A-Za-z0-9_-])(?:(?=[A-Za-z0-9_-]*_${NAME}["']?\s*[=:]\s*(["']?)[A-Za-z0-9._~+/=-]{8,}\1)([A-Za-z0-9_-]*?)\b([A-Za-z0-9_-]*_${NAME})|([A-Za-z0-9_-]*?)\b(${NAME}))(["']?\s*[=:]\s*)(["']?)([A-Za-z0-9._~+/=-]{8,})\7`,
  "gi",
);
const QUERY_KEY = /([?&](?:[A-Za-z0-9_-]*[_-])?(?:keys?|tokens?)=)([A-Za-z0-9._~+/=-]+)/gi;

function removePemBlocks(input: string): string {
  let out = "";
  let pos = 0;
  for (;;) {
    PEM_OPEN.lastIndex = pos;
    const open = PEM_OPEN.exec(input);
    if (!open) break;
    // A header with no footer: everything after it goes (the desktop masks only a closed block; here an open one is
    // removed too, because a half-pasted key is still a key).
    PEM_CLOSE.lastIndex = open.index + open[0].length;
    const close = PEM_CLOSE.exec(input);
    if (!close) return `${out}${input.slice(pos, open.index)}${REMOVED}`;
    out += `${input.slice(pos, open.index)}${REMOVED}`;
    pos = close.index + close[0].length;
  }
  return out + input.slice(pos);
}

/** Secret shapes out, everything else as typed. Linear-time rules (see server/redact.ts "linear time"). */
export function scrubSecrets(input: string): string {
  // Every length: a short field can still be a whole credential (`?key=ab`, Astra r2 #2).
  if (!input) return input;
  let out = removePemBlocks(input);
  for (const re of KEY_PREFIXES) out = out.replace(re, REMOVED);
  out = out.replace(JWT, (_m, lead: string) => `${lead}${REMOVED}`);
  out = out.replace(BEARER, (_m, lead: string) => `${lead}${REMOVED}`);
  out = out.replace(
    KEY_VALUE,
    (_m, _q: string, leadA: string | undefined, keyA: string | undefined, leadB: string | undefined, keyB: string | undefined, sep: string, quote: string) =>
      `${leadA ?? leadB}${keyA ?? keyB}${sep}${quote}${REMOVED}${quote}`,
  );
  out = out.replace(QUERY_KEY, (match: string, lead: string, value: string) => (/^\d+$/.test(value) ? match : `${lead}${REMOVED}`));
  // Card, bank and personal id numbers keep their shape and lose their digits, the desktop's last rule too.
  return maskFinancialIdentifiers(out);
}

/** An id that is shaped like a secret (id characters do not exclude `ghp_...`) is replaced whole by this, which still
 *  passes the id rules. */
export const REMOVED_ID = "removed";
export const scrubId = (value: string): string => (scrubSecrets(value) === value ? value : REMOVED_ID);

/** The envelope as stored: every id that looks like a secret replaced. */
function scrubbedEnvelope(item: OwnerFeedback): JSONValue {
  const s = item.state;
  const state: { [key: string]: JSONValue } = {};
  if (s.page !== undefined) state.page = s.page;
  if (s.gates !== undefined) state.gates = s.gates.map((g) => ({ id: scrubId(g.id), reason: g.reason }));
  return {
    screen: scrubId(item.screen),
    title: item.title,
    state,
    controls: item.controls.map((c) => ({ id: scrubId(c.id), label: c.label, address: c.address })),
    createdAt: item.createdAt,
  };
}

// ── hashing and limits ───────────────────────────────────────────────
function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256 under the pepper: the install id is never stored as itself. */
export async function pepperedHash(scope: string, value: string, pepper: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${scope}:${value}`)));
}

// ── Discord ──────────────────────────────────────────────────────────
export type ChatFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"]);
const DISCORD_CONTENT_MAX = 2_000;
/** The first line of every post (Sean, 10-30): the masterclass channel must read it as product feedback, not a support request. */
export const PRODUCT_FEEDBACK_LABEL = "**Product feedback (not a support request)**";

/** A webhook this Worker may post to: an https Discord webhook URL (/api/webhooks/<id>/<token>), nothing else. */
export function discordWebhook(env: Env): string | null {
  const raw = String(env.FEEDBACK_DISCORD_WEBHOOK_URL ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const ok = url.protocol === "https:" && DISCORD_HOSTS.has(url.hostname) && /^\/api\/webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,200}$/.test(url.pathname)
      && !url.username && !url.password && !url.port;
    return ok ? `${url.origin}${url.pathname}` : null;
  } catch {
    return null;
  }
}

/** Untrusted text shown literally: every Markdown character Discord reads (emphasis, code, quotes, headings, lists, masked
 *  links, spoilers, mentions, escapes) gets a backslash. Mentions never ping either way (allowed_mentions below). */
export function discordLiteral(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u206f]/g, " ").replace(/[\\*_~`|>#\-+.!\[\]()<>:@]/g, (c) => `\\${c}`);
}

/** The title is one line: every line break Discord honours (CR, LF, CRLF, U+2028, U+2029) becomes a space first. */
export const oneLine = (value: string): string => value.replace(/\r\n|[\r\n\u2028\u2029]/g, " ");

/** Sean's ruling (10-30): the label, the screen's name and the words, nothing else (no id, version, OS or envelope).
 *  The words are bounded so the whole post, escaped, fits Discord's 2000 characters. */
export function discordMessage(row: { screen: string; title: string; words: string }): { content: string } {
  const head = `${PRODUCT_FEEDBACK_LABEL}\nScreen: ${discordLiteral(oneLine(row.title))} (${discordLiteral(row.screen)})\n`;
  let words = discordLiteral(row.words);
  const room = DISCORD_CONTENT_MAX - head.length;
  if (words.length > room) {
    words = words.slice(0, room - 3);
    if (words.endsWith("\\")) words = words.slice(0, -1);
    words += "...";
  }
  return { content: `${head}${words}` };
}

async function postToDiscord(webhook: string, message: { content: string }, chatFetch: ChatFetch, requestId: string): Promise<void> {
  try {
    const response = await chatFetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...message, allowed_mentions: { parse: [] }, flags: 4 }),
      redirect: "manual",
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (!response.ok) console.error(JSON.stringify({ message: "owner feedback: discord refused", requestId, status: response.status }));
  } catch {
    console.error(JSON.stringify({ message: "owner feedback: discord unreachable", requestId }));
  }
}

// ── routes ───────────────────────────────────────────────────────────
export interface FeedbackDependencies {
  chatFetch?: ChatFetch;
  now?: () => number;
  /** ctx.waitUntil: the Discord post runs after the answer. */
  waitUntil?: (work: Promise<unknown>) => void;
}

async function receive(request: Request, env: Env, deps: FeedbackDependencies, requestId: string): Promise<Response> {
  const parsed = feedbackSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  const pepper = String(env.FEEDBACK_PEPPER ?? "");
  if (pepper.length < 32) {
    console.error(JSON.stringify({ message: "owner feedback refused: FEEDBACK_PEPPER is not set", requestId, errorCode: "feedback_unconfigured" }));
    throw new HTTPError(503, "feedback_unconfigured");
  }
  const item = parsed.data;
  const now = (deps.now ?? Date.now)();
  const dayStart = utcDayStart(now);
  const installHash = await pepperedHash("feedback-install", item.installId, pepper);
  // Read first, write only when there is room: a full day or a busy install never reaches a write statement.
  const counts = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM owner_feedback WHERE received_at >= ?) AS everyone,
      (SELECT COUNT(*) FROM owner_feedback WHERE install_hash = ? AND received_at > ?) AS minute,
      (SELECT COUNT(*) FROM owner_feedback WHERE install_hash = ? AND received_at > ?) AS mine`)
    .bind(dayStart, installHash, now - MINUTE_MS, installHash, now - DAY_MS)
    .first<{ everyone: number; minute: number; mine: number }>();
  if ((counts?.everyone ?? 0) >= GLOBAL_PER_DAY) throw busy(requestId);
  if ((counts?.mine ?? 0) >= PER_DAY) throw new HTTPError(429, "rate_limited", { message: DAILY_LIMIT_LINE });
  if ((counts?.minute ?? 0) >= PER_MINUTE) throw new HTTPError(429, "rate_limited", { message: RATE_LIMITED_LINE });

  const id = crypto.randomUUID();
  const screen = scrubId(item.screen);
  // The day's ceiling is checked again inside the insert, so rows and posts never pass 400 a day even when requests race.
  const inserted = await env.DB.prepare(
    `INSERT INTO owner_feedback (id, received_at, install_hash, app_version, os, surface, screen, envelope_json, words, reply_email, status)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new'
     WHERE (SELECT COUNT(*) FROM owner_feedback WHERE received_at >= ?) < ?`,
  ).bind(
    id, now, installHash, item.appVersion, item.os, item.surface, screen, JSON.stringify(scrubbedEnvelope(item)), item.words, null,
    dayStart, GLOBAL_PER_DAY,
  ).run();
  if (inserted.meta.changes === 0) throw busy(requestId);

  const webhook = discordWebhook(env);
  if (webhook) {
    const message = discordMessage({ screen, title: item.title, words: item.words });
    const work = postToDiscord(webhook, message, deps.chatFetch ?? fetch, requestId);
    if (deps.waitUntil) deps.waitUntil(work);
    else await work;
  }
  return json({ ok: true, id });
}

function busy(requestId: string): HTTPError {
  console.error(JSON.stringify({ message: "owner feedback: daily ceiling reached", requestId, errorCode: "feedback_ceiling" }));
  return new HTTPError(429, "rate_limited", { message: BUSY_LINE });
}

/** The scheduled sweep: rows older than 90 days go. Cron-driven, never on a request. */
export async function sweepOwnerFeedback(env: Env, now: number): Promise<number> {
  const result = await env.DB.prepare("DELETE FROM owner_feedback WHERE received_at < ?").bind(now - RETENTION_MS).run();
  return result.meta.changes;
}

interface Row {
  id: string; received_at: number; install_hash: string; app_version: string; os: string; surface: string; screen: string;
  envelope_json: string; words: string; reply_email: string | null; status: string;
}

const statusSchema = z.enum(STATUSES);
const patchSchema = z.strictObject({ status: statusSchema });

async function list(request: Request, env: Env): Promise<Response> {
  await admin(request, env);
  const url = new URL(request.url);
  const status = statusSchema.safeParse(url.searchParams.get("status") ?? "new");
  if (!status.success) throw new HTTPError(400, "invalid_request");
  const limitRaw = Number(url.searchParams.get("limit") ?? "100");
  const limit = Number.isSafeInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 500 ? limitRaw : 100;
  const rows = await env.DB.prepare(
    "SELECT * FROM owner_feedback WHERE status = ? ORDER BY received_at ASC LIMIT ?",
  ).bind(status.data, limit).all<Row>();
  return json({
    items: rows.results.map((row) => ({
      id: row.id,
      receivedAt: new Date(row.received_at).toISOString(),
      install: row.install_hash.slice(0, 12),
      appVersion: row.app_version,
      os: row.os,
      surface: row.surface,
      screen: row.screen,
      envelope: JSON.parse(row.envelope_json) as JSONValue,
      words: row.words,
      status: row.status,
    })),
  });
}

async function item(request: Request, env: Env, id: string): Promise<Response> {
  await admin(request, env);
  if (request.method === "PATCH") {
    const parsed = patchSchema.safeParse(await readBoundedJSON(request));
    if (!parsed.success) throw new HTTPError(400, "invalid_request");
    const result = await env.DB.prepare("UPDATE owner_feedback SET status = ? WHERE id = ?").bind(parsed.data.status, id).run();
    if (result.meta.changes === 0) throw new HTTPError(404, "not_found");
    return json({ ok: true, id, status: parsed.data.status });
  }
  const result = await env.DB.prepare("DELETE FROM owner_feedback WHERE id = ?").bind(id).run();
  if (result.meta.changes === 0) throw new HTTPError(404, "not_found");
  return json({ ok: true, id, deleted: true });
}

/** The four routes, or null for any other path. */
export async function ownerFeedbackRoute(request: Request, env: Env, deps: FeedbackDependencies, requestId: string): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === FEEDBACK_PATH) {
    if (request.method === "POST") return receive(request, env, deps, requestId);
    if (request.method === "GET") return list(request, env);
    throw new HTTPError(405, "method_not_allowed");
  }
  const match = ITEM_PATH.exec(path);
  if (!match) return null;
  if (request.method !== "PATCH" && request.method !== "DELETE") throw new HTTPError(405, "method_not_allowed");
  return item(request, env, match[1]);
}
