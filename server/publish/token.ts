// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Where the Netlify bearer comes from. Two sources, both held with the other
// link-server secrets (memory only in the packaged app; see mcp-secrets.ts):
//   1. a personal access token the owner pasted, held as the secret entry
//      NETLIFY_PAT_SERVER (env NETLIFY_AUTH_TOKEN);
//   2. the access token from the Netlify MCP sign-in, when a link points at
//      the Netlify MCP (switched on or off) and the token has not expired.
// The token is returned to the adapter and nowhere else.
import { NETLIFY_LINK_ENTRY, NETLIFY_TOKEN_ENTRY } from "../../shared/published-sites.ts";
import { currentAccessToken, getMcpServerSecrets } from "../mcp-secrets.ts";

export const NETLIFY_PAT_SERVER = NETLIFY_TOKEN_ENTRY;
const NETLIFY_MCP_ORIGIN = "https://netlify-mcp.netlify.app";

export function netlifyToken(servers: Record<string, unknown> | undefined, now: number = Date.now()): string | undefined {
  const pasted = getMcpServerSecrets(NETLIFY_PAT_SERVER)?.env?.NETLIFY_AUTH_TOKEN?.trim();
  if (pasted) return pasted;
  for (const [name, server] of Object.entries(servers ?? {})) {
    // A link kept switched off still counts: Connect Netlify adds it that way on purpose, so the bots
    // are not handed Netlify's own deploy tools (which would skip the owner's approval card).
    const entry = server as { url?: unknown } | null;
    if (!entry || typeof entry !== "object" || typeof entry.url !== "string") continue;
    let origin = "";
    try { origin = new URL(entry.url).origin; } catch { continue; }
    if (origin !== NETLIFY_MCP_ORIGIN) continue;
    const token = currentAccessToken(name, now);
    if (token) return token;
  }
  return undefined;
}

/** The link Connect Netlify adds so the owner can sign in. */
export const NETLIFY_MCP_URL = `${NETLIFY_MCP_ORIGIN}/mcp`;
export const NETLIFY_LINK_NAME = NETLIFY_LINK_ENTRY;

/** Which way Netlify is connected right now, without the token. */
export function netlifyConnection(servers: Record<string, unknown> | undefined, now: number = Date.now()): "token" | "sign-in" | undefined {
  if (getMcpServerSecrets(NETLIFY_PAT_SERVER)?.env?.NETLIFY_AUTH_TOKEN?.trim()) return "token";
  return netlifyToken(servers, now) ? "sign-in" : undefined;
}
