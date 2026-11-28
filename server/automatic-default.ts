// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F33 (Sean 2026-11-27, owner q1024-autodefault): Murage starts in Automatic mode. A fresh install's bots start at Full access,
// shown to the customer as "Automatic"; the edge guards under it (rulebook 12) keep asking at every level. The install shows one
// notice, once. An upgraded install keeps every level it has and never sees the notice: nothing is widened without the owner.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "./config.ts";

/** What still asks in Automatic, in plain words (rulebook 12 edge list). The notice and its help article name these. */
export const AUTOMATIC_ALWAYS_ASKS: readonly string[] = [
  "Deleting a lot at once, like a whole folder or drive",
  "Spending money because a web page, email or file told it to",
  "Messaging someone new, or someone other than you",
  "Posting where other people will see it",
];

/** A fresh install has neither a saved config nor a saved bot. Any one of them means an earlier version ran here: that is an
 * upgrade (or a restore), and its levels are left exactly as they are. Read before anything writes either file. */
export function isFreshInstall(dataDir: string): boolean {
  return !existsSync(join(dataDir, "config.json")) && !existsSync(join(dataDir, "bots.json"));
}

/** The one write a fresh install gets: new bots start at Full access (Automatic) and the notice is pending. Never called on an
 * upgrade, and an owner's own new-bot level always wins (`??=`). Returns the patch to persist, or null when there is nothing to do. */
export function automaticDefaultSeed(cfg: Pick<AppConfig, "newBots" | "automaticNotice">): Pick<AppConfig, "newBots" | "automaticNotice"> | null {
  if (cfg.newBots?.permissionLevel !== undefined && cfg.automaticNotice !== undefined) return null;
  return { newBots: { ...cfg.newBots, permissionLevel: cfg.newBots?.permissionLevel ?? "full" }, automaticNotice: cfg.automaticNotice ?? "pending" };
}

/** The renderer shows the notice only while it is pending: absent (an upgrade) and acknowledged both mean never. */
export function automaticNoticePending(cfg: Pick<AppConfig, "automaticNotice">): boolean {
  return cfg.automaticNotice === "pending";
}
