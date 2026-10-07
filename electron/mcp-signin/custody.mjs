// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where main keeps the secrets of the owner's own MCP servers (MCP-LINK 3.4):
// `mcpServerSecrets` in credentials.bin, one document per server name, written
// only through the one serialized credential writer. A document holds:
//   origin      the address its secrets were issued for (link servers)
//   headers     header name -> value (link servers)
//   url         the full link when it holds a key (link servers)
//   env         environment name -> value (command servers, T16)
//   oauth       issuer, client registration, endpoints, tokens (link servers)
//   savedAt     when main last wrote it
// The harness is handed only projectMcpServerSecrets(doc): header values, the
// link, env values and the access token (with when it was issued and its
// scope). The refresh token, the client registration and the endpoints never
// leave this process.
import { dropMcpServerSecrets, projectMcpServerSecrets } from "../workspace-credentials.mjs";

export const MCP_SECRETS_KEY = "mcpServerSecrets";
export const SERVER_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function readServerDoc(credentials, name) {
  const store = credentials?.[MCP_SECRETS_KEY];
  if (!isRecord(store) || !Object.hasOwn(store, name)) return undefined;
  return isRecord(store[name]) ? structuredClone(store[name]) : undefined;
}

export function serverNames(credentials) {
  const store = credentials?.[MCP_SECRETS_KEY];
  return isRecord(store) ? Object.keys(store).filter((name) => SERVER_NAME.test(name)) : [];
}

/** credentials with one server's document replaced (null removes it). The input is not changed. */
export function withServerDoc(credentials, name, doc) {
  const store = isRecord(credentials?.[MCP_SECRETS_KEY]) ? { ...credentials[MCP_SECRETS_KEY] } : {};
  if (doc === null) delete store[name];
  else Object.defineProperty(store, name, { value: doc, enumerable: true, writable: true, configurable: true });
  return { ...credentials, [MCP_SECRETS_KEY]: store };
}

/** What the harness may hold for one document, or null when nothing. */
export function projectDoc(doc) {
  if (!isRecord(doc)) return null;
  return projectMcpServerSecrets({ doc }).doc ?? null;
}

/** The OAuth record with every token removed: the client registration is kept,
 * so signing in again does not register a new client. */
export function clientOnly(oauth) {
  if (!isRecord(oauth)) return undefined;
  const { accessToken: _a, refreshToken: _r, expiresAt: _e, issuedAt: _i, signedInAt: _s, ...rest } = oauth;
  void _a; void _r; void _e; void _i; void _s;
  return rest;
}

/**
 * `murage:mcp-secrets-stale {name, at}` from the harness: a server was removed,
 * or its link or sign-in kind changed. Drop main's copy, unless it was saved at
 * or after `at` (a save the owner made after the change, NEXT-T11 L-f). A drop
 * that fails is logged with the server name and nothing else.
 */
export async function handleSecretsStale(message, { updateDocument, log }) {
  const name = message?.name;
  if (typeof name !== "string" || !SERVER_NAME.test(name)) return false;
  const at = typeof message.at === "number" && Number.isFinite(message.at) ? message.at : undefined;
  try {
    await updateDocument((credentials) => dropMcpServerSecrets(credentials, name, at));
    return true;
  } catch {
    log?.(`mcp server ${name}: its saved secrets could not be dropped`);
    return false;
  }
}

/** The OAuth record after the token endpoint rejected its client (`invalid_client`):
 * the client registration and the refresh token issued to it are dropped, so the
 * next sign-in registers a new client. The access token is kept until it expires. */
export function withoutClient(oauth) {
  if (!isRecord(oauth)) return undefined;
  const { clientId: _c, clientSecret: _s, refreshToken: _r, redirectPort: _p, ...rest } = oauth;
  void _c; void _s; void _r; void _p;
  return rest;
}
