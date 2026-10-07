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
  const root = artifactWorkspaceIdentity(partitionRoots(bot, isHomePartition(p) ? { kind: "home" } : p, dataDir)[0]);
  const managed = artifactWorkspaceIdentity(join(dataDir, "workspaces"));
  const general = artifactWorkspaceIdentity(join(dataDir, "workspaces", bot.id + ".general"));
  const inside = (path: string, base: string) => path === base || path.startsWith(base + "/");
  for (const path of paths) {
    const lexical = resolve(cwd ?? root, path), canonical = artifactWorkspaceIdentity(lexical);
    if (inside(lexical, general) || inside(canonical, general)) return `Only you can change what ${bot.name} knows for every team.`;
    if ((inside(lexical, managed) || inside(canonical, managed)) && (!inside(lexical, root) || !inside(canonical, root))) return `That folder belongs to ${bot.name}'s work for another team.`;
  }
  return null;
}
