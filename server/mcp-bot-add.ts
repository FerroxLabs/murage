// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A bot files an MCP server switched off (item 118, design MCP-118-175 118-1,
// 118-2). Adapted from OpenMausBot 45401f491 `addDisabledMcpServer`
// (Apache-2.0, see NOTICE); rewritten for Murage: a bot sends NAMES and
// addresses only, never a value, and every key it names becomes a pending slot
// the owner fills on a card. The screen here runs before the shared registry
// parser and is the same in packaged, dev and headless runs.
import { urlHasSecret } from "../shared/mcp-secret-url.mjs";
import {
  MAX_MCP_SERVERS,
  isHarnessOwnedMcpEnvName,
  isRefusedMcpHeaderName,
  mcpEntryRev,
  mcpServerNameError,
  parseAnyStoredMcpServer,
  toStoredMcpEntry,
  type AnyStoredMcpServer,
} from "./mcp-registry.ts";
import { BEARER_TOKEN, KEY_PREFIXES, PEM_PRIVATE_KEY } from "./redact.ts";

/** The one sentence every value-shaped refusal ends with. */
export const BOT_MCP_NAMES_ONLY = "Send names and addresses only; the owner enters every value on a card";

const BOT_ENV_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
const BOT_HEADER_KEY = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
/** `--token`, `--api-key`, `--password` and their spellings, as a flag. */
const SECRET_FLAG = /^--?(?:token|api[-_]?key|apikey|key|k|auth|authorization|password|passwd|secret|client[-_]?secret|access[-_]?token|auth[-_]?token|bearer)(?:=(.*))?$/i;
/** A Basic or Bearer header literal, whether one token or split across arguments. */
const AUTH_HEADER_LITERAL = /\b(?:basic|bearer)\s+[A-Za-z0-9._~+\/=-]{4,}/i;
/** `scheme://user:pass@host`: credentials in a URL's userinfo. */
const URL_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^\s\/?#@:]*:[^\s\/?#@]+@/i;
/** Bot-filed servers still off and unreviewed that one bot may leave waiting. */
export const MAX_WAITING_BOT_MCP_SERVERS = 3;
export const BOT_MCP_WAITING_MESSAGE = `You already have ${MAX_WAITING_BOT_MCP_SERVERS} servers waiting for the owner. Ask the owner to review those first, then add more.`;
const ALLOWED_FIELDS = new Set(["name", "command", "args", "env_keys", "url", "transport", "auth", "header_keys"]);
const MAX_ARGS = 64;
const MAX_KEYS = 16;

export type BotMcpAddResult =
  | { ok: true; name: string; server: AnyStoredMcpServer; entry: Record<string, unknown>; rev: string }
  | { ok: false; status: 400 | 409; error: string };

const refuse = (error: string, status: 400 | 409 = 400): BotMcpAddResult => ({ ok: false, status, error });
const namesOnly = (what: string): BotMcpAddResult => refuse(`${what}. ${BOT_MCP_NAMES_ONLY}.`);

/** True when one token carries a credential: a known key prefix, a PEM
 * private-key header or a bearer-looking token. */
function credentialShaped(token: string): boolean {
  if (PEM_PRIVATE_KEY.test(token) || BEARER_TOKEN.test(token)) return true;
  return KEY_PREFIXES.some((pattern) => token.search(pattern) !== -1);
}

/** Why a command string or argument list is refused, or null. Each whitespace
 * token is checked, the joined text is checked for a bearer pair split across
 * arguments, and a secret-style flag is refused when a value follows it or is
 * joined to it with `=`. */
export function commandCredentialRefusal(command: string, args: readonly string[]): string | null {
  const tokens = [...command.split(/\s+/), ...args.flatMap((arg) => arg.split(/\s+/))].filter(Boolean);
  const joined = [command, ...args].join(" ");
  if (tokens.some(credentialShaped) || credentialShaped(joined)) return "This command carries a key";
  if (AUTH_HEADER_LITERAL.test(joined) || tokens.some((token) => URL_USERINFO.test(token))) return "This command carries a key";
  for (let index = 0; index < tokens.length; index++) {
    const flag = SECRET_FLAG.exec(tokens[index]!);
    if (!flag) continue;
    if (flag[1] !== undefined ? flag[1].length > 0 : index + 1 < tokens.length) return "This command carries a key";
  }
  return null;
}

function stringList(value: unknown, pattern: RegExp, label: string, extra?: (name: string) => string | null): { ok: true; value: string[] } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.length > MAX_KEYS || value.some((item) => typeof item !== "string")) {
    return { ok: false, error: `${label} must be a list of at most ${MAX_KEYS} names` };
  }
  const names = value as string[];
  for (const name of names) {
    if (!pattern.test(name)) return { ok: false, error: `${label} “${name}” is not a valid name` };
    const refused = extra?.(name);
    if (refused) return { ok: false, error: refused };
  }
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) return { ok: false, error: `${label} lists a name twice` };
  return { ok: true, value: [...names] };
}

/** How many servers `botName` filed that are still off and unreviewed: filed by a
 * bot (they carry a rev) and not yet turned on by the owner. */
export function waitingBotServers(current: Record<string, unknown>, botName: string): number {
  const reason = botFiledReason(botName);
  return Object.values(current).filter((entry) => {
    const record = entry as Record<string, unknown> | null;
    return record !== null && typeof record === "object" && record.enabled === false && typeof record.rev === "string" && record.disabledReason === reason;
  }).length;
}

const botFiledReason = (botName: string): string => `Added by ${botName.trim().slice(0, 120) || "a bot"}; turn on to use it`;

/**
 * Build the disabled entry a bot asked for, or refuse. `current` is the stored
 * MCP map; `botName` words the disabledReason. Nothing is written here: the
 * caller persists `entry` under mcpConfigBusy. A refusal means no server.
 */
export function addBotMcpServer(current: Record<string, unknown>, body: unknown, botName: string): BotMcpAddResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) return refuse("Expected an MCP server with a name");
  const record = body as Record<string, unknown>;
  if (Object.hasOwn(record, "enabled")) return refuse("A bot cannot turn a server on. It is saved off and only the owner turns it on");
  for (const key of Object.keys(record)) {
    if (!ALLOWED_FIELDS.has(key)) {
      return key === "env" || key === "headers" || key === "oauth" ? namesOnly(`“${key}” carries values`) : refuse(`Unknown field “${key}”`);
    }
  }
  const name = typeof record.name === "string" ? record.name : "";
  const nameError = mcpServerNameError(name, Object.keys(current));
  if (nameError) return refuse(nameError);
  if (Object.hasOwn(current, name)) return refuse("A connected tool with that name already exists. Pick another name.", 409);
  if (Object.keys(current).length >= MAX_MCP_SERVERS) return refuse(`You can add up to ${MAX_MCP_SERVERS} connected tools. Remove one to add another.`);
  const hasCommand = record.command !== undefined;
  const hasUrl = record.url !== undefined;
  if (hasCommand === hasUrl) return refuse("Send either a command or a url");
  if (waitingBotServers(current, botName) >= MAX_WAITING_BOT_MCP_SERVERS) return refuse(BOT_MCP_WAITING_MESSAGE, 409);
  const disabledReason = botFiledReason(botName);

  let raw: Record<string, unknown>;
  if (hasCommand) {
    if (record.transport !== undefined || record.auth !== undefined || record.header_keys !== undefined) return refuse("A command server takes command, args and env_keys only");
    if (typeof record.command !== "string" || !record.command.trim()) return refuse("command must be text");
    const args = record.args ?? [];
    if (!Array.isArray(args) || args.length > MAX_ARGS || args.some((arg) => typeof arg !== "string")) return refuse(`args must be a list of at most ${MAX_ARGS} strings`);
    const refusal = commandCredentialRefusal(record.command, args as string[]);
    if (refusal) return namesOnly(refusal);
    const envKeys = stringList(record.env_keys, BOT_ENV_KEY, "env_keys", (key) => isHarnessOwnedMcpEnvName(key) ? `env_keys “${key}” is reserved by Murage` : null);
    if (!envKeys.ok) return refuse(envKeys.error);
    raw = { command: record.command, args, env: {}, ...(envKeys.value.length ? { pendingEnv: envKeys.value } : {}), enabled: false, disabledReason };
  } else {
    if (record.args !== undefined || record.env_keys !== undefined) return refuse("A link server takes url, transport, auth and header_keys only");
    if (typeof record.url !== "string" || !record.url.trim()) return refuse("url must be text");
    // A link with userinfo, query or fragment is refused whatever the run keeps.
    if (urlHasSecret(record.url)) return namesOnly("This link carries a key or sign-in details");
    let parsedUrl: URL;
    try { parsedUrl = new URL(record.url); } catch { return refuse("url is not a valid address"); }
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") return refuse("url must start with https://");
    if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash || record.url.includes("#")) return namesOnly("This link carries a key or sign-in details");
    const path = (() => { try { return decodeURIComponent(parsedUrl.pathname); } catch { return parsedUrl.pathname; } })();
    if (credentialShaped(path)) return namesOnly("This link carries a key");
    const transport = record.transport ?? "http";
    if (transport !== "http" && transport !== "sse") return refuse("transport must be http or sse");
    const auth = record.auth ?? "none";
    if (auth !== "none" && auth !== "oauth" && auth !== "header") return refuse("auth must be none, oauth or header");
    const headerKeys = stringList(record.header_keys, BOT_HEADER_KEY, "header_keys", (key) => isRefusedMcpHeaderName(key) ? `Header “${key}” is set by Murage and cannot be changed` : null);
    if (!headerKeys.ok) return refuse(headerKeys.error);
    if (auth === "header" && headerKeys.value.length === 0) return refuse("auth header needs header_keys");
    if (auth !== "header" && headerKeys.value.length > 0) return refuse("header_keys go with auth header");
    raw = { url: record.url.trim(), transport, auth, headers: {}, ...(headerKeys.value.length ? { pendingHeaders: headerKeys.value } : {}), enabled: false, disabledReason };
  }
  // The shared parser has the last word on every field.
  const parsed = parseAnyStoredMcpServer(name, raw);
  if (!parsed.ok) return refuse(parsed.error.replace(/\.$/, ""));
  if (parsed.server.enabled !== false) return refuse("A bot cannot turn a server on");
  const rev = mcpEntryRev(name, parsed.server);
  const server = { ...parsed.server, rev };
  return { ok: true, name, server, entry: toStoredMcpEntry(server), rev };
}
