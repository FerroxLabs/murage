// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// A saved prompt block a bot wrote in a turn rests on that turn (recordTurnObject). When the owner
// forgets what the turn rested on, the block is withheld like any other memory object: the list and
// the get hand a bot only the blocks the write-time lookup still shows.
import type { DatabaseSync } from "node:sqlite";
import { doorReader } from "./bot-read.ts";
import { memoryRefKey } from "./memory/lineage-types.ts";
import { memoryLookup } from "./memory/deny-read.ts";
import { fileRef } from "./memory/prompt-parts.ts";

/** An image-library item a bot keeps (a prompt block, a reference pack) as a lineage object: every version of a name is one object. */
export const imageLibraryRef = (libraryKey: string, kind: "prompt-block" | "reference-pack", name: string) => fileRef(libraryKey, `image-${kind}:${name}`);

/** The blocks the lookup still shows. A workspace block rests on the owner, not on a turn, so it stays; a bot block whose lookup is
 * withheld, still checking or failed is left out (fail closed). */
export function shownPromptBlocks<T extends { name: string; scope: string }>(db: DatabaseSync, libraryKey: string, blocks: readonly T[]): T[] {
  const own = blocks.filter(block => block.scope === "bot");
  if (!own.length) return [...blocks];
  let verdicts: ReturnType<typeof memoryLookup>;
  try { verdicts = memoryLookup(db, own.map(block => imageLibraryRef(libraryKey, "prompt-block", block.name)), doorReader()); }
  catch { return blocks.filter(block => block.scope !== "bot"); }
  return blocks.filter(block => block.scope !== "bot" || verdicts.get(memoryRefKey(imageLibraryRef(libraryKey, "prompt-block", block.name)))?.state === "shown");
}
