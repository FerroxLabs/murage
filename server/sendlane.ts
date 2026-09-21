// Sendlane list subscription for the onboarding signup.
//
// This runs server-side on purpose. The API key is a write credential for the
// whole account; shipping it to the renderer would publish it, since an
// Electron renderer bundle is readable by anyone who installs the app.
//
// Legacy v1 API. Base is api.sendlane.com (www.sendlane.com redirects and
// breaks). Auth is form-encoded `api` + `hash` in the POST body, not a header.
// `list-subscriber-add` updates rather than duplicating, so a retry or a repeat
// signup is safe and never clears fields we did not send.
import { loadConfig } from "./config.ts";

const BASE = "https://api.sendlane.com/api/v1";

export interface SendlaneCredentials {
  apiKey: string;
  hashKey: string;
  listId: string;
}

/**
 * Murage's own list.
 *
 * A LIST ID IS CONFIGURATION, NOT A SECRET, and that is the whole reason it
 * gets a default while `apiKey` and `hashKey` never will. Those two are write
 * credentials for the entire Sendlane account; this is a number that says
 * which of that account's lists the onboarding signup lands on. Owner's
 * ruling, 2026-09-21: "List ID 37 is Murage's list."
 *
 * Defaulting it removes one of the three ways a packaged build could be
 * silently misconfigured, and removes the one that would be WORST: credentials
 * present, list id absent or wrong, so every address is either dropped on the
 * floor or posted to somebody else's list. A build still cannot run without
 * real credentials, because both keys stay required.
 *
 * An explicit `sendlane.listId` in config, or `SENDLANE_LIST_ID` in the
 * environment, still wins. This is a default, not a constant.
 */
export const SENDLANE_DEFAULT_LIST_ID = "37";

/** Config first, then env, then the default list, so a packaged build can be
 *  pointed at a different list without a rebuild. Absent credentials disable
 *  the feature: a fork with no Sendlane account should not throw on every
 *  signup. Disabled is no longer SILENT, though — see `sendlaneStartupNotice`. */
export function sendlaneCredentials(
  env: NodeJS.ProcessEnv = process.env,
): SendlaneCredentials | null {
  let cfg: { sendlane?: { apiKey?: string; hashKey?: string; listId?: string } } = {};
  try {
    cfg = loadConfig() as typeof cfg;
  } catch {
    // a malformed config must not take signup down with it
  }
  const apiKey = (cfg.sendlane?.apiKey ?? env.SENDLANE_API_KEY ?? "").trim();
  const hashKey = (cfg.sendlane?.hashKey ?? env.SENDLANE_HASH_KEY ?? "").trim();
  const listId = (cfg.sendlane?.listId ?? env.SENDLANE_LIST_ID ?? "").trim() || SENDLANE_DEFAULT_LIST_ID;
  if (!apiKey || !hashKey) return null;
  return { apiKey, hashKey, listId };
}

/**
 * The names of the credentials this build is missing. NAMES ONLY, never
 * values: nothing in this module may print a secret, and a diagnostic that
 * echoed one would put a write credential for the whole marketing account
 * into a log file and a support bundle.
 */
export function sendlaneMissing(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return sendlaneCredentials(env) ? [] : ["SENDLANE_API_KEY", "SENDLANE_HASH_KEY"];
}

/**
 * WHY THIS EXISTS, AND WHY IT IS AT STARTUP RATHER THAN PER SIGNUP.
 *
 * `subscribe()` answers `{ ok: false, reason: "disabled" }` when no credentials
 * are configured, and the `/api/subscribe` route logs only `reason ===
 * "upstream"`. So "disabled" was logged NOWHERE. A packaged build shipped
 * without credentials therefore collected zero addresses, for ever, without a
 * single line anywhere saying so — and this signup is the thing that builds
 * the list.
 *
 * Once, at startup, server-side:
 *   - once, because a line per signup is noise nobody reads, and the condition
 *     it reports cannot change without a restart anyway;
 *   - server-side, because the renderer must learn nothing whatsoever about
 *     this credential. It is not told whether one exists, and it does not need
 *     to be: the signup is fire-and-report either way, and a failure here has
 *     never been allowed to block entry to the app.
 *
 * Returns the sentence rather than printing it, so the condition can be tested
 * without a server and without capturing console output.
 */
export function sendlaneStartupNotice(env: NodeJS.ProcessEnv = process.env): string | null {
  const missing = sendlaneMissing(env);
  if (missing.length === 0) return null;
  return `Sendlane is not configured (${missing.join(", ")}), so onboarding signups are recorded nowhere. `
    + "Nobody who gives their email during the first run will reach the list until this build has credentials.";
}

/** Sendlane answers with an HTML error page instead of JSON when it is unhappy,
 *  including under concurrency. Treat any HTML body as a retryable failure. */
function isHtml(body: string): boolean {
  const head = body.slice(0, 200).toLowerCase();
  return head.includes("<!doctype") || head.includes("<html") || head.includes("server error");
}

export interface SubscribeResult {
  ok: boolean;
  /** "disabled" when no credentials are configured — not an error. */
  reason?: "disabled" | "invalid-email" | "upstream";
  status?: number;
}

/**
 * Add or update one contact on the configured list.
 *
 * Never throws. Signup must not be able to block someone from entering the app:
 * the worst acceptable outcome of Sendlane being down is a missed subscriber.
 */
export async function subscribe(
  email: string,
  name: string | undefined,
  opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; retries?: number } = {},
): Promise<SubscribeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const creds = sendlaneCredentials(opts.env);
  if (!creds) return { ok: false, reason: "disabled" };

  const trimmed = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)) {
    return { ok: false, reason: "invalid-email" };
  }

  const body = new URLSearchParams({
    api: creds.apiKey,
    hash: creds.hashKey,
    list_id: creds.listId,
    email: trimmed,
    tag_names: "murage,app-onboarding",
  });
  // Omitted fields are left intact by Sendlane, so only send a name we have.
  const first = (name ?? "").trim();
  if (first) body.set("first_name", first);

  const attempts = Math.max(1, opts.retries ?? 3);
  let status: number | undefined;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(`${BASE}/list-subscriber-add`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      status = res.status;
      const text = await res.text();
      if (res.ok && !isHtml(text)) return { ok: true, status };
      // 4xx that is not an HTML error page is a real rejection — do not retry it
      if (res.status < 500 && !isHtml(text)) return { ok: false, reason: "upstream", status };
    } catch {
      // network failure — fall through to the backoff
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400 * 2 ** i));
  }
  return { ok: false, reason: "upstream", status };
}
