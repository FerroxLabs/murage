// Box relay: a cloud home's turns never hold the account-wide box key and
// never contact ascii.dev. The computer proxy (computer-proxy.ts) is pointed
// at /api/internal/box/v1 on this server with the turn's own control token;
// this module checks the token, checks the box is the one this bot is bound
// to, forwards ONLY the calls the proxy actually makes, and adds the real
// Authorization here, server-side.
//
// Allowlist (everything else is a bare 404; <id> is the bot's own box):
//   POST /boxes/<id>/resume                                  wake an archived box
//   GET  /boxes/<id>                                         state poll after resume
//   POST /boxes/<id>/commands          body {"command": str} run a shell command
//   GET  /boxes/<id>/artifacts?path=/tmp/muragebox-shot.jpg  raw screenshot bytes
//   GET  /boxes/<id>/files?path=/tmp/muragebox-shot.jpg&encoding=base64
// No creation, deletion, listing, account or billing endpoint is reachable.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { InternalCapability } from "./internal-capabilities.ts";

export const BOX_RELAY_PREFIX = "/api/internal/box/v1";
/** The one file the proxy ever reads back over HTTP (computer-proxy.ts SHOT_PATH). */
export const BOX_RELAY_FRAME_PATH = "/tmp/muragebox-shot.jpg";
/** Request body cap: a command carries a base64 script (box-exec.ts), well under this. */
export const BOX_RELAY_MAX_REQUEST_BYTES = 1_048_576;
/** Response caps: JSON replies hold stdout tails and one inline frame (<=400 KB raw, ~540 KB base64). */
export const BOX_RELAY_MAX_JSON_BYTES = 4 * 1_048_576;
/** Raw screenshot bytes and their base64 envelope. */
export const BOX_RELAY_MAX_FRAME_BYTES = 16 * 1_048_576;

const BOX_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_REDIRECTS = 2;

type Route = {
  method: "GET" | "POST";
  /** Path after /boxes/<id> ("" for the box itself). */
  tail: string;
  timeoutMs: number;
  maxResponseBytes: number;
  /** Exact query strings accepted, as sorted key=value pairs; empty = no query. */
  queries: readonly string[];
  hasBody: boolean;
};
export const BOX_RELAY_ALLOWLIST: readonly Route[] = [
  { method: "POST", tail: "/resume", timeoutMs: 15_000, maxResponseBytes: BOX_RELAY_MAX_JSON_BYTES, queries: [""], hasBody: false },
  { method: "GET", tail: "", timeoutMs: 15_000, maxResponseBytes: BOX_RELAY_MAX_JSON_BYTES, queries: [""], hasBody: false },
  { method: "POST", tail: "/commands", timeoutMs: 10 * 60_000, maxResponseBytes: BOX_RELAY_MAX_JSON_BYTES, queries: [""], hasBody: true },
  { method: "GET", tail: "/artifacts", timeoutMs: 60_000, maxResponseBytes: BOX_RELAY_MAX_FRAME_BYTES,
    queries: [`path=${encodeURIComponent(BOX_RELAY_FRAME_PATH)}`], hasBody: false },
  { method: "GET", tail: "/files", timeoutMs: 60_000, maxResponseBytes: BOX_RELAY_MAX_FRAME_BYTES,
    queries: [`encoding=base64&path=${encodeURIComponent(BOX_RELAY_FRAME_PATH)}`], hasBody: false },
];

export type BoxRelayDeps = {
  /** InternalCapabilities.resolve: constant-time token compare. */
  resolveClaim: (authorization: string | string[] | undefined) => InternalCapability | null;
  isActive: (claim: InternalCapability) => boolean;
  /** The box this bot is bound to on this server right now, if any. */
  boundBoxId: (botId: string) => string | null | undefined;
  /** The account key. Read per call; never stored here, never logged. */
  accountToken: () => string | undefined;
  /** Whether this home allows hosted computers at all (opt-in, default off). */
  enabled: () => boolean;
  upstreamBase: string;
  fetch?: typeof fetch;
  /** One short line per refusal: bot id and reason only. */
  log?: (line: string) => void;
};
export type BoxRelayInput = {
  method: string;
  /** Request path with the BOX_RELAY_PREFIX still on, and its query string. */
  pathname: string;
  search: string;
  authorization: string | string[] | undefined;
  /** Parses the JSON body, refusing past the cap (index.ts readBody). */
  readJson: (maxBytes: number) => Promise<unknown>;
  signal?: AbortSignal;
};
export type BoxRelayResult = { status: number; contentType: string; body: Buffer };

const reply = (status: number, error: string): BoxRelayResult =>
  ({ status, contentType: "application/json", body: Buffer.from(JSON.stringify({ error })) });
const NOT_FOUND = () => reply(404, "not found");

function matchRoute(method: string, pathname: string, search: string): { boxId: string; route: Route } | null {
  if (!pathname.startsWith(`${BOX_RELAY_PREFIX}/boxes/`)) return null;
  const parts = pathname.slice(BOX_RELAY_PREFIX.length + "/boxes/".length).split("/");
  const boxId = parts[0] ?? "";
  if (!BOX_ID.test(boxId)) return null;
  const tail = parts.length === 1 ? "" : `/${parts.slice(1).join("/")}`;
  const params = new URLSearchParams(search);
  const normalized = [...params.entries()].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).sort().join("&");
  const route = BOX_RELAY_ALLOWLIST.find((r) => r.method === method && r.tail === tail && r.queries.includes(normalized));
  return route ? { boxId, route } : null;
}

async function readCapped(response: Response, cap: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) { await response.body?.cancel().catch(() => {}); return null; }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** The provider's own host: the upstream host or a subdomain of it. */
function isProviderHost(candidate: URL, upstream: URL): boolean {
  if (candidate.protocol !== "https:" && candidate.protocol !== upstream.protocol) return false;
  const host = candidate.hostname.toLowerCase();
  const base = upstream.hostname.toLowerCase();
  return host === base || host.endsWith(`.${base}`);
}

export async function relayBoxCall(input: BoxRelayInput, deps: BoxRelayDeps): Promise<BoxRelayResult> {
  const claim = deps.resolveClaim(input.authorization);
  if (!claim || !deps.isActive(claim)) return reply(401, "unauthorized");
  const refuse = (reason: string): BoxRelayResult => {
    deps.log?.(`box relay refused bot=${claim.botId} reason=${reason}`);
    return NOT_FOUND();
  };
  if (claim.kind !== "computer") return refuse("capability");
  if (!deps.enabled()) return refuse("boxes-off");
  const matched = matchRoute(input.method, input.pathname, input.search);
  if (!matched) return refuse("shape");
  const bound = deps.boundBoxId(claim.botId);
  if (!bound || bound !== matched.boxId) return refuse("other-box");
  const key = deps.accountToken();
  if (!key) return refuse("no-key");

  const { route } = matched;
  let body: string | undefined;
  if (route.hasBody) {
    let parsed: unknown;
    try { parsed = await input.readJson(BOX_RELAY_MAX_REQUEST_BYTES); }
    catch (error) {
      const status = (error as { status?: number }).status;
      deps.log?.(`box relay refused bot=${claim.botId} reason=${status === 413 ? "body-too-large" : "body"}`);
      return reply(status === 413 ? 413 : 400, status === 413 ? "body too large" : "invalid body");
    }
    const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed) : [];
    const command = (parsed as { command?: unknown } | null)?.command;
    if (keys.length !== 1 || typeof command !== "string" || !command) return refuse("body-shape");
    body = JSON.stringify({ command });
    if (Buffer.byteLength(body) > BOX_RELAY_MAX_REQUEST_BYTES) return reply(413, "body too large");
  }

  const doFetch = deps.fetch ?? fetch;
  const upstream = new URL(`${deps.upstreamBase.replace(/\/+$/, "")}/boxes/${matched.boxId}${route.tail}`);
  if (input.search) upstream.search = input.search;
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(route.timeoutMs)])
    : AbortSignal.timeout(route.timeoutMs);
  try {
    let target = upstream;
    for (let hop = 0; ; hop++) {
      const sameOrigin = target.origin === upstream.origin;
      const response = await doFetch(target, {
        method: route.method,
        // Only this: the caller's headers (Authorization, cookies, hop-by-hop) are never forwarded.
        headers: {
          ...(sameOrigin ? { authorization: `Bearer ${key}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body } : {}),
        redirect: "manual",
        signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        // A GET (artifact bytes) may be handed to a download URL. Follow it only
        // while it stays on the provider's host; a pre-signed URL on another host
        // cannot be validated, so it is refused rather than fetched.
        const location = response.headers.get("location");
        let next: URL | null = null;
        try { next = location ? new URL(location, target) : null; } catch { next = null; }
        if (route.method !== "GET" || !next || hop >= MAX_REDIRECTS || !isProviderHost(next, upstream)) {
          deps.log?.(`box relay refused bot=${claim.botId} reason=redirect`);
          return reply(502, "upstream redirect refused");
        }
        target = next;
        continue;
      }
      const bytes = await readCapped(response, route.maxResponseBytes);
      if (!bytes) {
        deps.log?.(`box relay refused bot=${claim.botId} reason=response-too-large`);
        return reply(502, "upstream response too large");
      }
      return {
        status: response.status,
        contentType: (response.headers.get("content-type") ?? "application/octet-stream").slice(0, 100),
        body: bytes,
      };
    }
  } catch {
    deps.log?.(`box relay refused bot=${claim.botId} reason=upstream`);
    return reply(502, "upstream unavailable");
  }
}

/** Writes a relay result to a Node response. */
export function sendBoxRelayResult(res: ServerResponse, result: BoxRelayResult): void {
  res.writeHead(result.status, {
    "content-type": result.contentType,
    "content-length": String(result.body.length),
    "cache-control": "no-store",
  });
  res.end(result.body);
}

export async function serveBoxRelay(
  req: IncomingMessage, res: ServerResponse, url: URL,
  deps: BoxRelayDeps, readJson: (maxBytes: number) => Promise<unknown>,
): Promise<void> {
  const abort = new AbortController();
  const gone = () => { if (!res.writableEnded) abort.abort(); };
  res.once("close", gone);
  try {
    sendBoxRelayResult(res, await relayBoxCall({
      method: req.method ?? "GET", pathname: url.pathname, search: url.search.replace(/^\?/, ""),
      authorization: req.headers.authorization, readJson, signal: abort.signal,
    }, deps));
  } finally {
    res.off("close", gone);
  }
}

// ---- cloud home policy -------------------------------------------------

export function isCloudHome(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MURAGE_CLOUD_ROLE === "home";
}

/** Opt-in: hosted computers on a cloud home are off unless the owner turns
 * them on (config features.cloudBoxComputers). Desktop is not affected. */
export function cloudBoxComputersAllowed(cfg: { features?: { cloudBoxComputers?: boolean } }): boolean {
  return cfg.features?.cloudBoxComputers === true;
}

/** Env for the turn's computer proxy on a cloud home: the relay base and the
 * per-turn control token, never the account key. */
export function cloudBoxRelayEnv(control: { url: string; token: string } | undefined): { MURAGEBOX_BOX_API: string; MURAGEBOX_BOX_TOKEN: string } {
  let origin = "";
  try { if (control) origin = new URL(control.url).origin; } catch { origin = ""; }
  return origin && control
    ? { MURAGEBOX_BOX_API: `${origin}${BOX_RELAY_PREFIX}`, MURAGEBOX_BOX_TOKEN: control.token }
    : { MURAGEBOX_BOX_API: "", MURAGEBOX_BOX_TOKEN: "" };
}
