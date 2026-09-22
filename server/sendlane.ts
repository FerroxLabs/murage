// The onboarding signup, as the desktop now performs it: one POST to the
// control plane, carrying an address and a name and nothing else.
//
// THE CREDENTIAL IS GONE FROM HERE, AND CANNOT COME BACK.
//
// This module used to call api.sendlane.com directly with SENDLANE_API_KEY and
// SENDLANE_HASH_KEY. It ran server-side, which was the right instinct and the
// wrong conclusion: `electron-builder.yml` packs the app with `asar: true`,
// and an ASAR is an ARCHIVE, NOT ENCRYPTION. Anything inside it — harness code,
// config, an env baked into the build — is readable by everyone who installs
// Murage, and those two keys are write credentials for the whole Sendlane
// account. Server-side of the renderer is not the same thing as server-side of
// the customer.
//
// So the keys live as Worker secrets on the control plane
// (cloudflare/control-plane/src/announcements.ts), the list id lives there as
// configuration, and the desktop holds a URL. There is deliberately no config
// field and no environment variable on this side that could hold a Sendlane
// key: the only knob is which control plane to post to, so a fork can point at
// its own Worker without ever handling Murage's credentials.
import { loadConfig } from "./config.ts";

/** The hosted control plane (cloudflare/control-plane/wrangler.jsonc). A URL,
 *  not a secret, so it is safe to ship and safe to default — which is the
 *  whole reason a packaged build can no longer be silently unable to collect
 *  anything. */
export const DEFAULT_ANNOUNCEMENTS_BASE_URL = "https://accounts.murage.ai";
export const ANNOUNCEMENTS_SUBSCRIBE_PATH = "/v1/announcements/subscribe";

/** Is this process the harness Electron embeds?
 *
 * `process.parentPort` is supplied by exactly one runtime — an Electron
 * `utilityProcess` child — and `electron/main.mjs` forks the harness that way
 * from `startServerOn`, which is guarded by `app.isPackaged`. The same
 * structural test `sse-visibility.ts` uses, for the same reason: it is a fact
 * about how the process was launched, not a claim its environment makes about
 * itself. */
function embeddedInDesktopApp(env: NodeJS.ProcessEnv): boolean {
  return (process as NodeJS.Process & { parentPort?: unknown }).parentPort !== undefined
    || env.MURAGE_DESKTOP_PARENT === "1";
}

/** An exact origin and nothing else — no path, no query, no credentials in the
 *  URL. HTTPS, or HTTP on loopback so a contributor can run the Worker with
 *  `wrangler dev`. The same rule `normalizeControlPlaneURL` applies in
 *  electron/control-plane-client.mjs. */
function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "";
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash
  ) {
    return "";
  }
  return url.origin;
}

/**
 * Where a signup is posted, or null when this build does not collect.
 *
 * Config first, then env, so a fork can be pointed at its own Worker without a
 * rebuild — the same order `fluxKey()` uses. An override that is present but
 * unusable DISABLES the signup rather than quietly falling back to Murage's
 * own control plane: somebody who typed a URL meant that URL, and posting
 * their users' addresses to our list instead would be the worst possible
 * reading of a typo.
 *
 * With no override at all, only the packaged desktop gets the hosted default.
 * A dev run and a test fixture collect nothing, on purpose: the signup writes
 * to a real mailing list, and `someone@example.com` has no business on it.
 */
export function announcementsBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  let cfg: { sendlane?: { baseUrl?: string } } = {};
  try {
    cfg = loadConfig() as typeof cfg;
  } catch {
    // a malformed config must not take signup down with it
  }
  const override = (cfg.sendlane?.baseUrl ?? env.MURAGE_ANNOUNCEMENTS_URL ?? "").trim();
  if (override) return normalizeBaseUrl(override) || null;
  return embeddedInDesktopApp(env) ? DEFAULT_ANNOUNCEMENTS_BASE_URL : null;
}

/**
 * WHY THIS EXISTS, AND WHY IT IS AT STARTUP RATHER THAN PER SIGNUP.
 *
 * `subscribe()` answers `{ ok: false, reason: "disabled" }` when this build
 * has nowhere to post, and the `/api/subscribe` route logs only `reason ===
 * "upstream"`. So "disabled" was logged NOWHERE, and a build that collected
 * nothing said nothing about it.
 *
 * It no longer names a credential, because this side holds none. It names the
 * one thing that can now be wrong here: an override that is not a usable
 * origin. A packaged build with no override cannot reach this state at all.
 *
 * Returns the sentence rather than printing it, so the condition can be tested
 * without a server and without capturing console output.
 */
export function announcementsStartupNotice(env: NodeJS.ProcessEnv = process.env): string | null {
  if (announcementsBaseUrl(env) !== null) return null;
  const override = (env.MURAGE_ANNOUNCEMENTS_URL ?? "").trim();
  return override
    ? "MURAGE_ANNOUNCEMENTS_URL is not an exact https origin, so onboarding signups are recorded nowhere. "
      + "Nobody who gives their email during the first run will reach the list until it is a URL like "
      + `${DEFAULT_ANNOUNCEMENTS_BASE_URL}.`
    : "Onboarding signups are recorded nowhere: this build has no announcements endpoint. "
      + `A packaged build uses ${DEFAULT_ANNOUNCEMENTS_BASE_URL}; set MURAGE_ANNOUNCEMENTS_URL to collect from here.`;
}

export interface SubscribeResult {
  ok: boolean;
  /** "disabled" when this build has no announcements endpoint — not an error. */
  reason?: "disabled" | "invalid-email" | "upstream";
  status?: number;
}

/**
 * Put one address on the announcement list, through the control plane.
 *
 * Never throws. Signup must not be able to block someone from entering the
 * app: the worst acceptable outcome of the control plane being down is a
 * missed subscriber. The result shape is unchanged from when this called
 * Sendlane itself, because `/api/subscribe` and its tests are built on it.
 */
export async function subscribe(
  email: string,
  name: string | undefined,
  opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; retries?: number } = {},
): Promise<SubscribeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = announcementsBaseUrl(opts.env);
  if (!base) return { ok: false, reason: "disabled" };

  const trimmed = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)) {
    return { ok: false, reason: "invalid-email" };
  }

  // The Worker takes exactly these two fields and refuses anything else, and
  // an absent name must stay absent: Sendlane leaves omitted fields intact, so
  // an empty string would wipe a name the record already has.
  const first = (name ?? "").trim();
  const body = JSON.stringify(first ? { email: trimmed, name: first } : { email: trimmed });

  const attempts = Math.max(1, opts.retries ?? 3);
  let status: number | undefined;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(`${base}${ANNOUNCEMENTS_SUBSCRIBE_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      status = res.status;
      if (res.ok) return { ok: true, status };
      // 4xx is the control plane saying no on purpose — a rejected address, a
      // rate limit, a request it will refuse identically next time. Only a 5xx
      // or a dead socket is worth another try.
      if (res.status < 500) return { ok: false, reason: "upstream", status };
    } catch {
      // network failure — fall through to the backoff
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400 * 2 ** i));
  }
  return { ok: false, reason: "upstream", status };
}
