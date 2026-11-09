// S5 site 17: migrate only the structured fields of the two named JSON stores.
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { dataRoots, ownedPath } from "./data-roots.ts";
import { rebaseAttachmentRecord } from "./attachment-paths.ts";

/** Called before a scheduler loads its state. Unchanged/refused stores incur no write. */
export function rebaseScheduledAttachmentPaths(file: string, lists: readonly string[]): void {
  if (!dataRoots().previousRoots().length) return;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { return; } // the store retains its existing recovery policy
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const data = raw as Record<string, unknown>;
  if (data.version !== 1) return;
  const next = { ...data };
  let count = 0;
  for (const key of lists) {
    const records = data[key];
    if (!Array.isArray(records)) continue;
    next[key] = records.map(record => {
      if (!record || typeof record !== "object" || Array.isArray(record)) return record;
      const changed = rebaseAttachmentRecord(record);
      if (changed !== record) count++;
      return changed;
    });
  }
  if (!count) return;
  const parent = ownedPath(dirname(file), { create: false });
  writeFileAtomic(join(parent.canonical, basename(file)), JSON.stringify(next, null, 2), { mode: 0o600 });
  console.warn(`data-dir-rebase kind=attachment count=${count}`);
}
