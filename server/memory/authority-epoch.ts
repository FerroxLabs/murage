// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The authority epoch (PROPOSAL-v2 10.1, AUDIT B1). `databaseStamp()` is
// `total_changes():data_version`, so any write through the main connection
// moves it, and every turn writes (receipts, counters, jobs). A dispatch check
// guarded by it therefore never skipped. The epoch moves only when something
// that could REVOKE what a bundle or a resumed session was shown changes: a
// record or source leaving or changing, a tombstone, a disclosure revoked, a
// scope binding, a policy revision or deletion epoch, a message deleted or
// turned into a copy, root-set and output-lineage edits. Plain growth (new
// records, new jobs, projection receipts, retrieval counters, new messages) does not move it.
//
// Temp triggers belong to this connection only and are not part of the
// validated memory schema, so no migration is involved (the lineage cache uses
// the same pattern). Another connection's commits are covered by
// `data_version`. If any trigger cannot be installed the stamp falls back to
// "every write", which is slower and never wrong.
import type { DatabaseSync } from "node:sqlite";
import { database } from "../database.ts";
import { databaseStamp } from "./replay-lineage.ts";

const BUMP = "UPDATE authority_epoch SET n=n+1";
function trigger(name: string, event: string, table: string, when?: string): string {
  return `CREATE TEMP TRIGGER IF NOT EXISTS authority_${name} AFTER ${event} ON main.${table}${when ? ` WHEN ${when}` : ""} BEGIN ${BUMP}; END;`;
}
const ALL_EVENTS = ["INSERT", "UPDATE", "DELETE"] as const;
function writes(table: string, events: readonly string[] = ALL_EVENTS, when?: string): string[] {
  return events.map(event => trigger(`${table}_${event[0].toLowerCase()}`, event, table, when));
}
/** Rows of memory_scope_bindings that background work rewrites all the time and that grant or remove nothing:
 * counters, cursors, intents of queued jobs. Every other binding (a person, a human thread, an exclusion, the
 * roster, a bot grant, the owner's settings) moves the epoch when it is written. */
const NOISY_SYSTEM_SUBJECTS = [
  "observability", "reveal-capture", "reveal-scan", "procedure-review", "procedure-review-pending", "pip-stance", "pip-render",
  "pip-reflect", "pip-coverage", "consolidation-pending", "consolidation", "parked-sweep", "parked-reconcile", "origin-backfill",
  "memory-shape-check", "gepa-job", "continuity-budget", "extract-budget", "memory-status-snapshot", "notebook-migration",
];
const NOISY = (row: "NEW" | "OLD") => `${row}.subject_type='system' AND ${row}.subject_id IN (${NOISY_SYSTEM_SUBJECTS.map(subject => `'${subject}'`).join(",")})`;
// A thread's checkpoint rolls to a new version on every captured message and the old version is archived; a receipt that cites
// the old version still holds (bundle.ts supersededThreadCheckpoint), so that one transition is not a revocation.
const RECORD_CHANGED = "(OLD.state IS NOT NEW.state AND NOT (OLD.kind='checkpoint' AND OLD.state='active' AND NEW.state='archived')) OR OLD.owner_pinned IS NOT NEW.owner_pinned OR OLD.assertion IS NOT NEW.assertion OR OLD.supersedes_id IS NOT NEW.supersedes_id OR OLD.kind IS NOT NEW.kind OR OLD.text IS NOT NEW.text OR OLD.scope_id IS NOT NEW.scope_id";
const SOURCE_CHANGED = "OLD.state IS NOT NEW.state OR OLD.revision IS NOT NEW.revision OR OLD.content_hash IS NOT NEW.content_hash OR OLD.speaker IS NOT NEW.speaker OR OLD.thread_id IS NOT NEW.thread_id OR OLD.message_id IS NOT NEW.message_id OR OLD.scope_id IS NOT NEW.scope_id";
// A row being ADDED never takes anything away from a bundle or a session that was already checked: a new record, source,
// job, receipt or disclosure grants nothing retroactively. Changes and removals are what the epoch counts, plus the rows
// whose arrival is itself a restriction (tombstones, audience bindings).
const TRIGGERS: string[] = [
  ...writes("memory_records", ["UPDATE"], RECORD_CHANGED), ...writes("memory_records", ["DELETE"]),
  ...writes("memory_sources", ["UPDATE"], SOURCE_CHANGED), ...writes("memory_sources", ["DELETE"]),
  ...writes("memory_source_versions", ["UPDATE", "DELETE"]),
  ...writes("memory_evidence", ["UPDATE", "DELETE"]),
  ...writes("memory_derivations", ["UPDATE", "DELETE"]),
  ...writes("memory_tombstones"),
  // (a trigger of the schema rewrites a record's details whenever its state changes; the state change is what counts)
  ...writes("memory_record_details", ["UPDATE"], "OLD.partition IS NOT NEW.partition"), ...writes("memory_record_details", ["DELETE"]),
  ...writes("memory_scopes", ["UPDATE", "DELETE"]),
  trigger("bindings_i", "INSERT", "memory_scope_bindings", `NOT (${NOISY("NEW")})`),
  trigger("bindings_u", "UPDATE", "memory_scope_bindings", `NOT (${NOISY("NEW")}) OR NOT (${NOISY("OLD")})`),
  trigger("bindings_d", "DELETE", "memory_scope_bindings", `NOT (${NOISY("OLD")})`),
  // A receipt matters when it is revoked or its contents change; becoming delivered, or getting its session bound, does not.
  ...writes("memory_disclosures", ["UPDATE"], "NEW.state='revoked' AND OLD.state IS NOT 'revoked' OR OLD.record_versions IS NOT NEW.record_versions OR OLD.source_versions IS NOT NEW.source_versions OR OLD.policy_revision IS NOT NEW.policy_revision OR OLD.deletion_epoch IS NOT NEW.deletion_epoch"),
  ...writes("memory_disclosures", ["DELETE"]),
  // Output links and roots are added for the reply a turn just produced, a new message nothing existing rests on; the lineage
  // cache treats them as dirty for that one message. Changing or removing one is what counts here.
  ...writes("memory_disclosure_outputs", ["UPDATE", "DELETE"]),
  ...writes("memory_output_roots", ["UPDATE", "DELETE"]),
  ...writes("memory_root_set_members", ["DELETE"]),
  ...writes("memory_root_sets", ["DELETE"]),
  ...writes("memory_lineage_meta", ["UPDATE", "DELETE"]),
  trigger("meta_u", "UPDATE", "memory_meta", "OLD.policy_revision IS NOT NEW.policy_revision OR OLD.deletion_epoch IS NOT NEW.deletion_epoch OR OLD.mode IS NOT NEW.mode"),
  trigger("messages_u", "UPDATE", "messages", "OLD.json IS NOT NEW.json AND (instr(OLD.json,'copyOf')>0 OR instr(NEW.json,'copyOf')>0)"),
  trigger("messages_d", "DELETE", "messages"),
];

/** A second counter for one question the turn asks every time and the index cannot answer: which records does the owner pin. It moves when a
 * pinned record is added, changed or removed, or a record is pinned or unpinned, and for nothing else. */
/** A checkpoint archived is only "rolled" if a newer version of it arrives: the roll writes both in one transaction. The archive leaves a mark
 * that the arrival of the successor clears; while a mark stands, the stamp differs from the one before it (an archive with no successor
 * takes the checkpoint away). */
const CHECKPOINT_TRIGGERS: string[] = [
  "CREATE TEMP TRIGGER IF NOT EXISTS authority_ckpt_archived AFTER UPDATE ON main.memory_records WHEN OLD.kind='checkpoint' AND OLD.state='active' AND NEW.state='archived' BEGIN INSERT OR IGNORE INTO authority_pending VALUES(OLD.id); END;",
  "CREATE TEMP TRIGGER IF NOT EXISTS authority_ckpt_arrived AFTER INSERT ON main.memory_records WHEN NEW.kind='checkpoint' BEGIN DELETE FROM authority_pending WHERE id=NEW.id; END;",
];
const PIN_BUMP = "UPDATE authority_epoch SET pins=pins+1";
const PIN_TRIGGERS: string[] = [
  `CREATE TEMP TRIGGER IF NOT EXISTS authority_pins_i AFTER INSERT ON main.memory_records WHEN NEW.owner_pinned=1 BEGIN ${PIN_BUMP}; END;`,
  `CREATE TEMP TRIGGER IF NOT EXISTS authority_pins_u AFTER UPDATE ON main.memory_records WHEN OLD.owner_pinned=1 OR NEW.owner_pinned=1 BEGIN ${PIN_BUMP}; END;`,
  `CREATE TEMP TRIGGER IF NOT EXISTS authority_pins_d AFTER DELETE ON main.memory_records WHEN OLD.owner_pinned=1 BEGIN ${PIN_BUMP}; END;`,
  `CREATE TEMP TRIGGER IF NOT EXISTS authority_pins_details AFTER UPDATE ON main.memory_record_details WHEN OLD.partition IS NOT NEW.partition BEGIN ${PIN_BUMP}; END;`,
];

const state = new WeakMap<object, boolean>();
let warned = false;
function install(db: DatabaseSync): boolean {
  const known = state.get(db);
  if (known !== undefined) return known;
  let ok = true;
  try {
    db.exec("CREATE TEMP TABLE IF NOT EXISTS authority_epoch(id INTEGER PRIMARY KEY CHECK(id=1), n INTEGER NOT NULL, pins INTEGER NOT NULL DEFAULT 0); INSERT OR IGNORE INTO temp.authority_epoch(id,n,pins) VALUES(1,0,0);\nCREATE TEMP TABLE IF NOT EXISTS authority_pending(id TEXT PRIMARY KEY);");
    for (const sql of [...TRIGGERS, ...PIN_TRIGGERS, ...CHECKPOINT_TRIGGERS]) db.exec(sql);
  } catch (error) {
    ok = false;
    if (!warned) { warned = true; console.warn(`[memory] authority epoch triggers could not be installed; every write moves the dispatch stamp (${error instanceof Error ? error.message : String(error)})`); }
  }
  state.set(db, ok);
  return ok;
}

/** Whether the epoch triggers are in place on the shared connection. */
export function authorityEpochInstalled(): boolean { return install(database()); }

/** A stamp that is equal at two moments only if nothing revocation-relevant was written in between by this
 * connection or committed by another. Undefined inside a transaction (a verdict may rest on writes that roll back). */
export function authorityStamp(): string | undefined {
  const db = database();
  if (db.isTransaction) return undefined;
  if (!install(db)) return databaseStamp();
  const row = db.prepare("SELECT (SELECT n FROM temp.authority_epoch) AS epoch, (SELECT count(*) FROM temp.authority_pending) AS pending, (SELECT data_version FROM pragma_data_version) AS version").get();
  return `a${row?.epoch}.${row?.pending}:${row?.version}`;
}

/** True when `since` no longer describes the database: an unknown stamp always counts as moved. */
export function authorityMoved(since: string | undefined): boolean {
  if (since === undefined) return true;
  return authorityStamp() !== since;
}

/** Equal at two moments only if no pinned record was added, changed or removed in between (here or by another connection). Undefined
 * inside a transaction and when the triggers are missing: the caller then asks the database. */
export function pinStamp(): string | undefined {
  const db = database();
  if (db.isTransaction || !install(db)) return undefined;
  const row = db.prepare("SELECT (SELECT pins FROM temp.authority_epoch) AS pins, (SELECT data_version FROM pragma_data_version) AS version").get();
  return `p${row?.pins}:${row?.version}`;
}
