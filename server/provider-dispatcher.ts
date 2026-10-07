// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The dispatcher for requests to model and image providers. Node's fetch
// otherwise ends a response whose headers or next bytes take longer than
// 300 seconds (undici's headersTimeout and bodyTimeout): a fixed silence cut
// under the owner's setting. A local model reading a long prompt, or a
// buffered image render, was stopped at five minutes and told the connection
// dropped. Silence is judged by the thread's watch, whose stop aborts the
// request; each caller keeps its own ceiling where it has one. Image POSTs
// use imageDispatcher below: the same clocks, a fresh connection each time.
import { Agent, EnvHttpProxyAgent, type Dispatcher } from "undici";

const NO_TRANSPORT_CLOCK = { headersTimeout: 0, bodyTimeout: 0 } as const;
let direct: Agent | undefined;
let viaEnvProxy: EnvHttpProxyAgent | undefined;

/** Node's fetch honours HTTP(S)_PROXY and NO_PROXY only when told to
 * (NODE_USE_ENV_PROXY, or --use-env-proxy on the command line or in
 * NODE_OPTIONS); an explicit dispatcher replaces that default, so it follows
 * the same switch. The proxy address is read once, as Node's own is. */
const envProxyOn = (): boolean => {
  const flag = process.env.NODE_USE_ENV_PROXY?.trim().toLowerCase();
  return (flag !== undefined && flag !== "" && flag !== "0" && flag !== "false")
    || process.execArgv.includes("--use-env-proxy")
    || /(^|\s)--use-env-proxy(\s|$)/.test(process.env.NODE_OPTIONS ?? "");
};

/** A model server on this computer or the local network is always reached
 * directly: a proxy would see a plain-HTTP key and prompt for a server that
 * never needed one. Names that only DNS could place are left to the proxy
 * rules (NO_PROXY). */
export function isLocalTarget(target: string | URL | undefined): boolean {
  if (target === undefined) return false;
  let host: string;
  try { host = new URL(String(target)).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch { return false; }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1" || host === "::") return true;
  if (/^(fc|fd)[0-9a-f]{2}:/.test(host) || host.startsWith("fe80:")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host.replace(/^::ffff:/, ""));
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

export function providerDispatcher(target?: string | URL): Dispatcher {
  if (envProxyOn() && !isLocalTarget(target)) return (viaEnvProxy ??= new EnvHttpProxyAgent(NO_TRANSPORT_CLOCK));
  return (direct ??= new Agent(NO_TRANSPORT_CLOCK));
}

/** How long an image request may take to open its connection (TCP, TLS and,
 * behind a proxy, the tunnel). No byte of the request is written before that
 * finishes, so a dead route fails here quickly and can be tried again. */
export const IMAGE_CONNECT_TIMEOUT_MS = 10_000;
const imageTransport = (connectTimeoutMs: number) => ({ ...NO_TRANSPORT_CLOCK, pipelining: 0, connect: { timeout: connectTimeoutMs } }) as const;
let imageDirect: Agent | undefined;
let imageViaEnvProxy: EnvHttpProxyAgent | undefined;

/** The dispatcher for image POSTs. Each request opens its own connection and
 * closes it after the answer (pipelining 0 sends `connection: close`), so a
 * render is never written into a pooled socket that went quiet since the last
 * one: a socket the far end or the network dropped without a word takes the
 * request and never answers. A render lasts tens of seconds, so one more TLS
 * handshake costs nothing that shows. Same proxy rules as providerDispatcher. */
export function imageDispatcher(target?: string | URL, connectTimeoutMs = IMAGE_CONNECT_TIMEOUT_MS): Dispatcher {
  if (connectTimeoutMs !== IMAGE_CONNECT_TIMEOUT_MS) return envProxyOn() && !isLocalTarget(target) ? new EnvHttpProxyAgent(imageTransport(connectTimeoutMs)) : new Agent(imageTransport(connectTimeoutMs));
  if (envProxyOn() && !isLocalTarget(target)) return (imageViaEnvProxy ??= new EnvHttpProxyAgent(imageTransport(IMAGE_CONNECT_TIMEOUT_MS)));
  return (imageDirect ??= new Agent(imageTransport(IMAGE_CONNECT_TIMEOUT_MS)));
}

/** How long an image upload may go without a body byte moving before it is
 * ended. A stalled upload never reaches the provider whole, and nothing on
 * the client side would otherwise notice. */
export const UPLOAD_STALL_MS = 20_000;
/** A chunk is handed to the socket at once and waits there until it drains:
 * a large one gets the time it needs at this slow floor on top of the limit,
 * so a slow line is never taken for a stalled one. */
const UPLOAD_FLOOR_BYTES_PER_SECOND = 32 * 1024;
type AnyHandler = Record<string | symbol, unknown>;

/** One request's view of its dispatcher: whether the request reached it,
 * whether undici began writing it, and whether its upload stalled. undici
 * marks the start (onConnect, onRequestStart in the new handler API) on the
 * connected socket just before the first header byte, so a request that
 * reached the dispatcher and never started had not one byte on the wire:
 * the provider cannot have seen it. From the start until the whole body is
 * written (onRequestSent), each chunk undici hands the socket (onBodySent)
 * must drain within the stall limit, or `signal` aborts the request. The
 * clock stops there: the render's own wait is never counted. */
export function watchRequestStart(base: Dispatcher, options: { stallMs?: number } = {}): { dispatcher: Dispatcher; reached: () => boolean; started: () => boolean; stalled: () => boolean; signal: AbortSignal } {
  let reached = false, started = false, done = false, stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const stallMs = options.stallMs ?? UPLOAD_STALL_MS;
  const stop = () => { done = true; if (timer) clearTimeout(timer); timer = undefined; };
  const arm = (bytes: number) => {
    if (done) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { stalled = true; controller.abort(new DOMException("upload stalled", "TimeoutError")); }, stallMs + Math.ceil(bytes / UPLOAD_FLOOR_BYTES_PER_SECOND * 1000));
    timer.unref?.();
  };
  const call = (target: AnyHandler, key: string, args: unknown[]) => { const fn = target[key]; return typeof fn === "function" ? fn.apply(target, args) : undefined; };
  const watched = (handler: AnyHandler) => new Proxy(handler, {
    get(target, key) {
      if (key === "onConnect" || key === "onRequestStart") {
        if (typeof target[key] !== "function") return target[key];
        return (...args: unknown[]) => { started = true; arm(0); return call(target, key, args); };
      }
      if (key === "onBodySent") return (...args: unknown[]) => { const chunk = args[0] as { length?: number } | undefined; arm(typeof chunk?.length === "number" ? chunk.length : 0); return call(target, key, args); };
      if (key === "onRequestSent") return (...args: unknown[]) => { stop(); return call(target, key, args); };
      if (["onHeaders", "onResponseStart", "onUpgrade", "onRequestUpgrade", "onError", "onResponseError", "onComplete", "onResponseEnd"].includes(String(key)) && typeof target[key] === "function") {
        return (...args: unknown[]) => { stop(); return call(target, key as string, args); };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const dispatcher = new Proxy(base, {
    get(target, key) {
      if (key === "dispatch") return (opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) => { reached = true; return target.dispatch(opts, watched(handler as unknown as AnyHandler) as unknown as Dispatcher.DispatchHandler); };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { dispatcher, reached: () => reached, started: () => started, stalled: () => stalled, signal: controller.signal };
}
