// Per-turn capability tokens used to ride in each MCP server's env, which made
// every turn's spawn contract unique and a warm process impossible. They now
// travel in a per-process credential file instead:
//   - the file lives in its own random 0700 directory, one per engine process,
//     so another thread's process has no path to it;
//   - the driver writes it atomically at turn start, empties it at settle, and
//     unlinks the directory when the process is recycled or exits;
//   - the server still revokes the turn's token at its end, so a token copied
//     out of the file is dead even before the file is next rewritten.
import { randomBytes } from "node:crypto";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CRED_FILE_ENV, CRED_SERVER_ENV } from "../turn-credential.ts";

/** Env names whose value is a per-turn secret. */
export const TURN_SECRET_ENV = [
  "MURAGE_COMMS_TOKEN",
  "MURAGE_MEMORY_TOKEN",
  "MURAGE_CONNECTORS_TOKEN",
  "MURAGE_CONNECTOR_UPSTREAM_HEADERS",
  "MURAGE_CONTROL_TOKEN",
  "MURAGE_MCP_TOKEN",
  "MURAGE_BROWSER_TOKEN",
] as const;

/** Stands in for the real path inside the reuse key and the stable config. */
export const CRED_FILE_PLACEHOLDER = "<murage-cred-file>";

export type TurnSecrets = Record<string, Record<string, string>>;

/** Splits per-turn secrets out of every server's env. `stableServers` is safe
 * to put in the reuse key; `secrets` is what the credential file carries. */
export function splitTurnSecrets(mcpServers: Record<string, unknown>): { stableServers: Record<string, unknown>; secrets: TurnSecrets } {
  const stableServers: Record<string, unknown> = {};
  const secrets: TurnSecrets = {};
  for (const [name, server] of Object.entries(mcpServers)) {
    const env = (server as { env?: Record<string, string> } | null)?.env;
    const found = env ? TURN_SECRET_ENV.filter((key) => typeof env[key] === "string") : [];
    if (!env || !found.length) {
      stableServers[name] = server;
      continue;
    }
    const rest: Record<string, string> = { ...env };
    secrets[name] = {};
    for (const key of found) {
      secrets[name]![key] = rest[key]!;
      delete rest[key];
    }
    stableServers[name] = { ...(server as object), env: { ...rest, [CRED_FILE_ENV]: CRED_FILE_PLACEHOLDER, [CRED_SERVER_ENV]: name } };
  }
  return { stableServers, secrets };
}

/** The same servers with the real credential path in place of the placeholder. */
export function bindCredentialPath(stableServers: Record<string, unknown>, path: string): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (value === CRED_FILE_PLACEHOLDER) return path;
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    return value;
  };
  return walk(stableServers) as Record<string, unknown>;
}

export interface TurnCredentialStore {
  readonly path: string;
  /** Replace the file's contents with this turn's secrets (tmp + rename). */
  write(secrets: TurnSecrets): void;
  /** Between turns: nothing in the file works. */
  clear(): void;
  /** Recycle or exit: unlink the file and its directory. */
  dispose(): void;
  readonly disposed: boolean;
}

export function createTurnCredentialStore(): TurnCredentialStore {
  const dir = mkdtempSync(join(tmpdir(), "murage-cred-"));
  // the directory name is random already; the file name adds more, so the path
  // is not derivable from anything in the engine's environment
  const path = join(dir, `${randomBytes(16).toString("hex")}.json`);
  let disposed = false;
  const put = (body: string) => {
    if (disposed) return;
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, path);
  };
  put("{}");
  return {
    path,
    get disposed() { return disposed; },
    write: (secrets) => put(JSON.stringify(secrets)),
    clear: () => put("{}"),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}
