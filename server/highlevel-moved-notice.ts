// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.20 (Sean 11-19): Murage's own HighLevel integration is removed. HighLevel connects only through Connected apps
// (Composio) or an owner-added MCP server. An owner who had the built-in connection set up is told so ONCE, in one plain
// line, on the first desktop start after the update. Nothing else about HighLevel is shown anywhere.
//
// The owner's stored HighLevel files (DATA_DIR/highlevel/*) and token are left exactly as they are: this only checks
// whether they exist and never opens, rewrites or deletes them (cleanup is a 1.0.21 row, with the owner's consent).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

export const HIGHLEVEL_MOVED_LINE = "HighLevel now connects through Connected apps (Composio) or your own MCP server.";
const FILE = "highlevel-moved-notice.json";

/** Whether this install had the built-in HighLevel connection set up: a saved token, the connection folder, or a bot
 *  that held a built-in HighLevel grant. Existence checks only. */
export function hadBuiltInHighLevel(input: { dataDir: string; privateToken?: string; bots: ReadonlyArray<{ highlevelAccess?: unknown }> }): boolean {
  if (typeof input.privateToken === "string" && input.privateToken.trim() !== "") return true;
  if (existsSync(join(input.dataDir, "highlevel"))) return true;
  return input.bots.some((bot) => {
    const grants = (bot.highlevelAccess as { grants?: unknown } | null | undefined)?.grants;
    return Array.isArray(grants) && grants.length > 0;
  });
}

function shown(dataDir: string): boolean {
  try { return existsSync(join(dataDir, FILE)) && JSON.parse(readFileSync(join(dataDir, FILE), "utf8"))?.shown === true; }
  catch { return true; } // a damaged marker never shows the line twice
}

/** The line, the first time it is asked for on an install that had the built-in connection; null otherwise and every
 *  time after. The marker is written before the line is handed out, so a failed write shows nothing (never twice). */
export function takeHighLevelMovedLine(input: { dataDir: string; privateToken?: string; bots: ReadonlyArray<{ highlevelAccess?: unknown }> }): string | null {
  if (shown(input.dataDir) || !hadBuiltInHighLevel(input)) return null;
  try { writeFileAtomic(join(input.dataDir, FILE), JSON.stringify({ shown: true, at: Date.now() }) + "\n", { mode: 0o600 }); }
  catch { return null; }
  return HIGHLEVEL_MOVED_LINE;
}
