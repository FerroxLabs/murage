// Murage Cloud B3 WP1: the privileged `murage-home://<homeId>/` scheme.
//
// Pure module (no Electron import) so node tests drive every rule directly.
//
//   * Non-/api paths are served from the desktop's OWN dist/ (asar). The home
//     never serves the top frame; a path that is not a plain file name inside
//     dist/ is refused (traversal, encoded separators, absolute URLs).
//   * /api and /api/* are proxied to the home origin through net.fetch with the
//     body streamed. The proxy adds Authorization: Bearer <token> and
//     Origin: <home origin>, and strips the desktop surface secret (header and
//     query parameter) plus cookies and the renderer's own authorization.
//   * Any HTML coming back from /api gets `Content-Security-Policy: sandbox`
//     and nosniff, so it can never run as an app page.
//   * SSE: protocol.handle never sees `Last-Event-ID` on an EventSource
//     reconnect (WP1 spike, 3 OSes), so main tees the stream, records the last
//     dispatched `id:` per path and injects Last-Event-ID on the next request.
//
// WP2 (cloud-home-client/store) implements CloudHomeProvider below. Nothing in
// this file pairs, refreshes or stores a credential.

/**
 * What WP2 must implement. WP1 only consumes it.
 *
 * @typedef {object} CloudHome
 * @property {string} homeId   Lowercase DNS label, /^[a-z0-9][a-z0-9-]{0,62}$/. The scheme host and partition suffix.
 * @property {string} origin   The pinned https origin of the home, e.g. "https://h-abc.murage.ai" (no path).
 * @property {() => (string | null | undefined | Promise<string | null | undefined>)} getAccessToken
 *   The current access token, or null when unpaired. Called once per proxied
 *   request; it must return from memory (refresh is the client's job).
 *
 * @typedef {(homeId: string) => (CloudHome | null | undefined)} CloudHomeProvider
 */

export const CLOUD_HOME_SCHEME = "murage-home";
export const HOME_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const CLOUD_HOME_SCHEME_PRIVILEGES = Object.freeze({
  standard: true,
  secure: true,
  supportFetchAPI: true,
  stream: true,
  corsEnabled: true,
});

export function isValidHomeId(value) {
  return typeof value === "string" && HOME_ID_PATTERN.test(value);
}

export function cloudPartition(homeId) {
  if (!isValidHomeId(homeId)) throw new Error("invalid cloud home id");
  return `persist:cloud-${homeId}`;
}

/** The only URL a cloud window's top frame starts on. */
export function cloudHomeEntryUrl(homeId, path = "/") {
  if (!isValidHomeId(homeId)) throw new Error("invalid cloud home id");
  return `${CLOUD_HOME_SCHEME}://${homeId}${path.startsWith("/") ? path : `/${path}`}`;
}

/** True for `/api` and `/api/...` (proxied, never static). Case-sensitive on the raw path. */
export function isApiPath(pathname) {
  return pathname === "/api" || pathname.startsWith("/api/");
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".map": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json",
};

export function mimeFor(rel) {
  const dot = rel.lastIndexOf(".");
  return (dot >= 0 && MIME[rel.slice(dot).toLowerCase()]) || "application/octet-stream";
}

/**
 * Map a request pathname (still percent-encoded, as in URL.pathname) to a
 * relative file path inside dist/, or null when it must be refused.
 *
 * Refused: undecodable input, NUL, backslash, a second layer of encoding (%25),
 * encoded or literal `.`/`..` segments, empty segments (`//host/x` absolute-URL
 * lookalikes), and anything under /api (that is the proxy's, and an encoded
 * `/%61pi` must not fall through to static serving).
 *
 * @returns {string | null} e.g. "index.html", "assets/app.js"
 */
export function resolveStaticPath(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return null;
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.includes("%")) return null;
  if (!decoded.startsWith("/")) return null;
  const rest = decoded.slice(1);
  if (rest === "") return "index.html";
  const segments = rest.split("/");
  if (segments[segments.length - 1] === "") segments.pop(); // one trailing slash is fine
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || segment.trim() !== segment) return null;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(segment)) return null; // scheme-looking segment
  }
  if (segments[0].toLowerCase() === "api") return null;
  return segments.join("/");
}

const STRIPPED_REQUEST_HEADERS = ["host", "origin", "referer", "cookie", "authorization", "proxy-authorization", "x-murage-surface-secret", "connection", "keep-alive", "upgrade"];
const STRIPPED_QUERY_PARAMS = ["surfaceSecret", "surface_secret", "x-murage-surface-secret"];

/**
 * Build the upstream request for a renderer request on /api/*. Pure.
 *
 * @param {{ url: string, method: string, headers: Headers, body?: any }} req renderer request
 * @param {{ origin: string, token?: string | null, lastEventId?: string | null, body?: Uint8Array | null }} opts  `body`: already-buffered request bytes (replayable); omitted means stream req.body
 * @returns {{ url: string, init: object } | null} null when the path is not a clean /api path
 */
export function buildProxyRequest(req, { origin, token, lastEventId, body }) {
  const incoming = new URL(req.url);
  if (!isApiPath(incoming.pathname)) return null;
  let decoded;
  try { decoded = decodeURIComponent(incoming.pathname); } catch { return null; }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.split("/").some((s) => s === ".." || s === ".")) return null;
  if (/%2e|%2f|%5c/i.test(incoming.pathname)) return null;
  const target = new URL(incoming.pathname, origin);
  if (target.origin !== new URL(origin).origin) return null;
  for (const [key, value] of incoming.searchParams) {
    if (!STRIPPED_QUERY_PARAMS.some((p) => p.toLowerCase() === key.toLowerCase())) target.searchParams.append(key, value);
  }
  const headers = new Headers(req.headers);
  for (const name of STRIPPED_REQUEST_HEADERS) headers.delete(name);
  for (const name of [...headers.keys()]) if (name.toLowerCase().replace(/[-_]/g, "").includes("surfacesecret")) headers.delete(name);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  headers.set("Origin", new URL(origin).origin);
  if (lastEventId && !headers.has("last-event-id")) headers.set("Last-Event-ID", lastEventId);
  const init = { method: req.method, headers, redirect: "manual" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (body !== undefined && body !== null) init.body = body; // buffered bytes: replayable for the single auth retry
    else if (req.body) { init.body = req.body; init.duplex = "half"; }
  }
  return { url: target.toString(), init };
}

/** Headers for the renderer: HTML from the home is sandboxed, bodies are already decoded by net.fetch. */
export function sanitizeResponseHeaders(upstream) {
  const out = new Headers(upstream);
  out.delete("set-cookie");
  out.delete("content-encoding");
  out.delete("content-length");
  const type = (out.get("content-type") || "").toLowerCase();
  if (type.includes("html") || type.includes("xml")) {
    out.set("Content-Security-Policy", "sandbox");
    out.set("X-Content-Type-Options", "nosniff");
  }
  return out;
}

/**
 * Tracks the last dispatched SSE `id:` per key, per the EventSource rule: an id
 * counts once its event is dispatched (blank line). Lines may split across chunks.
 */
export function createLastEventIdTracker({ maxKeys = 64 } = {}) {
  const ids = new Map();
  const set = (key, id) => {
    if (id === "") { ids.delete(key); return; }
    ids.delete(key);
    ids.set(key, id);
    while (ids.size > maxKeys) ids.delete(ids.keys().next().value);
  };
  return {
    get: (key) => ids.get(key) ?? null,
    clear: () => ids.clear(),
    /** Wrap an SSE body so passing chunks through updates the recorded id. */
    tee(key, body) {
      const decoder = new TextDecoder();
      let carry = "";
      let pending;
      const feed = (text) => {
        carry += text;
        let nl;
        while ((nl = carry.search(/\r\n|\n|\r/)) >= 0) {
          const line = carry.slice(0, nl);
          const eol = carry.startsWith("\r\n", nl) ? 2 : 1;
          if (nl + eol === carry.length && carry[nl] === "\r") break; // maybe half of a CRLF
          carry = carry.slice(nl + eol);
          if (line === "") { if (pending !== undefined) { set(key, pending); pending = undefined; } continue; }
          if (line.startsWith("id:")) { const v = line.slice(3).replace(/^ /, ""); if (!v.includes("\0")) pending = v; }
        }
        if (carry.length > 65536) carry = "";
      };
      return body.pipeThrough(new TransformStream({
        transform(chunk, controller) { feed(decoder.decode(chunk, { stream: true })); controller.enqueue(chunk); },
        flush() { feed(decoder.decode()); },
      }));
    },
  };
}

/** The home's 403 `error` strings that mean "this access token is not a valid session" (same set as cloud-home-client.mjs). */
export const SESSION_INVALID_ERRORS = Object.freeze(["Open this on a device you've paired with your Cloud.", "Sign in required"]);
export const STEP_UP_REQUIRED_ERROR = "step-up required";
/** Largest request body the proxy buffers (needed to replay it once after a refresh). Bigger gets 413. */
export const MAX_BUFFERED_BODY_BYTES = 32 * 1024 * 1024;

async function readBounded(body, limit) {
  if (!body) return new Uint8Array(0);
  const chunks = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { void reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}

/** The home's JSON `error` string from a cloned 403, or null. Bounded; never throws. */
async function errorOf(response) {
  try {
    if (!(response.headers.get("content-type") || "").toLowerCase().includes("json")) return null;
    const bytes = await readBounded(response.clone().body, 64 * 1024);
    const parsed = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
    return typeof parsed?.error === "string" ? parsed.error : null;
  } catch { return null; }
}

function text(status, message) {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
}

/**
 * The protocol handler for one cloud home window/partition.
 *
 * @param {object} deps
 * @param {string} deps.homeId
 * @param {() => (CloudHome | null | undefined)} deps.home   current pinned home (re-read per request)
 * @param {(input: string, init?: object) => Promise<Response>} deps.netFetch  electron `net.fetch`
 * @param {(rel: string) => Promise<Buffer | Uint8Array | null>} deps.readAsset  dist/ file reader, null when absent
 * @param {(homeId: string) => Promise<boolean>} [deps.onAuthFailure]  client.onAuthFailure: refresh once; true means retry once
 * @param {(homeId: string, req: { method: string, path: string, headers: Record<string, string>, body: Uint8Array | null }) => Promise<Response>} [deps.onStepUp]
 *   client.stepUpRetry shape: confirm + sign + ONE retry; throws on a "no". Without it a step-up 403 goes to the renderer as the home sent it.
 * @param {(message: string) => void} [deps.warn]
 * @returns {(req: Request) => Promise<Response>}
 *
 * Auth handling on /api: a 401, or a 403 whose error is in SESSION_INVALID_ERRORS, calls onAuthFailure(homeId) and,
 * when it returns true, retries ONCE with the refreshed token and the same buffered body. A 403 "step-up required" on a
 * write calls onStepUp (WP4): a native confirm that names the action, a signature over the bytes main already holds, one
 * retry. Deny, or no onStepUp, and the renderer gets the home's original 403. Step-up is never bypassed.
 */
export function createCloudHomeHandler({ homeId, home, netFetch, readAsset, onAuthFailure, onStepUp, warn = () => {} }) {
  const tracker = createLastEventIdTracker();
  const handler = async (req) => {
    let url;
    try { url = new URL(req.url); } catch { return text(400, "bad url"); }
    if (url.protocol !== `${CLOUD_HOME_SCHEME}:` || url.hostname !== homeId) return text(404, "not found");
    if (url.username || url.password) return text(400, "bad url");

    if (isApiPath(url.pathname)) {
      const current = home();
      if (!current || current.homeId !== homeId) return text(503, "cloud home not available");
      const readToken = async (c) => { try { return (await c.getAccessToken()) ?? null; } catch { return null; } };
      const key = url.pathname + url.search;
      let body;
      if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
        body = await readBounded(req.body, MAX_BUFFERED_BODY_BYTES);
        if (body === null) return text(413, "request body too large");
      }
      const send = async (c) => {
        const built = buildProxyRequest(req, { origin: c.origin, token: await readToken(c), lastEventId: tracker.get(key), body });
        if (!built) return text(400, "bad path");
        try { return await netFetch(built.url, built.init); } catch (error) {
          warn(`proxy fetch failed: ${error?.message ?? error}`);
          return text(502, "cloud home unreachable");
        }
      };
      let upstream = await send(current);
      const authFailed = async (r) => r.status === 401 || (r.status === 403 && SESSION_INVALID_ERRORS.includes(await errorOf(r)));
      if (typeof onAuthFailure === "function" && await authFailed(upstream)) {
        let refreshed = false;
        try { refreshed = (await onAuthFailure(homeId)) === true; } catch { refreshed = false; }
        const again = refreshed ? home() : null;
        if (again && again.homeId === homeId) {
          void upstream.body?.cancel().catch(() => {});
          upstream = await send(again); // the one retry; whatever comes back is returned
        }
      }
      if (upstream.status === 403 && req.method !== "GET" && req.method !== "HEAD" && typeof onStepUp === "function" && await errorOf(upstream) === STEP_UP_REQUIRED_ERROR) {
        // Main-driven step-up (WP4). The renderer never sees a challenge and never chooses what is signed: main holds the
        // buffered bytes, shows a native confirm that names the action, signs stepPurpose over THOSE bytes and retries ONCE.
        // A "no" (or any failure) returns the home's own 403 untouched; nothing is sent and nothing is queued.
        const built = buildProxyRequest(req, { origin: current.origin, token: null, body });
        let stepped = null;
        if (built) {
          const target = new URL(built.url);
          const headers = Object.fromEntries(built.init.headers);
          for (const name of ["authorization", "origin", "last-event-id", "x-murage-step-up"]) delete headers[name];
          try { stepped = await onStepUp(homeId, { method: req.method, path: target.pathname + target.search, headers, body: body ?? null }); }
          catch (error) {
            warn(`step-up not completed: ${error?.code ?? "error"}`);
            if (error?.code === "unreachable") { void upstream.body?.cancel().catch(() => {}); return text(502, "cloud home unreachable"); }
          }
        }
        if (stepped) { void upstream.body?.cancel().catch(() => {}); upstream = stepped; }
      }
      if (upstream.status >= 300 && upstream.status < 400) return text(502, "redirect refused");
      const headers = sanitizeResponseHeaders(upstream.headers);
      let stream = upstream.body;
      if (stream && (headers.get("content-type") || "").toLowerCase().includes("text/event-stream")) stream = tracker.tee(key, stream);
      return new Response(req.method === "HEAD" ? null : stream, { status: upstream.status, statusText: upstream.statusText, headers });
    }

    if (req.method !== "GET" && req.method !== "HEAD") return text(405, "method not allowed");
    const rel = resolveStaticPath(url.pathname);
    if (!rel) return text(400, "bad path");
    let data = await readAsset(rel);
    let served = rel;
    if (!data && !/\.[A-Za-z0-9]+$/.test(rel)) { data = await readAsset("index.html"); served = "index.html"; } // client-side routes
    if (!data) return text(404, "not found");
    return new Response(req.method === "HEAD" ? null : data, {
      headers: { "content-type": mimeFor(served), "x-content-type-options": "nosniff", "cache-control": "no-store" },
    });
  };
  handler.tracker = tracker;
  return handler;
}
