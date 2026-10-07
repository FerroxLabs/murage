// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// An HTTP client for servers the owner pointed Murage at by link (spec
// MCP-LINK 3.9). `fetch` plus a pre-check leaves a gap: the check resolves the
// name, then fetch resolves it again and may connect somewhere else (DNS
// rebinding). This client closes the gap:
//
//   1. resolve the hostname ONCE (a literal address needs no DNS);
//   2. judge every address in the answer with shared/remote-mcp-url.mjs;
//   3. connect only to an address from that answer, through a custom `lookup`
//      that can return nothing else;
//   4. when the socket connects, check its remote address is one that was
//      judged, and send no byte of the request until it is.
//
// The policy check runs again on every call, so a name that changes class
// between calls gets no request. Redirects follow the per-kind rules in the
// policy module, and every hop goes through all four steps again. TLS uses the
// system trust store: there is no option to turn verification off.
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

import { LIMITS, decideRedirect, evaluateUrlPolicy, hopMode, parseServerUrl, redirectPolicyFor } from "./remote-mcp-url.mjs";

export class GuardedHttpError extends Error {
  /**
   * @param {string} code
   * @param {{ needs?: string, cause?: unknown }} [extra]
   */
  constructor(code, extra = {}) {
    super(code);
    this.name = "GuardedHttpError";
    this.code = code;
    if (extra.needs) this.needs = extra.needs;
    if (extra.cause) this.cause = extra.cause;
  }
}

const KIND_MAX_BYTES = {
  mcp: LIMITS.mcpResponseBytes,
  sse: LIMITS.mcpResponseBytes,
  metadata: LIMITS.metadataBytes,
  register: LIMITS.registerBytes,
  token: LIMITS.tokenBytes,
};
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const CONNECT_FAILURES = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"]);
/** The only caller headers a redirect hop keeps (review F1). A redirect is an
 * unjudged instruction from the server, so nothing the owner stored (API keys
 * under any name, bearer tokens, cookies) follows it, same origin or not. */
const HOP_ALLOWED = new Set(["accept", "user-agent", "mcp-protocol-version", "accept-language"]);

/** Request headers the client sets itself or that change how Node frames the
 * request. Dropped from caller headers (review L5). */
const DROPPED_HEADERS = new Set([
  "host", "content-length", "transfer-encoding", "connection", "expect", "upgrade", "te", "trailer",
  "keep-alive", "proxy-authorization", "proxy-connection",
]);
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * The test-only seams. They ride on a symbol key, never on a string option, so
 * a caller that spreads a config or JSON object into `guardedRequest` cannot
 * reach them (review L2). Only shared/guarded-http.testing.mjs sets this.
 */
export const SEAMS = Symbol("guarded-http.seams");

/** Refuse a header a caller should never have been able to send (review L6).
 * Returns the cleaned headers; throws GuardedHttpError("invalid-header"). */
export function validateRequestHeaders(headers) {
  const clean = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!HEADER_TOKEN.test(name)) throw new GuardedHttpError("invalid-header");
    if (typeof value !== "string" || /[^\t\x20-\x7e\x80-\xff]/.test(value)) throw new GuardedHttpError("invalid-header");
    if (DROPPED_HEADERS.has(name.toLowerCase())) continue;
    clean[name] = value;
  }
  return clean;
}

const systemResolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

function normalizeAddress(address) {
  return String(address).toLowerCase().replace(/^::ffff:/, "");
}

function withTimeout(promise, ms, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new GuardedHttpError(code)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @typedef {object} GuardedRequestOptions
 * @property {string} url
 * @property {string} [method]
 * @property {Record<string, string>} [headers]
 * @property {string | Uint8Array} [body]
 * @property {"mcp" | "sse" | "metadata" | "token" | "register"} [kind]  request kind; sets redirect rules and the default size cap
 * @property {"inspect" | "request"} [mode]  "inspect" asks for a confirmation on a local address; "request" (default) refuses a change of class
 * @property {"this-computer" | "local-network" | null} [confirmed]  what the stored entry confirmed
 * @property {number} [maxBytes]
 * @property {number} [dnsMs]
 * @property {number} [connectMs]
 * @property {number} [totalMs]
 * @property {AbortSignal} [signal]
 * @property {"buffer" | "stream"} [responseMode]
 * @property {(hostname: string) => Promise<ReadonlyArray<{ address: string, family?: number }>>} [resolver]  injected in tests
 */

/**
 * @param {GuardedRequestOptions} options
 * @returns {Promise<{ status: number, headers: Record<string, string | string[] | undefined>, body: Buffer, remoteAddress: string, url: string, hops: number } | { status: number, headers: Record<string, string | string[] | undefined>, stream: import("node:stream").Readable, remoteAddress: string, url: string, hops: number, close(): void }>}
 */
export async function guardedRequest(options) {
  const kind = options.kind ?? "mcp";
  options = { ...options, headers: validateRequestHeaders(options.headers) };
  const deadline = Date.now() + (options.totalMs ?? LIMITS.probeTotalMs);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (options.signal?.aborted) throw new GuardedHttpError("aborted");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let streaming = false;
  try {
    const result = await hop(options, options.url, options.method ?? "GET", options.headers ?? {}, options.body, 0, deadline, controller, kind);
    streaming = "stream" in result;
    return result;
  } finally {
    // A stream outlives this call: the caller's abort must still reach it.
    if (!streaming) options.signal?.removeEventListener("abort", onAbort);
  }
}

async function hop(options, url, method, headers, body, hops, deadline, controller, kind) {
  if (controller.signal.aborted) throw new GuardedHttpError("aborted");
  const parsed = parseServerUrl(url);
  if (!parsed.ok) throw new GuardedHttpError(parsed.code);
  const isLiteral = parsed.hostname.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.hostname);

  // 0. A name that is refused by its spelling never reaches DNS.
  const spelling = evaluateUrlPolicy({ url, mode: hopMode(options.mode ?? "request", hops), confirmed: options.confirmed ?? null });
  if (!spelling.ok && spelling.code === "refused-address") throw new GuardedHttpError("refused-address");

  // 1. resolve once
  let resolved;
  if (isLiteral) {
    resolved = [{ address: parsed.hostname, family: parsed.hostname.includes(":") ? 6 : 4 }];
  } else {
    const resolver = options.resolver ?? systemResolver;
    const dnsMs = Math.min(options.dnsMs ?? LIMITS.dnsMs, Math.max(1, deadline - Date.now()));
    try {
      resolved = await withTimeout(Promise.resolve().then(() => resolver(parsed.hostname)), dnsMs, "dns-timeout");
    } catch (error) {
      if (error instanceof GuardedHttpError) throw error;
      throw new GuardedHttpError("not-found", { cause: error });
    }
  }

  // 2. judge every address
  const verdict = evaluateUrlPolicy({
    url,
    mode: hopMode(options.mode ?? "request", hops),
    confirmed: options.confirmed ?? null,
    resolved: isLiteral ? undefined : resolved,
  });
  if (!verdict.ok) throw new GuardedHttpError(verdict.code, verdict.code === "local-confirm" ? { needs: verdict.needs } : {});

  // 3 and 4. connect only to a judged address, verify, then send
  const allowed = resolved.map((entry) => ({ address: String(entry.address).replace(/^\[(.*)\]$/, "$1"), family: entry.family ?? (String(entry.address).includes(":") ? 6 : 4) }));
  let response;
  let lastError;
  for (const target of allowed) {
    try {
      response = await send(options, parsed, url, method, headers, body, target, allowed, deadline, controller, kind);
      break;
    } catch (error) {
      lastError = error;
      // Only a refused or unreachable connection moves on to the next judged
      // address; nothing was sent to the one that failed.
      if (!(error instanceof GuardedHttpError) || error.code !== "unreachable" || !CONNECT_FAILURES.has(error.detail ?? "")) throw error;
    }
  }
  if (!response) throw lastError ?? new GuardedHttpError("unreachable");
  response.hops = hops;
  return afterResponse(options, response, url, headers, hops, deadline, controller, kind);
}

async function afterResponse(options, response, url, headers, hops, deadline, controller, kind) {
  if (!REDIRECT_STATUS.has(response.status)) return response;
  const location = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location;
  const decision = decideRedirect({ kind, hopsSoFar: hops, from: url, location: location ?? "", allowPlainHttp: (options.confirmed ?? null) !== null });
  // A kind that never follows hands the 3xx back so the caller can say "moved".
  if (!decision.follow && decision.code === "redirect-not-allowed") return response;
  response.discard();
  if (!decision.follow) throw new GuardedHttpError(decision.code);
  const carried = Object.fromEntries(Object.entries(headers).filter(([name]) => HOP_ALLOWED.has(name.toLowerCase())));
  return hop(options, decision.url, "GET", carried, undefined, hops + 1, deadline, controller, kind);
}

function send(options, parsed, url, method, headers, body, target, allowed, deadline, controller, kind) {
  return new Promise((resolve, reject) => {
    const validated = new Set(allowed.map((entry) => normalizeAddress(entry.address)));
    const responseMode = options.responseMode ?? "buffer";
    const maxBytes = options.maxBytes ?? KIND_MAX_BYTES[kind];
    const connectMs = options.connectMs ?? LIMITS.connectMs;
    const seams = options[SEAMS] ?? {};
    const transport = (seams.transportFor ?? ((scheme) => (scheme === "https" ? https : http)))(parsed.scheme);
    let settled = false;
    let req;
    const timers = [];
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      fn(value);
    };
    // Settle with the error FIRST: destroying the request makes the response
    // emit "aborted", and that must not win the race and rename the failure.
    const fail = (code, detail) => {
      const error = new GuardedHttpError(code);
      if (detail) error.detail = detail;
      finish(reject, error);
      req?.destroy();
    };
    const onAbort = () => fail("aborted");
    controller.signal.addEventListener("abort", onAbort, { once: true });

    const total = setTimeout(() => fail("timeout"), Math.max(1, deadline - Date.now()));
    total.unref?.();
    timers.push(total);

    // The one place an address is chosen. It can only return `target`, which
    // came from the judged answer; `tamperAddress` exists so a test can prove
    // the socket check below catches a lookup that lies.
    const lookup = (_hostname, lookupOptions, callback) => {
      const address = seams.tamperAddress ? seams.tamperAddress(target.address) : target.address;
      if (lookupOptions && lookupOptions.all) callback(null, [{ address, family: target.family }]);
      else callback(null, address, target.family);
    };

    const outgoing = { ...headers };
    for (const name of Object.keys(outgoing)) {
      if (DROPPED_HEADERS.has(name.toLowerCase())) delete outgoing[name];
    }
    const payload = body === undefined ? undefined : Buffer.from(body);
    if (payload) outgoing["content-length"] = String(payload.length);

    try {
      req = transport.request({
        protocol: `${parsed.scheme}:`,
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${new URL(url).pathname}${new URL(url).search}`,
        method,
        headers: outgoing,
        lookup,
        agent: false,
        autoSelectFamily: false,
      });
    } catch {
      // Node refuses a malformed request synchronously. Nothing was sent; clean up.
      fail("invalid-header");
      return;
    }

    req.on("socket", (socket) => {
      const verify = () => {
        const remote = normalizeAddress(socket.remoteAddress ?? "");
        if (!validated.has(remote)) {
          socket.destroy();
          fail("address-mismatch");
          return;
        }
        // Only now does the request go out.
        req.end(payload);
      };
      if (socket.connecting) {
        const connectTimer = setTimeout(() => fail("unreachable", "ETIMEDOUT"), connectMs);
        connectTimer.unref?.();
        timers.push(connectTimer);
        socket.once("connect", () => {
          clearTimeout(connectTimer);
          verify();
        });
      } else {
        verify();
      }
    });

    req.on("error", (error) => {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH") return fail("unreachable", code);
      if (code === "ENOTFOUND" || code === "EAI_AGAIN") return fail("not-found");
      if (/CERT|TLS|SSL|ERR_TLS|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code) || /certificate|tls|ssl/i.test(String(error?.message))) return fail("unreachable", "TLS");
      return fail("unreachable", code || "ERR");
    });

    req.on("response", (res) => {
      const remote = normalizeAddress(res.socket?.remoteAddress ?? "");
      if (!validated.has(remote)) return fail("address-mismatch");
      const declared = Number(res.headers["content-length"]);
      const status = res.statusCode ?? 0;
      const base = {
        status,
        headers: res.headers,
        remoteAddress: remote,
        url,
        hops: 0,
        discard: () => res.destroy(),
      };
      if (responseMode === "stream") {
        // Headers are in: the total timer has done its job.
        clearTimeout(total);
        let seen = 0;
        let capExceeded = false;
        let closedByCaller = false;
        // Pull-based: nothing is read from the socket until the caller reads,
        // so a cap error reaches a consumer that is already listening.
        const capped = new Readable({ read() { res.resume(); } });
        res.on("data", (chunk) => {
          seen += chunk.length;
          if (seen > maxBytes) {
            capExceeded = true;
            capped.destroy(new GuardedHttpError("body-too-large"));
            res.destroy();
            return;
          }
          if (!capped.push(chunk)) res.pause();
        });
        res.pause();
        res.on("end", () => capped.push(null));
        res.on("error", (error) => capped.destroy(error));
        res.on("aborted", () => {
          if (!capExceeded && !closedByCaller && !capped.destroyed) capped.destroy(new GuardedHttpError("unreachable"));
        });
        capped.on("close", () => res.destroy());
        // A consumer that stopped reading (or closed on purpose) has no error
        // listener left; an error here must not become an uncaught exception.
        capped.on("error", () => undefined);
        // The caller's abort stays wired for the life of the stream (finish()
        // has already removed the one for the request phase): an aborted probe
        // or call must end a stream that is still busy.
        const onStreamAbort = () => {
          closedByCaller = true;
          capped.destroy(new GuardedHttpError("aborted"));
          res.destroy();
        };
        if (controller.signal.aborted) onStreamAbort();
        else {
          controller.signal.addEventListener("abort", onStreamAbort, { once: true });
          capped.once("close", () => controller.signal.removeEventListener("abort", onStreamAbort));
        }
        finish(resolve, { ...base, stream: capped, close: () => { closedByCaller = true; res.destroy(); capped.destroy(); } });
        return;
      }
      if (Number.isFinite(declared) && declared > maxBytes) return fail("body-too-large");
      const chunks = [];
      let seen = 0;
      res.on("data", (chunk) => {
        seen += chunk.length;
        if (seen > maxBytes) {
          fail("body-too-large");
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => finish(resolve, { ...base, body: Buffer.concat(chunks) }));
      res.on("error", () => fail("unreachable", "ERR"));
      res.on("aborted", () => fail("unreachable", "ERR"));
    });
  });
}

export { redirectPolicyFor };
