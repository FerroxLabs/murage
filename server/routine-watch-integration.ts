import { createHash } from "node:crypto";
import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse } from "node:path";
import { z } from "zod";
import type { RoutineWatchBinding, RoutineWatchInput, RoutineWatchSource } from "../shared/routine-watch.ts";
import { readRoutineWatchState } from "./routine-watch-state.ts";
import { validateRoutineWatchFilePath, type RoutineWatchFileScope } from "./routine-watch-file.ts";

export const routineFileWatchProposalSchema = z.object({
  relativePath: z.string().min(1).max(200),
  expiresAt: z.string().datetime({ offset: true }),
  maxChecks: z.number().int().min(1).max(10_000),
}).strict();
export const routineWatchInputSchema = z.object({
  source: z.object({ adapterId: z.literal("file"), sourceId: z.string().min(1).max(200), scopeId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  maxChecks: z.number().int().min(1).max(10_000),
}).strict().superRefine((value, ctx) => {
  try { validateRoutineWatchFilePath(value.source.sourceId); }
  catch { ctx.addIssue({ code: "custom", message: "Choose a supported relative file in the working folder" }); }
});
export function readRoutineWatchBinding(value: unknown, id: string): RoutineWatchBinding {
  const binding = z.object({ ownerBotId: z.string().min(1).max(128), state: z.unknown() }).strict().parse(value);
  const state = readRoutineWatchState(binding.state);
  const { id: watchId, ...input } = state.definition;
  routineWatchInputSchema.parse(input);
  if (watchId !== id) throw new Error("Watch identity does not match its routine");
  return { ownerBotId: binding.ownerBotId, state };
}
export function routineWatchInput(binding: RoutineWatchBinding): RoutineWatchInput {
  const { id: _id, ...input } = binding.state.definition;
  return structuredClone(input);
}

/** Only the current working folder is passed here. Never creates a workspace,
 * falls back to HOME, or searches retained task/artifact roots. */
export function routineWatchFileScope(botId: string, workspaceRoot: string | undefined): RoutineWatchFileScope | null {
  if (!workspaceRoot || !isAbsolute(workspaceRoot)) return null;
  try {
    const stat = lstatSync(workspaceRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const canonical = realpathSync.native(workspaceRoot);
    if (canonical === parse(canonical).root || canonical === realpathSync.native(homedir())) return null;
    const workspaceId = createHash("sha256").update(JSON.stringify([botId, canonical, stat.dev, stat.ino])).digest("hex");
    return { botId, workspaceId, workspaceRoot: canonical };
  } catch { return null; }
}
export function selectRoutineWatchFile(scope: RoutineWatchFileScope | null, relativePath: string): RoutineWatchSource {
  const parts = validateRoutineWatchFilePath(relativePath);
  if (!scope) throw new Error("Choose an existing working folder for this bot before creating a file watch");
  let path = scope.workspaceRoot;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024)) {
      throw new Error("Choose a regular file up to 1 MB inside the working folder");
    }
  }
  return { adapterId: "file", sourceId: relativePath, scopeId: scope.workspaceId };
}

export function listRoutineWatchFiles(scope: RoutineWatchFileScope | null, directory = "") {
  if (!scope) throw new Error("Choose an existing working folder for this bot before creating a file watch");
  let path = scope.workspaceRoot;
  for (const part of directory ? validateRoutineWatchFilePath(directory) : []) {
    path = join(path, part);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("This watch folder is unavailable");
  }
  const folder = opendirSync(path), entries: Array<{ relativePath: string; name: string; directory: boolean }> = [];
  let scanned = 0, truncated = false;
  try {
    for (let item; (item = folder.readSync());) {
      if (++scanned > 500 || entries.length >= 200) { truncated = true; break; }
      const relativePath = directory ? `${directory}/${item.name}` : item.name;
      try {
        validateRoutineWatchFilePath(relativePath);
        const stat = lstatSync(join(path, item.name));
        if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile() && stat.nlink === 1 && stat.size <= 1024 * 1024)) continue;
        entries.push({ relativePath, name: item.name, directory: stat.isDirectory() });
      } catch { /* unsupported source stays out of this file picker */ }
    }
  } finally { folder.closeSync(); }
  return { directory, entries: entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)), truncated };
}
