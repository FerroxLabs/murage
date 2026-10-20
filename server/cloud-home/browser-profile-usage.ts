// SPDX-License-Identifier: AGPL-3.0-or-later
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";
import { cloudHomeCopy } from "./copy.ts";

const bot = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const partition = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const schema = z.object({ version: z.literal(1), bots: z.record(bot, z.array(partition).max(512)) }).strict();
/** Own metadata, not browser/sign-in files. Usage is durable before launch,
 * retained after reassignment, and cleared only after whole-bot erasure. */
export class CloudBrowserProfileUsage {
  readonly #file: string;
  readonly #browserRoot: string;
  #bots: Record<string, string[]> = {};
  constructor(file: string, browserRoot: string) {
    this.#file = file; this.#browserRoot = browserRoot;
    try { this.#bots = schema.parse(JSON.parse(readFileSync(file, "utf8"))).bots; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(cloudHomeCopy.profileHistoryUnknown); }
  }
  assertKnown(ids: readonly string[]): void {
    for (const id of ids) {
      if (!bot.safeParse(id).success) throw new Error(cloudHomeCopy.profileHistoryUnknown);
      if (Object.hasOwn(this.#bots, id)) continue;
      for (const name of [id, `.cleanup-${id}`]) {
        try { lstatSync(join(this.#browserRoot, name)); throw new Error(cloudHomeCopy.profileHistoryUnknown); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(cloudHomeCopy.profileHistoryUnknown); }
      }
    }
  }
  record(id: string, partitionId?: string): void {
    this.assertKnown([id]);
    if (partitionId !== undefined && !partition.safeParse(partitionId).success) throw new Error(cloudHomeCopy.profileHistoryUnknown);
    const existing = this.#bots[id];
    if (existing && (partitionId === undefined || existing.includes(partitionId))) return;
    const next = { ...this.#bots, [id]: [...new Set([...(existing ?? []), ...(partitionId ? [partitionId] : [])])] };
    writeFileAtomic(this.#file, JSON.stringify({ version: 1, bots: next }), { mode: 0o600 }); this.#bots = next;
  }
  botsFor(partitionId: string, knownBots: readonly string[]): string[] {
    this.assertKnown(knownBots);
    return Object.entries(this.#bots).filter(([, ids]) => ids.some(id => id.toLowerCase() === partitionId.toLowerCase())).map(([id]) => id).sort();
  }
  erased(ids: readonly string[]): void {
    const next = { ...this.#bots }; for (const id of ids) delete next[id];
    writeFileAtomic(this.#file, JSON.stringify({ version: 1, bots: next }), { mode: 0o600 }); this.#bots = next;
  }
}
