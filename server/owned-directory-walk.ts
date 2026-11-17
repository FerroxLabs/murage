// DR4's shared directory walk. The caller admits and pins the top-level root.
import { join } from "node:path";
import type { Stats } from "node:fs";
export function walkOwnedDirectories(base: string, parts: readonly string[], options: {
  create?: boolean; lstat(path: string): Stats | null; mkdir(path: string): void;
  created(path: string): void; refuse(code: "not-a-folder" | "link-below-root"): never;
}): string {
  let at = base, stopped = false;
  for (const part of parts) {
    at = join(at, part);
    if (stopped) continue;
    let stat = options.lstat(at);
    if (!stat) {
      if (!options.create) { stopped = true; continue; }
      try { options.mkdir(at); options.created(at); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      stat = options.lstat(at);
    }
    if (!stat) options.refuse("not-a-folder");
    if (stat.isSymbolicLink()) options.refuse("link-below-root");
    if (!stat.isDirectory()) options.refuse("not-a-folder");
  }
  return at;
}
