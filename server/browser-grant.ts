// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// DESIGN-JOURNEY-1024 sections 0C + 3 (owner: q1024-journey build seat; extension side: q1024-journeyind): the one per-bot grant.
// `chrome` ("Can use your browser"): unset = not decided, 'on' = rungs 2 (and 3 with screenWithBrowser), 'off' = never, at every level.
// `screenWithBrowser`: the screen half of the OK, written ONLY by an OK surface that named the screen; never by migration or restore.
// `browserGrantMigrated`: the legacy route (browserMode / useMyChrome / browserTransport) is read into `chrome` once per record, so a
// restore that drops `on` is never re-granted by the legacy fields it keeps (F5 same-home rule).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic.ts';
import { readPersistedRecords } from './persisted-state.ts';
import type { BrowserChoiceBot } from './browser-mode-transition.ts';

export type BrowserGrant = 'on' | 'off';
export type BrowserGrantBot = BrowserChoiceBot & { chrome?: unknown; screenWithBrowser?: unknown; browserGrantMigrated?: unknown };

/** Boot migration (W13), once per record. Returns true when the record changed. Unknown values are dropped (unset = not decided).
 * `storedMode` is the selection BrowserModeStorage validated for this bot (its storedMode), the only authority: an ambiguous legacy
 * record it left unmapped is never read again from its raw fields here (ASTRA d961956a02), so it stays undecided (fail closed). */
export function migrateBrowserGrant(bot: BrowserGrantBot, storedMode: string | undefined): boolean {
  let changed = false;
  if (bot.chrome !== undefined && bot.chrome !== 'on' && bot.chrome !== 'off') { delete bot.chrome; changed = true; }
  if (bot.screenWithBrowser !== undefined && bot.screenWithBrowser !== true) { delete bot.screenWithBrowser; changed = true; }
  if (bot.browserGrantMigrated === true) return changed;
  // The owner chose their own Chrome before (extension, or the legacy inspect route, which is shown "Not set up" until the extension
  // says hello): rungs 2 only. A bot on its own browser stays undecided. The screen bit is never inferred.
  // A record whose browser was switched off stays undecided (fail closed).
  if (bot.chrome === undefined && (bot as { browser?: unknown }).browser !== false && (storedMode === 'chrome-extension' || storedMode === 'chrome-direct')) bot.chrome = 'on';
  bot.browserGrantMigrated = true;
  return true;
}

/** Restore (backup or reset): an Off survives, an On and the screen bit never come back from a backup; the record counts as migrated. */
export function restoredBrowserGrant(record: Record<string, unknown>): void {
  if (record.chrome !== 'off') delete record.chrome;
  delete record.screenWithBrowser;
  record.browserGrantMigrated = true;
}

/** A Cloud reset or undo (consumeRestoreMarker at boot, before the store reads bots.json; ASTRA d961956a02): the restored roster gets the
 * same grant rule as a desktop restore. Idempotent, so a crash before the marker's commit just does it again at the next boot. The rename
 * is made durable (parent directory fsync) BEFORE the marker's commit (ASTRA 656f9e0447): a power cut never keeps the commit without it. */
export function dropRestoredBrowserGrants(dataDir: string): void {
  const file = join(dataDir, 'bots.json');
  if (!existsSync(file)) return;
  // The store's own reader (store.ts Store.load), so the scrub sees exactly what the store will load (BOM included, ASTRA 4b3ab21cf7);
  // a roster it cannot read throws here, the marker stays and the boot step fails, as the store would (fail closed).
  const bots = readPersistedRecords<Record<string, unknown>>(file);
  for (const record of bots) restoredBrowserGrant(record);
  // Always written and synced, even when nothing changed: a retry after a failed directory sync must sync again (ASTRA 7bdb8d0f49).
  writeFileAtomic(file, JSON.stringify(bots), { mode: 0o600, syncDir: true });
}

export const browserGrantOf = (bot: { chrome?: unknown }): BrowserGrant | undefined => bot.chrome === 'on' || bot.chrome === 'off' ? bot.chrome : undefined;
