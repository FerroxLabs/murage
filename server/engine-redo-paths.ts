// S5 site 18. Pure reconstruction; executor I/O remains in engine-fs.ts.
import nodePath from "node:path";
import { lexicalKey, rebaseStoredPath } from "../shared/stored-root-path.mjs";
import type { AnyRecord } from "./engine-redo.ts";

export interface RedoPathContext { dataDir: string; previous: string[]; platform: NodeJS.Platform }
export function rebaseEngineRedoRecord<T extends AnyRecord>(record: T, context: RedoPathContext): T | null {
  const p = context.platform === "win32" ? nodePath.win32 : nodePath.posix;
  // Only the two engine-home constructors Murage owns. An external HOME stays external.
  let homeTail: string[] | undefined;
  for (const root of [context.dataDir, ...context.previous]) {
    const relative = p.relative(root, record.home), parts = relative.split(p.sep);
    if (!lexicalKey(record.home, context.platform) || p.isAbsolute(relative) || parts.some(part => !part || part === "." || part === "..")) continue;
    if ((parts.length === 2 && parts[0] === "providers" && /^[A-Za-z0-9][\w.-]{0,159}$/.test(parts[1]!))
      || (parts.length >= 3 && parts[0] === "native" && /^[\w-]+-scope$/.test(parts[1]!) && /^[a-f0-9]{16}$/.test(parts[2]!))) { homeTail = parts; break; }
  }
  const home = rebaseStoredPath(record.home, root => homeTail ? [p.join(root, ...homeTail)] : [], context);
  if ("refused" in home) return null;
  if (!("path" in home)) return record;
  const file = (path: string): string | null => {
    if (!lexicalKey(path, context.platform)) return null;
    const relative = p.relative(record.home, path);
    if (!relative || p.isAbsolute(relative) || relative.split(p.sep).some(part => !part || part === "." || part === "..")) return null;
    return p.join(home.path, relative);
  };
  if (record.kind === "join") {
    const into = file(record.into.path), from = file(record.from.path);
    return into && from ? { ...record, home: home.path, into: { ...record.into, path: into }, from: { ...record.from, path: from } } : null;
  }
  const path = file(record.path);
  return path ? { ...record, home: home.path, path } : null;
}
