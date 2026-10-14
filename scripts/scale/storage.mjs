// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Storage measurement for the scale gate (STORAGE-AUDIT section 6). rig.mjs calls these at the end of a run, on the
// data-dir copy with the server stopped; gate.mjs judges the result against budgets.json `storage`.
//   measureStorage: dbstat bytes per table (indexes counted with their table), live and file bytes, events/ bytes.
//   slopeBytes: bytes per new message early and late in the slope session, from live-byte samples taken per turn.
//   groupBytes: tables summed by name prefix (the groups are listed in budgets.json).
// dbstat missing is never a pass: the measurement comes back with `error`, and every storage row fails on it.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Bytes of every file under a directory (0 when it does not exist). */
export function dirBytes(dir) {
  let total = 0, entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) total += dirBytes(path);
    else if (e.isFile()) { try { total += statSync(path).size; } catch { /* gone meanwhile */ } }
  }
  return total;
}

const pragma = (db, name) => Number(Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0] ?? 0);

/** Live bytes, (page_count - freelist_count) x page_size: what a VACUUM would leave. Cheap (three pragmas). */
export function liveBytes(db) {
  return (pragma(db, "page_count") - pragma(db, "freelist_count")) * pragma(db, "page_size");
}

/** One end-of-run measurement of an open messages.db (a writable handle: the log is checkpointed first, so the file
 * size is the database alone). `file` is the path of messages.db, `eventsDir` the data dir's events/. */
export function measureStorage(db, { file, eventsDir } = {}) {
  const out = { at: new Date().toISOString() };
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (error) { out.checkpointError = String(error.message).slice(0, 160); }
  out.pageSize = pragma(db, "page_size");
  out.pageCount = pragma(db, "page_count");
  out.freelist = pragma(db, "freelist_count");
  out.autoVacuum = pragma(db, "auto_vacuum");
  out.liveBytes = (out.pageCount - out.freelist) * out.pageSize;
  try { out.fileBytes = file ? statSync(file).size : out.pageCount * out.pageSize; } catch { out.fileBytes = out.pageCount * out.pageSize; }
  out.eventsBytes = eventsDir ? dirBytes(eventsDir) : null;
  try {
    // one row per b-tree (aggregate), each index counted with the table it belongs to (autoindexes are in sqlite_schema too)
    const rows = db.prepare("SELECT coalesce(s.tbl_name, d.name) AS tbl, sum(d.pgsize) AS bytes FROM dbstat AS d LEFT JOIN sqlite_schema AS s ON s.name=d.name WHERE d.aggregate=TRUE GROUP BY 1").all();
    out.tables = Object.fromEntries(rows.map(r => [String(r.tbl), Number(r.bytes)]));
    // the messages b-tree alone (M in STORAGE-AUDIT): not its indexes
    out.messagesBytes = Number(db.prepare("SELECT sum(pgsize) AS bytes FROM dbstat WHERE name='messages' AND aggregate=TRUE").get()?.bytes ?? 0);
  } catch (error) {
    out.error = `dbstat unavailable: ${String(error.message).slice(0, 160)} (the storage gate cannot be judged without it)`;
  }
  return out;
}

/** Bytes of the tables whose names start with any of the prefixes. */
export function groupBytes(tables, prefixes) {
  return Object.entries(tables ?? {}).filter(([name]) => prefixes.some(p => name.startsWith(p))).reduce((a, [, b]) => a + b, 0);
}
/** Tables that fall in more than one group (a budgets.json mistake: their bytes would be judged twice). */
export function overlappingTables(tables, groups) {
  return Object.keys(tables ?? {}).filter(name => Object.values(groups).filter(prefixes => prefixes.some(p => name.startsWith(p))).length > 1);
}

/** Bytes per new message early and late in a run, from samples { live, messages } taken before the first turn and after
 * each turn. Early is the first `share` of the turns, late the last `share` (each at least one turn). */
export function slopeBytes(samples, share = 0.1) {
  const turns = Math.max(0, (samples?.length ?? 0) - 1);
  if (turns < 2) return { turns, error: `slope storage: ${turns} turns sampled (needs at least 2)` };
  const width = Math.max(1, Math.round(turns * share));
  const window = (from, to) => {
    const bytes = samples[to].live - samples[from].live, messages = samples[to].messages - samples[from].messages;
    return { turns: to - from, bytes, messages, perMessage: messages > 0 ? Math.round(bytes / messages) : null };
  };
  return { turns, early: window(0, width), late: window(turns - width, turns) };
}
