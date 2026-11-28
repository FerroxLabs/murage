// Settings v10 K2: the app version in which each library skill id first appeared.
// Its own small database, never part of the rebuildable skill index, so an index
// rebuild with unchanged entries makes nothing New. The first time this runs on a
// home every id present is "before this version" and never New.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "./sqlite-open.ts";
import { DATA_DIR } from "./config.ts";

export const BASELINE_VERSION = "before";

export interface FirstSeen {
  version: string;
  at: string;
}

const FILE = () => join(DATA_DIR, "skill-first-seen.db");

function open(): DatabaseSync {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(FILE());
  db.exec("CREATE TABLE IF NOT EXISTS first_seen(id TEXT PRIMARY KEY, version TEXT NOT NULL, at TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return db;
}

/** Record every id not seen before, then return the first-seen map. On the very
 * first call for a home the ids already there are stamped "before" and are never New. */
export function recordSkillsSeen(ids: readonly string[], appVersion: string, now = new Date()): Map<string, FirstSeen> {
  const db = open();
  try {
    const initialised = db.prepare("SELECT value FROM meta WHERE key = 'initialised'").get() as { value?: string } | undefined;
    const version = initialised ? appVersion : BASELINE_VERSION;
    const insert = db.prepare("INSERT OR IGNORE INTO first_seen(id, version, at) VALUES (?, ?, ?)");
    db.exec("BEGIN");
    try {
      for (const id of ids) insert.run(id, version, now.toISOString());
      db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('initialised', ?)").run(now.toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const map = new Map<string, FirstSeen>();
    for (const row of db.prepare("SELECT id, version, at FROM first_seen").all() as Array<{ id: string; version: string; at: string }>) {
      map.set(row.id, { version: row.version, at: row.at });
    }
    return map;
  } finally {
    db.close();
  }
}

/** New in this version: first seen in exactly the running version, never at the baseline. */
export function isNewInVersion(seen: FirstSeen | undefined, appVersion: string): boolean {
  return Boolean(seen) && seen!.version === appVersion && seen!.version !== BASELINE_VERSION;
}
