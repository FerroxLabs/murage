// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F10/E1 "Every bot": the owner marks a skill once and every bot they have,
// and every bot they add later, gets a copy (skills-api.ts does the copying
// through the same "Use with" path). This file only keeps the marks:
// DATA_DIR/skill-state/every-bot.json, mode 0600. The name has a dot, so it
// can never be a bot's own skill-state folder ([\w-]+ ids).
//
// An unreadable record cannot authorize replacing ownership.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

export interface EveryBotMark {
  /** The scan hash the owner said yes to, for a skill that needs a look. Honoured only while it equals the current scan. */
  acknowledged?: string;
  /** Bots this mark switched on. Off turns only these off; a bot here is never given it again. */
  appliedTo: string[];
  /** Durable intent before enabling; OFF also drains unfinished applications. */
  pendingTo?: string[];
  /** An interrupted OFF must never grant this skill to newly created bots. */
  turningOff?: boolean;
}
const botIds = z.array(z.string().regex(/^[\w-]{1,128}$/)).max(100_000);
const markSchema = z.object({ acknowledged: z.string().regex(/^[a-f0-9]{64}$/).optional(), appliedTo: botIds, pendingTo: botIds.optional(), turningOff: z.boolean().optional() }).strict();
const fileSchema = z.object({ version: z.literal(1), marks: z.record(z.string().regex(/^(collection|library):[a-z0-9][a-z0-9-]{0,127}$/), markSchema) }).strict();

export const everyBotFile = (): string => join(DATA_DIR, "skill-state", "every-bot.json");

export function readEveryBotMarks(): Record<string, EveryBotMark> | null {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(everyBotFile(), "utf8")));
    return parsed.success ? parsed.data.marks : null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
  }
}

export function writeEveryBotMarks(marks: Record<string, EveryBotMark>): void {
  // A fresh workspace has no skill-state folder yet: the first mark makes it.
  mkdirSync(dirname(everyBotFile()), { recursive: true, mode: 0o700 });
  writeFileAtomic(everyBotFile(), JSON.stringify({ version: 1, marks }, null, 2) + "\n", { mode: 0o600 });
}

// Deletion removes both completed ownership and interrupted apply intents.
export function removeBotFromEveryBotMarks(botId: string): void {
  const marks = readEveryBotMarks();
  if (!marks) return;
  let changed = false;
  for (const mark of Object.values(marks)) {
    if (mark.appliedTo.includes(botId) || mark.pendingTo?.includes(botId)) {
      mark.appliedTo = mark.appliedTo.filter(id => id !== botId);
      if (mark.pendingTo) mark.pendingTo = mark.pendingTo.filter(id => id !== botId);
      changed = true;
    }
  }
  if (changed) writeEveryBotMarks(marks);
}
