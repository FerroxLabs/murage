// The one place a custom MCP entry is validated, whether it arrived from a
// hand-edited config.json or from the desktop settings panel. config.ts reads
// it to mount the fleet; index.ts reads it to answer the /api/mcp/servers
// routes. Two parsers for one file format is how the file and the UI drift.
import { z } from "zod";

import { MASK, displayUrl, splitSecretUrl, urlHasSecret } from "../shared/mcp-secret-url.mjs";

export interface StoredMcpServer {
  command: string;
  args: string[];
  /** Values written in config.json (dev and headless runs, and any name not moved yet). */
  env: Record<string, string>;
  /** Names whose value the secret store holds (config.json says `true`, MCP-LINK
   * T16). Present only when non-empty. A mount resolves them at mount time. */
  heldEnv?: string[];
  enabled: boolean;
}

export interface StoredMcpParseOptions {
  /** True when the secret store holds `key` for server `name`. Without it a
   * stored `true` is refused, as it always was. */
  envHeld?: (name: string, key: string) => boolean;
}

/** What the renderer is allowed to see. Environment NAMES, never values. */
export interface McpServerListing {
  name: string;
  command: string;
  args: string[];
  envKeys: string[];
  enabled: boolean;
}

export const MAX_MCP_SERVERS = 20;
const MAX_ARGS = 64;
const MAX_ENV = 64;
const MCP_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Routing and capability names owned by built-in MCP integrations. Codex
 * shares their child environment, so custom mounts must not copy or request
 * these names. Match case-insensitively for case-insensitive environments. */
export function isHarnessOwnedMcpEnvName(name: string): boolean {
  const normalized = name.toUpperCase();
  return normalized.startsWith("MURAGE_")
    || normalized.startsWith("MURAGEBOX_")
    || normalized === "ELECTRON_RUN_AS_NODE"
    || normalized === "DWEB_URL"
    || normalized === "PH_ANDROID_SERIAL";
}

function environmentNameError(name: string): string | null {
  if (!ENV_NAME.test(name)) return `Environment variable “${name}” is not valid.`;
  if (isHarnessOwnedMcpEnvName(name)) return `Environment variable “${name}” is reserved by Murage.`;
  return null;
}

/** Server keys the harness mounts itself — a custom entry must never
 * shadow or clobber one of these across any driver's namespace. */
const RESERVED_MCP_NAMES = new Set([
  "muragebox",
  "computer",
  "agents",
  "composio",
  "browser",
  "phone",
  "dweb",
  "murage_connectors",
  "murage_phone",
]);

const storedEntrySchema = z.object({
  command: z.string().trim().min(1).max(1_024),
  args: z.array(z.string().max(4_096)).max(MAX_ARGS).optional(),
  env: z.record(z.string(), z.union([z.string().max(16_384), z.literal(true)])).optional(),
  enabled: z.boolean().optional(),
}).strict();

const mutationEntrySchema = storedEntrySchema;

export function mcpServerNameError(name: string): string | null {
  if (!MCP_NAME.test(name)) {
    return "Use 1–32 lowercase letters, numbers, underscores, or hyphens, starting with a letter.";
  }
  if (RESERVED_MCP_NAMES.has(name)) return "That name is reserved by Murage.";
  return null;
}

export function parseStoredMcpServer(
  name: string,
  raw: unknown,
  options: StoredMcpParseOptions = {},
): { ok: true; server: StoredMcpServer } | { ok: false; error: string } {
  const nameError = mcpServerNameError(name);
  if (nameError) return { ok: false, error: nameError };
  const parsed = storedEntrySchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid MCP server." };
  }
  const rawEnv = parsed.data.env ?? {};
  const invalidEnv = Object.keys(rawEnv).map(environmentNameError).find((error) => error !== null);
  if (invalidEnv) return { ok: false, error: invalidEnv };
  if (Object.keys(rawEnv).length > MAX_ENV) {
    return { ok: false, error: `Use at most ${MAX_ENV} environment variables.` };
  }
  const env: Record<string, string> = {};
  const heldEnv: string[] = [];
  for (const [key, value] of Object.entries(rawEnv)) {
    if (value !== true) env[key] = value;
    else if (options.envHeld?.(name, key)) heldEnv.push(key);
    // T16: `true` means the value is in the secret store. An older build, or
    // a store that does not hold it, skips the entry rather than mount it bare.
    else return { ok: false, error: `No saved value exists for ${key}.` };
  }
  return {
    ok: true,
    server: {
      command: parsed.data.command,
      args: parsed.data.args ?? [],
      env,
      ...(heldEnv.length > 0 ? { heldEnv } : {}),
      // A hand-authored entry has always mounted unless it said otherwise.
      enabled: parsed.data.enabled !== false,
    },
  };
}

/** What config.json stores for a command server: held names written back as
 * `true`, never a value. */
export function toStoredMcpEntry(server: AnyStoredMcpServer): Record<string, unknown> {
  if (isRemoteMcpServer(server)) return { ...server };
  const { heldEnv, ...rest } = server;
  if (!heldEnv || heldEnv.length === 0) return { ...rest };
  return { ...rest, env: { ...rest.env, ...Object.fromEntries(heldEnv.map((key) => [key, true])) } };
}

/** Parse a renderer mutation. `true` is a write-only placeholder meaning
 * “keep this already stored value”; it is never accepted for a new key.
 *
 * T16: with `secretsInBody: false` (the packaged app) a value in the body is
 * refused and `true` names a value main holds or is about to hold (the renderer
 * saves it through the desktop shell after the entry exists). Left undefined,
 * the rules are the dev/headless ones above. */
export function parseMcpServerMutation(
  name: string,
  raw: unknown,
  existing?: StoredMcpServer,
  options: { secretsInBody?: boolean } = {},
): { ok: true; server: StoredMcpServer } | { ok: false; error: string } {
  const nameError = mcpServerNameError(name);
  if (nameError) return { ok: false, error: nameError };
  const parsed = mutationEntrySchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid MCP server." };
  }
  const incomingEnv = parsed.data.env ?? {};
  const invalidEnv = Object.keys(incomingEnv).map(environmentNameError).find((error) => error !== null);
  if (invalidEnv) return { ok: false, error: invalidEnv };
  if (Object.keys(incomingEnv).length > MAX_ENV) {
    return { ok: false, error: `Use at most ${MAX_ENV} environment variables.` };
  }
  const packaged = options.secretsInBody === false;
  const env: Record<string, string> = {};
  const heldEnv: string[] = [];
  for (const [key, value] of Object.entries(incomingEnv)) {
    if (value === true) {
      const saved = existing?.env[key];
      if (saved !== undefined) env[key] = saved;
      else if (existing?.heldEnv?.includes(key) || packaged) heldEnv.push(key);
      else return { ok: false, error: `No saved value exists for ${key}.` };
    } else if (packaged) {
      return { ok: false, error: "Enter the value in its field." };
    } else {
      env[key] = value;
    }
  }
  return {
    ok: true,
    server: {
      command: parsed.data.command,
      args: parsed.data.args ?? [],
      env,
      ...(heldEnv.length > 0 ? { heldEnv } : {}),
      // A newly added command is inert until the person has tested and
      // explicitly enabled it. Existing file-authored entries keep today's
      // enabled-by-default behavior through parseStoredMcpServer.
      enabled: existing ? (parsed.data.enabled ?? existing.enabled) : false,
    },
  };
}

export function listMcpServers(raw: Record<string, unknown> | undefined): McpServerListing[] {
  return Object.entries(raw ?? {}).flatMap(([name, value]) => {
    const parsed = parseStoredMcpServer(name, value);
    if (!parsed.ok) return [];
    return [{
      name,
      command: parsed.server.command,
      args: parsed.server.args,
      envKeys: Object.keys(parsed.server.env).sort(),
      enabled: parsed.server.enabled,
    }];
  });
}


// ── remote (URL) servers ────────────────────────────────────────────────
// A `url` key selects the remote shape. The stdio functions above are left
// exactly as they were (their callers and tests are unchanged); the `Any`
// functions below accept both shapes and are what the routes move to.

export type McpRemoteTransport = "http" | "sse";
export type McpRemoteAuth = "none" | "oauth" | "header";
export type McpLocalConfirmation = "this-computer" | "local-network";

export interface StoredRemoteMcpServer {
  url: string;
  transport?: McpRemoteTransport;
  auth: McpRemoteAuth;
  /** Header NAMES. `true` means the value lives in the secret store; a string
   * is a hand-edited value that the packaged boot migration moves there. */
  headers: Record<string, string | true>;
  local?: McpLocalConfirmation;
  urlSecret?: true;
  enabled: boolean;
}

export type AnyStoredMcpServer = StoredMcpServer | StoredRemoteMcpServer;

export function isRemoteMcpServer(server: AnyStoredMcpServer): server is StoredRemoteMcpServer {
  return "url" in server;
}

export const MAX_MCP_HEADERS = 16;
export const MAX_MCP_HEADER_VALUE = 8 * 1024;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const REFUSED_HEADER_NAMES = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "cookie",
  "mcp-session-id",
  "mcp-protocol-version",
  "accept",
  "content-type",
  // Hop-by-hop and request-shaping headers: Upgrade makes Node wait for an
  // upgrade event that never comes, Expect changes when the body is sent.
  "expect",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "origin",
]);

/** The header names a link entry may not set. Exported so a test can name each. */
export function isRefusedMcpHeaderName(name: string): boolean {
  return REFUSED_HEADER_NAMES.has(name.toLowerCase());
}
const LOCAL_CONFIRMATIONS = new Set<string>(["this-computer", "local-network"]);
const ALIAS_TRANSPORTS: Record<string, McpRemoteTransport> = {
  http: "http",
  "streamable-http": "http",
  streamableHttp: "http",
  sse: "sse",
};

/** A stored `url` is http(s) only, with no userinfo, query or fragment: those
 * go to the secret store and `urlSecret` marks that they exist. */
function storedUrlError(value: string, urlSecret: boolean): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "The server link is not a valid address.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "The server link must start with https://.";
  if (!parsed.hostname) return "The server link is not a valid address.";
  // With urlSecret set the file is the dev/headless fallback, which keeps the
  // full link ("local-config" in spec 3.4). A packaged entry never has these.
  if (!urlSecret && (parsed.username || parsed.password)) return "Keep the sign-in details out of the link; Murage stores them separately.";
  if (!urlSecret && (parsed.search || parsed.hash)) return "Keep the query and fragment out of the link; Murage stores them separately.";
  return null;
}

function headerError(headers: Record<string, unknown>): string | null {
  const names = Object.keys(headers);
  if (names.length > MAX_MCP_HEADERS) return `Use at most ${MAX_MCP_HEADERS} headers.`;
  for (const name of names) {
    if (!HEADER_NAME.test(name)) return `Header name “${name}” is not valid.`;
    if (isRefusedMcpHeaderName(name)) return `Header “${name}” is set by Murage and cannot be changed.`;
    const value = headers[name];
    if (value === true) continue;
    if (typeof value !== "string") return `Header “${name}” needs a value.`;
    if (value.length > MAX_MCP_HEADER_VALUE) return `Header “${name}” is too long.`;
    if (/[\r\n\0]/.test(value)) return `Header “${name}” cannot contain a line break.`;
  }
  return null;
}

const remoteEntrySchema = z.object({
  url: z.string().trim().min(1).max(8_192),
  transport: z.enum(["http", "sse"]).optional(),
  auth: z.enum(["none", "oauth", "header"]).optional(),
  headers: z.record(z.string(), z.union([z.string(), z.literal(true)])).optional(),
  local: z.enum(["this-computer", "local-network"]).optional(),
  urlSecret: z.literal(true).optional(),
  enabled: z.boolean().optional(),
}).strict();

/** Fold the vendor spellings into the canonical keys. Returns an error
 * sentence instead of guessing when two spellings disagree. */
function normalizeRemoteAliases(raw: Record<string, unknown>): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const value: Record<string, unknown> = { ...raw };
  for (const alias of ["serverUrl", "httpUrl"] as const) {
    if (!(alias in value)) continue;
    if ("url" in value && value.url !== value[alias]) return { ok: false, error: "Use only one server link." };
    value.url = value[alias];
    delete value[alias];
  }
  if ("type" in value) {
    const type = value.type;
    delete value.type;
    const transport = typeof type === "string" ? ALIAS_TRANSPORTS[type] : undefined;
    if (!transport) return { ok: false, error: "Only http and sse servers can be added by link." };
    if ("transport" in value && value.transport !== transport) return { ok: false, error: "Use only one transport." };
    value.transport = transport;
  }
  return { ok: true, value };
}

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function hasUrlKey(raw: unknown): raw is Record<string, unknown> {
  return isPlainObject(raw) && ("url" in raw || "serverUrl" in raw || "httpUrl" in raw);
}

type RemoteParse = { ok: true; server: StoredRemoteMcpServer } | { ok: false; error: string };

function buildRemote(
  raw: Record<string, unknown>,
  defaults: { enabled: boolean; local: McpLocalConfirmation | undefined },
  mutation: { secretsInBody: boolean } | null = null,
): RemoteParse {
  const aliased = normalizeRemoteAliases(raw);
  if (!aliased.ok) return aliased;
  const parsed = remoteEntrySchema.safeParse(aliased.value);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid MCP server." };
  const urlError = storedUrlError(parsed.data.url, parsed.data.urlSecret === true);
  if (urlError) return { ok: false, error: urlError };
  const headers = parsed.data.headers ?? {};
  if (mutation && !mutation.secretsInBody) {
    // F3: a renderer body never carries a secret. Values go renderer, main,
    // credentials.bin, then the commit route; the body holds `true` only.
    if (Object.values(headers).some((value) => typeof value === "string")) return { ok: false, error: "Enter the key in the key field." };
    if (urlHasSecret(parsed.data.url)) return { ok: false, error: "This link holds a key. Murage stores it separately; send the masked link." };
  }
  const invalidHeader = headerError(headers);
  if (invalidHeader) return { ok: false, error: invalidHeader };
  const auth = parsed.data.auth ?? (Object.keys(headers).length > 0 ? "header" : "none");
  if (auth === "header" && Object.keys(headers).length === 0) {
    return { ok: false, error: "Add the header that carries the API key." };
  }
  // Key order is fixed so a normalized entry serialises the same every time.
  const out: StoredRemoteMcpServer = {
    url: parsed.data.url,
    ...(parsed.data.transport ? { transport: parsed.data.transport } : {}),
    auth,
    headers,
    ...(defaults.local ? { local: defaults.local } : {}),
    ...(parsed.data.urlSecret ? { urlSecret: true as const } : {}),
    enabled: defaults.enabled,
  };
  return { ok: true, server: out };
}

/** Read a stored entry of either shape. A `local` confirmation in the file is
 * kept: the owner's own file is trusted, and every request re-checks that the
 * address is still in the confirmed class anyway. */
export function parseAnyStoredMcpServer(
  name: string,
  raw: unknown,
  options: StoredMcpParseOptions = {},
): { ok: true; server: AnyStoredMcpServer } | { ok: false; error: string } {
  if (!hasUrlKey(raw)) return parseStoredMcpServer(name, raw, options);
  const nameError = mcpServerNameError(name);
  if (nameError) return { ok: false, error: nameError };
  const local = isPlainObject(raw) && typeof raw.local === "string" && LOCAL_CONFIRMATIONS.has(raw.local)
    ? (raw.local as McpLocalConfirmation)
    : undefined;
  return buildRemote(raw, {
    // A hand-authored entry mounts unless it said otherwise, as stdio does.
    enabled: raw.enabled !== false,
    local,
  });
}

export interface McpMutationOptions {
  /** Set by the renderer's explicit "This computer" / "Local network"
   * confirmation and by nothing else. */
  confirmLocal?: McpLocalConfirmation;
  /** False (the default, and the packaged setting) refuses a literal header
   * value or a link that holds a secret in a mutation body. Dev and headless
   * runs, which keep secrets in config.json, pass true. */
  secretsInBody?: boolean;
}

/** Parse a renderer mutation of either shape. A `local` key in `raw` (which may
 * be a pasted snippet) is ignored; only `options.confirmLocal` sets it. */
export function parseAnyMcpServerMutation(
  name: string,
  raw: unknown,
  existing?: AnyStoredMcpServer,
  options: McpMutationOptions = {},
): { ok: true; server: AnyStoredMcpServer } | { ok: false; error: string } {
  if (!hasUrlKey(raw)) {
    return parseMcpServerMutation(name, raw, existing && !isRemoteMcpServer(existing) ? existing : undefined, { secretsInBody: options.secretsInBody });
  }
  const nameError = mcpServerNameError(name);
  if (nameError) return { ok: false, error: nameError };
  if (options.confirmLocal !== undefined && !LOCAL_CONFIRMATIONS.has(options.confirmLocal)) {
    return { ok: false, error: "Unknown local confirmation." };
  }
  const { local: _ignored, ...withoutLocal } = raw;
  void _ignored;
  const previous = existing && isRemoteMcpServer(existing) ? existing : undefined;
  const built = buildRemote(withoutLocal, {
    enabled: previous ? (typeof raw.enabled === "boolean" ? raw.enabled : previous.enabled) : false,
    local: undefined,
  }, { secretsInBody: options.secretsInBody === true });
  if (!built.ok) return built;
  // A confirmation belongs to one address: it carries over an edit that keeps
  // the link, and is dropped when the link changes.
  const local = options.confirmLocal ?? (previous && previous.url === built.server.url ? previous.local : undefined);
  if (!local) return built;
  return { ok: true, server: { ...built.server, local } };
}

/** The link with userinfo, query, fragment removed and every opaque path
 * segment masked, for listings and logs. "" when it is not an http(s) link. */
export function maskMcpUrl(value: string): string {
  return displayUrl(value);
}

/** See splitSecretUrl in shared/mcp-secret-url.mjs: the same rule runs in the
 * desktop shell's boot migration, so it lives in one place. */
export function splitMcpUrl(
  value: string,
  options: { keepFullInConfig?: boolean } = {},
): { storedUrl: string; fullUrl: string; urlSecret: boolean } | null {
  return splitSecretUrl(value, options);
}

/** True when the stored link is a placeholder that cannot be dialed: a masked
 * path whose real link is in the secret store. */
export function isMaskedStoredUrl(server: StoredRemoteMcpServer): boolean {
  return server.urlSecret === true && server.url.includes(MASK);
}

export interface McpSecretPresence {
  hasHeader(serverName: string, headerName: string, entryUrl?: string): boolean;
  hasOAuth(serverName: string, entryUrl?: string): boolean;
  /** A command server's env value (T16). */
  hasEnv?(serverName: string, envName: string): boolean;
}

export type McpRemoteStatus = "ready" | "needs-sign-in" | "needs-key" | "unknown";

export interface StdioMcpListing extends McpServerListing {
  kind: "stdio";
  /** Present only when some env value lives in the secret store (T16):
   * "needs-key" while one of them is held nowhere. */
  status?: "ready" | "needs-key";
}

export interface RemoteMcpListing {
  kind: "remote";
  name: string;
  url: string;
  host: string;
  transport?: McpRemoteTransport;
  auth: McpRemoteAuth;
  headerNames: string[];
  local?: McpLocalConfirmation;
  enabled: boolean;
  status: McpRemoteStatus;
}

function remoteStatus(name: string, server: StoredRemoteMcpServer, secrets: McpSecretPresence | undefined): McpRemoteStatus {
  if (server.auth === "none") return "ready";
  if (!secrets) return "unknown";
  if (server.auth === "oauth") return secrets.hasOAuth(name, server.url) ? "ready" : "needs-sign-in";
  const present = Object.entries(server.headers).every(([header, value]) =>
    typeof value === "string" ? value.length > 0 : secrets.hasHeader(name, header, server.url));
  return present ? "ready" : "needs-key";
}

/** Renderer listing of both shapes. It never carries a value: env and header
 * NAMES only, and a masked link. */
export function listAllMcpServers(
  raw: Record<string, unknown> | undefined,
  secrets?: McpSecretPresence,
): Array<StdioMcpListing | RemoteMcpListing> {
  return Object.entries(raw ?? {}).flatMap(([name, value]): Array<StdioMcpListing | RemoteMcpListing> => {
    // Listed whether or not a held env value is present: the owner has to see
    // the server to enter what is missing.
    const parsed = parseAnyStoredMcpServer(name, value, { envHeld: () => true });
    if (!parsed.ok) return [];
    const server = parsed.server;
    if (!isRemoteMcpServer(server)) {
      const held = server.heldEnv ?? [];
      return [{
        kind: "stdio",
        name,
        command: server.command,
        args: server.args,
        envKeys: [...Object.keys(server.env), ...held].sort(),
        enabled: server.enabled,
        ...(held.length > 0 ? { status: held.every((key) => secrets?.hasEnv?.(name, key) === true) ? "ready" as const : "needs-key" as const } : {}),
      }];
    }
    return [{
      kind: "remote",
      name,
      url: maskMcpUrl(server.url),
      host: new URL(server.url).hostname,
      ...(server.transport ? { transport: server.transport } : {}),
      auth: server.auth,
      headerNames: Object.keys(server.headers).sort(),
      ...(server.local ? { local: server.local } : {}),
      enabled: server.enabled,
      status: remoteStatus(name, server, secrets),
    }];
  });
}
