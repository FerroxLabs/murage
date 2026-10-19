// SPDX-License-Identifier: AGPL-3.0-or-later
// The Cloud home's own sandboxed browser (the unprivileged browser user, in its own network
// namespace) renders the app's page. That namespace cannot dial the host or its loopback, so
// the page is not fetched by the browser: the browser is driven over its existing CDP relay
// and every request it makes for the canary origin is answered by this server from its own
// listener with Fetch.fulfillRequest. Anything else the page asks for is refused. No new
// launcher mode, no firewall change and no extra privilege is used.
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import WebSocket from "ws";
import { ChildDuplex, cloudRelayConnection } from "./browser-relay.ts";
import { domShowsUi, type CanarySpawner, type UiCanaryLauncher } from "./ui-canary.ts";
import { cloudHomeInternal } from "./copy.ts";

const SESSION = "guest-ui-canary";
const ORIGIN = "http://murage-canary.invalid";
const POLL_MS = 500;
export const CANARY_ORIGIN = ORIGIN;
/** The fixed source the control plane's per-source limits see: the canary alone. */
export const CANARY_SOURCE = "127.0.0.1";

/** GET only, on the canary origin, for the page, the built static files and the door state. Everything else is refused. */
export function canaryRequestAllowed(method: string, rawUrl: string): boolean {
  if (method !== "GET") return false;
  let url: URL;
  try { url = new URL(rawUrl); } catch { return false; }
  if (url.origin !== ORIGIN || url.search || url.hash || url.username || url.password) return false;
  const path = url.pathname;
  if (path.includes("%") || path.includes("..") || path.includes("//")) return false;
  return path === "/" || path === "/api/cloud/door-state" || /^\/assets\/[A-Za-z0-9._\/-]+$/.test(path) || /^\/[A-Za-z0-9._-]+\.[A-Za-z0-9]+$/.test(path);
}

export interface ProxyAnswer { status: number; contentType: string; body: Buffer; headers?: Record<string, string | string[] | undefined> }
export type ProxyGet = (path: string, userAgent: string, signal: AbortSignal) => Promise<ProxyAnswer>;

const NEVER_FORWARD = new Set([
  "set-cookie", "set-cookie2", "cookie", "authorization", "www-authenticate", "proxy-authenticate", "proxy-authorization",
  "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-connection", "content-length",
]);
/** The response's real headers for Fetch.fulfillRequest (CSP, Trusted Types, nosniff and the rest), minus credentials and hop-by-hop headers. */
export function fulfilHeaders(answer: ProxyAnswer): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const [name, value] of Object.entries(answer.headers ?? {})) {
    if (value === undefined || NEVER_FORWARD.has(name.toLowerCase())) continue;
    for (const v of Array.isArray(value) ? value : [value]) out.push({ name, value: v });
  }
  if (!out.some(h => h.name.toLowerCase() === "content-type")) out.push({ name: "content-type", value: answer.contentType });
  return out;
}

/** The same transport Caddy uses: the app's Unix proxy listener. No cookie, no authorization, a fixed forwarded source.
 * If the socket cannot be reached the check fails; it never falls back to TCP loopback (that would run as the "service" scope). */
export function proxyGetOverUnix(socketPath: string): ProxyGet {
  return (path, userAgent, signal) => new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method: "GET", signal, headers: { host: "127.0.0.1", "user-agent": userAgent, "x-forwarded-for": CANARY_SOURCE, accept: "*/*" } }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 16 * 1024 * 1024) req.destroy(new Error(cloudHomeInternal.canaryResponseTooLarge)); else chunks.push(chunk); });
      res.once("end", () => resolve({ status: res.statusCode ?? 502, contentType: String(res.headers["content-type"] ?? "application/octet-stream"), body: Buffer.concat(chunks), headers: res.headers }));
      res.once("error", reject);
    });
    req.once("error", reject); req.end();
  });
}

type Run = (args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal) => Promise<string>;
/** The canary step a browser command belongs to, for the failure line. */
export function canaryStep(args: string[]): string {
  return args.includes("open") ? "open" : args.includes("cdp-url") ? "cdp-url" : args.includes("close") ? "close" : args[0] === "relay" ? "relay" : "browser";
}
/** The launcher's fixed refusal sentences, as fixed-word reason codes. Anything else is "other": the health log never carries free text. */
const REASONS: [RegExp, string][] = [
  [/^Cloud browser session is not running$/, "session-not-running"],
  [/^Cloud browser session did not start$/, "session-did-not-start"],
  [/^Cloud browser relay could not reach its endpoint \((session|endpoint lookup|connect) (timed out|refused|failed)\)$/, "$1-$2"],
  [/^Cloud browser relay could not reach its endpoint$/, "unreachable"],
  [/^Cloud browser is busy$/, "busy"],
  [/^Cloud browser launch refused: the server restarted$/, "stale-instance"],
  [/^Cloud turn launcher refused the request$/, "launcher-refused"],
];
export function canaryReason(text: string): string {
  const line = text.trim();
  for (const [pattern, code] of REASONS) if (pattern.test(line)) return line.replace(pattern, code).replace(/ /g, "-");
  return "other";
}
/** A failed canary step: `canaryCode` is fixed words only (step-reason), safe for the one-line health log. */
export function canaryFailure(step: string, reason: string): Error & { canaryCode: string } {
  return Object.assign(new Error(`${step}: ${reason}`), { canaryCode: `${step}-${reason}` });
}
const lastLine = (text: string) => text.split("\n").map(line => line.trim()).filter(Boolean).pop() ?? "";
/** Runs one browser command through the canary's spawner. The identity is fixed by the spawner's base spawn, never by `env`.
 * A failure names the step and carries the launcher's own refusal text (fixed words), e.g.
 * "cdp-url: Cloud browser session is not running". */
const runThrough = (spawner: CanarySpawner): Run => (args, env, signal) => new Promise((resolve, reject) => {
  const step = canaryStep(args);
  let child;
  try { child = spawner.spawn(args, env); } catch (error) { return reject((error as Error)?.message === "aborted" ? error : canaryFailure(step, "spawn-refused")); }
  if (!child) return reject(canaryFailure(step, "unavailable"));
  let out = "", err = "";
  // SIGTERM, not SIGKILL: sudo relays it to the root launcher, while SIGKILL to sudo would orphan it.
  const stop = () => { try { child.kill("SIGTERM"); } catch {} };
  if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
  child.stderr.on("data", (chunk: Buffer) => { err = (err + chunk.toString()).slice(-4096); });
  child.stdout.on("data", (chunk: Buffer) => { out = (out + chunk.toString()).slice(-65536); });
  child.once("error", () => reject(canaryFailure(step, "spawn-error")));
  child.once("close", code => {
    signal.removeEventListener("abort", stop);
    if (code === 0) return resolve(out);
    const reason = canaryReason(lastLine(err));
    reject(canaryFailure(step, reason !== "other" ? reason : `exit-${typeof code === "number" ? code : "signal"}`));
  });
});

/** Renders only. It never stops the browser: the canary controller fences the spawner, drains its children and cleans up. */
export function createCloudUiLauncher(proxySocket: string, deps: { run?: Run; proxyGet?: ProxyGet } = {}): UiCanaryLauncher {
  const proxyGet = deps.proxyGet ?? proxyGetOverUnix(proxySocket);
  const launcher: UiCanaryLauncher = async ({ path, userAgent, signal, spawner }) => {
    const runCommand = deps.run ?? runThrough(spawner);
    // The browser identity is fixed by the canary's spawner; this env carries no bot id at all.
    const env: NodeJS.ProcessEnv = {
      AGENT_BROWSER_SESSION: SESSION,
      AGENT_BROWSER_ENCRYPTION_KEY: randomBytes(32).toString("hex"), AGENT_BROWSER_RESTORE_SAVE: "never",
    };
    let ws: WebSocket | undefined;
    const pending = new Map<number, { ok: (value: any) => void; bad: (error: Error) => void }>();
    const rejectAll = (reason: string) => { for (const { bad } of pending.values()) bad(new Error(reason)); pending.clear(); };
    const onAbort = () => { rejectAll("aborted"); try { ws?.terminate(); } catch {} };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal.aborted) throw new Error(cloudHomeInternal.canaryAborted);
      await runCommand(["--json", "open", "about:blank"], env, signal);
      if (signal.aborted) throw new Error(cloudHomeInternal.canaryAborted);
      const found = JSON.parse(await runCommand(["--json", "get", "cdp-url"], env, signal)) as { data?: unknown };
      const data = found.data as string | { cdpUrl?: string; cdp_url?: string; url?: string } | undefined;
      const url = typeof data === "string" ? data : data?.cdpUrl ?? data?.cdp_url ?? data?.url;
      if (typeof url !== "string") throw canaryFailure("cdp-url", "no-endpoint");
      const relayConnection = cloudRelayConnection("cdp", env, spawner.spawn);
      let relay: ChildDuplex | undefined;
      const createConnection = relayConnection ? () => { const duplex = relayConnection(); if (duplex instanceof ChildDuplex) relay = duplex; return duplex; } : undefined;
      const socket = ws = new WebSocket(url, { handshakeTimeout: 5000, ...(createConnection ? { createConnection: createConnection as never } : {}) });
      if (signal.aborted) onAbort();
      socket.on("close", () => rejectAll("disconnected"));
      // The relay's own refusal text (fixed words) says why the socket closed, e.g. "Cloud browser session is not running".
      const relayFailed = (fallback: string) => { const reason = canaryReason(relay?.stderrTail() ?? ""); return canaryFailure("relay", reason !== "other" ? reason : fallback); };
      await new Promise<void>((ok, bad) => {
        socket.once("open", ok);
        // The relay child's close (and its stderr) may land just after the socket's: read the reason on the next turn.
        socket.once("error", () => setImmediate(() => bad(relayFailed("error"))));
        socket.once("close", () => setImmediate(() => bad(relayFailed("disconnected"))));
      });
      socket.on("error", () => rejectAll("disconnected"));
      let id = 0;
      let sessionId: string | undefined;
      const send = (method: string, params: object = {}, scoped = true): Promise<any> => new Promise((ok, bad) => {
        const n = ++id; pending.set(n, { ok, bad });
        socket.send(JSON.stringify({ id: n, method, params, ...(scoped && sessionId ? { sessionId } : {}) }), error => { if (error) { pending.delete(n); bad(error); } });
      });
      socket.on("message", raw => {
        const message = JSON.parse(raw.toString());
        if (message.id !== undefined) {
          const entry = pending.get(message.id); pending.delete(message.id);
          if (entry) message.error ? entry.bad(new Error(message.error.message)) : entry.ok(message.result);
          return;
        }
        if (message.method !== "Fetch.requestPaused") return;
        const { requestId, request } = message.params as { requestId: string; request: { url: string; method: string } };
        void (async () => {
          try {
            if (!canaryRequestAllowed(request.method, request.url)) return void await send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
            const target = new URL(request.url);
            const answer = await proxyGet(target.pathname, userAgent, signal);
            await send("Fetch.fulfillRequest", { requestId, responseCode: answer.status,
              responseHeaders: fulfilHeaders(answer), body: answer.body.toString("base64") });
          } catch { await send("Fetch.failRequest", { requestId, errorReason: "Failed" }).catch(() => {}); }
        })();
      });
      const targets = await send("Target.getTargets", {}, false) as { targetInfos: { targetId: string; type: string }[] };
      const page = targets.targetInfos.find(item => item.type === "page");
      if (!page) throw canaryFailure("cdp", "no-page");
      sessionId = (await send("Target.attachToTarget", { targetId: page.targetId, flatten: true }, false)).sessionId;
      await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      await send("Page.navigate", { url: ORIGIN + path });
      let dom = "";
      while (!signal.aborted) {
        const result = await send("Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true });
        dom = String(result?.result?.value ?? "");
        if (domShowsUi(dom)) break;
        await new Promise(wait => setTimeout(wait, POLL_MS));
      }
      return dom;
    } finally {
      signal.removeEventListener("abort", onAbort);
      rejectAll("finished");
      try { ws?.terminate(); } catch {}
      // Courtesy only, never awaited and never a proof: the controller fences, drains and cleans up after this settles.
      if (!signal.aborted) void runCommand(["--session", SESSION, "close"], env, AbortSignal.timeout(5000)).catch(() => {});
    }
  };
  return launcher;
}
