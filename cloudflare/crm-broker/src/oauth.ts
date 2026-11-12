// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Exchange/timeout cases adapted from OpenMausBot highlevel.ts (Apache-2.0;
// Copyright 2026 Milind Soni and the OpenMausBot contributors). See NOTICE.
import { HIGHLEVEL_CRM_SCOPES } from "../../../server/highlevel/provider-contract.ts";

export const HIGHLEVEL_TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";
/** Schema pin, NOT a token endpoint Version header. */
export const HIGHLEVEL_TOKEN_CONTRACT = "2021-07-28";
export const HIGHLEVEL_AUTHORIZE_URL = "https://marketplace.leadconnectorhq.com/v2/oauth/chooselocation";
export const OAUTH_TIMEOUT_MS = 10_000;
export const OAUTH_RESPONSE_MAX_BYTES = 65_536;
export interface OAuthConfig { readonly clientId: string; readonly clientSecret: string; readonly redirectUri: string; readonly stagingOrigin?: string }
/** Broker-private: never return this object from a runtime or browser route. */
export interface OAuthCredentials {
  readonly accessToken: string; readonly refreshToken: string; readonly expiresAt: number;
  readonly locationId: string; readonly companyId: string | null; readonly userId: string;
  readonly scopes: readonly string[]; readonly scopeProvenance: "oauth-token-response";
}
export type OAuthGrant = { readonly kind: "code"; readonly code: string } | { readonly kind: "refresh"; readonly refreshToken: string };
export type OAuthResult = { readonly kind: "ok"; readonly credentials: OAuthCredentials } |
  { readonly kind: "error"; readonly error: "invalid_request" | "exchange_failed" | "reconnect_required" };
export interface OAuthOptions { readonly fetch: typeof fetch; readonly now?: () => number; readonly timeoutMs?: number }
const TOKEN = /^[\x21-\x7e]{1,8192}$/u;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SCOPE_LIST = /^[A-Za-z0-9_./-]+(?: [A-Za-z0-9_./-]+)*$/u;
const qualifiedScopes = new Set(HIGHLEVEL_CRM_SCOPES.filter(scope => scope !== "none" && !scope.startsWith("oauth.")));

function credentialsFromResponse(value: unknown, now: number): OAuthCredentials | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.access_token !== "string" || !TOKEN.test(v.access_token) ||
      typeof v.refresh_token !== "string" || !TOKEN.test(v.refresh_token) ||
      v.token_type !== "Bearer" || v.userType !== "Location" ||
      typeof v.locationId !== "string" || !ID.test(v.locationId) ||
      typeof v.userId !== "string" || !ID.test(v.userId) ||
      (v.companyId !== undefined && (typeof v.companyId !== "string" || !ID.test(v.companyId))) ||
      typeof v.expires_in !== "number" || !Number.isSafeInteger(v.expires_in) || v.expires_in <= 0 || v.expires_in > 31 * 86400 ||
      typeof v.scope !== "string" || v.scope.length > 4096 || !SCOPE_LIST.test(v.scope)) return null;
  const scopes = [...new Set(v.scope.split(" "))].sort();
  if (scopes.length > 128 || scopes.some(scope => !qualifiedScopes.has(scope))) return null;
  return Object.freeze({ accessToken: v.access_token, refreshToken: v.refresh_token,
    expiresAt: now + v.expires_in * 1000, locationId: v.locationId, companyId: v.companyId as string | undefined ?? null,
    userId: v.userId, scopes: Object.freeze(scopes), scopeProvenance: "oauth-token-response" });
}

/** One bounded exchange. No retry: an ambiguous code or rotating refresh must
 * never be resent automatically. Caller owns durable rotation and reconnection. */
function allowedRedirect(config: OAuthConfig): boolean {
  if(config.redirectUri === "https://connect.murage.ai/v1/crm/callback") return true;
  if(!config.stagingOrigin) return false;
  try {const origin=new URL(config.stagingOrigin);return origin.protocol==="https:" && origin.origin===config.stagingOrigin && !origin.username && !origin.password && config.redirectUri===`${origin.origin}/v1/crm/callback`;}catch{return false;}
}
export async function exchangeOAuth(config: OAuthConfig, grant: OAuthGrant, options: OAuthOptions): Promise<OAuthResult> {
  if (!config || typeof config.clientId !== "string" || !/^[\x21-\x7e]{1,256}$/u.test(config.clientId) ||
      typeof config.clientSecret !== "string" || !/^[\x21-\x7e]{8,1024}$/u.test(config.clientSecret) ||
      !allowedRedirect(config) ||
      !grant || (grant.kind !== "code" && grant.kind !== "refresh") ||
      (grant.kind === "code" ? typeof grant.code !== "string" || !/^[\x21-\x7e]{1,1024}$/u.test(grant.code) :
        typeof grant.refreshToken !== "string" || !TOKEN.test(grant.refreshToken))) return { kind: "error", error: "invalid_request" };
  const now = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(now) || now < 0) return { kind: "error", error: "invalid_request" };
  const form = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
    user_type: "Location", redirect_uri: config.redirectUri,
    ...(grant.kind === "code" ? { grant_type: "authorization_code", code: grant.code } :
      { grant_type: "refresh_token", refresh_token: grant.refreshToken }),
  });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  // A race also bounds injected transports which ignore AbortSignal.
  const timeoutMs = options.timeoutMs === undefined ? OAUTH_TIMEOUT_MS : Math.max(1, Math.min(OAUTH_TIMEOUT_MS, options.timeoutMs));
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); void reader?.cancel().catch(() => {}); reject(new Error("exchange_failed")); }, timeoutMs);
  });
  try {
    const perform = async (): Promise<OAuthResult> => {
      const response = await options.fetch(HIGHLEVEL_TOKEN_URL, { method: "POST", redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: form.toString(), signal: controller.signal });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        return { kind: "error", error: "exchange_failed" };
      }
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        return { kind: "error", error: response.status >= 400 && response.status < 500 ? "reconnect_required" : "exchange_failed" };
      }
      if (!response.body || Number(response.headers.get("content-length") ?? 0) > OAUTH_RESPONSE_MAX_BYTES) {
        void response.body?.cancel().catch(() => {});
        return { kind: "error", error: "exchange_failed" };
      }
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      let reads = 0;
      while (true) {
        // Empty chunks must not turn a byte ceiling into an unbounded loop.
        if (++reads > OAUTH_RESPONSE_MAX_BYTES) {
          void reader.cancel().catch(() => {});
          return { kind: "error", error: "exchange_failed" };
        }
        const next = await reader.read();
        if (controller.signal.aborted) return { kind: "error", error: "exchange_failed" };
        if (next.done) break;
        size += next.value.byteLength;
        if (size > OAUTH_RESPONSE_MAX_BYTES) {
          void reader.cancel().catch(() => {});
          return { kind: "error", error: "exchange_failed" };
        }
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { return { kind: "error", error: "exchange_failed" }; }
      const credentials = credentialsFromResponse(value, now);
      return credentials ? { kind: "ok", credentials } : { kind: "error", error: "reconnect_required" };
    };
    return await Promise.race([perform(), timedOut]);
  } catch {
    return { kind: "error", error: "exchange_failed" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
