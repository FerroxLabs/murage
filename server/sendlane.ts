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

/** Config first, then env, so a packaged build can be pointed at a different
 *  list without a rebuild. Absent credentials disable the feature silently:
 *  a fork with no Sendlane account should not throw on every signup. */
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
  const listId = (cfg.sendlane?.listId ?? env.SENDLANE_LIST_ID ?? "").trim();
  if (!apiKey || !hashKey || !listId) return null;
  return { apiKey, hashKey, listId };
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
