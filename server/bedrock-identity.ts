// M9 (BEDROCK-ENGINE-1023 r2 section 3 step 3): IDENTITY. Resolves the profile's credentials from the two explicit AWS files only
// (never the env/container/IMDS providers) and calls sts:GetCallerIdentity, the only AWS call Murage makes (free).
// Owner: M9 builder lane. Imports allowed from @aws-sdk: client-sts (STSClient, GetCallerIdentityCommand, getDefaultRoleAssumer) and
// credential-provider-ini (fromIni). Nothing else (witness W10).
import { readFileSync, statSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { GetCallerIdentityCommand, STSClient, getDefaultRoleAssumer } from "@aws-sdk/client-sts";
import { fromIni } from "@aws-sdk/credential-provider-ini";
import { Agent, EnvHttpProxyAgent, request as undiciRequest, type Dispatcher } from "undici";
import type { BedrockFiles } from "./bedrock-env.ts";

export const STS_TIMEOUT_MS = 8000;
export const IDENTITY_CACHE_MS = 10 * 60 * 1000;

export class BedrockIdentityError extends Error {
  readonly kind: "sts" | "credential-process" | "aborted" | "timeout";
  constructor(message: string, kind: "sts" | "credential-process" | "aborted" | "timeout") { super(message); this.name = "BedrockIdentityError"; this.kind = kind; }
}

export interface NetworkHand { HTTPS_PROXY?: string; HTTP_PROXY?: string; NO_PROXY?: string; NODE_EXTRA_CA_CERTS?: string }

const NETWORK_NAMES = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"] as const;

/** Proxy and CA in the CLI's order: managed settings env, then the engine's user settings env, then the hand (Fable M2, Opus M1). */
export function identityNetwork(hand: Readonly<Record<string, string | undefined>>, userEnv: Readonly<Record<string, string>> = {}, managedEnvs: ReadonlyArray<Readonly<Record<string, string>>> = []): NetworkHand {
  const out: NetworkHand = {};
  for (const name of NETWORK_NAMES) {
    const pick = (layer: Readonly<Record<string, string | undefined>>): string | undefined => {
      for (const key of [name, name.toLowerCase()]) if (typeof layer[key] === "string" && layer[key]) return layer[key];
      return undefined;
    };
    const value = managedEnvs.map(pick).find(Boolean) ?? pick(userEnv) ?? pick(hand);
    if (value) out[name] = value;
  }
  return out;
}

/** A small SDK request handler over undici: `EnvHttpProxyAgent` built from the hand's values (never Murage's process env) when a proxy is
 * named, a plain agent otherwise, and the hand's NODE_EXTRA_CA_CERTS as an extra CA. */
export function identityRequestHandler(net: NetworkHand, timeoutMs = STS_TIMEOUT_MS): { handle: (req: any, opts?: { abortSignal?: AbortSignal }) => Promise<{ response: any }>; destroy: () => void } {
  let tls: { ca: string[] } | undefined;
  if (net.NODE_EXTRA_CA_CERTS) { try { tls = { ca: [...rootCertificates, readFileSync(net.NODE_EXTRA_CA_CERTS, "utf8")] }; } catch { tls = undefined; } }
  const dispatcher: Dispatcher = net.HTTPS_PROXY || net.HTTP_PROXY
    ? new EnvHttpProxyAgent({ httpProxy: net.HTTP_PROXY, httpsProxy: net.HTTPS_PROXY ?? net.HTTP_PROXY, noProxy: net.NO_PROXY ?? "", ...(tls ? { requestTls: tls, proxyTls: tls } : {}) })
    : new Agent(tls ? { connect: tls } : {});
  return {
    async handle(req, opts) {
      const q = req.query && Object.keys(req.query).length
        ? "?" + Object.entries(req.query as Record<string, string | string[]>).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${encodeURIComponent(k)}=${encodeURIComponent(x ?? "")}`)).join("&")
        : "";
      const url = `${req.protocol ?? "https:"}//${req.hostname}${req.port ? `:${req.port}` : ""}${req.path ?? "/"}${q}`;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers ?? {})) if (k.toLowerCase() !== "host") headers[k] = String(v);
      const signals = [AbortSignal.timeout(timeoutMs), ...(opts?.abortSignal ? [opts.abortSignal as AbortSignal] : [])];
      const res = await undiciRequest(url, { method: req.method, headers, body: req.body as any, dispatcher, signal: AbortSignal.any(signals) });
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) out[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
      return { response: { statusCode: res.statusCode, reason: "", headers: out, body: res.body } };
    },
    destroy() { void dispatcher.close().catch(() => {}); },
  };
}

export interface IdentityRequest {
  profile: string;
  region: string;
  files: BedrockFiles;
  network: NetworkHand;
  signal?: AbortSignal;
  /** Test seam: replaces the undici handler (the SDK still builds and signs the real requests). */
  requestHandler?: any;
  timeoutMs?: number;
}

/** Resolve the profile's credentials from the explicit files and return the AWS account id GetCallerIdentity reports. */
export async function resolveBedrockAccount(req: IdentityRequest): Promise<string> {
  const own = req.requestHandler ? null : identityRequestHandler(req.network, req.timeoutMs);
  const requestHandler = req.requestHandler ?? own!;
  const timeout = req.timeoutMs ?? STS_TIMEOUT_MS;
  const timer = AbortSignal.timeout(timeout);
  const signal = req.signal ? AbortSignal.any([req.signal, timer]) : timer;
  try {
    // No `region` in clientConfig: the SSO client then uses the profile's own sso_region. The role hop gets its region explicitly.
    const credentials = fromIni({
      profile: req.profile,
      configFilepath: req.files.configFile,
      filepath: req.files.credentialsFile,
      clientConfig: { requestHandler },
      roleAssumer: getDefaultRoleAssumer({ region: req.region, requestHandler } as any),
      ignoreCache: true,
    } as any);
    const sts = new STSClient({
      region: req.region,
      endpoint: `https://sts.${req.region}.amazonaws.com`,
      credentials,
      requestHandler,
      ignoreConfiguredEndpointUrls: true,
      maxAttempts: 1,
    } as any);
    // the credential hops and the call are raced against the Stop / 8 s signal too, so a handler that ignores abort cannot hang a turn
    const out = await new Promise<{ Account?: string }>((resolve, reject) => {
      const onAbort = () => reject(new Error("aborted"));
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      sts.send(new GetCallerIdentityCommand({}), { abortSignal: signal } as any).then((r) => resolve(r as { Account?: string }), reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
    const id = out.Account;
    if (typeof id !== "string" || !/^\d{12}$/.test(id)) throw new BedrockIdentityError("GetCallerIdentity returned no account id", "sts");
    return id;
  } catch (error) {
    if (error instanceof BedrockIdentityError) throw error;
    if (req.signal?.aborted) throw new BedrockIdentityError("stopped", "aborted");
    if (timer.aborted) throw new BedrockIdentityError(`timed out after ${Math.round(timeout / 1000)} s`, "timeout");
    const message = error instanceof Error ? error.message : String(error);
    if (/Command failed:|credential_process/i.test(message) || /credential_process/i.test(String((error as any)?.cause ?? "")))
      throw new BedrockIdentityError("Murage could not run this profile's credential_process command. Use its full path in ~/.aws/config.", "credential-process");
    throw new BedrockIdentityError(message, "sts");
  } finally {
    own?.destroy();
  }
}

// ---- the 10-minute cache -----------------------------------------------------------------------------------------------------------

function fileStat(path: string): string {
  try { const s = statSync(path); return `${s.mtimeMs}:${s.size}`; } catch { return "absent"; }
}

export class IdentityCache {
  private readonly map = new Map<string, { account: string; at: number }>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  key(instanceId: string, epoch: number, profile: string, region: string, files: BedrockFiles): string {
    return [instanceId, epoch, profile, region, fileStat(files.configFile), fileStat(files.credentialsFile)].join("|");
  }
  get(key: string): string | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > IDENTITY_CACHE_MS) { this.map.delete(key); return undefined; }
    return hit.account;
  }
  set(key: string, account: string): void { this.map.set(key, { account, at: this.now() }); }
  clear(): void { this.map.clear(); }
}

/** Profile names only (`[profile x]` and `[x]`), from the same two files IDENTITY uses. Never reads or returns a value. */
export function listBedrockProfiles(files: BedrockFiles, read: (p: string) => string = (p) => readFileSync(p, "utf8")): string[] {
  const names = new Set<string>();
  for (const [path, config] of [[files.configFile, true], [files.credentialsFile, false]] as const) {
    let text = "";
    try { text = read(path); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*\[\s*(?:profile\s+)?([A-Za-z0-9_.+=,@-]{1,64})\s*\]/.exec(line);
      if (!m) continue;
      if (config && /^\s*\[\s*(sso-session|services)\b/.test(line)) continue;
      names.add(m[1]!);
    }
  }
  return [...names].sort();
}
