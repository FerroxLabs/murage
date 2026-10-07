// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Where the harness keeps the secrets of servers added by link (spec MCP-LINK
// 3.4). They live in memory only. In the packaged app they arrive from the
// desktop shell: once at boot in MURAGE_MCP_SERVER_SECRETS (read and deleted
// here, and listed in WORKSPACE_CREDENTIAL_ENV so no child inherits it), then
// as pushes from main when a key is saved or a token is refreshed. The refresh
// token never gets here; main holds it.
//
// With no desktop shell (dev and headless runs) the values sit in config.json,
// as the other local-config secrets do, and `resolveRequestAuth` reads them from
// the entry.
import { sameOrigin } from "../shared/remote-mcp-url.mjs";
import type { StoredMcpServer, StoredRemoteMcpServer, McpSecretPresence } from "./mcp-registry.ts";
import { isHarnessOwnedMcpEnvName, isMaskedStoredUrl } from "./mcp-registry.ts";

export const MCP_SECRETS_ENV = "MURAGE_MCP_SERVER_SECRETS";

export interface McpServerSecrets {
  /** The origin these secrets were issued for (MCP-LINK H2). A key or token is
   * sent only to that origin; a doc with no origin is sent nowhere. */
  origin?: string;
  headers?: Record<string, string>;
  /** The full link, when the stored link is masked or holds a key. */
  url?: string;
  /** `issuedAt` (when main obtained this token) and `scope` are not secrets. A
   * mid-turn sign-in card is settled only by a token issued after the card. */
  oauth?: { accessToken: string; expiresAt?: number; issuedAt?: number; signedInAt?: number; scope?: string };
  /** A command server's env values (MCP-LINK T16). Merged at mount time into
   * the names its entry marks `true`; never part of a link server's request. */
  env?: Record<string, string>;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const store = new Map<string, McpServerSecrets>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Keep only the fields the harness may hold, whatever a caller sent: header
 * values, the link, and the access token with its expiry. A refresh token, a
 * client secret or anything else is dropped here, not trusted to be absent. */
export function sanitizeSecretDoc(raw: unknown): McpServerSecrets | null {
  if (!isRecord(raw)) return null;
  const out: McpServerSecrets = {};
  if (typeof raw.origin === "string") {
    try {
      const parsed = new URL(raw.origin);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") out.origin = parsed.origin;
    } catch {
      // not an origin: the doc stays unbound
    }
  }
  if (isRecord(raw.headers)) {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(raw.headers)) {
      if (name !== "__proto__" && typeof value === "string" && value) Object.defineProperty(headers, name, { value, enumerable: true, writable: true, configurable: true });
    }
    if (Object.keys(headers).length > 0) out.headers = headers;
  }
  if (typeof raw.url === "string" && raw.url) out.url = raw.url;
  if (isRecord(raw.oauth) && typeof raw.oauth.accessToken === "string" && raw.oauth.accessToken) {
    const { expiresAt, issuedAt, signedInAt, scope } = raw.oauth;
    out.oauth = {
      accessToken: raw.oauth.accessToken,
      ...(typeof expiresAt === "number" && Number.isFinite(expiresAt) ? { expiresAt } : {}),
      ...(typeof issuedAt === "number" && Number.isFinite(issuedAt) ? { issuedAt } : {}),
      ...(typeof signedInAt === "number" && Number.isFinite(signedInAt) ? { signedInAt } : {}),
      ...(typeof scope === "string" && scope && scope.length <= 2_000 && /^[\x20-\x7e]+$/.test(scope) ? { scope } : {}),
    };
  }
  if (isRecord(raw.env)) {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(raw.env)) {
      if (ENV_NAME.test(name) && !isHarnessOwnedMcpEnvName(name) && typeof value === "string" && value.length <= 16_384) {
        Object.defineProperty(env, name, { value, enumerable: true, writable: true, configurable: true });
      }
    }
    if (Object.keys(env).length > 0) out.env = env;
  }
  // An origin alone is not a secret.
  return out.headers || out.url || out.oauth || out.env ? out : null;
}

/** True when these secrets were issued for the origin of `url`. The one rule
 * that decides whether a stored key, link or token may be sent anywhere. */
export function secretsBoundTo(doc: McpServerSecrets | undefined, url: string): boolean {
  return doc !== undefined && doc.origin !== undefined && sameOrigin(doc.origin, url);
}

/** Read the boot secrets from the environment ONCE and delete the variable. A
 * second call finds nothing. Unreadable JSON loads nothing and says nothing
 * about its content. */
export function loadMcpSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): { loaded: number } {
  const raw = env[MCP_SECRETS_ENV];
  delete env[MCP_SECRETS_ENV];
  if (!raw) return { loaded: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { loaded: 0 };
  }
  if (!isRecord(parsed)) return { loaded: 0 };
  replaceAllMcpServerSecrets(parsed);
  return { loaded: store.size };
}

/** Replace everything (a full push from main after the server starts). */
export function replaceAllMcpServerSecrets(all: Record<string, unknown>): void {
  store.clear();
  for (const [name, doc] of Object.entries(all)) {
    const clean = sanitizeSecretDoc(doc);
    if (clean) store.set(name, clean);
  }
}

interface TokenWaiter {
  name: string;
  previous: string | undefined;
  resolve: (token: string | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
}
const tokenWaiters = new Set<TokenWaiter>();

function settleWaiters(name: string): void {
  const current = store.get(name)?.oauth?.accessToken;
  for (const waiter of [...tokenWaiters]) {
    if (waiter.name === name && current !== undefined && current !== waiter.previous) {
      clearTimeout(waiter.timer);
      tokenWaiters.delete(waiter);
      waiter.resolve(current);
    }
  }
}

/** Wait up to `timeoutMs` for main to push an access token different from
 * `previous` (after the harness reported one rejected). Resolves to the new
 * token, or undefined on timeout. A call that hit a 401 waits here once, then
 * retries once; it never loops. */
export function waitForNewAccessToken(name: string, previous: string | undefined, timeoutMs: number): Promise<string | undefined> {
  const current = store.get(name)?.oauth?.accessToken;
  if (current !== undefined && current !== previous) return Promise.resolve(current);
  return new Promise((resolve) => {
    const waiter: TokenWaiter = {
      name, previous, resolve,
      timer: setTimeout(() => { tokenWaiters.delete(waiter); resolve(undefined); }, timeoutMs),
    };
    waiter.timer.unref?.();
    tokenWaiters.add(waiter);
  });
}

/** Set or merge one server's secrets (a push from main). An empty result removes the entry. */
export function setMcpServerSecrets(name: string, doc: unknown): void {
  const clean = sanitizeSecretDoc(doc);
  if (clean) store.set(name, clean);
  else store.delete(name);
  settleWaiters(name);
}

function releaseWaiters(match: (waiter: TokenWaiter) => boolean): void {
  for (const waiter of [...tokenWaiters]) {
    if (match(waiter)) {
      clearTimeout(waiter.timer);
      tokenWaiters.delete(waiter);
      waiter.resolve(undefined);
    }
  }
}

export function clearMcpServerSecrets(name: string): void {
  store.delete(name);
  releaseWaiters((waiter) => waiter.name === name);
}

export function clearAllMcpServerSecrets(): void {
  store.clear();
  releaseWaiters(() => true);
}

export function getMcpServerSecrets(name: string): McpServerSecrets | undefined {
  return store.get(name);
}

/** When the held access token was issued and the scope it carries: what the
 * sign-in card asks to tell a new sign-in from the one it was posted for.
 * Never the token. */
export function heldSignInFacts(name: string): { issuedAt?: number; signedInAt?: number; scope?: string } {
  const oauth = store.get(name)?.oauth;
  return {
    ...(oauth?.issuedAt !== undefined ? { issuedAt: oauth.issuedAt } : {}),
    ...(oauth?.signedInAt !== undefined ? { signedInAt: oauth.signedInAt } : {}),
    ...(oauth?.scope !== undefined ? { scope: oauth.scope } : {}),
  };
}

/** The access token if it is held and not past its expiry. */
export function currentAccessToken(name: string, now: number = Date.now()): string | undefined {
  const token = store.get(name)?.oauth;
  if (!token) return undefined;
  return token.expiresAt !== undefined && token.expiresAt <= now ? undefined : token.accessToken;
}

/** True when the store holds env value `key` for command server `name`. */
export function mcpEnvHeld(name: string, key: string): boolean {
  const env = store.get(name)?.env;
  return env !== undefined && Object.hasOwn(env, key);
}

/** A command server's env with its held values filled in (T16), and the held
 * names whose value is nowhere. */
export function resolveHeldEnv(name: string, server: StoredMcpServer): { env: Record<string, string>; missing: string[] } {
  const env: Record<string, string> = { ...server.env };
  const missing: string[] = [];
  const held = store.get(name)?.env;
  for (const key of server.heldEnv ?? []) {
    if (held && Object.hasOwn(held, key)) env[key] = held[key]!;
    else missing.push(key);
  }
  return { env, missing };
}

/** What a listing needs to say "ready" or "needs sign-in": presence, never a value. */
export function mcpSecretPresence(): McpSecretPresence {
  return {
    hasEnv: (name, key) => mcpEnvHeld(name, key),
    hasHeader: (name, header, entryUrl) => {
      const doc = store.get(name);
      return Boolean(doc?.headers && Object.hasOwn(doc.headers, header) && (entryUrl === undefined || secretsBoundTo(doc, entryUrl)));
    },
    hasOAuth: (name, entryUrl) => {
      const doc = store.get(name);
      return doc?.oauth !== undefined && (entryUrl === undefined || secretsBoundTo(doc, entryUrl));
    },
  };
}

/** The link to dial. The stored full link is used ONLY when the entry's own link
 * is a masked placeholder for it, and only while it was issued for the entry's
 * origin: an edited link is never overridden by a stored one. A masked link with
 * no usable stored copy cannot be dialed: null. */
export function resolveDialUrl(name: string, server: StoredRemoteMcpServer): string | null {
  if (!isMaskedStoredUrl(server)) return server.url;
  const doc = store.get(name);
  const held = doc?.url;
  if (held && secretsBoundTo(doc, server.url) && sameOrigin(held, server.url)) return held;
  return null;
}

export interface ResolvedAuth {
  headers: Record<string, string>;
  bearer?: string;
  /** Header names the entry lists whose value is nowhere to be found. */
  missing: string[];
}

/** The credentials to send for a server: stored header values (or the dev
 * fallback strings in config.json) and the current access token. */
export function resolveRequestAuth(name: string, server: StoredRemoteMcpServer, now: number = Date.now()): ResolvedAuth {
  const doc = store.get(name);
  // Stored values are sent only to the origin they were issued for.
  const bound = secretsBoundTo(doc, server.url);
  const held = bound ? doc?.headers ?? {} : {};
  const headers: Record<string, string> = {};
  const missing: string[] = [];
  for (const [header, configured] of Object.entries(server.headers)) {
    const value = Object.hasOwn(held, header) ? held[header] : typeof configured === "string" && configured ? configured : undefined;
    if (value === undefined) missing.push(header);
    else Object.defineProperty(headers, header, { value, enumerable: true, writable: true, configurable: true });
  }
  const bearer = server.auth === "oauth" && bound ? currentAccessToken(name, now) : undefined;
  return { headers, ...(bearer ? { bearer } : {}), missing };
}
