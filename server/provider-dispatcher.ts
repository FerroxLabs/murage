// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The dispatcher for requests to model and image providers. Node's fetch
// otherwise ends a response whose headers or next bytes take longer than
// 300 seconds (undici's headersTimeout and bodyTimeout): a fixed silence cut
// under the owner's setting. A local model reading a long prompt, or a
// buffered image render, was stopped at five minutes and told the connection
// dropped. Silence is judged by the thread's watch, whose stop aborts the
// request; each caller keeps its own ceiling where it has one.
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
