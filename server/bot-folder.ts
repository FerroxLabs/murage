import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

/** A turn cannot start without the folder supplied by its bot context. */
export class BotFolderUnavailableError extends Error {
  readonly code = "BOT_FOLDER_UNAVAILABLE";
  constructor() {
    super("couldn't find this bot's folder");
    this.name = "BotFolderUnavailableError";
  }
}

/** No default: callers must carry the bot's resolved folder across every launch. */
export function botFolderOrThrow(bot: { cwd?: unknown } | null | undefined): string {
  const cwd = bot?.cwd;
  if (typeof cwd !== "string" || !cwd.trim() || !isAbsolute(cwd) || cwd.includes("\0")) throw new BotFolderUnavailableError();
  try { if (statSync(cwd).isDirectory()) return cwd; } catch { /* same user text for unavailable folders */ }
  throw new BotFolderUnavailableError();
}
