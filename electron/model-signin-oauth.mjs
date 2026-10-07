// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure OAuth building blocks for plan sign-in, ported from Wayland:
//   ChatGPT: wayland/app/src/process/onboarding/chatgptOAuthCore.ts
//   Grok:    wayland/app/src/process/onboarding/xaiOAuthCore.ts
// Same clients, endpoints, scopes and parameters as Wayland (Sean,
// 2026-09-30: "we've already solved this problem and you can grab it").
// Dropped from the port on purpose: Wayland's readers for ~/.codex/auth.json
// and ~/.grok/auth.json. Murage never touches another app's login files.
//
// Nothing here performs I/O except randomBytes/createHash (in oauth/pkce.mjs).
import { createPkce as createSharedPkce, s256Challenge } from "./oauth/pkce.mjs";

export { s256Challenge };

// ── ChatGPT (the Codex CLI's desktop PKCE flow) ──────────────────────────
export const CHATGPT_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const CHATGPT_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CHATGPT_OAUTH_CLIENT_ID_DEFAULT = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CHATGPT_SCOPES = "openid profile email offline_access";
/** Registered loopback ports for this client (redirect_uri must match exactly). */
export const CHATGPT_REDIRECT_PORT = 1455;
export const CHATGPT_REDIRECT_PORT_FALLBACK = 1457;
export const CHATGPT_REDIRECT_PATH = "/auth/callback";
/** ChatGPT device-code sign-in (the Codex CLI's `--device-auth` flow; Hermes
 * and OpenClaw use the same endpoints). The user opens CHATGPT_DEVICE_VERIFY_URL
 * on any device and types the code; this side polls. */
export const CHATGPT_DEVICE_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const CHATGPT_DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
export const CHATGPT_DEVICE_VERIFY_URL = "https://auth.openai.com/codex/device";
export const CHATGPT_DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
export const CHATGPT_AUTH_CLAIM = "https://api.openai.com/auth";

// ── Grok (Grok Build's PKCE client, as Wayland ships it) ─────────────────
export const XAI_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
export const XAI_AUTHORIZE_URL_FALLBACK = "https://auth.x.ai/oauth2/authorize";
export const XAI_TOKEN_URL_FALLBACK = "https://auth.x.ai/oauth2/token";
export const XAI_SCOPES = "openid profile offline_access grok-cli:access api:access";
export const XAI_OAUTH_CLIENT_ID_DEFAULT = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_REDIRECT_PATH = "/callback";
/** RFC 8628 device authorization, as Hermes ships it for the same client. */
export const XAI_DEVICE_CODE_URL_FALLBACK = "https://auth.x.ai/oauth2/device/code";

/** Env override wins, so a corrected client id needs no rebuild. */
export function resolveClientId(provider, env = process.env) {
  const name = provider === "chatgpt" ? "MURAGE_CHATGPT_OAUTH_CLIENT_ID" : "MURAGE_XAI_OAUTH_CLIENT_ID";
  const override = env?.[name];
  if (typeof override === "string" && /^[A-Za-z0-9_.-]{8,200}$/.test(override.trim())) return override.trim();
  return provider === "chatgpt" ? CHATGPT_OAUTH_CLIENT_ID_DEFAULT : XAI_OAUTH_CLIENT_ID_DEFAULT;
}

/** PKCE (RFC 7636, S256) plus a CSRF state. ChatGPT uses Codex's 64-byte
 * verifier, Grok a 32-byte one, both inside the 43 to 128 character range. */
export function createPkce(provider) {
  const { verifier, challenge, state } = createSharedPkce({ verifierBytes: provider === "chatgpt" ? 64 : 32, stateBytes: 16 });
  return { verifier, challenge, state };
}

export function isPinnedOpenAiAuthHttps(url) {
  try { const parsed = new URL(url); return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "auth.openai.com"; }
  catch { return false; }
}

export function isPinnedXaiHttps(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:" && (host === "x.ai" || host.endsWith(".x.ai"));
  } catch { return false; }
}

/** The registered redirect for the Codex client names localhost, not
 * 127.0.0.1; the listener itself binds 127.0.0.1 only. */
export function chatgptRedirectUri(port) {
  return `http://localhost:${port}${CHATGPT_REDIRECT_PATH}`;
}

export function buildChatGptAuthorizeUrl({ clientId, challenge, state, redirectUri }) {
  const url = new URL(CHATGPT_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", CHATGPT_SCOPES);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "codex_cli_rs");
  return url.toString();
}

export function buildXaiAuthorizeUrl(authorizeUrl, { clientId, challenge, state, redirectUri }) {
  const url = new URL(authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", XAI_SCOPES);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
}

const XAI_AUTHORIZE_HOSTS = new Set(["auth.x.ai", "accounts.x.ai"]);
/** The xAI token endpoint may only be auth.x.ai: refresh tokens go nowhere else. */
export function isPinnedXaiTokenUrl(url) {
  try { const parsed = new URL(url); return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "auth.x.ai" && !parsed.username && !parsed.password; }
  catch { return false; }
}
export function isPinnedXaiAuthorizeUrl(url) {
  try { const parsed = new URL(url); return parsed.protocol === "https:" && XAI_AUTHORIZE_HOSTS.has(parsed.hostname.toLowerCase()); }
  catch { return false; }
}

const XAI_VERIFICATION_HOSTS = new Set(["auth.x.ai", "accounts.x.ai"]);
/** Exact origins only: Hermes talks to the auth.x.ai issuer and the xAI consent
 * pages live on accounts.x.ai. No other x.ai subdomain, port or credentials. */
export function isPinnedXaiVerificationUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && XAI_VERIFICATION_HOSTS.has(parsed.hostname.toLowerCase()) && parsed.port === "" && !parsed.username && !parsed.password;
  } catch { return false; }
}

/** A device verification page the user is told to open. Exact xAI origins only. */
export function pinnedXaiVerificationUrl(...candidates) {
  return candidates.find(url => typeof url === "string" && isPinnedXaiVerificationUrl(url)) ?? null;
}

/** OIDC discovery, pinned to xAI's own sign-in hosts. Null means "use the fallbacks". */
export function parseXaiDiscovery(doc) {
  if (!doc || typeof doc !== "object") return null;
  const { authorization_endpoint: authorizeUrl, token_endpoint: tokenUrl } = doc;
  if (typeof authorizeUrl !== "string" || typeof tokenUrl !== "string") return null;
  if (!isPinnedXaiAuthorizeUrl(authorizeUrl) || !isPinnedXaiTokenUrl(tokenUrl)) return null;
  return { authorizeUrl, tokenUrl };
}

/** The device authorization endpoint from discovery, pinned to auth.x.ai. */
export function parseXaiDeviceEndpoint(doc) {
  const url = doc && typeof doc === "object" ? doc.device_authorization_endpoint : undefined;
  return typeof url === "string" && isPinnedXaiTokenUrl(url) ? url : XAI_DEVICE_CODE_URL_FALLBACK;
}

function decodeJwtPayload(jwt) {
  const parts = typeof jwt === "string" ? jwt.split(".") : [];
  if (parts.length < 2) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

const PLANS = new Set(["free", "go", "plus", "pro", "team", "business", "enterprise", "edu"]);
/** Identity from the ChatGPT id_token. As in Wayland, the signature is not
 * checked: the token came straight from the pinned token endpoint over TLS
 * and is only read for display and the account header. */
export function parseChatGptIdToken(idToken) {
  const payload = decodeJwtPayload(idToken);
  if (!payload) return null;
  const identity = {};
  if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) identity.expiresAt = payload.exp * 1000;
  if (typeof payload.email === "string" && payload.email.length <= 320) identity.email = payload.email;
  const auth = payload[CHATGPT_AUTH_CLAIM];
  if (auth && typeof auth === "object") {
    if (typeof auth.chatgpt_account_id === "string" && auth.chatgpt_account_id) identity.accountId = auth.chatgpt_account_id;
    const plan = typeof auth.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type.toLowerCase() : "";
    if (PLANS.has(plan)) identity.plan = plan;
  }
  return identity;
}

/** Token endpoint body to a normalized bundle, or null with no access token. */
export function parseTokenResponse(provider, body, now = Date.now()) {
  if (!body || typeof body !== "object") return null;
  const { access_token: accessToken, refresh_token: refreshToken, id_token: idToken, expires_in: expiresIn } = body;
  if (typeof accessToken !== "string" || !accessToken) return null;
  const tokens = { accessToken };
  if (typeof refreshToken === "string" && refreshToken) tokens.refreshToken = refreshToken;
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) tokens.expiresAt = now + expiresIn * 1000;
  if (provider === "chatgpt" && typeof idToken === "string" && idToken) {
    tokens.idToken = idToken;
    const identity = parseChatGptIdToken(idToken);
    if (identity?.accountId) tokens.accountId = identity.accountId;
    if (identity?.plan) tokens.plan = identity.plan;
    if (identity?.email) tokens.email = identity.email;
  }
  // The access token is a JWT for both vendors; its own exp is the truth
  // when expires_in is missing.
  if (tokens.expiresAt === undefined) {
    const exp = decodeJwtPayload(accessToken)?.exp;
    if (typeof exp === "number" && Number.isFinite(exp)) tokens.expiresAt = exp * 1000;
  }
  return tokens;
}

/** What a refused token call means. `dead` wipes the tokens (sign in again);
 * `retry` keeps them (a network or vendor hiccup never erases a sign-in). */
export function classifyTokenFailure(status, body) {
  const code = String(body?.error?.code ?? body?.error ?? body?.code ?? "").toLowerCase();
  if (/invalid_grant|refresh_token|token_expired|token_revoked|invalid_token/.test(code)) return "dead";
  // A bare 400 (invalid_request, invalid_scope, a vendor change) is not proof
  // the sign-in is gone; only an explicit grant error or a 401 is.
  if (status === 401) return "dead";
  if (status === 403) return "forbidden";
  return "retry";
}

/** Milliseconds to wait from a Retry-After header (seconds or an HTTP date).
 * The vendor's deadline is returned in full, with no ceiling: callers hold a
 * deadline and chunk the actual timer to what a timer can express. */
export function parseRetryAfterMs(value, now = Date.now()) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** Proactive refresh margin: five minutes before expiry, as Wayland does. */
export function needsProactiveRefresh(expiresAt, now = Date.now(), skewMs = 5 * 60 * 1000) {
  return typeof expiresAt === "number" && now > expiresAt - skewMs;
}

/** Linux with no display cannot finish a browser sign-in (Wayland #525). */
export function isHeadlessEnvironment(platform = process.platform, env = process.env) {
  return platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}
