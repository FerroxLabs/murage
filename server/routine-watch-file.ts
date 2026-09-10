import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse } from "node:path";
import type { RoutineWatchSourceAdapter } from "../shared/routine-watch.ts";

export const ROUTINE_WATCH_FILE_MAX_BYTES = 1024 * 1024;
export interface RoutineWatchFileScope { botId: string; workspaceId: string; workspaceRoot: string }
export class RoutineWatchFileError extends Error {
  readonly code: "invalid-source" | "unavailable" | "missing" | "unsafe" | "too-large" | "changed-during-read" | "aborted";
  constructor(code: RoutineWatchFileError["code"]) {
    super(`Watch file: ${code}`);
    this.code = code;
  }
}
function fail(code: RoutineWatchFileError["code"]): never { throw new RoutineWatchFileError(code); }
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

export function validateRoutineWatchFilePath(path: string): string[] {
  if (typeof path !== "string" || !path || path.length > 200 || isAbsolute(path) || /[\\:*?\[\]{}\x00-\x1f\x7f]/.test(path)) fail("invalid-source");
  const parts = path.split("/");
  if (parts.some(p => !p || p.startsWith(".") || /[. ]$/.test(p))) fail("invalid-source");
  if (parts.some(p => /^(?:memory|skills|credentials?|secrets?|config|configuration|settings|node_modules)(?:[._-]|$)/i.test(p))
    || /^(?:AGENTS|CLAUDE|SOUL|MEMORY)\.md$/i.test(parts.at(-1)!)
    || /(?:^|[._-])(?:auth|token|password|credential|secret|config|settings)(?:[._-]|$)/i.test(parts.at(-1)!)
    || /\.(?:pem|key|p12|pfx|keystore|env|ini|toml|ya?ml)$/i.test(path)) fail("unsafe");
  return parts;
}

/** scopeId is an opaque persisted bot/workspace binding, never a native path.
 * The trusted resolver must return only the bot's CURRENT authorized working
 * folder for that binding, or null after removal, reassignment or revocation.
 * It must not create a workspace. sourceId is the exact user-selected relative
 * file. Only a hash leaves this adapter; missing/error reads throw, never yield
 * an unchanged observation. No scheduling, model, network or publication. */
export function createRoutineWatchFileAdapter(resolveScope: (scopeId: string) => RoutineWatchFileScope | null): RoutineWatchSourceAdapter {
  return { async read(source, signal) {
    let fd: number | undefined;
    try {
      if (signal.aborted) fail("aborted");
      if (source.adapterId !== "file" || typeof source.scopeId !== "string" || !source.scopeId || source.scopeId.length > 200) fail("invalid-source");
      const parts = validateRoutineWatchFilePath(source.sourceId);
      const scope = resolveScope(source.scopeId);
      if (!scope || !scope.botId || !scope.workspaceId || !isAbsolute(scope.workspaceRoot)) fail("unavailable");
      const rootStat = lstatSync(scope.workspaceRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("unsafe");
      const root = realpathSync.native(scope.workspaceRoot);
      if (root === parse(root).root || root === realpathSync.native(homedir())) fail("unsafe");
      const observed: Array<[string, Stats]> = [[scope.workspaceRoot, rootStat]];
      let path = root;
      for (const [index, part] of parts.entries()) {
        path = join(path, part);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail("unsafe");
        observed.push([path, stat]);
      }
      const before = observed.at(-1)![1];
      if (before.size > ROUTINE_WATCH_FILE_MAX_BYTES) fail("too-large");
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      if (!same(before, fstatSync(fd))) fail("changed-during-read");
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        if (signal.aborted) fail("aborted");
        const count = readSync(fd, bytes, offset, bytes.length - offset, null);
        if (!count) fail("changed-during-read");
        offset += count;
      }
      if (readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0 || !same(before, fstatSync(fd))
        || observed.some(([file, stat]) => !same(stat, lstatSync(file)))
        || realpathSync.native(scope.workspaceRoot) !== root) fail("changed-during-read");
      const current = resolveScope(source.scopeId);
      if (!current || current.botId !== scope.botId || current.workspaceId !== scope.workspaceId || current.workspaceRoot !== scope.workspaceRoot) fail("unavailable");
      if (signal.aborted) fail("aborted");
      return { fingerprint: createHash("sha256").update(bytes).digest("hex") };
    } catch (error) {
      if (error instanceof RoutineWatchFileError) throw error;
      fail((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable");
    } finally { if (fd !== undefined) closeSync(fd); }
  } };
}
