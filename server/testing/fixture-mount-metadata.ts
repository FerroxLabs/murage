// Producer owner: sc-safety (immutable relay observation). Consumer owner: new3-g2 (fake ACP behavior).
// Test support only: the engine's actual wire stanza remains the stdio shim.
import { readFileSync, statSync } from "node:fs";
const FIELDS = ["MURAGE_TURN_DEPTH", "MURAGE_EMAIL", "MURAGE_VENUE_POST", "MURAGE_PROJECT_ROLE"] as const;
type Entry = { name?: string; env?: Array<{ name: string; value: string }> };
export function withFixtureMountMetadata<T extends Entry>(entry: T | null): T | null {
  if (!entry) return null;
  if (!entry.name) return entry;
  const socket = entry.env?.find(row => row.name === "MURAGE_RELAY_SOCKET")?.value;
  if (!socket) return entry;
  try {
    const path = socket + ".fixture-metadata.json";
    if (statSync(path).size > 16 * 1024) return entry;
    const observed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!observed || typeof observed !== "object") return entry;
    const mounts = Reflect.get(observed, "mounts");
    if (!mounts || typeof mounts !== "object" || !Object.hasOwn(mounts, entry.name)) return entry;
    const metadata = Reflect.get(mounts, entry.name);
    if (!metadata || typeof metadata !== "object") return entry;
    const flags = FIELDS.flatMap(name => typeof metadata[name] === "string" ? [{ name, value: metadata[name] }] : []);
    const names = new Set(flags.map(row => row.name));
    return { ...entry, env: [...(entry.env ?? []).filter(row => !names.has(row.name as typeof FIELDS[number])), ...flags] };
  } catch { return entry; }
}
