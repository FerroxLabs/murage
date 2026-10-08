// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DATA_DIR } from "./config.ts";
import { artifactWorkspaceIdentity } from "./artifacts.ts";
import { isHomePartition, partitionRoots, threadPartition } from "./execution-audience.ts";
import type { BotRecord } from "./store.ts";

/** Structured paths only. Denial is terminal, before modes or owner cards. */
export function partitionFileRefusal(bot: BotRecord, threadId: string, paths: readonly string[] | undefined, cwd?: string, dataDir = DATA_DIR): string | null {
  if (bot.partitionedAt === undefined || !paths?.length) return null;
  const p = threadPartition(bot, threadId);
  // Each base in both spellings: as written under dataDir and as the file
  // system resolves it (a Windows 8.3 short name, a linked ancestor), so a
  // lexical path is compared with its own spelling and a canonical one with its.
  const both = (path: string) => [resolve(path), artifactWorkspaceIdentity(path)];
  const root = both(partitionRoots(bot, isHomePartition(p) ? { kind: "home" } : p, dataDir)[0]);
  const managed = both(join(dataDir, "workspaces"));
  const general = both(join(dataDir, "workspaces", bot.id + ".general"));
  // By path segments with the platform's separator and case rule (relative):
  // a "/" prefix test never matched a Windows path, so no write was refused there.
  const inside = (path: string, bases: readonly string[]) => bases.some(base => {
    const rest = relative(base, path);
    return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
  });
  for (const path of paths) {
    const lexical = resolve(cwd ?? root[1], path), canonical = artifactWorkspaceIdentity(lexical);
    if (inside(lexical, general) || inside(canonical, general)) return `Only you can change what ${bot.name} knows for every team.`;
    if ((inside(lexical, managed) || inside(canonical, managed)) && (!inside(lexical, root) || !inside(canonical, root))) return `That folder belongs to ${bot.name}'s work for another team.`;
  }
  return null;
}
