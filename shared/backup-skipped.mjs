// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What a finished backup left out, in plain words (0.1.60 audit A-01). A bot's
// ordinary work never stops a backup: what truly can't be backed up is left
// out and listed after it, e.g.
//   "Skipped 2 items in Mira's folder: site/node_modules (installed packages,
//    reinstall them after a restore), notes 10:30.md (couldn't be read).
//    Everything else was backed up."
// Paths are shown inside the bot's own folder, or inside Murage's data folder.

const REASONS = Object.freeze({
  rebuildable: "installed packages or a cache, reinstall them after a restore",
  "file-limit": "over the 100,000-item limit for one backup",
  unreadable: "couldn't be read",
  special: "not a regular file",
  "too-deep": "too many folders deep",
  "linked-folder": "a shortcut to a folder outside Murage's data folder, so its contents aren't in the backup",
  "path-too-long": "its path is too long for another computer to hold",
});

/** One sentence per folder, or [] when nothing was left out. `skipped` is
 * { count, items: [{ path, reason }], bots: { id: name } }. */
export function backupSkippedLines(skipped) {
  if (!skipped || typeof skipped !== "object" || !Number.isSafeInteger(skipped.count) || skipped.count < 1 || !Array.isArray(skipped.items)) return [];
  const bots = skipped.bots && typeof skipped.bots === "object" ? skipped.bots : {};
  const groups = new Map();
  for (const item of skipped.items) {
    if (!item || typeof item.path !== "string" || !Object.hasOwn(REASONS, item.reason)) continue;
    const bot = /^workspaces\/([^/]+)\/(.+)$/.exec(item.path);
    const where = bot ? (typeof bots[bot[1]] === "string" ? `${bots[bot[1]]}'s folder` : "a bot's folder") : "Murage's data folder";
    const shown = bot ? bot[2] : item.path;
    if (!groups.has(where)) groups.set(where, []);
    groups.get(where).push(`${shown} (${REASONS[item.reason]})`);
  }
  const lines = [...groups].map(([where, entries]) => `Skipped ${entries.length} ${entries.length === 1 ? "item" : "items"} in ${where}: ${entries.join(", ")}.`);
  const listed = [...groups.values()].reduce((total, entries) => total + entries.length, 0);
  if (skipped.count > listed) lines.push(`${lines.length ? "And" : "Skipped"} ${skipped.count - listed} more ${skipped.count - listed === 1 ? "item" : "items"} for the same reasons.`);
  if (lines.length) lines.push("Everything else was backed up.");
  return lines;
}
