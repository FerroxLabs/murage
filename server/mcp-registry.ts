// The one place a custom MCP entry is validated, whether it arrived from a
// hand-edited config.json or from the desktop settings panel. config.ts reads
// it to mount the fleet; index.ts reads it to answer the /api/mcp/servers
// routes. Two parsers for one file format is how the file and the UI drift.
import { z } from "zod";

export interface StoredMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
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
  env: z.record(z.string(), z.string().max(16_384)).optional(),
  enabled: z.boolean().optional(),
}).strict();

const mutationEntrySchema = storedEntrySchema.extend({
  env: z.record(z.string(), z.union([z.string().max(16_384), z.literal(true)])).optional(),
});

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
): { ok: true; server: StoredMcpServer } | { ok: false; error: string } {
  const nameError = mcpServerNameError(name);
  if (nameError) return { ok: false, error: nameError };
  const parsed = storedEntrySchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid MCP server." };
  }
  const env = parsed.data.env ?? {};
  const invalidEnv = Object.keys(env).map(environmentNameError).find((error) => error !== null);
  if (invalidEnv) return { ok: false, error: invalidEnv };
  if (Object.keys(env).length > MAX_ENV) {
    return { ok: false, error: `Use at most ${MAX_ENV} environment variables.` };
  }
  return {
    ok: true,
    server: {
      command: parsed.data.command,
      args: parsed.data.args ?? [],
      env,
      // A hand-authored entry has always mounted unless it said otherwise.
      enabled: parsed.data.enabled !== false,
    },
  };
}

/** Parse a renderer mutation. `true` is a write-only placeholder meaning
 * “keep this already stored value”; it is never accepted for a new key. */
export function parseMcpServerMutation(
  name: string,
  raw: unknown,
  existing?: StoredMcpServer,
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
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(incomingEnv)) {
    if (value === true) {
      const saved = existing?.env[key];
      if (saved === undefined) return { ok: false, error: `No saved value exists for ${key}.` };
      env[key] = saved;
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
