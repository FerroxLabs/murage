// The reuse key for a warm engine process, shared by the drivers that keep one
// process per conversation thread. Two turns may share a process only when
// every field here matches; `diffWarmKey` names the first field that does not,
// for the dispatch trace (`process=spawned reason=<field>`).
import { createHmac, randomBytes } from "node:crypto";

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((k) => record[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export type WarmKeyParts = Record<string, unknown>;

/** What a warm key keeps in memory. Never the values: a field can carry a
 * secret (an MCP server's env, args or headers; an injected credential), and a
 * key outlives the turn that made it. Each field is kept as a salted digest;
 * the field NAME is the only readable label, which is all `diffWarmKey` needs. */
export interface WarmKey {
  digest: string;
  parts: Readonly<Record<string, string>>;
}

// Random per process: digests cannot be compared with, or brute-forced from,
// anything outside this process's memory.
const SALT = randomBytes(32);

const fieldDigest = (value: unknown): string => createHmac("sha256", SALT).update(stableJson(value)).digest("hex");

export function warmKey(parts: WarmKeyParts): WarmKey {
  const hashed: Record<string, string> = {};
  for (const [name, value] of Object.entries(parts)) hashed[name] = fieldDigest(value);
  return { digest: fieldDigest(hashed), parts: hashed };
}

/** A stable digest of credential values (never the values themselves), for a
 * key field: a rotated key changes it, nothing else does. */
export function credentialDigest(values: Record<string, string | undefined>): string {
  const present: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) if (typeof value === "string" && value) present[name] = value;
  return fieldDigest(present);
}

/** The first field whose value differs, or null when the keys match. */
export function diffWarmKey(a: WarmKey, b: WarmKey): string | null {
  if (a.digest === b.digest) return null;
  // declared order: the key lists identity fields before the raw argv
  const names = new Set([...Object.keys(a.parts), ...Object.keys(b.parts)]);
  for (const name of names) {
    if (a.parts[name] !== b.parts[name]) return name;
  }
  return "unknown";
}
