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
import { cacheEnvFromProcess, clearMountIncomplete, mountHoldsStandIn, mountIncomplete, type MountRef } from "../connector-cache.ts";

/** Env names whose value is a per-turn secret. */
export const TURN_SECRET_ENV = [
  "MURAGE_COMMS_TOKEN",
  "MURAGE_MEMORY_TOKEN",
  "MURAGE_CONNECTORS_TOKEN",
  "MURAGE_CONNECTOR_UPSTREAM_HEADERS",
  // Not secrets, but they change with the turn's access and must not make the
  // spawn contract unique: the bridge reads the current pair on each call.
  "MURAGE_CONNECTOR_IDENTITY",
  "MURAGE_CONNECTOR_REVISION",
  "MURAGE_CONNECTOR_INITIAL_TOOLS",
  "MURAGE_CONNECTOR_INITIAL_GENERATION",
  "MURAGE_CONTROL_TOKEN",
  "MURAGE_MCP_TOKEN",
  "MURAGE_BROWSER_TOKEN",
  // U20: the computer proxy's box token. Not per turn, but a credential: it rides the owner-only file like the rest, never the
  // stanza env Claude hands its shell prefix and the server (computer-proxy.ts reads it per call).
  "MURAGEBOX_BOX_TOKEN",
  // Not a secret: the provider turn this credential file belongs to (BOTADDED-DESIGN-V3 r6 §5). Per turn, so never in the stable key.
  "MURAGE_TURN_ID",
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

/** The connected-apps list scope (account identity and access revision) this
 * turn carries, from the secrets split out of the mounts; empty when none. A
 * warm engine keeps the tool catalog it listed at spawn, and nothing makes it
 * list again when the bot's access changes, so a change here recycles the
 * process (a field of the reuse key) instead of leaving old account choices,
 * or missing new ones, in the model's tools. */
export function connectorScopeOf(secrets: TurnSecrets): string {
  return Object.keys(secrets).sort()
    .map((name) => `${secrets[name]?.MURAGE_CONNECTOR_IDENTITY ?? ""}|${secrets[name]?.MURAGE_CONNECTOR_REVISION ?? ""}`)
    .filter((scope) => scope !== "|")
    .join(";");
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
    try {
      renameSync(tmp, path);
    } catch (error) {
      // Windows refuses a rename onto a file another process holds open (a proxy
      // reading it, a scanner): EPERM/EBUSY/EACCES. The new body still has to
      // land (the empty one is what revokes the turn), so write it in place;
      // the directory is private and the proxies' reads tolerate a partial file.
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      try {
        writeFileSync(path, body, { mode: 0o600 });
      } finally {
        rmSync(tmp, { force: true });
      }
    }
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

// ── Session recovery for engines that never list again ───────────────────
// When the connector bridge had to serve a provisional tool list, it filed a
// marker (connector-cache.ts markMountIncomplete). A driver that keeps an
// engine warm reads it at the next turn and starts a fresh engine instead of
// reusing the one holding the stand-in: the conversation continues through the
// usual resume, only the MCP mount is new, and it lists the remembered real list.

/** The mount reference of one connected-apps server from its environment (null when it has no list scope). */
export function connectorMountRefOfEnv(env: Record<string, string | undefined>, thread: string): MountRef | null {
  const identity = env.MURAGE_CONNECTOR_IDENTITY ?? "";
  const revision = env.MURAGE_CONNECTOR_REVISION ?? "";
  return identity && revision ? { cache: cacheEnvFromProcess(env), identity, revision, thread } : null;
}

/** Mount references of a split turn: the cache folder rides the stable server env, the identity and revision the secrets. */
export function connectorMountRefsOf(stableServers: Record<string, unknown>, secrets: TurnSecrets, thread: string): MountRef[] {
  const refs: MountRef[] = [];
  for (const name of Object.keys(secrets)) {
    const own = secrets[name] ?? {};
    if (!own.MURAGE_CONNECTOR_IDENTITY) continue;
    const stable = ((stableServers[name] as { env?: Record<string, string> } | undefined)?.env) ?? {};
    const ref = connectorMountRefOfEnv({ ...stable, ...own }, thread);
    if (ref) refs.push(ref);
  }
  return refs;
}

/** True when any of these mounts was last served only a provisional list. */
export const anyMountIncomplete = (refs: MountRef[]): boolean => refs.some((ref) => mountIncomplete(ref));
/** The warm engine is being replaced for it: the new mount starts clean. */
export const clearMountsIncomplete = (refs: MountRef[]): void => { for (const ref of refs) clearMountIncomplete(ref); };
/** True when any of these mounts still holds a stand-in list (the real one has not reached the engine). */
export const anyMountHoldsStandIn = (refs: MountRef[]): boolean => refs.some((ref) => mountHoldsStandIn(ref));
