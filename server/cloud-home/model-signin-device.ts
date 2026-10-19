// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Wire provenance: OpenAI Codex 60947e234156ac12bdb7fba2477d3965f166bd34
// login/device_code_auth.rs; xai-org/grok-build 2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8
// xai-grok-login/device_code.rs. Bounds and S256 comparison are Murage policy.
import { cloudHomeCopy } from "./copy.ts";
import { Pool, fetch as pooledFetch } from "undici";
import { CHATGPT_TOKEN_URL, XAI_TOKEN_URL_FALLBACK, XAI_SCOPES, parseTokenResponse, s256Challenge } from "../../electron/model-signin-oauth.mjs";
export type HomeSignInProvider = "chatgpt" | "supergrok";
export type DeviceChallenge = { verificationUrl: string; userCode: string; expiresAt: number };
export type AcquireContext = { provider: HomeSignInProvider; clientId: string; signal: AbortSignal; epoch: number; isCurrent(): boolean; onChallenge?(challenge: DeviceChallenge): void };
export type DeviceOptions = { fetch?: typeof fetch; now?: () => number; setTimeout?: typeof setTimeout; clearTimeout?: typeof clearTimeout };
const origins = ["https://auth.openai.com", "https://auth.x.ai"];
const paths = new Set(["https://auth.openai.com/api/accounts/deviceauth/usercode", "https://auth.openai.com/api/accounts/deviceauth/token", CHATGPT_TOKEN_URL, "https://auth.x.ai/oauth2/device/code", XAI_TOKEN_URL_FALLBACK]);
const bounded = (v: unknown, max = 4096): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
export function createDeviceAcquirer(options: DeviceOptions = {}) {
  const pools = options.fetch ? [] : origins.map(origin => new Pool(origin, { connections: 1, pipelining: 1 }));
  const now = options.now ?? Date.now;
  const setTimer = options.setTimeout ?? setTimeout, clearTimer = options.clearTimeout ?? clearTimeout;
  const fetcher: typeof fetch = options.fetch ?? ((url: Parameters<typeof fetch>[0], init?: RequestInit) => pooledFetch(String(url), { method: init?.method, headers: init?.headers as Record<string, string>, body: init?.body as string, signal: init?.signal, redirect: "error", dispatcher: pools[origins.indexOf(new URL(String(url)).origin)] }) as unknown as Promise<Response>);
  async function request(url: string, body: object | URLSearchParams, signal: AbortSignal) {
    if (!paths.has(url)) throw new Error(cloudHomeCopy.homeSignInUnauthorized);
    const timeout = new AbortController();
    const timer = setTimer(() => timeout.abort(), 15_000);
    try {
      const response = await fetcher(url, { method: "POST", redirect: "error", signal: AbortSignal.any([signal, timeout.signal]), headers: { accept: "application/json", "content-type": body instanceof URLSearchParams ? "application/x-www-form-urlencoded" : "application/json" }, body: body instanceof URLSearchParams ? body.toString() : JSON.stringify(body) });
      if (Number(response.headers.get("content-length") ?? 0) > 65536) throw new Error(cloudHomeCopy.homeSignInUnauthorized);
      const reader = response.body?.getReader(); let length = 0; const chunks: Uint8Array[] = [];
      if (reader) { try { for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > 65536) throw new Error(cloudHomeCopy.homeSignInUnauthorized); chunks.push(value); } } finally { await reader.cancel().catch(() => {}); } }
      let data; try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { data = null; }
      const retry = response.headers.get("retry-after");
      return { status: response.status, ok: response.ok, data, retry: retry && /^\d+$/.test(retry) ? Math.min(60, Math.max(5, Number(retry))) : 5 };
    } finally { clearTimer(timer); }
  }
  function wait(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(new Error(cloudHomeCopy.homeSignInCancelled)); return; }
      const abort = () => { clearTimer(timer); reject(new Error(cloudHomeCopy.homeSignInCancelled)); };
      const timer = setTimer(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  async function acquire(context: AcquireContext) {
    const { provider, clientId, signal, epoch } = context;
    const tokenUrl = provider === "chatgpt" ? CHATGPT_TOKEN_URL : XAI_TOKEN_URL_FALLBACK;
    const check = () => { if (signal.aborted || !context.isCurrent()) throw new Error(cloudHomeCopy.homeSignInCancelled); };
    try {
      check();
      const start = await request(provider === "chatgpt" ? "https://auth.openai.com/api/accounts/deviceauth/usercode" : "https://auth.x.ai/oauth2/device/code", provider === "chatgpt" ? { client_id: clientId } : new URLSearchParams({ client_id: clientId, scope: XAI_SCOPES, referrer: "murage" }), signal);
      check(); if (!start.ok || !start.data) throw new Error(cloudHomeCopy.homeSignInUnauthorized);
      const d = start.data, userCode = d.user_code ?? d.usercode;
      let interval = d.interval ?? (provider === "chatgpt" ? "5" : 5);
      if (provider === "chatgpt") { if (typeof interval !== "string" || !/^\d+$/.test(interval)) throw new Error(cloudHomeCopy.homeSignInUnauthorized); interval = Number(interval); }
      if (!Number.isInteger(interval) || interval < 1 || interval > 60 || !bounded(userCode, 128)) throw new Error(cloudHomeCopy.homeSignInUnauthorized);
      const privateCode = provider === "chatgpt" ? d.device_auth_id : d.device_code;
      if (!bounded(privateCode)) throw new Error(cloudHomeCopy.homeSignInUnauthorized);
      let expiresAt = now() + 900_000, verificationUrl = "https://auth.openai.com/codex/device";
      if (provider === "supergrok") {
        if (!/^[A-Za-z0-9-]+$/.test(userCode) || !Number.isInteger(d.expires_in) || d.expires_in <= 0 || !bounded(d.verification_uri)) throw new Error(cloudHomeCopy.homeSignInUnauthorized);
        const validateUrl = (value: unknown) => { if (!bounded(value)) throw new Error(cloudHomeCopy.homeSignInUnauthorized); const u = new URL(value); if (u.protocol !== "https:" || !["auth.x.ai", "accounts.x.ai"].includes(u.hostname) || u.port || u.username || u.password || u.hash) throw new Error(cloudHomeCopy.homeSignInUnauthorized); return u.toString(); };
        verificationUrl = validateUrl(d.verification_uri);
        if (d.verification_uri_complete !== undefined) validateUrl(d.verification_uri_complete);
        expiresAt = now() + Math.min(900_000, d.expires_in * 1000);
      } else interval = Math.max(5, interval);
      context.onChallenge?.({ verificationUrl, userCode, expiresAt });
      while (now() < expiresAt) {
        await wait(Math.min(interval * 1000, expiresAt - now()), signal); check(); if (now() >= expiresAt) break;
        const poll = await request(provider === "chatgpt" ? "https://auth.openai.com/api/accounts/deviceauth/token" : tokenUrl, provider === "chatgpt" ? { device_auth_id: privateCode, user_code: userCode } : new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: privateCode, client_id: clientId }), signal);
        check(); if (now() >= expiresAt) break;
        if (poll.status === 429) { interval = Math.max(interval, poll.retry); continue; }
        if (provider === "chatgpt" && [403, 404].includes(poll.status)) continue;
        if (provider === "supergrok" && !poll.ok) {
          if (poll.data?.error === "authorization_pending") continue;
          if (poll.data?.error === "slow_down") { interval += 5; continue; }
        }
        if (!poll.ok || !poll.data) throw new Error(cloudHomeCopy.homeSignInUnauthorized);
        let body = poll.data;
        if (provider === "chatgpt") {
          if (!bounded(body.authorization_code) || !bounded(body.code_verifier, 128) || !bounded(body.code_challenge, 128) || s256Challenge(body.code_verifier) !== body.code_challenge) throw new Error(cloudHomeCopy.homeSignInUnauthorized);
          // Exactly one attempt: transport ambiguity must never replay this code.
          const exchanged = await request(tokenUrl, new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code: body.authorization_code, code_verifier: body.code_verifier, redirect_uri: "https://auth.openai.com/deviceauth/callback" }), signal);
          check(); if (!exchanged.ok) throw new Error(cloudHomeCopy.homeSignInUnauthorized); body = exchanged.data;
        }
        const tokens = parseTokenResponse(provider, body, now());
        if (!tokens || !bounded(tokens.accessToken, 16384)) throw new Error(cloudHomeCopy.homeSignInUnauthorized);
        return { kind: "tokens" as const, provider, clientId, tokenUrl, tokens, epoch };
      }
      return { kind: "error" as const, error: cloudHomeCopy.homeSignInTimeout, epoch };
    } catch (error) {
      return { kind: "error" as const, error: signal.aborted || !context.isCurrent() ? "cancelled" : error instanceof Error && ["unauthorized", "cancelled"].includes(error.message) ? error.message : "offline", epoch };
    }
  }
  return { acquire,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const reply = await request(String(url), new URLSearchParams(String(init?.body ?? "")), init?.signal ?? new AbortController().signal);
      return Response.json(reply.data, { status: reply.status });
    }) as typeof fetch,
    dispose() { for (const pool of pools) void pool.close(); } };
}
