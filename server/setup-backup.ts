// Where the first run's backup step stands (Settings L5).
//
// Setup ends VERIFIED: configured is not protected. So the first run is only
// finished once a checked backup exists, or the person chose to keep backups
// off.
//
// ONE state, owned by the desktop backup host and this harness together, and
// nothing a caller says is taken as a fact:
//  - the desktop host owns the facts: its schedule, its receipt and its
//    first-run record, in the backup control folder it names to this harness
//    at launch (MURAGE_BACKUP_CONTROL_DIR);
//  - this harness owns setup-backup.json in the data folder: whether this
//    folder owes the first-run backup at all, written ONCE when setup starts
//    on a folder that has never had backups (durable initialization), and the
//    ending it derived, kept so that losing the desktop's record never reopens
//    it. The desktop reads this file before it will set backups up without
//    asking;
//  - setup.json (the checklist) carries the same "owed" fact while the step
//    is open, written by the same initialization: once setup.json exists,
//    initialization never runs again, so losing setup-backup.json alone must
//    not read as "never owed" (Astra r3 R1-4). Each boot reconciles the two:
//    either one saying owed keeps the step pending and restores the other.
//    Once the step has ended "off" the marker leaves setup.json again, so the
//    file returns to the shape 1.0.2 reads; a "verified" ending keeps it,
//    because verified is re-derived and reopens when the folder or key
//    changes.
// "verified" is derived on every read from a receipt that matches the
// schedule's CURRENT folder and key. A request to POST /api/setup/backup only
// asks for that derivation to run now; a body that claims a state is refused.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { BackupCoordinator } from "./backup-coordinator.ts";
import { DATA_DIR } from "./config.ts";
import { SETUP_BACKUP_FILE_NAME, readSetupBackupRecord, type SetupBackupRecord } from "../shared/setup-backup-record.mjs";
import { emptySetupState, setupStateSchema, type SetupBackupReading, type SetupState } from "../shared/setup.ts";
import { SETUP_FILE } from "./setup.ts";

export interface SetupBackupSources {
  /** The data folder that holds setup-backup.json. */
  dataDir: string;
  /** The desktop backup host's control folder, or undefined off the desktop. */
  controlDirectory: string | undefined;
  /** The checklist file (setup.json), which keeps a second copy of "owed" while the step is open. */
  setupFile?: string;
  now?: () => number;
}

export function defaultSetupBackupSources(): SetupBackupSources {
  const control = process.env.MURAGE_DESKTOP_PARENT === "1" ? process.env.MURAGE_BACKUP_CONTROL_DIR : undefined;
  return { dataDir: DATA_DIR, controlDirectory: control && control.length < 4096 ? control : undefined, setupFile: SETUP_FILE };
}

/** A request, never a claim. `{}` asks for the derivation to run now.
 * `{choice:"off"}` is the person's own request to keep backups off, for a
 * desktop whose backup host could not start: it can only end an owed step as
 * "off", which never says anything is protected. No body can say "verified". */
export const setupBackupRequestSchema = z.union([z.object({}).strict(), z.object({ choice: z.literal("off") }).strict()]);

type HostFacts = {
  /** The desktop recorded the person's choice to keep backups off. */
  off: boolean;
  /** The receipt was taken of the schedule's current folder and key, and backups are on. */
  receiptCurrent: boolean;
  /** Nothing was ever set up here: no schedule, no receipt, no recorded ending. */
  fresh: boolean;
} | null;

function hostFacts(controlDirectory: string | undefined): HostFacts {
  if (!controlDirectory) return null;
  const coordinator = new BackupCoordinator({ stateDirectory: controlDirectory });
  let record: ReturnType<BackupCoordinator["firstRunRecord"]> | "unreadable";
  try { record = coordinator.firstRunRecord(); } catch { record = "unreadable"; }
  let status: ReturnType<BackupCoordinator["status"]>;
  try { status = coordinator.status(); } catch { return { off: record !== "unreadable" && record?.state === "off", receiptCurrent: false, fresh: false }; }
  const r = status.lastVerified, schedule = status.schedule;
  return {
    off: record !== "unreadable" && record?.state === "off",
    receiptCurrent: Boolean(status.enabled && r && schedule.installationRef && schedule.destinationRef && schedule.recoveryRef
      && r.installationRef === schedule.installationRef && r.destinationRef === schedule.destinationRef),
    fresh: record === undefined && status.revision === 0 && !r && !status.job,
  };
}

function write(dataDir: string, record: Omit<SetupBackupRecord, "version" | "at">, now: number) {
  writeFileAtomic(join(dataDir, SETUP_BACKUP_FILE_NAME), JSON.stringify({ version: 2, owed: record.owed, ending: record.ending, at: now }), { mode: 0o600 });
}

/** setup.json as the checklist reads it: missing, unreadable (the checklist starts afresh), or the state. */
function readChecklist(file: string): { kind: "missing" } | { kind: "unreadable" } | { kind: "state"; state: SetupState } {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return { kind: "unreadable" };
    const parsed = setupStateSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? { kind: "state", state: parsed.data } : { kind: "unreadable" };
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable" };
  }
}
const checklistOwed = (sources: SetupBackupSources) => {
  if (!sources.setupFile) return false;
  const read = readChecklist(sources.setupFile);
  return read.kind === "state" && read.state.backupOwed === true;
};
/** Writes setup.json with the marker set or removed. An unreadable or missing checklist is one the checklist would start afresh, so the
 * marker goes onto a fresh one, exactly as it would load it. */
function writeChecklistOwed(file: string, owed: boolean, now: number) {
  const read = readChecklist(file);
  if (!owed && read.kind !== "state") return;
  const base: SetupState = read.kind === "state" ? read.state : emptySetupState(now);
  const { backupOwed: _was, ...rest } = base;
  const next = setupStateSchema.parse(owed ? { ...rest, backupOwed: true } : rest);
  writeFileAtomic(file, JSON.stringify(next, null, 2), { mode: 0o600 });
}

/** Durable initialization at harness start, before the checklist loads: a
 * data folder whose setup has never started, and whose desktop backup host
 * has never had backups, owes the first-run backup, recorded in
 * setup-backup.json and in setup.json. Every other folder (one that predates
 * the first-run backup, or a harness off the desktop) is never marked, and so
 * is never held. On every later boot the two copies are reconciled: either
 * one saying owed restores the other; an "off" ending removes the
 * setup.json marker, a "verified" one never does. */
export function initializeSetupBackup(setupFresh: boolean, sources: SetupBackupSources = defaultSetupBackupSources()): void {
  const now = sources.now?.() ?? Date.now();
  if (setupFresh && sources.controlDirectory && !existsSync(join(sources.dataDir, SETUP_BACKUP_FILE_NAME)) && hostFacts(sources.controlDirectory)?.fresh) {
    write(sources.dataDir, { owed: true, ending: null }, now);
  }
  if (!sources.setupFile) return;
  const own = readSetupBackupRecord(sources.dataDir);
  const kept = own.kind === "record" ? own.record : null;
  const marked = checklistOwed(sources);
  const owed = Boolean(kept?.owed) || own.kind === "unreadable" || marked;
  if (!owed) return;
  // Only "off" is an ending that stands on its own. "verified" is re-derived from the current receipt and goes back to pending when the
  // folder or key changes (Astra r4), so the marker stays for as long as the step can reopen.
  const reading = deriveSetupBackup(sources);
  if (reading === "off") { if (marked) writeChecklistOwed(sources.setupFile, false, now); return; }
  if (!marked) writeChecklistOwed(sources.setupFile, true, now);
  if (readSetupBackupRecord(sources.dataDir).kind === "missing") write(sources.dataDir, { owed: true, ending: null }, now);
}

/** Where the step stands, derived now. "off" stands wherever it was
 * recorded; "verified" only while a receipt of the current folder and key
 * exists; "pending" while this folder owes the step (or its record cannot be
 * read); null where it was never owed. An ending is kept in this harness's
 * own record the first time it is seen. */
export function deriveSetupBackup(sources: SetupBackupSources = defaultSetupBackupSources()): SetupBackupReading | null {
  const own = readSetupBackupRecord(sources.dataDir);
  const facts = hostFacts(sources.controlDirectory);
  const kept = own.kind === "record" ? own.record : null;
  // setup.json's copy covers a lost setup-backup.json (Astra r3 R1-4)
  const marked = own.kind === "missing" && checklistOwed(sources);
  const owed = own.kind === "unreadable" || Boolean(kept?.owed) || marked;
  // A checked backup of the folder and key in use now outranks an earlier
  // "off": backups turned on later and proven are protected.
  const reading: SetupBackupReading | null = facts?.receiptCurrent ? "verified"
    : kept?.ending === "off" || facts?.off ? "off"
    : owed ? "pending" : null;
  if ((reading === "off" || reading === "verified") && kept?.ending !== reading && owed) {
    try { write(sources.dataDir, { owed: true, ending: reading }, sources.now?.() ?? Date.now()); } catch { /* derived again at the next read */ }
  } else if (reading === "pending" && marked) {
    // the desktop reads setup-backup.json before it sets backups up without asking: restore it from setup.json's copy
    try { write(sources.dataDir, { owed: true, ending: null }, sources.now?.() ?? Date.now()); } catch { /* derived again at the next read */ }
  }
  return reading;
}

/** POST /api/setup/backup: asks for the derivation to run now. */
export function setupBackupRequest(body: unknown, sources: SetupBackupSources = defaultSetupBackupSources()): { status: number; body: Record<string, unknown> } {
  const input = setupBackupRequestSchema.safeParse(body ?? {});
  if (!input.success) return { status: 400, body: { error: "INVALID_SETUP_BACKUP" } };
  if ("choice" in input.data && deriveSetupBackup(sources) === "pending") {
    write(sources.dataDir, { owed: true, ending: "off" }, sources.now?.() ?? Date.now());
  }
  return { status: 200, body: { state: deriveSetupBackup(sources) } };
}
