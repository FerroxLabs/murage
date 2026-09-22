// The onboarding announcement signup, and the only place a Sendlane
// credential exists.
//
// WHY IT MOVED HERE. This ran in the desktop app until now, from
// `server/sendlane.ts`, reading `SENDLANE_API_KEY` and `SENDLANE_HASH_KEY`.
// `electron-builder.yml` packs the app with `asar: true`, and an ASAR is an
// archive, not encryption — so both keys were readable by everyone who
// installed Murage, and both are write credentials for the WHOLE Sendlane
// account. They are Worker secrets now. A desktop build carries an address,
// a name and a URL, and nothing else.
//
// Legacy v1 API. Base is api.sendlane.com (www.sendlane.com redirects and
// breaks). Auth is form-encoded `api` + `hash` in the POST body, not a header.
// `list-subscriber-add` updates rather than duplicating, so a retry or a
// repeat signup is safe and never clears fields we did not send.
import { z } from "zod";

import { HTTPError, json, readBoundedJSON } from "./http";

/**
 * Murage's own list.
 *
 * A LIST ID IS CONFIGURATION, NOT A SECRET, and that is the whole reason it
 * gets a default while `SENDLANE_API_KEY` and `SENDLANE_HASH_KEY` never will.
 * Those two are write credentials for the entire Sendlane account; this is a
 * number that says which of that account's lists the onboarding signup lands
 * on. Owner's ruling, 2026-09-21: "List ID 37 is Murage's list."
 *
 * `SENDLANE_LIST_ID` is a plaintext `var` in wrangler.jsonc for the same
 * reason: an operator pointing a fork at their own list is editing
 * configuration, not handling a secret. This constant is the fallback for a
 * fork that deletes the var, so the endpoint cannot end up posting to list
 * "" — credentials present, list absent, every address on the floor.
 */
export const DEFAULT_LIST_ID = "37";

/** Names only, never values. Nothing in this module may log a secret. */
export const SENDLANE_SECRET_NAMES = ["SENDLANE_API_KEY", "SENDLANE_HASH_KEY"] as const;

const SENDLANE_BASE = "https://api.sendlane.com/api/v1";
const SENDLANE_TIMEOUT_MS = 5_000;
const SENDLANE_ATTEMPTS = 3;
const MAX_RESPONSE_BYTES = 64 * 1_024;

/** One address, three tries in a quarter of an hour. A person signs up once;
 *  anything past that is a script or a mistake. Same shape and the same
 *  numbers as the OTP recipient limit in `otp-rate-limit.ts`. */
const EMAIL_WINDOW_MS = 15 * 60 * 1_000;
const EMAIL_MAX_ATTEMPTS = 3;
/** A per-address limit alone stops nothing: a spammer simply uses a different
 *  address every time. The caller is bounded too. */
const CALLER_WINDOW_MS = 60 * 60 * 1_000;
const CALLER_MAX_ATTEMPTS = 10;
const RETENTION_MS = 24 * 60 * 60 * 1_000;

/** Shape first, address second, so an unknown field and a typo in an address
 *  are not the same answer to the person who sent it. */
const subscribeSchema = z.strictObject({
  email: z.string().max(254),
  name: z.string().max(80).optional(),
});
const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
const listIdSchema = z.string().regex(/^[0-9]{1,20}$/);

export type SendlaneFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface SendlaneCredentials {
  apiKey: string;
  hashKey: string;
  listId: string;
}

/** The two keys are required and have no default, so a Worker nobody has run
 *  `wrangler secret put` against cannot look configured. A malformed list id
 *  counts as unconfigured for the same reason: posting to a list this Worker
 *  cannot name is worse than refusing. */
export function sendlaneCredentials(env: Env): SendlaneCredentials | null {
  const apiKey = String(env.SENDLANE_API_KEY ?? "").trim();
  const hashKey = String(env.SENDLANE_HASH_KEY ?? "").trim();
  const listId = String(env.SENDLANE_LIST_ID ?? "").trim() || DEFAULT_LIST_ID;
  if (!apiKey || !hashKey || !listIdSchema.safeParse(listId).success) return null;
  return { apiKey, hashKey, listId };
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** HMAC, never the address or the IP itself. This table is a spam ledger, and
 *  it has to stay useless to anyone who reads it — the same rule, and the same
 *  key material, as the OTP recipient limiter. */
async function subjectKey(scope: string, value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${scope}:${value}`)));
}

async function withinLimit(
  env: Env,
  key: string,
  windowMs: number,
  maxAttempts: number,
  now: number,
): Promise<boolean> {
  const cutoff = now - windowMs;
  const result = await env.DB.prepare(
    `INSERT INTO announcement_rate_limits
      (subject_key, window_started_at, attempts, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(subject_key) DO UPDATE SET
       window_started_at = CASE
         WHEN window_started_at <= ? THEN excluded.window_started_at
         ELSE window_started_at
       END,
       attempts = CASE
         WHEN window_started_at <= ? THEN 1
         ELSE attempts + 1
       END,
       updated_at = excluded.updated_at
     WHERE window_started_at <= ? OR attempts < ?`,
  ).bind(key, now, now, cutoff, cutoff, cutoff, maxAttempts).run();
  return result.meta.changes !== 0;
}

/** Sendlane answers with an HTML error page instead of JSON when it is
 *  unhappy, including under concurrency, and it does it with a 200. Read as a
 *  success that body would report a subscriber who was never added. Treat any
 *  HTML body as a retryable failure. */
function isHtml(body: string): boolean {
  const head = body.slice(0, 200).toLowerCase();
  return head.includes("<!doctype") || head.includes("<html") || head.includes("server error");
}

/** Enough of the body to tell an HTML error page from an answer, and not a
 *  byte more: an upstream that streams forever must not hold a request open. */
async function boundedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.byteLength;
      if (length >= MAX_RESPONSE_BYTES) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

interface SendlaneResult {
  ok: boolean;
  status?: number;
}

/** Add or update one contact on the configured list. Never throws: the caller
 *  turns the result into a status code, and a Sendlane outage is a missed
 *  subscriber, not a stack trace. */
async function addSubscriber(
  credentials: SendlaneCredentials,
  email: string,
  name: string,
  sendlaneFetch: SendlaneFetch,
  attempts: number,
): Promise<SendlaneResult> {
  const body = new URLSearchParams({
    api: credentials.apiKey,
    hash: credentials.hashKey,
    list_id: credentials.listId,
    email,
    tag_names: "murage,app-onboarding",
  });
  // Omitted fields are left intact by Sendlane, so only send a name we have.
  if (name) body.set("first_name", name);

  let status: number | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await sendlaneFetch(`${SENDLANE_BASE}/list-subscriber-add`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        // Workers only implements `follow` and `manual`. Manual keeps the two
        // keys in the form body from being replayed to a redirect target.
        redirect: "manual",
        signal: AbortSignal.timeout(SENDLANE_TIMEOUT_MS),
      });
      status = response.status;
      const text = await boundedText(response);
      if (response.ok && !isHtml(text)) return { ok: true, status };
      // 4xx that is not an HTML error page is a real rejection — do not retry it
      if (response.status < 500 && !isHtml(text)) return { ok: false, status };
    } catch {
      // network failure or timeout — fall through to the backoff
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
    }
  }
  return { ok: false, status };
}

/**
 * `POST /v1/announcements/subscribe`, unauthenticated.
 *
 * Unauthenticated because the caller is somebody's first run, before any
 * account exists. That makes it a write into the owner's mailing list that
 * anyone on the internet can reach, so the address is validated here rather
 * than trusted from the client, and both the address and the caller are rate
 * limited before a single byte goes to Sendlane.
 */
export async function subscribeToAnnouncements(
  request: Request,
  env: Env,
  sendlaneFetch: SendlaneFetch,
  requestId: string,
): Promise<Response> {
  const parsed = subscribeSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  const email = emailSchema.safeParse(parsed.data.email);
  if (!email.success) throw new HTTPError(400, "invalid_email");
  const name = (parsed.data.name ?? "").trim();

  const credentials = sendlaneCredentials(env);
  if (!credentials) {
    // SAY IT WHERE SOMEBODY WILL SEE IT.
    //
    // The desktop's old version of this wrote one console line at startup,
    // which was useless: nobody reads a packaged app's child-process console,
    // so a build that collected nothing collected nothing in silence, for
    // ever. Here there are three witnesses instead, and none of them is a
    // console line nobody reads: `wrangler deploy` refuses while a name in
    // `secrets.required` is unset, every signup answers 503 rather than a
    // cheerful 200, and this lands in Workers observability, which is logging
    // at a head sampling rate of 1. Names only — never a value.
    console.error(JSON.stringify({
      message: "announcement signup refused: Sendlane is not configured",
      requestId,
      errorCode: "announcements_unconfigured",
      missing: SENDLANE_SECRET_NAMES.filter((secret) => !String(env[secret] ?? "").trim()),
    }));
    throw new HTTPError(503, "announcements_unconfigured");
  }

  const now = Date.now();
  const caller = request.headers.get("cf-connecting-ip") ?? "";
  const [emailKey, callerKey] = await Promise.all([
    subjectKey("announce-email", email.data, env.BETTER_AUTH_SECRET),
    subjectKey("announce-caller", caller, env.BETTER_AUTH_SECRET),
  ]);
  const allowed = await withinLimit(env, emailKey, EMAIL_WINDOW_MS, EMAIL_MAX_ATTEMPTS, now)
    && await withinLimit(env, callerKey, CALLER_WINDOW_MS, CALLER_MAX_ATTEMPTS, now);
  await env.DB.prepare(
    "DELETE FROM announcement_rate_limits WHERE updated_at < ?",
  ).bind(now - RETENTION_MS).run();
  if (!allowed) throw new HTTPError(429, "rate_limited");

  const result = await addSubscriber(credentials, email.data, name, sendlaneFetch, SENDLANE_ATTEMPTS);
  if (!result.ok) {
    console.error(JSON.stringify({
      message: "announcement signup failed upstream",
      requestId,
      errorCode: "announcements_upstream",
      status: result.status ?? null,
    }));
    throw new HTTPError(502, "announcements_upstream");
  }
  return json({ ok: true });
}
