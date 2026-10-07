// Reader for the per-process credential file (see drivers/turn-credentials.ts).
// Murage's MCP proxies outlive a turn when the engine process is kept warm, so
// the capability token for the CURRENT turn arrives in a 0600 file the driver
// rewrites at every turn start and empties at every settle. A proxy reads it on
// each call; it never caches a value. The file holds
// { "<mcp server name>": { "<ENV_NAME>": "<value>" } }.
//
// Standalone and dependency-free on purpose: the proxies are bundled and
// spawned as their own node processes.
import { readFileSync } from "node:fs";

export const CRED_FILE_ENV = "MURAGE_CRED_FILE";
export const CRED_SERVER_ENV = "MURAGE_CRED_SERVER";

/** The named secret for this call: the credential file's current value when the
 * process was launched with one (empty between turns), else the plain env var
 * for launchers that still pass it directly. */
export function turnSecret(name: string, env: Record<string, string | undefined> = process.env): string {
  const file = env[CRED_FILE_ENV];
  if (!file) return env[name] ?? "";
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const section = (parsed as Record<string, unknown> | null)?.[env[CRED_SERVER_ENV] ?? ""];
    const value = (section as Record<string, unknown> | undefined)?.[name];
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

/** True when a secret can ever be present: a credential file is wired (its
 * content comes and goes per turn) or the env carries it. Startup checks use
 * this, never `turnSecret`, because the file is empty between turns. */
export function turnSecretWired(name: string, env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env[CRED_FILE_ENV] || env[name]);
}
