// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The ONE place that knows Flux's device-code endpoints and field names (RFC 8628), as FluxMain's contract fixes them (PR TradeCanyon/flux-router-app#274):
//   GET  /api/device/capabilities  -> {device_authorization_grant, client_id, scope, grant_type, device_authorization_endpoint, token_endpoint,
//                                      revocation_endpoint, verification_uri, expires_in, interval, slow_down_increment, max_interval, bot_keys?}
//   POST /api/device/code  {client_id:"murage-cloud", scope:"email:owner"} -> {device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval}
//   POST /api/device/token {grant_type, device_code, client_id} -> 400 {error} | 200 {api_key, key_prefix, name, key_id, account_id, scopes} (once)
//   POST /api/device/revoke  Bearer api_key -> 204 revoked | 401 invalid_token (already gone) | 503 temporarily_unavailable (NOT revoked)
// With Flux's flag OFF every route answers 404, which counts as unavailable. Sign-in starts only when capabilities answers `bot_keys: true`
// (the bot-key routes accept the `Murage Cloud` key). The supervisor session constructs it with the home's Flux routing base; `fetch` is always injected.
import { FLUX_DEVICE_BASE } from "../flux-routing.ts";
import { KEY_ID } from "../email/email-secrets.ts";
import { MAX_CODE_LIFETIME_MS, MAX_POLL_INTERVAL_MS, OWNER_BACKOFF_MS, type DeviceCodePoll, type DeviceCodeStart, type FluxDeviceCodeClient, type RevokeResult } from "./email-owner-signin.ts";

import { EMAIL_SIGNIN_TTL_MS } from "./email-signin-availability.ts";

export const DEVICE_CAPABILITIES_PATH = "/api/device/capabilities";
export const DEVICE_CODE_PATH = "/api/device/code";
export const DEVICE_TOKEN_PATH = "/api/device/token";
export const DEVICE_REVOKE_PATH = "/api/device/revoke";
export const DEVICE_CLIENT_ID = "murage-cloud";
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const SCOPE = "email:owner";
export const DEVICE_REQUEST_TIMEOUT_MS = 5_000;
const MAX_FIELD = 4096;
/** r3 7.2: the polling interval is a whole number of seconds, at least 5. */
const MIN_INTERVAL_S = 5;

type Json = Record<string, unknown>;
const text = (value: unknown, max = MAX_FIELD): string | null => typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
const positive = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
async function jsonOf(response: Response): Promise<Json | null> {
  try { const value: unknown = await response.json(); return value && typeof value === "object" && !Array.isArray(value) ? value as Json : null; } catch { return null; }
}

export function createFluxDeviceCodeClient(options: { baseUrl: string; fetch: typeof fetch; now?: () => number; homeLabel?: string }): FluxDeviceCodeClient {
  const base = new URL(options.baseUrl);
  /** Sign-in links are restricted to the compiled app origin for this environment. Never fetched. */
  const resolve = (value: unknown): URL | null => {
    const raw = text(value, 2048);
    if (!raw) return null;
    try { const url = new URL(raw, base); return url.origin === FLUX_DEVICE_BASE && !url.username && !url.password ? url : null; } catch { return null; }
  };
  /** An endpoint a response names must be EXACTLY the compiled-in one (r3 7.2: endpoints are compared, never followed). */
  const isExactly = (value: unknown, path: string): boolean => {
    const raw = text(value, 2048);
    if (!raw) return false;
    try { const url = new URL(raw, base); return url.origin === base.origin && !url.username && !url.password && url.pathname === path && url.search === "" && url.hash === ""; } catch { return false; }
  };
  const at = (path: string) => new URL(path, base).href;
  // redirects are never followed: a 3xx would carry the request body (device code, bearer key) wherever it points
  const send = async (url: string, init: RequestInit): Promise<Response | null> => {
    const response = await options.fetch(url, { ...init, redirect: "manual" });
    return response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400) ? null : response;
  };
  const post = (url: string, body: Json, headers: Record<string, string> = {}) => send(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...headers }, body: JSON.stringify(body) });
  const now = options.now ?? (() => performance.now());
  let cached = false, until = 0, failures = 0;
  let inflight: Promise<{ available: boolean; retryAfterMs: number }> | undefined;
  const readCapabilities = async (): Promise<boolean> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const caps = await send(at(DEVICE_CAPABILITIES_PATH), { method: "GET", headers: { accept: "application/json" }, signal: controller.signal });
          if (!caps?.ok) return false;
          const c = await jsonOf(caps);
          return !!c && c.device_authorization_grant === true && c.bot_keys === true && c.client_id === DEVICE_CLIENT_ID && c.scope === SCOPE && c.grant_type === DEVICE_GRANT_TYPE
            && isExactly(c.device_authorization_endpoint, DEVICE_CODE_PATH) && isExactly(c.token_endpoint, DEVICE_TOKEN_PATH)
            && (c.revocation_endpoint === undefined || isExactly(c.revocation_endpoint, DEVICE_REVOKE_PATH));
        })(),
        new Promise<false>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(false); }, DEVICE_REQUEST_TIMEOUT_MS); timer.unref?.(); }),
      ]);
    } catch { return false; }
    finally { if (timer) clearTimeout(timer); controller.abort(); }
  };
  const availability = (): Promise<{ available: boolean; retryAfterMs: number }> => {
    if (now() < until) return Promise.resolve({ available: cached, retryAfterMs: until - now() });
    if (inflight) return inflight;
    cached = false;
    inflight = readCapabilities().then(available => {
      cached = available;
      const delay = available ? EMAIL_SIGNIN_TTL_MS : OWNER_BACKOFF_MS[Math.min(failures++, OWNER_BACKOFF_MS.length - 1)]!;
      if (available) failures = 0;
      until = now() + delay;
      return { available, retryAfterMs: delay };
    }).finally(() => { inflight = undefined; });
    return inflight;
  };
  return {
    availability,
    async start(): Promise<DeviceCodeStart | { state: "unavailable" }> {
      try {
        if (!(await availability()).available) return { state: "unavailable" };
        // Only an existing home display name may be supplied. A home with no such name sends no label.
        const homeLabel = options.homeLabel?.replace(/[^A-Za-z0-9 ._'()-]/g, "").trim().slice(0, 64);
        const response = await post(at(DEVICE_CODE_PATH), { client_id: DEVICE_CLIENT_ID, scope: SCOPE, ...(homeLabel ? { home_label: homeLabel } : {}) });
        if (!response || !response.ok) return { state: "unavailable" };
        const body = await jsonOf(response);
        const deviceCode = text(body?.device_code), userCode = text(body?.user_code, 64), uri = resolve(body?.verification_uri);
        const expires = positive(body?.expires_in), interval = positive(body?.interval);
        if (!body || !deviceCode || !userCode || !uri || !expires || !interval) return { state: "unavailable" };
        const complete = resolve(body.verification_uri_complete);
        return { deviceCode, userCode, verificationUrl: (complete ?? uri).href, intervalMs: Math.min(Math.max(MIN_INTERVAL_S, Math.ceil(interval)) * 1000, MAX_POLL_INTERVAL_MS), expiresInMs: Math.min(expires * 1000, MAX_CODE_LIFETIME_MS) };
      } catch { return { state: "unavailable" }; }
    },
    async poll(deviceCode: string): Promise<DeviceCodePoll> {
      try {
        const response = await post(at(DEVICE_TOKEN_PATH), { grant_type: DEVICE_GRANT_TYPE, device_code: deviceCode, client_id: DEVICE_CLIENT_ID });
        if (!response) return { state: "retry" };
        const body = await jsonOf(response);
        if (response.ok) {
          // The device-code token parser (r3 7.5 step 1): token 1..4096 with no whitespace, KEY_ID, scope email:owner, account_id a non-empty string.
          const token = text(body?.api_key);
          if (!token || /\s/.test(token)) return { state: "unavailable" };
          const keyId = typeof body?.key_id === "string" && KEY_ID.test(body.key_id) ? body.key_id : null;
          const account = text(body?.account_id, 200);
          const scoped = Array.isArray(body?.scopes) && body.scopes.includes(SCOPE);
          // A well-formed token that fails the rest is still returned unscoped, so the caller revokes it by its token and nothing is written.
          return { state: "ok", owner: { token, keyId: keyId ?? "unknown" }, scoped: scoped && keyId !== null && account !== null };
        }
        switch (body?.error) {
          case "authorization_pending": return { state: "pending" };
          case "slow_down": return { state: "slow_down" };
          case "expired_token": case "invalid_grant": return { state: "expired" };
          case "access_denied": return { state: "denied" };
          default: return { state: "retry" };
        }
      } catch { return { state: "retry" }; }
    },
    async revoke(token: string): Promise<RevokeResult> {
      try {
        const response = await post(at(DEVICE_REVOKE_PATH), {}, { authorization: `Bearer ${token}` });
        if (!response) return "retry";
        if (response.ok) return "revoked";
        if (response.status === 401 || response.status === 404) {
          const body = await jsonOf(response);
          if ((response.status === 401 && body?.error === "invalid_token") || (response.status === 404 && body?.error === "gone")) return "gone";
        }
        return "retry";
      } catch { return "retry"; }
    },
  };
}
