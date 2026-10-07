// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// What the Connect Netlify card does, apart from how it looks. Two ways in:
//   1. sign in through the same remote sign-in every link server uses, then ask
//      the server whether Netlify's own API accepts that sign-in (it may not);
//   2. paste an access token. With the desktop shell the value goes straight to
//      its secret store (the same call every other secret uses) and never into
//      a request body, a message or a log. A dev launch without the shell keeps
//      it in the harness's own store, as every other local-config secret.
// Every result is a small state the card words; none contains a token.
import { NETLIFY_LINK_ENTRY, NETLIFY_TOKEN_ENTRY } from "../../shared/published-sites";
import type { ApiFn } from "./mcp-add-flow";
import type { McpBridge } from "./mcp-bridge";

export interface ConnectDeps { api: ApiFn; bridge?: McpBridge }
/** The chat and the card being settled. The server finds the bot from the chat. */
export interface ConnectContext { botId?: string; threadId: string; messageId: string }
export type NeedsTokenWhy = "sign-in-not-enough" | "no-shell" | "token-rejected" | "token-shape" | "unreachable" | "save-failed";
export type ConnectResult =
  | { state: "connected"; via: "sign-in" | "token" }
  | { state: "start"; error?: string; problem?: "unreachable" }
  | { state: "needs-token"; why: NeedsTokenWhy; error?: string };

const NETLIFY_MCP_URL = "https://netlify-mcp.netlify.app/mcp";
const ENV = "NETLIFY_AUTH_TOKEN";

/** The pasted value without surrounding space, or null when it cannot be an access token. */
export function readableToken(value: string): string | null {
  const token = String(value ?? "").trim();
  return token.length >= 8 && token.length <= 512 && /^[\x21-\x7e]+$/.test(token) ? token : null;
}

const taken = (error: unknown) => (error as { status?: number } | null)?.status === 409;

/** Ask the server whether Netlify accepts the connection, and settle the card. */
async function check(deps: ConnectDeps, context: ConnectContext, via: "sign-in" | "token"): Promise<ConnectResult> {
  let answer: { connected?: boolean; via?: "sign-in" | "token"; reason?: string };
  try { answer = await deps.api("/api/publish/netlify/check", { method: "POST", body: JSON.stringify(context) }); }
  catch { return via === "token" ? { state: "needs-token", why: "unreachable" } : { state: "start", problem: "unreachable" }; }
  if (answer?.connected) return { state: "connected", via: answer.via ?? via };
  if (answer?.reason === "unreachable") return via === "token" ? { state: "needs-token", why: "unreachable" } : { state: "start", problem: "unreachable" };
  return via === "token" ? { state: "needs-token", why: "token-rejected" } : { state: "needs-token", why: "sign-in-not-enough" };
}

export async function connectWithSignIn(deps: ConnectDeps, context: ConnectContext): Promise<ConnectResult> {
  if (!deps.bridge) return { state: "needs-token", why: "no-shell" };
  try {
    await deps.api("/api/mcp/servers", { method: "POST", body: JSON.stringify({ name: NETLIFY_LINK_ENTRY, url: NETLIFY_MCP_URL, auth: "oauth", enabled: false }) });
  } catch (error) {
    if (!taken(error)) return { state: "start", error: error instanceof Error ? error.message : String(error) };
    // An entry that was already there is switched off: Netlify's own tools stay out of the bots' reach.
    try { await deps.api(`/api/mcp/servers/${encodeURIComponent(NETLIFY_LINK_ENTRY)}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) }); }
    catch (failure) { return { state: "start", error: failure instanceof Error ? failure.message : String(failure) }; }
  }
  const signedIn = await deps.bridge.signIn(NETLIFY_LINK_ENTRY);
  if (!signedIn.ok) return signedIn.error === "cancelled" ? { state: "start" } : { state: "start", error: signedIn.message };
  return check(deps, context, "sign-in");
}

export async function connectWithToken(deps: ConnectDeps, pasted: string, context: ConnectContext): Promise<ConnectResult> {
  const token = readableToken(pasted);
  if (!token) return { state: "needs-token", why: "token-shape" };
  const entry = { name: NETLIFY_TOKEN_ENTRY, command: "node", args: ["-e", "0"], enabled: false };
  try {
    await deps.api("/api/mcp/servers", { method: "POST", body: JSON.stringify({ ...entry, env: { [ENV]: deps.bridge ? true : token } }) });
  } catch (error) {
    if (!taken(error)) return { state: "needs-token", why: "save-failed", error: error instanceof Error ? error.message : String(error) };
    // Only Murage's own inert entry may receive the value; anything else under this name is left alone.
    try {
      const listed = await deps.api("/api/mcp/servers") as { servers?: Array<{ name?: string; command?: string; args?: string[] }> };
      const mine = listed.servers?.find(item => item.name === NETLIFY_TOKEN_ENTRY);
      if (!mine || mine.command !== entry.command || JSON.stringify(mine.args) !== JSON.stringify(entry.args)) return { state: "needs-token", why: "save-failed" };
      await deps.api(`/api/mcp/servers/${encodeURIComponent(NETLIFY_TOKEN_ENTRY)}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    } catch (failure) { return { state: "needs-token", why: "save-failed", error: failure instanceof Error ? failure.message : String(failure) }; }
    // Already there: with the shell, only the held value changes; without it, the entry is rewritten.
    if (!deps.bridge) {
      try {
        const { name: _name, ...body } = entry;
        await deps.api(`/api/mcp/servers/${encodeURIComponent(NETLIFY_TOKEN_ENTRY)}`, { method: "PUT", body: JSON.stringify({ ...body, env: { [ENV]: token }, keepSavedValues: false }) });
      } catch (failure) { return { state: "needs-token", why: "save-failed", error: failure instanceof Error ? failure.message : String(failure) }; }
    }
  }
  if (deps.bridge) {
    const saved = await deps.bridge.saveSecrets(NETLIFY_TOKEN_ENTRY, { env: { [ENV]: token } });
    if (!saved.ok) return { state: "needs-token", why: "save-failed", error: saved.message };
  }
  return check(deps, context, "token");
}
