// The browser door.
//
// A separate listener with its own handler, and that separateness is the
// design rather than an implementation detail. `index.ts` once had two
// listeners sharing one `proxy` handler, which is how a route added for a
// phone becomes a route on a public tunnel without anyone deciding it. This
// file cannot do that: a route added here appears here and nowhere else.
//
// Why a browser cannot simply use the device port, proven rather than argued:
// `dist/index.html` loads its bundle with `<script type="module" crossorigin>`,
// and a `crossorigin` script tag is a CORS-mode fetch, which sends `Origin`
// **even same-origin**. `proxy.ts` 403s any `Origin` before the token check,
// so the device port would refuse the app's own entry bundle. The fix is not
// to weaken that check. The fix is this file.
//
// Three things about the surrounding deployment are measured, not assumed:
//
//  - Port **8813**. Not 8812: `electron/companion-origin-gateway.mjs:12`
//    already owns 8812 for the managed loopback gateway. The security plan's
//    ACL example says 8812 and is wrong.
//  - `tailscale serve` is the front, and it connects over **loopback**. It
//    forwards `Host` intact, adds `Tailscale-User-Login` / `-Name`,
//    `X-Forwarded-For` and `X-Forwarded-Proto: https`, and strips
//    client-supplied copies of those headers. SSE passes through with event
//    ids intact. So the door does not have to bind the tailnet to be reached
//    from it — but it must still be able to, for the direct path.
//  - `funnel` never appears anywhere in this design. `serve` is
//    tailnet-scoped; `funnel` is the public internet, and the two subcommands
//    differ by one word.
import { request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

import { cleanDeviceName, type PublicDevice } from "./devices.ts";
import { BROWSER_STATIC, denyReason, isCloudDesktopJoin, isRoutineWrite } from "./routes.ts";
import { createSseScrubber, isJson, scrub } from "./wire.ts";

/** The identity this door actually answers to.
 *
 * Derived from what was bound and from what Tailscale says this machine is
 * called — never from a header alone. Computing "our origin" from the `Host`
 * header and then comparing `Origin` to it proves nothing at all, because
 * `Host` is attacker-controlled: both sides of the comparison would be the
 * attacker's. */
export interface BoundIdentity {
  /** `https` once the tailnet has certificates and `tailscale serve` is in
   * front; `http` over plain WireGuard until then. It decides the cookie
   * name and whether `Secure` is set, so it is read at bind time rather
   * than compiled in. */
  scheme: "http" | "https";
  /** Hostnames — no ports — this door will answer to. The MagicDNS name, the
   * tailnet address, and loopback when serve is fronting it. Nothing else. */
  hosts: ReadonlySet<string>;
}

/** The slice of `DeviceRegistry` this door needs. Structural rather than the
 * class, so a test can state the world in a few lines — and so it is visible
 * at a glance that the door can pair, sign in, and sign out, and cannot
 * revoke, list or enumerate anything. */
export interface BrowserDeviceStore {
  redeem(
    credential: string,
    name: unknown,
    pairRequestId?: unknown,
  ): { device: PublicDevice; token: string } | { error: string };
  openSession(deviceId: string, label: unknown): { value: string; session: { expiresAt: number } } | null;
  resolveSession(
    value: string | undefined,
  ): { device: { id: string; name: string; cloudDesktopAccess: boolean }; session: { expiresAt: number } } | null;
  closeSession(value: string | undefined): boolean;
}

export interface BrowserDoorOptions {
  /** Where the harness is listening on loopback. */
  harnessPort: number;
  /** Read per request, not captured: the tailnet address can change under a
   * running sidecar and the door re-binds rather than restarting. */
  identity: () => BoundIdentity;
  devices: BrowserDeviceStore;
  /** Register one authenticated live stream against its device, so revoking
   * that device terminates it in flight — the same tracker the device port
   * uses, for the same reason and with the same disposer contract. */
  connected?: (deviceId: string, disconnect: () => void) => () => void;
  /** How long the harness may take to produce response *headers*. Tests only. */
  headersTimeoutMs?: number;
}

/** Headers only. Once they arrive the clock is off and the body may take as
 * long as it likes — an SSE stream is a response that deliberately never
 * ends. Same value and same reasoning as the device proxy. */
const HEADERS_TIMEOUT_MS = 30_000;

/** A JSON response is buffered whole before it can be scrubbed. Far above any
 * real payload; it exists to have a ceiling at all. */
const MAX_JSON_BODY_BYTES = 32 * 1024 * 1024;

/** Methods that do not change state, and therefore need not carry `Origin`. */
const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** Content types for the static shell, keyed by extension.
 *
 * The door's own table, deliberately, rather than the harness's. The harness
 * maps `.html .js .css .svg .png .ico .json .woff2` and nothing else
 * (`server/index.ts:267-276`), so `.webmanifest` falls through to
 * `application/octet-stream` — and a manifest served as octet-stream is
 * ignored by the browser, so the PWA never installs. Overriding here fixes
 * that without editing the harness; the one-line upstream fix is still worth
 * making, and is filed as a patch request rather than made from this lane. */
const STATIC_MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

/** Headers on every response this door writes. No CORS headers appear here or
 * anywhere else in the file, and that absence is load-bearing: without
 * `Access-Control-Allow-Origin` a cross-origin read is opaque, so a GET that
 * somehow slipped a gate still leaks nothing back to the page that made it.
 * It is also why no CSRF token is needed on reads. */
const BASE_HEADERS = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  // The shell is not a frameable document, and neither is anything else here.
  "x-frame-options": "DENY",
} as const;

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    ...BASE_HEADERS,
  });
  res.end(text);
};

/** The host out of a `Host` header, port removed.
 *
 * A bracketed IPv6 literal has colons of its own, so `split(":")[0]` turns
 * `[::1]:8813` into `[`. A malformed authority comes back unchanged rather
 * than empty, so it fails the check instead of skipping it. Same shape as
 * `control.ts`'s parser, kept here rather than imported because that module
 * pulls the whole control server in with it. */
export function hostOf(authority: string): string {
  if (!authority.startsWith("[")) return authority.split(":")[0].toLowerCase();
  const end = authority.indexOf("]");
  // Only a port may follow the bracket. Without that check `[::1].evil.example`
  // unwraps to `::1` and passes the allowlist — the parser would be the hole.
  const rest = end > 1 ? authority.slice(end + 1) : "";
  const bracketed = end > 1 && (rest === "" || /^:\d+$/.test(rest));
  return (bracketed ? authority.slice(1, end) : authority).toLowerCase();
}

/** The origin this door serves for *this* request, or null when the `Host` is
 * not one we bound. Null is a refusal, not a fallback. */
export function expectedOrigin(req: IncomingMessage, identity: BoundIdentity): string | null {
  const authority = String(req.headers.host ?? "");
  if (!authority) return null;
  if (!identity.hosts.has(hostOf(authority))) return null;
  return `${identity.scheme}://${authority}`;
}

/** The origin and cross-site gate, in order, as a refusal or null.
 *
 * Exported so a test can state each rule on its own. The measurements this
 * encodes, taken against a real browser:
 *
 *   fetch() same-origin GET, and EventSource   → Origin ABSENT
 *   fetch() same-origin POST                   → Origin PRESENT
 *   attacker page on another PORT, any request → Sec-Fetch-Site: same-site
 *
 * so "require Origin" would break every read and `EventSource` has no headers
 * API at all, which kills a custom-header CSRF scheme outright. And
 * `SameSite` cookies protect nothing between two ports on one hostname: site
 * is scheme plus registrable domain, and ports are not part of it. Murage
 * runs four listeners on one MagicDNS name. `Sec-Fetch-Site` is what actually
 * closes that, which is why `same-site` is refused rather than tolerated. */
export function originGate(
  req: IncomingMessage,
  identity: BoundIdentity,
): { status: number; error: string } | null {
  const verdict = originGateInner(req, identity);
  if (verdict && process.env.MURAGE_DOOR_DIAGNOSE === "1") {
    const h = req.headers;
    // Deliberately NOT the cookie: this names why a request was refused, and
    // a session token has no place in a log.
    console.error("[door-refused]", JSON.stringify({
      why: verdict.error,
      method: req.method,
      url: (req.url ?? "").split("#")[0],
      host: h.host,
      origin: h.origin ?? null,
      referer: h.referer ?? null,
      secFetchSite: h["sec-fetch-site"] ?? null,
      secFetchMode: h["sec-fetch-mode"] ?? null,
      secFetchDest: h["sec-fetch-dest"] ?? null,
      accept: (h.accept ?? "").slice(0, 60),
      ua: (h["user-agent"] ?? "").slice(0, 90),
      boundHosts: [...identity.hosts],
    }));
  }
  return verdict;
}

function originGateInner(
  req: IncomingMessage,
  identity: BoundIdentity,
): { status: number; error: string } | null {
  // 1. Host allowlist. The harness has one because it is loopback-only; this
  //    door is not on loopback in the direct case, so it needs its own or DNS
  //    rebinding turns any name the phone resolves into a route to this port.
  const origin = expectedOrigin(req, identity);
  if (!origin) return { status: 403, error: "forbidden: unexpected host" };

  const method = req.method ?? "GET";
  const path = (req.url ?? "/").split("?")[0];

  // 2. Sec-Fetch-Site. Sent by every browser that can run this app, on every
  //    request including EventSource and no-cors images. Absent means the
  //    caller is not a browser, and this door is only for browsers.
  const site = req.headers["sec-fetch-site"];

  //    ...but a TOP-LEVEL NAVIGATION to the shell is exempt, and that
  //    exemption is the difference between a working door and a dead one.
  //
  //    `none` is only sent for a URL typed into the address bar. Every other
  //    way a person opens a link on a phone — tapping it in Messages, in
  //    mail, in a notes app, from a QR scanner — is a navigation with an
  //    initiator, and the browser sends `cross-site`. So the rule below
  //    refused the single flow this door exists to serve: Sean pasted the
  //    pairing link to his phone, tapped it, and got "forbidden: cross-origin
  //    request". Measured, not guessed: none → 200, same-origin → 200,
  //    cross-site → 403, same-site → 403, header absent → 403.
  //
  //    Allowing it costs nothing. A cross-site initiator cannot READ what
  //    comes back — that is what the same-origin policy is for, and no CORS
  //    header here ever says otherwise — so navigating someone to this page
  //    reveals nothing. It cannot forge one either: the shell is inert
  //    without a session, and the pairing token rides in the URL FRAGMENT,
  //    which browsers never put on the wire. What an attacker would gain is
  //    the ability to show a person their own sign-in page.
  //
  //    Narrow on purpose: a safe method, never an `/api/` path, and the
  //    request must actually look like a document navigation. Everything
  //    else — every API read, every write, every subresource — still faces
  //    the strict rule, which is where same-site matters and where the
  //    comment above about ports on one MagicDNS name still holds.
  //
  //    An ABSENT `Sec-Fetch-Site` is still refused, deliberately. Widening to
  //    cover it would let any non-browser reach the shell, which throws away
  //    the "this door is only for browsers" property for the sake of Safari
  //    below 16.4 — and a browser that old cannot run this app anyway. The
  //    cost is recorded rather than paid.
  const navigating =
    SAFE_METHODS.has(method) &&
    !path.startsWith("/api/") &&
    (req.headers["sec-fetch-mode"] === "navigate" ||
      req.headers["sec-fetch-dest"] === "document");

  //    ...and it is only ENFORCED when the browser actually sent it.
  //
  //    `Sec-Fetch-*` is a secure-context feature. Over plain `http://` to a
  //    host that is not localhost — which is precisely what this door is
  //    until the tailnet has certificates — Chrome sends none of the three.
  //    Measured from Sean's Android Chrome 152 against this door: site, mode
  //    and dest all ABSENT, on `/enter` and on `/favicon.ico`, over both the
  //    MagicDNS name and the raw tailnet address.
  //
  //    So "absent means the caller is not a browser" was false, and it was
  //    the whole bug. It refused every real phone while my own reconstructed
  //    requests passed, because I had added the headers by hand. Two fixes
  //    built on that reading changed nothing.
  //
  //    Absent now falls through to rules 3 and 4, which do not depend on it:
  //    a cross-origin `fetch()` or `EventSource` carries `Origin` and is
  //    refused there, and a request with no `Origin` — an <img>, a <script> —
  //    cannot read this door's answer, because nothing here ever sends a CORS
  //    header. Present is still enforced exactly as before, so the day this
  //    door speaks HTTPS the stronger guarantee returns by itself.
  if (site !== undefined && !navigating && site !== "same-origin" && site !== "none") {
    return { status: 403, error: "forbidden: cross-origin request" };
  }
  // `none` is a typed URL or a bookmark — a top-level navigation with no
  // initiator. Fine for the shell, never for an API route.
  if (site === "none" && (method !== "GET" || path.startsWith("/api/"))) {
    return { status: 403, error: "forbidden: cross-origin request" };
  }

  // 3. Origin, when present, must be exactly ours. "When present" and not
  //    "required" because it is absent on same-origin GET and on EventSource.
  //
  //    The navigation exemption from rule 2 carries through here, and it has
  //    to: a browser opening a link from another app sends `Origin` on the
  //    top-level navigation — Safari sends the originating origin, and
  //    `Origin: null` after a redirect or from a sandboxed webview. Exempting
  //    the request from the Sec-Fetch check and then refusing it on this one
  //    fixes nothing, which is exactly what happened: Sean's phone still got
  //    "forbidden: cross-origin request" after rule 2 was opened. Measured —
  //    cross-site navigate 200, the same request with any Origin header 403.
  //
  //    Safe for the same reason: whoever sent him cannot read the response.
  //    Every API read and every write still faces the full check below.
  if (!navigating && req.headers.origin && req.headers.origin !== origin) {
    return { status: 403, error: "forbidden: cross-origin request" };
  }

  // 4. And a write must carry one. A browser always sends `Origin` on
  //    POST/PATCH/PUT/DELETE, so a write without one is not a browser.
  if (!SAFE_METHODS.has(method) && !req.headers.origin) {
    return { status: 403, error: "forbidden: cross-origin request" };
  }

  return null;
}

/** The cookie name for a scheme.
 *
 * `__Host-` forbids `Domain`, forces `Path=/`, and requires `Secure` — the
 * strongest prefix the platform has, and it costs nothing. But it *requires*
 * `Secure`, which is unavailable until the tailnet has certificates, so the
 * name is chosen at bind time. The day HTTPS is enabled the cookie upgrades
 * with no code change. */
export function cookieName(scheme: BoundIdentity["scheme"]): string {
  return scheme === "https" ? "__Host-murage_session" : "murage_session";
}

/** The `Set-Cookie` line for a new session.
 *
 * Never a `Domain` attribute. `ts.net` is a public suffix, so
 * `tail0a48a4.ts.net` is the registrable domain and a `Domain` cookie would
 * be scoped to every node in the tailnet. Host-only is what keeps it on this
 * machine's name.
 *
 * `SameSite=Strict`, not Lax. Lax would still ride a top-level cross-site
 * navigation, and the thing it buys — a bookmark into `/chat/<id>` arriving
 * signed in — is worth less than the attack surface it keeps open between two
 * ports of one hostname. `Sec-Fetch-Site` is the gate that actually holds;
 * this is the layer under it. */
export function sessionCookie(value: string, identity: BoundIdentity, maxAgeSeconds: number): string {
  const parts = [
    `${cookieName(identity.scheme)}=${value}`,
    "Path=/",
    "HttpOnly",
    // Lax, not Strict. Strict withholds the cookie on EVERY cross-site
    // navigation, including tapping a link to your own machine from a chat
    // app or a mail client — which is how a person actually arrives. Sean
    // signed in, tapped the plain origin from a message, and the door told
    // him "Not signed in" while his session sat valid on disk with three
    // months left on it.
    //
    // The comment this replaces justified Strict by saying `Sec-Fetch-Site`
    // is the gate that actually holds and this is only the layer beneath it.
    // That is now known to be false HERE: Sec-Fetch is a secure-context
    // feature and no browser sends it to a plain-HTTP tailnet address, which
    // is what this door is until it has certificates. So Strict was paying
    // the entire cost of the bookmark flow for a backstop to a gate that is
    // not running.
    //
    // Lax still withholds the cookie from every cross-site SUBREQUEST and
    // every cross-site POST, which is what CSRF actually needs. The host
    // allowlist and the Origin rules above are what hold the rest.
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (identity.scheme === "https") parts.push("Secure");
  return parts.join("; ");
}

/** The cleared form of the same cookie, for signing out. */
export function clearedCookie(identity: BoundIdentity): string {
  return sessionCookie("", identity, 0);
}

/** One named cookie out of a `Cookie` header, or undefined.
 *
 * Hand-parsed rather than split on `;` and `=` naively, because a value may
 * contain `=` and a name may be padded with spaces. Duplicates resolve to the
 * first, which is what every browser sends first for the most specific path. */
export function readCookie(header: string | string[] | undefined, name: string): string | undefined {
  const raw = Array.isArray(header) ? header.join("; ") : header;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value || undefined;
  }
  return undefined;
}

/** The URL to replay upstream, with any `surface` parameter removed.
 *
 * This is defence in depth and it is worth stating why it is needed at all.
 * `requestSurface` (`server/sse-visibility.ts`) resolves in this order:
 * `x-murage-companion: "1"` wins first, then the `x-murage-surface` header,
 * then `?surface=desktop`. The stamped header below therefore already wins.
 * But a browser can type `?surface=desktop` into a URL bar, and the only
 * thing standing between that and an unscoped grep of every transcript on the
 * machine is one `if` ordering in another module. Deleting the parameter here
 * means this door does not depend on that ordering staying the way round it
 * is today. */
export function forwardedPath(rawUrl: string | undefined): string {
  const url = rawUrl ?? "/";
  const q = url.indexOf("?");
  if (q < 0) return url;
  const params = new URLSearchParams(url.slice(q + 1));
  if (!params.has("surface")) return url;
  params.delete("surface");
  const rest = params.toString();
  return rest ? `${url.slice(0, q)}?${rest}` : url.slice(0, q);
}

/** The headers to send upstream — built from nothing.
 *
 * **This function is the security requirement of the whole file.** It starts
 * from an empty object and copies four things in by name. It never spreads
 * `req.headers`, so there is no path by which a client-supplied
 * `x-murage-surface`, `x-murage-companion`, `Tailscale-User-Login`,
 * `Cookie`, `Authorization`, `Host` or `Origin` reaches the harness.
 *
 * `x-murage-companion: "1"` is then stamped in. A browser cannot clear it,
 * because it is not copying anything the browser sent; it is writing a fresh
 * value into a fresh object. That marker is what makes `requestSurface`
 * answer `remote`, which is what scopes `/api/events`, `/api/search`,
 * `/api/bots` and the transcript routes to the threads a person can see. One
 * missing line here is an unscoped read of every conversation on the machine,
 * silently, and visible only to whoever is reading the stream. */
export function forwardedHeaders(req: IncomingMessage, body: Buffer | null = null): Record<string, string> {
  const out: Record<string, string> = {
    accept: String(req.headers.accept ?? "*/*"),
    "x-murage-companion": "1",
  };
  const contentType = req.headers["content-type"];
  if (contentType) out["content-type"] = String(contentType);
  if (body) {
    out["content-length"] = String(body.byteLength);
  } else {
    const contentLength = req.headers["content-length"];
    if (
      typeof contentLength === "string" &&
      /^(?:0|[1-9]\d*)$/.test(contentLength) &&
      Number.isSafeInteger(Number(contentLength))
    ) {
      out["content-length"] = contentLength;
    }
  }
  // Last-Event-ID is how a reconnecting stream asks for the gap. Dropping it
  // turns every resume into a full re-hydration, silently. `tailscale serve`
  // was measured to pass it and the event ids through unchanged.
  const lastEventId = req.headers["last-event-id"];
  if (lastEventId) out["last-event-id"] = String(lastEventId);
  return out;
}

/** Whether a path is one of the static shell entries, and what it should be
 * served as. Null when the path is not static at all. */
export function staticContentType(path: string): string | null {
  if (!BROWSER_STATIC.some((entry) => entry.path.test(path))) return null;
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  if (dot < 0 || dot < slash) return STATIC_MIME[".html"]; // "/" and the SPA deep links
  return STATIC_MIME[path.slice(dot).toLowerCase()] ?? null;
}

/** Read a body as raw bytes, bounded, so it can be inspected and then
 * forwarded byte-for-byte. */
const readRaw = (req: IncomingMessage, limit = 64 * 1024): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

const readJson = async (req: IncomingMessage, limit = 8 * 1024): Promise<Record<string, unknown>> => {
  const text = (await readRaw(req, limit)).toString("utf8").trim();
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
};

/** Whether a routine body asks to run in the cloud. Same gate as the device
 * door: `runOn: "cloud"` reaches the same billable provisioning call that
 * `POST /api/bots/:id/computer/provision` is denied for, and the
 * discriminator lives in the body where a path allowlist cannot see it. */
const declaresCloudRun = (raw: Buffer): boolean => {
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    return (parsed as { runOn?: unknown } | null)?.runOn === "cloud";
  } catch {
    return false;
  }
};

/** A short label for a browser, from its user agent. Display text only, and
 * clamped by the same function that clamps a device name — it comes from the
 * client and ends up in a settings panel. */
export function browserLabel(userAgent: string | undefined): string {
  const ua = String(userAgent ?? "");
  const engine =
    /\bEdg\//.test(ua) ? "Edge"
    : /\bOPR\//.test(ua) ? "Opera"
    : /\bFirefox\//.test(ua) ? "Firefox"
    : /\bChrome\//.test(ua) ? "Chrome"
    : /\bSafari\//.test(ua) ? "Safari"
    : "";
  const platform =
    /\biPhone\b/.test(ua) ? "iPhone"
    : /\biPad\b/.test(ua) ? "iPad"
    : /\bAndroid\b/.test(ua) ? "Android"
    : /\bMac OS X\b/.test(ua) ? "Mac"
    : /\bWindows\b/.test(ua) ? "Windows"
    : /\bLinux\b/.test(ua) ? "Linux"
    : "";
  if (engine && platform) return `${engine} on ${platform}`;
  return cleanDeviceName(engine || platform || "Browser");
}

/** First contact: a self-contained page that moves the credential out of the
 * URL and into an HttpOnly cookie.
 *
 * Four things about it are deliberate.
 *
 *  1. The credential rides in the **fragment** — `/enter#<token>` — never the
 *     query string. A fragment is never sent to the server, never enters an
 *     access log, and never leaks through `Referer`.
 *  2. The page clears it before it does anything else, so it does not survive
 *     in session history or in a screenshot of the address bar.
 *  3. The response to `POST /session` never contains the credential. The raw
 *     device bearer token is generated, hashed and discarded inside the
 *     sidecar; it is never sent to the browser at all. A body page script can
 *     read is a body an XSS can read.
 *  4. A CSP with a nonce, tight because the page has no assets of its own.
 *
 * No build step and no assets on purpose, the same call `control.ts` makes. */
function enterPage(nonce: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Murage</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; --fg: #111; --dim: #666; --bg: #fff; }
  @media (prefers-color-scheme: dark) { :root { --fg: #eee; --dim: #999; --bg: #151515; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
         font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 30rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { color: var(--dim); margin: 0 0 .75rem; }
  #w:empty { display: none; }
  #w { color: #b8791f; }
  button { font: inherit; padding: .75rem 1.25rem; border-radius: .5rem; border: 0;
           background: #e2622a; color: #fff; cursor: pointer; margin-top: .5rem; }
  button[disabled] { opacity: .5; cursor: default; }
</style>
<main>
  <h1 id="t">Sign in to Murage</h1>
  <p id="m">On this device.</p>
  <p id="w"></p>
  <button id="go" hidden>Sign in on this device</button>
</main>
<script nonce="${nonce}">
(function () {
  var say = function (title, detail) {
    document.getElementById("t").textContent = title;
    document.getElementById("m").textContent = detail || "";
  };
  var credential = location.hash.slice(1);
  // Before anything else, and before any network call: the address bar and
  // the session history must not keep it.
  history.replaceState(null, "", "/enter");
  if (!credential) {
    say("Nothing to sign in with", "Open Phone settings in Murage on your computer and scan the code again.");
    return;
  }

  // A TAP, not a page load.
  //
  // The credential lives in the fragment so it never reaches a server log or
  // a Referer — but that buys nothing against something that RENDERS the
  // page, because the script then runs with the fragment in hand. Paste this
  // link into a chat app and its link-preview crawler fetches it, runs this,
  // signs itself in and burns the single-use code before the person ever taps
  // it. Sean hit exactly that relaying a link through a messenger: a device
  // appeared, was never seen again, and his own tap was told the code was
  // already spent.
  //
  // A crawler does not press buttons. One tap costs a person nothing they
  // were not already doing, and it is also the only moment at which we can
  // warn them BEFORE the code is spent — see the in-app browser note below.
  var go = document.getElementById("go");
  var warn = document.getElementById("w");
  var ua = navigator.userAgent || "";
  // An in-app webview has its own cookie jar. Signing in here strands the
  // session in an app the person cannot bookmark or install from, and the
  // code is single-use, so they must come back for another. Say so first.
  // Plain string matching, not a regular expression. This script is emitted
  // inside a TEMPLATE LITERAL, where a backslash is an escape the template
  // consumes before JavaScript ever sees it. A word-boundary escape became a
  // backspace character, the pattern collapsed into an unterminated literal,
  // the whole script died with a syntax error, and the button below was never
  // revealed — the page simply sat there saying "Sign in to Murage" with no
  // way to. Nothing here is worth a regex.
  //
  // Note for anyone editing this string: no backticks, and no backslashes.
  // Both belong to the template literal, not to the script.

  var webview = false;
  var marks = ["Line/", "FBAN", "FBAV", "Instagram", "WhatsApp", "MicroMessenger", "; wv)"];
  for (var i = 0; i < marks.length; i++) {
    if (ua.indexOf(marks[i]) !== -1) { webview = true; break; }
  }
  if (webview) {
    warn.textContent = "You are in an app's built-in browser. Its sign-in will not carry over to Chrome or Safari, and this code can only be used once. Open this link in your normal browser first.";
  }
  go.hidden = false;
  go.addEventListener("click", function () {
    go.disabled = true;
    say("Signing in…", "");
    fetch("/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: credential })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (r.ok) { location.replace("/"); return; }
        say("Could not sign in", body.error || "That code is no longer valid.");
      });
    }).catch(function () {
      say("Could not reach Murage", "The app may have stopped on your computer.");
    });
  });
})();
</script>
`;
}

/** What a person sees when they open the address without a session.
 *
 * No script and no link to `/enter`: that page is useless without a
 * credential in its fragment, and a link to it would only produce a second
 * dead end. The way in is the QR, which is on the computer. */
function signInPage(): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Murage</title>
<style>
  :root { color-scheme: light dark; --fg: #111; --dim: #666; --bg: #fff; }
  @media (prefers-color-scheme: dark) { :root { --fg: #eee; --dim: #999; --bg: #151515; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
         font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 30rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { color: var(--dim); margin: 0; }
</style>
<main>
  <h1>Not signed in</h1>
  <p>Open Phone settings in Murage on your computer and scan the code with this device.</p>
</main>
`;
}

/**
 * The browser-facing handler.
 *
 * Order, and every step of it matters:
 *
 *   host allowlist → Sec-Fetch-Site → Origin → sidecar-owned routes →
 *   session cookie → allowlist (surface: "browser") → capability gates →
 *   forward with a freshly built header set
 *
 * `GET /enter` is the one unauthenticated route and it terminates here.
 */
export function createBrowserHandler(options: BrowserDoorOptions) {
  return function handle(req: IncomingMessage, res: ServerResponse): void {
    const identity = options.identity();
    const path = (req.url ?? "/").split("?")[0];
    const method = req.method ?? "GET";

    const gate = originGate(req, identity);
    if (gate) return sendJson(res, gate.status, { error: gate.error });

    // ── first contact ────────────────────────────────────────────────────
    if (method === "GET" && path === "/enter") {
      const nonce = randomBytes(16).toString("base64");
      const html = enterPage(nonce);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(html),
        "content-security-policy":
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
          `connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
        ...BASE_HEADERS,
      });
      res.end(html);
      return;
    }

    if (path === "/session") {
      if (method === "POST") {
        readJson(req).then(
          (body) => {
            // The same redemption the native path uses. A second
            // implementation would be a second set of attempt counters and a
            // second place the five-attempt lockout can be forgotten.
            const result = options.devices.redeem(String(body.credential ?? ""), browserLabel(String(req.headers["user-agent"] ?? "")));
            if ("error" in result) return sendJson(res, 401, { error: result.error });
            // The raw bearer stops here. It is not written down, not logged,
            // and not sent on.
            const session = options.devices.openSession(result.device.id, browserLabel(String(req.headers["user-agent"] ?? "")));
            if (!session) return sendJson(res, 500, { error: "could not save the session" });
            const maxAge = Math.floor((session.session.expiresAt - Date.now()) / 1000);
            res.setHeader("set-cookie", sessionCookie(session.value, identity, maxAge));
            return sendJson(res, 201, { ok: true, device: { name: result.device.name } });
          },
          (error: Error) => sendJson(res, 400, { error: error.message }),
        );
        return;
      }
      const cookie = readCookie(req.headers.cookie, cookieName(identity.scheme));
      if (method === "DELETE") {
        options.devices.closeSession(cookie);
        res.setHeader("set-cookie", clearedCookie(identity));
        return sendJson(res, 200, { ok: true });
      }
      if (method === "GET") {
        const resolved = options.devices.resolveSession(cookie);
        if (!resolved) return sendJson(res, 401, { error: "sign in", signIn: "/enter" });
        return sendJson(res, 200, {
          device: { name: resolved.device.name },
          expiresAt: resolved.session.expiresAt,
        });
      }
      return sendJson(res, 404, { error: `no route: ${method} ${path}` });
    }

    // ── everything else is credentialed ──────────────────────────────────
    const cookie = readCookie(req.headers.cookie, cookieName(identity.scheme));
    const resolved = options.devices.resolveSession(cookie);
    const device = resolved?.device ?? null;

    const denial = denyReason({
      path,
      method,
      authenticated: Boolean(device),
      // This handler is the browser door and only ever that.
      surface: "browser",
    });
    if (denial) {
      // A person who typed the address, or opened a bookmark, gets a
      // sentence rather than a JSON object. Still 401 and still not a
      // redirect — the SPA's own `fetch` calls target `/api/…`, never the
      // shell, so none of them can end up parsing this as JSON.
      if (denial.status === 401 && method === "GET" && staticContentType(path)?.startsWith("text/html")) {
        const html = signInPage();
        res.writeHead(401, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(html),
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
          ...BASE_HEADERS,
        });
        res.end(html);
        return;
      }
      const body: Record<string, unknown> = { error: denial.error };
      if (denial.signIn) body.signIn = denial.signIn;
      return sendJson(res, denial.status, body);
    }

    // Same per-device capability the device door applies to the same route,
    // read from the same record. Off until the computer owner turns it on.
    if (isCloudDesktopJoin(method, path) && !device?.cloudDesktopAccess) {
      return sendJson(res, 403, {
        error: "cloud desktop access is off for this device — enable it in Murage → Settings → Phone",
      });
    }

    const forward = (body: Buffer | null): void => {
      const staticType = method === "GET" ? staticContentType(path) : null;
      const upstream = httpRequest(
        {
          hostname: "127.0.0.1",
          port: options.harnessPort,
          path: forwardedPath(req.url),
          method,
          headers: forwardedHeaders(req, body),
        },
        (harness) => {
          clearTimeout(headersDeadline);
          const contentType = String(harness.headers["content-type"] ?? "");

          if (staticType) return relayStatic(harness, res, staticType, path);

          if (contentType.includes("text/event-stream")) {
            return relayStream(harness, req, res, method, path, device, options);
          }

          const encoding = String(harness.headers["content-encoding"] ?? "").trim().toLowerCase();
          if (!isJson(contentType) || (encoding && encoding !== "identity")) {
            // Images and anything else: byte for byte, no parsing. An encoded
            // body reaches here too — `forwardedHeaders` never sends
            // accept-encoding, so this is a guard rather than a path, and it
            // passes through intact rather than scrubbed and broken.
            res.writeHead(harness.statusCode ?? 200, { ...harness.headers, ...BASE_HEADERS });
            harness.on("error", () => res.destroy());
            harness.pipe(res);
            return;
          }

          const chunks: Buffer[] = [];
          let size = 0;
          harness.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_JSON_BODY_BYTES) {
              harness.destroy();
              if (res.headersSent) res.destroy();
              else sendJson(res, 502, { error: "the response from Murage was too large" });
              return;
            }
            chunks.push(chunk);
          });
          harness.on("error", () => res.destroy());
          harness.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown;
            try {
              parsed = JSON.parse(raw);
            } catch {
              // Never was JSON — an empty 204, or a content-type that lied.
              // There is nothing to redact in bytes that do not read as an
              // object, so they go verbatim.
              return send(raw, harness.statusCode ?? 200, harness.headers);
            }
            let text: string;
            try {
              text = JSON.stringify(scrub(parsed));
            } catch {
              // A body that parses but will not scrub is the opposite case:
              // we know it is structured, and falling back to the raw body
              // sends exactly what the scrubber exists to withhold.
              return sendJson(res, 502, { error: "the response could not be prepared for this browser" });
            }
            return send(text, harness.statusCode ?? 200, harness.headers);
          });

          function send(text: string, status: number, upstreamHeaders: IncomingMessage["headers"]): void {
            const headers = { ...upstreamHeaders };
            // The body was re-serialised, so nothing the harness said about
            // its framing survives. Leaving transfer-encoding alongside the
            // content-length set here is a protocol violation Node's own
            // parser rejects outright.
            delete headers["content-length"];
            delete headers["content-encoding"];
            delete headers["transfer-encoding"];
            res.writeHead(status, {
              ...headers,
              ...BASE_HEADERS,
              "content-length": Buffer.byteLength(text),
            });
            res.end(text);
          }
        },
      );

      res.on("close", () => {
        if (!res.writableEnded) upstream.destroy();
      });
      req.on("error", () => upstream.destroy());

      let timedOut = false;
      const headersDeadline = setTimeout(() => {
        timedOut = true;
        upstream.destroy(new Error("the harness sent no response headers"));
      }, options.headersTimeoutMs ?? HEADERS_TIMEOUT_MS);
      headersDeadline.unref?.();

      upstream.on("error", () => {
        clearTimeout(headersDeadline);
        if (res.headersSent || res.writableEnded) {
          res.destroy();
          return;
        }
        sendJson(
          res,
          timedOut ? 504 : 502,
          timedOut ? { error: "Murage did not respond" } : { error: "Murage is not running on this computer" },
        );
      });

      if (body) upstream.end(body);
      else req.pipe(upstream);
    };

    if (isRoutineWrite(method, path) && !device?.cloudDesktopAccess) {
      readRaw(req).then(
        (raw) => {
          if (declaresCloudRun(raw)) {
            return sendJson(res, 403, {
              error: "cloud routines are set up on your computer — this browser is not allowed cloud access",
            });
          }
          forward(raw);
        },
        (error: Error) => sendJson(res, 400, { error: error.message }),
      );
      return;
    }

    forward(null);
  };
}

/** Relay one static file, refusing the harness's SPA fallback.
 *
 * The fallback is the reason this is not a plain pipe. `server/index.ts:9124`
 * answers a *miss* with `index.html`, `content-type: text/html`, **status
 * 200** — so `/assets/typo.js` comes back as HTML that a service worker
 * caches under a `.js` URL, and the app breaks in a way that survives reload.
 * The allowlist in `routes.ts` is the first layer; this is the second, and it
 * is the one that still holds when a hashed asset the allowlist *does* match
 * is missing from disk. Content type is written from the door's own table
 * rather than relayed, which is also where `.webmanifest` gets fixed. */
function relayStatic(
  harness: IncomingMessage,
  res: ServerResponse,
  expected: string,
  path: string,
): void {
  const upstreamType = String(harness.headers["content-type"] ?? "");
  const status = harness.statusCode ?? 200;

  // `MURAGE_STATIC_DIR` unset: the harness has no UI to serve and falls
  // through to its own JSON 404. A blank page is the wrong way to say that.
  if (status === 404 && isJson(upstreamType)) {
    harness.resume();
    return sendJson(res, 503, { error: "the desktop app is not serving the UI" });
  }
  if (status !== 200) {
    harness.resume();
    return sendJson(res, status, { error: `no route: GET ${path}` });
  }
  if (!expected.startsWith("text/html") && upstreamType.startsWith("text/html")) {
    harness.destroy();
    return sendJson(res, 404, { error: `no route: GET ${path}` });
  }

  // Hashed assets are immutable by construction; the shell never is.
  const cache = path.startsWith("/assets/")
    ? "private, max-age=31536000, immutable"
    : "private, no-store";
  res.writeHead(200, { ...BASE_HEADERS, "cache-control": cache, "content-type": expected });
  harness.on("error", () => res.destroy());
  harness.pipe(res);
}

/** Relay one SSE stream, registered against its device.
 *
 * Registration is the point: `connectedDeviceTracker` is what lets
 * `control.ts` terminate a revoked device's live streams synchronously
 * (`control.ts` → `connected-devices.ts:28`). Without this the browser's
 * stream would outlive the revocation that was supposed to kill it, which is
 * the failure that makes a revoke button a lie. */
function relayStream(
  harness: IncomingMessage,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  device: { id: string } | null,
  options: BrowserDoorOptions,
): void {
  const status = harness.statusCode ?? 500;
  const tracks = method === "GET" && path === "/api/events" && status >= 200 && status < 300 && Boolean(device?.id);

  // Re-resolve at the moment the stream opens. A session revoked during the
  // round trip must not get a stream that then lives for hours.
  const current = tracks
    ? options.devices.resolveSession(readCookie(req.headers.cookie, cookieName(options.identity().scheme)))
    : null;
  if (tracks && current?.device.id !== device?.id) {
    harness.destroy();
    return sendJson(res, 401, { error: "sign in", signIn: "/enter" });
  }

  const disconnect = () => {
    if (!harness.destroyed) harness.destroy();
    if (!res.destroyed) res.destroy();
  };
  let releaseConnection = tracks && device?.id ? options.connected?.(device.id, disconnect) ?? null : null;
  const release = () => {
    releaseConnection?.();
    releaseConnection = null;
  };

  res.writeHead(status, {
    "content-type": "text/event-stream",
    ...BASE_HEADERS,
    "cache-control": "private, no-store, no-transform",
    connection: "keep-alive",
    // Nagle would hold a small frame back waiting for company, on a stream
    // whose whole value is being timely.
    "x-accel-buffering": "no",
  });
  res.flushHeaders?.();
  res.socket?.setNoDelay(true);
  res.socket?.setKeepAlive(true, 30_000);

  const scrubStream = createSseScrubber();
  harness.setEncoding("utf8");
  harness.on("data", (chunk: string) => {
    let rewritten: string;
    try {
      rewritten = scrubStream(chunk);
    } catch {
      // The buffer ceiling. Half an event cannot be forwarded safely.
      release();
      harness.destroy();
      res.end();
      return;
    }
    if (!rewritten) return;
    // A browser on a slow link reads slower than the harness writes, and the
    // difference has to go somewhere. Pausing pushes it back to the harness,
    // which is where the backlog belongs; ignoring the write() result would
    // put it in this process's memory, unbounded.
    if (!res.write(rewritten)) harness.pause();
  });
  res.on("drain", () => harness.resume());
  harness.on("end", () => {
    release();
    res.end();
  });
  harness.on("error", () => {
    release();
    res.destroy();
  });
  res.on("close", () => {
    release();
    harness.destroy();
  });
}

/** Where the browser door may bind.
 *
 * `loopback` is the `tailscale serve` path: serve terminates TLS, adds its
 * identity headers, and connects to the backend over 127.0.0.1 — measured, so
 * the door does not need the tailnet address to be reachable from the tailnet.
 * `tailnet` is the direct path, and it binds the 100.64.0.0/10 address
 * specifically.
 *
 * There is no third mode. `0.0.0.0` is not offered, and asking for the
 * tailnet when there is no tailnet address **throws** rather than falling
 * back: falling back to 0.0.0.0 "so it works" is exactly how a tailnet-only
 * door becomes a LAN door, and the person who wanted the narrow bind would
 * never see it happen. */
export type BrowserBindMode = "auto" | "loopback" | "tailnet";

/** The tailnet address it is safe to bind, or a sentence saying why not.
 *
 * Two sources, deliberately: `fromInterfaces` is the first address in
 * 100.64.0.0/10 on this machine's interface table, and `reported` is what the
 * Tailscale CLI says this node's address is — the value `tailscale ip -4`
 * prints. They are normally the same string, and the case where they are not
 * is the whole reason for asking twice. 100.64/10 is CGNAT space and Tailscale
 * does not own it: a carrier-grade-NAT uplink, another mesh VPN, or a
 * container bridge can put a real address there, and the interface picker
 * takes the first one it finds. Binding that address opens the door on a
 * network nobody chose, silently, on exactly the machines where being wrong
 * costs the most.
 *
 * So a disagreement refuses the address. It does not guess which of the two is
 * Tailscale's, and it does not average them.
 *
 * A missing CLI answer is not a disagreement — Tailscale may simply not be
 * installed where we looked, and the interface address is then the only
 * evidence there is. A CLI answer with no matching interface *is* refused:
 * nothing can bind an address the kernel does not have, and saying so beats
 * an EADDRNOTAVAIL three frames away. */
export function tailnetBindAddress(
  fromInterfaces: string | null,
  reported: string | null,
): { address: string } | { refused: string } {
  if (reported && fromInterfaces && reported !== fromInterfaces) {
    return {
      refused:
        `Tailscale reports this node at ${reported}, but the first 100.64.0.0/10 address on this ` +
        `machine is ${fromInterfaces}. Something else is using Tailscale's address range, and the ` +
        `browser door will not pick between them`,
    };
  }
  if (reported && !fromInterfaces) {
    return {
      refused:
        `Tailscale reports this node at ${reported}, but no interface on this machine carries that ` +
        `address — the tailnet interface may be coming up or going down`,
    };
  }
  if (!fromInterfaces) return { refused: "this machine has no Tailscale address" };
  return { address: fromInterfaces };
}

/** Where the browser door binds, given what was asked for and what is there.
 *
 * `auto` is the shipped setting and the only one that is right on a laptop:
 * the tailnet address when there is a trustworthy one, loopback when there is
 * not. It never throws, because the alternative is an app that refuses to
 * start because Tailscale is not signed in yet — and loopback is a real,
 * safe door with `tailscale serve` able to go in front of it later.
 *
 * `tailnet` is an operator saying "that address or nothing", so it throws
 * rather than quietly becoming `auto`. `loopback` is the same in the other
 * direction and never consults Tailscale at all. */
export function browserBindHost(
  mode: BrowserBindMode,
  tailnet: string | null,
  reported: string | null = null,
  onDecline?: (reason: string) => void,
): string {
  if (mode === "loopback") return "127.0.0.1";
  const resolved = tailnetBindAddress(tailnet, reported);
  if ("address" in resolved) return resolved.address;
  if (mode === "auto") {
    onDecline?.(resolved.refused);
    return "127.0.0.1";
  }
  throw new Error(
    `the browser door is set to bind the Tailscale address and cannot: ${resolved.refused}. ` +
      "Bring Tailscale up, or set MURAGE_BROWSER_BIND=loopback and put `tailscale serve` in front",
  );
}

/** Move the door to a different address without restarting the sidecar.
 *
 * Tailscale is routinely installed, signed into or switched on minutes after
 * Murage is. Before this the door had bound loopback at startup and stayed
 * there for the life of the process, so the tailnet — the route this product
 * leads with — came up and the door did not follow. Restarting the sidecar
 * would have fixed it and would also have dropped every paired phone's event
 * stream and the pairing window with them, which is a worse cure.
 *
 * Only this one server closes. The device port, the control page, the managed
 * origin and the mDNS record are untouched, because they are not bound to the
 * address that changed.
 *
 * The cost, stated: any browser session open on the old address loses its
 * connection and reconnects. That is a page refresh, and it happens only when
 * the address genuinely changed — an unchanged address returns without
 * touching the socket, which is the common case by a long way.
 *
 * A failed re-bind tries to put the door back where it was. If even that
 * fails the door is down and says so with `host: null`, which is a true
 * statement the panel can render — rather than a listening socket on an
 * address the caller has since been told is different. */
export async function rebindBrowserDoor(options: {
  server: Server;
  port: number;
  /** Where it is bound now, or null if it is not listening. */
  boundHost: string | null;
  /** Where it should be. Throws for `tailnet` mode with no tailnet. */
  desiredHost: () => string;
  /** The caller's own bind-with-a-readable-error helper. */
  listen: (server: Server, port: number, host: string) => Promise<void>;
}): Promise<{ host: string | null; note: string }> {
  const { server, port, boundHost, listen } = options;
  let desired: string;
  try {
    desired = options.desiredHost();
  } catch (error) {
    return { host: boundHost, note: error instanceof Error ? error.message : String(error) };
  }
  if (desired === boundHost) return { host: boundHost, note: `already bound to ${desired}` };

  if (boundHost !== null) {
    // An SSE stream never ends on its own, so close() alone would wait for a
    // phone to navigate away — which is to say, forever.
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  try {
    await listen(server, port, desired);
    return { host: desired, note: `moved from ${boundHost ?? "nowhere"} to ${desired}` };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (boundHost === null) return { host: null, note: `could not bind ${desired}: ${why}` };
    try {
      await listen(server, port, boundHost);
      return { host: boundHost, note: `could not bind ${desired} (${why}); stayed on ${boundHost}` };
    } catch {
      return { host: null, note: `could not bind ${desired} (${why}), and ${boundHost} is gone too` };
    }
  }
}

/** Where a phone should point its browser at this door.
 *
 * The bind host and the *dialable* host are not the same question and were
 * being confused. Under `tailscale serve` the door binds 127.0.0.1 and is
 * still reachable from the whole tailnet under the MagicDNS name; bound to
 * the tailnet address directly it answers on that address. So the bind
 * argument alone cannot answer "what do I type into a phone".
 *
 * The order is the door's own host allowlist, best first: the MagicDNS name,
 * because it survives Tailscale re-issuing the node's address; then the
 * address, which still works when MagicDNS is off; then whatever the socket
 * is actually bound to, which on a machine with no tailnet is loopback and
 * is a true answer that happens to be useless from a phone. Reporting the
 * true useless answer beats reporting a reachable-looking one that 403s:
 * `browser.ts` refuses any Host outside that set, so a host invented here
 * would be refused by the door it names.
 *
 * `null` means the door is not listening — the caller has an "off" to render
 * rather than a guess to make. */
export interface BrowserDoor {
  scheme: BoundIdentity["scheme"];
  host: string;
  port: number;
}

export function browserDoorLocation(
  scheme: BoundIdentity["scheme"],
  port: number,
  /** The address the socket is bound to, or null when it is not listening. */
  boundHost: string | null,
  magicDnsName: string | null,
  tailnet: string | null,
): BrowserDoor | null {
  if (!boundHost) return null;
  return { scheme, host: magicDnsName ?? tailnet ?? boundHost, port };
}
