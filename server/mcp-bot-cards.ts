// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The cards of a server a bot filed switched off (item 118, design MCP-118-175
// 118-3): one "Turn on <name>?" approval card and one credential card per
// pending key, `mcp:<name>:<KEY>:<rev>`. Every save and every Turn on resolves
// the card against the stored entry again: it must exist, its revision must be
// the card's, and the key must be a slot it declares. Anything else saves
// nothing and closes the card with MCP_CARD_STALE. Names and addresses only;
// no value passes through here except on the dev/headless fallback, which
// writes it to config.json exactly as the Settings form does there.
import { MCP_CARD_STALE, mcpCredentialCardText, mcpCredentialId, parseMcpCredentialId } from "../shared/credential-request.ts";
import {
  isRemoteMcpServer,
  mcpDeclaredKeys,
  mcpEntryRev,
  mcpPendingKeys,
  parseAnyStoredMcpServer,
  type AnyStoredMcpServer,
} from "./mcp-registry.ts";
import { mcpSecretPresence, resolveHeldEnv, resolveRequestAuth } from "./mcp-secrets.ts";

export { MCP_CARD_STALE };

/** What a "Turn on <name>?" card carries (card.kind === "mcpEnable"). */
export interface McpEnableCardData {
  name: string;
  rev: string;
  /** The bot that filed it, by id and name. */
  botId: string;
  bot: string;
  kind: "stdio" | "remote";
  command?: string;
  args?: string[];
  url?: string;
  transport?: "http" | "sse";
  /** Key names the owner still enters on their cards. */
  pendingKeys: string[];
  /** Set when the owner turned it on from this card. */
  enabled?: boolean;
  error?: string;
}

export type McpCardResolution =
  | { ok: true; server: AnyStoredMcpServer }
  | { ok: false; stale: true };

/** Resolve a card's (name, rev, key?) against the stored MCP map. */
export function resolveMcpCard(servers: Record<string, unknown> | undefined, name: string, rev: string, key?: string): McpCardResolution {
  const raw = servers?.[name];
  if (raw === undefined) return { ok: false, stale: true };
  const parsed = parseAnyStoredMcpServer(name, raw, { envHeld: () => true });
  if (!parsed.ok || mcpEntryRev(name, parsed.server) !== rev) return { ok: false, stale: true };
  if (key !== undefined && !mcpDeclaredKeys(parsed.server).includes(key)) return { ok: false, stale: true };
  return { ok: true, server: parsed.server };
}

/** Resolve a dynamic credential id. Null when it is not one. */
export function resolveMcpCredential(servers: Record<string, unknown> | undefined, id: unknown): (McpCardResolution & { name: string; key: string; rev: string }) | null {
  const parsed = parseMcpCredentialId(id);
  if (!parsed) return null;
  return { ...resolveMcpCard(servers, parsed.name, parsed.rev, parsed.key), ...parsed };
}

/** Why `server` may not be turned on yet, or null (118-3): a pending key, or,
 * for an entry a bot filed, a held env value that is nowhere (resolveHeldEnv)
 * or a header whose value is not held for this server's origin
 * (resolveRequestAuth, origin-bound). */
export function mcpEnableRefusal(name: string, server: AnyStoredMcpServer): string | null {
  const pending = mcpPendingKeys(server);
  if (pending.length > 0) return `Enter ${pending[0]} on its card before turning ${name} on.`;
  // The held-value check covers an entry a bot filed (it carries a rev): its keys
  // left pending only when a value was saved. An owner's own entry keeps its
  // switch as before (turn on first, enter the key after).
  if (!server.rev) return null;
  if (!isRemoteMcpServer(server)) {
    const held = resolveHeldEnv(name, server);
    return held.missing.length > 0 ? `This server needs a value for ${held.missing[0]}. Enter it again.` : null;
  }
  if (server.auth !== "header") return null;
  const auth = resolveRequestAuth(name, server);
  return auth.missing.length > 0 ? `This server needs a value for ${auth.missing[0]}. Enter it again.` : null;
}

/** True when the value for `key` is held for this entry (packaged: the secret
 * store, origin-bound for a header; dev/headless: the entry's own literal). */
export function mcpKeyHeld(name: string, server: AnyStoredMcpServer, key: string): boolean {
  if (isRemoteMcpServer(server)) {
    const configured = server.headers[key];
    if (typeof configured === "string" && configured.length > 0) return true;
    return mcpSecretPresence().hasHeader(name, key, server.url);
  }
  if (typeof server.env[key] === "string") return true;
  return mcpSecretPresence().hasEnv?.(name, key) === true;
}

/** The entry with `key` moved from pending to held (`true` in config.json). */
export function withKeyHeld(server: AnyStoredMcpServer, key: string): AnyStoredMcpServer {
  if (isRemoteMcpServer(server)) {
    const pendingHeaders = (server.pendingHeaders ?? []).filter((header) => header !== key);
    const { pendingHeaders: _old, ...rest } = server;
    void _old;
    const headers = Object.hasOwn(server.headers, key) ? server.headers : { ...server.headers, [key]: true as const };
    return { ...rest, headers, ...(pendingHeaders.length > 0 ? { pendingHeaders } : {}) };
  }
  const pendingEnv = (server.pendingEnv ?? []).filter((name) => name !== key);
  const { pendingEnv: _old, ...rest } = server;
  void _old;
  const held = server.heldEnv ?? [];
  const heldEnv = typeof server.env[key] === "string" || held.includes(key) ? held : [...held, key];
  return { ...rest, ...(heldEnv.length > 0 ? { heldEnv } : {}), ...(pendingEnv.length > 0 ? { pendingEnv } : {}) };
}

/** Dev/headless fallback (no desktop shell): the value goes into the entry, as
 * the Settings form puts it there in that run (mcp-secrets.ts header). */
export function withKeyValue(server: AnyStoredMcpServer, key: string, value: string): AnyStoredMcpServer {
  if (isRemoteMcpServer(server)) {
    const pendingHeaders = (server.pendingHeaders ?? []).filter((header) => header !== key);
    const { pendingHeaders: _old, ...rest } = server;
    void _old;
    return { ...rest, headers: { ...server.headers, [key]: value }, ...(pendingHeaders.length > 0 ? { pendingHeaders } : {}) };
  }
  const pendingEnv = (server.pendingEnv ?? []).filter((name) => name !== key);
  const heldEnv = (server.heldEnv ?? []).filter((name) => name !== key);
  const { pendingEnv: _old, heldEnv: _held, ...rest } = server;
  void _old; void _held;
  return { ...rest, env: { ...server.env, [key]: value }, ...(heldEnv.length > 0 ? { heldEnv } : {}), ...(pendingEnv.length > 0 ? { pendingEnv } : {}) };
}

/** The approval card for a just-filed entry. */
export function mcpEnableCard(name: string, server: AnyStoredMcpServer, rev: string, bot: { id: string; name: string }): { title: string; subtitle: string; options: string[]; kind: "mcpEnable"; mcpEnable: McpEnableCardData } {
  const remote = isRemoteMcpServer(server);
  return {
    kind: "mcpEnable",
    title: `Turn on ${name}?`,
    subtitle: remote
      ? `${bot.name} added a server at ${server.url} (${server.transport ?? "http"}). It stays off until you turn it on.`
      : `${bot.name} added a command that runs on this computer: ${[server.command, ...server.args].join(" ")}. It stays off until you turn it on.`,
    options: ["Turn on", "Not now"],
    mcpEnable: {
      name, rev, botId: bot.id, bot: bot.name,
      ...(remote ? { kind: "remote" as const, url: server.url, transport: server.transport ?? "http" } : { kind: "stdio" as const, command: server.command, args: [...server.args] }),
      pendingKeys: mcpPendingKeys(server),
    },
  };
}

/** One credential card per pending key, bound to the entry's revision. */
export function mcpCredentialCards(name: string, server: AnyStoredMcpServer, rev: string): Array<{ target: ReturnType<typeof mcpCredentialId>; label: string; description: string; placeholder: string; helpUrl: string }> {
  return mcpPendingKeys(server).map((key) => ({ target: mcpCredentialId(name, key, rev), ...mcpCredentialCardText(name, key), helpUrl: "" }));
}

/** The minimal database surface (node:sqlite's DatabaseSync fits). */
export interface McpCardDatabase {
  prepare(sql: string): { all(...params: Array<string | number | null>): unknown[] };
}

/** Every open card of server `name`: credential cards not provided or
 * dismissed, and Turn on cards not answered or dismissed. Read from the saved
 * messages, so a restart loses none. */
export function openMcpCards(db: McpCardDatabase, name: string): Array<{ threadId: string; messageId: string; kind: "secret" | "options" }> {
  const prefix = `mcp:${name}:`;
  const secrets = db.prepare(`SELECT thread_id, id FROM messages
    WHERE kind='secret' AND substr(json_extract(json,'$.secret.target'),1,?)=?
      AND COALESCE(json_extract(json,'$.secret.provided'),0)=0
      AND COALESCE(json_extract(json,'$.secret.dismissed'),0)=0
    ORDER BY at, rowid`).all(prefix.length, prefix) as Array<{ thread_id: string; id: string }>;
  const enables = db.prepare(`SELECT thread_id, id FROM messages
    WHERE kind='options' AND json_extract(json,'$.card.kind')='mcpEnable' AND json_extract(json,'$.card.mcpEnable.name')=?
      AND json_extract(json,'$.card.answered') IS NULL
      AND COALESCE(json_extract(json,'$.card.dismissed'),0)=0
    ORDER BY at, rowid`).all(name) as Array<{ thread_id: string; id: string }>;
  return [
    ...secrets.map((row) => ({ threadId: row.thread_id, messageId: row.id, kind: "secret" as const })),
    ...enables.map((row) => ({ threadId: row.thread_id, messageId: row.id, kind: "options" as const })),
  ];
}
