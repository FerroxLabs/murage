// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { resolve, join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { artifactWorkspaceIdentity } from "./artifacts.ts";
import { isHomePartition, partitionRoots, threadPartition } from "./execution-audience.ts";
import type { BotRecord } from "./store.ts";

/** Structured paths only. Denial is terminal, before modes or owner cards. */
export function partitionFileRefusal(bot: BotRecord, threadId: string, paths: readonly string[] | undefined, cwd?: string, dataDir = DATA_DIR): string | null {
  if (bot.partitionedAt === undefined || !paths?.length) return null;
  const p = threadPartition(bot, threadId);
  const rootPath = partitionRoots(bot, isHomePartition(p) ? { kind: "home" } : p, dataDir)[0];
  // Each base in both spellings: the lexical one is compared with the lexical
  // target and the canonical one with the canonical target, so a short (8.3) or
  // linked spelling of the data folder never makes a path look outside it.
  const base = (path: string) => ({ lexical: resolve(path), canonical: artifactWorkspaceIdentity(path) });
  const root = base(rootPath), managed = base(join(dataDir, "workspaces")), general = base(join(dataDir, "workspaces", bot.id + ".general"));
  for (const path of paths) {
    const lexical = resolve(cwd ?? root.canonical, path), canonical = artifactWorkspaceIdentity(lexical);
    const within = (folder: { lexical: string; canonical: string }) => ({ lexical: inside(lexical, folder.lexical), canonical: inside(canonical, folder.canonical) });
    const inGeneral = within(general), inManaged = within(managed), inRoot = within(root);
    if (inGeneral.lexical || inGeneral.canonical) return `Only you can change what ${bot.name} knows for every team.`;
    // Where it really lands (canonical) must be this partition, and a name that
    // spells another partition's folder is refused even before it exists.
    if (((inManaged.lexical || inManaged.canonical) && !inRoot.canonical) || (inManaged.lexical && !inRoot.lexical)) return `That folder belongs to ${bot.name}'s work for another team.`;
  }
  return null;
}

/** Is `path` the folder `base` or inside it? Compared by segment on both
 * separators, and without case on Windows, where the file system ignores it:
 * a `/` prefix test never matched a Windows path, so no write was refused there. */
export function inside(path: string, base: string, platform: NodeJS.Platform = process.platform): boolean {
  const segments = (value: string) => {
    const parts = value.split(/[\\/]+/).filter(Boolean);
    return platform === "win32" ? parts.map((part) => part.toLowerCase()) : parts;
  };
  const target = segments(path), folder = segments(base);
  return target.length >= folder.length && folder.every((part, index) => part === target[index]);
}
