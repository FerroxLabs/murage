// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every top-level name Murage writes in its data folder, and what a backup
// does with it. This is the ONE list: the restorable stage
// (installation-state-snapshot.ts), the fidelity inventory
// (installation-fidelity-snapshot.ts) and the damaged-installation export
// (installation-damaged-export.ts) all read it.
//
// Why one list: a backup refuses any top-level name it does not know
// (BACKUP_UNCLASSIFIED_COMPONENT), because silently skipping an unknown file
// could lose owner work. Until 0.1.60 the classification lived in three
// separate hand-kept lists, and each new feature that wrote a file at the
// root (setup.json, queued-messages.json, What's New, House Rules, then About
// me, the skill collection, the stop line, Telegram) paused every backup of
// every owner who used it. data-dir-inventory.test.ts now fails when code
// writes a root name this file does not classify.
//
// Kinds:
//   record       required JSON record, validated and projected into the
//                restorable stage; reported "missing" when absent
//   owner-file   optional owner file copied into the restorable stage
//   owner-folder folder of owner work copied into the restorable stage
//   database     messages.db, captured through a consistent SQLite snapshot
//   sidecar      SQLite -wal/-shm files covered by their database's snapshot
//   retained     kept in the encrypted backup but never restored by itself
//   excluded     runtime, cache, rebuildable, trust or credential state;
//                never in a backup
//   refused      a state no backup may capture yet; the backup stops with
//                `code` until Murage itself clears it

export type DataDirBackup = "record" | "owner-file" | "owner-folder" | "database" | "sidecar" | "retained" | "excluded" | "refused";
export interface DataDirEntry {
  backup: DataDirBackup;
  /** Plain reason, shown in backup coverage for excluded and retained names. */
  why: string;
  /** Only for "refused": the backup's stop code. */
  code?: string;
}

const APPLICATION = "Application data preserved in encrypted fidelity payload";
const DOWNLOADED = "Downloaded copy fetched again when needed; not restored";
const RUNTIME = "Outside application-data capture; native/credential/derived state is not restored";
const TRUST = "Host identity and folder execution authority require fresh trust; not restored";
const CREDENTIAL = "Credential home re-added on the restored computer; not restored";
const LEFTOVER = "Temporary files left by an interrupted task; not restored";
const DERIVED_SKILLS = "Derived skill search index rebuilt from the skill library; not restored";
const RESTORE_MARKER = "Written by a restore into the installation it made; not restored";
const OS_METADATA = "Folder metadata the operating system writes; not restored";

const record = (): DataDirEntry => ({ backup: "record", why: APPLICATION });
const ownerFile = (): DataDirEntry => ({ backup: "owner-file", why: APPLICATION });
const ownerFolder = (): DataDirEntry => ({ backup: "owner-folder", why: APPLICATION });
const excluded = (why: string): DataDirEntry => ({ backup: "excluded", why });

export const DATA_DIR_ENTRIES: Readonly<Record<string, DataDirEntry>> = Object.freeze({
  // Required records (store.ts, routines.ts, config.ts and friends).
  "config.json": record(), "bots.json": record(), "groups.json": record(), "routines.json": record(),
  "calendar-calls.json": record(), "webhooks.json": record(), "delegations.json": record(),
  "delegation-receipts.json": record(), "section-contexts.json": record(), "browser-cleanups.json": record(),

  // Owner files present only in some installations. setup.json holds the
  // Chief of Staff and brief routine first run chose (setup.ts);
  // queued-messages.json the owner's words waiting behind a turn when Murage
  // closed (index.ts F7); whats-new.json the What's New pages already shown;
  // announcements.json the announcements seen or dismissed; house-rules.md and
  // house-rules.json the House Rules text and switch; about-me.md what the
  // owner wrote in Settings > About me (about-me.ts).
  "setup.json": ownerFile(), "queued-messages.json": ownerFile(), "whats-new.json": ownerFile(),
  "announcements.json": ownerFile(), "house-rules.md": ownerFile(), "house-rules.json": ownerFile(),
  "about-me.md": ownerFile(),
  // The approval decision log (decision-log.ts) and its one rotated file.
  // It is the owner's own record of what each bot was allowed or denied,
  // with command lines already passed through redactSecrets. It is no more
  // sensitive than messages.db, which holds the full commands and is backed
  // up the same way, encrypted with the owner's recovery key. It grants
  // nothing: approvals are decided from bots.json and routines.json, never
  // from this log, so restoring it restores history, not authority. Deleting
  // a conversation redacts its rows here just as it removes its messages.
  "decisions.ndjson": ownerFile(), "decisions.ndjson.1": ownerFile(),

  // Folders of owner work. skill-collection holds the skills the owner
  // imported or wrote in Settings > Skills (skill-collection.ts).
  "attachments": ownerFolder(), "artifact-files": ownerFolder(), "workspaces": ownerFolder(),
  "skills": ownerFolder(), "skill-state": ownerFolder(), "checkpoints": ownerFolder(), "events": ownerFolder(),
  "skill-collection": ownerFolder(),

  "messages.db": { backup: "database", why: APPLICATION },
  "messages.db-wal": { backup: "sidecar", why: APPLICATION },
  "messages.db-shm": { backup: "sidecar", why: APPLICATION },
  "memory-index.db-wal": { backup: "sidecar", why: APPLICATION },
  "memory-index.db-shm": { backup: "sidecar", why: APPLICATION },

  // Retained encrypted, never restored by themselves.
  "memory-index.db": { backup: "retained", why: "Consistent memory search projection retained encrypted only; rebuild from paused messages.db authority after review" },
  "channels": { backup: "retained", why: "Channel bindings and receipt history retained encrypted only; re-pairing required before use" },
  "startup-background.json": { backup: "retained", why: "Startup preferences retained encrypted only; automatic startup is not restored" },

  // Runtime and derived state.
  "messages.pre-memory-v2.db": excluded("Pre-upgrade copy of messages.db kept for manual 0.1.x rollback only; the live messages.db is the backed-up authority"),
  "native": excluded(RUNTIME), "pending-deletions.json": excluded(RUNTIME), "memory-index": excluded(RUNTIME),
  "models": excluded(RUNTIME), "logs": excluded(RUNTIME), "tmp": excluded(RUNTIME), "browser-profiles": excluded(RUNTIME),
  "browser-engine": excluded(RUNTIME),
  // Handoff budgets that expire after 24 hours (coordination-budget.ts) and
  // who holds each native browser session (browser-control.ts).
  "coordination-roots.json": excluded(RUNTIME), "browser-control.json": excluded(RUNTIME),
  "skill-index.db": excluded(DERIVED_SKILLS), "skill-index.db-wal": excluded(DERIVED_SKILLS),
  "skill-index.db-shm": excluded(DERIVED_SKILLS), "skill-index.db-journal": excluded(DERIVED_SKILLS),
  // Downloads Murage fetches again on demand: model catalogs, managed engine
  // binaries, the team-library catalog copy, the memory embedding model, the
  // pinned agent-browser binary, the signed announcements feed and each bot's
  // engine "/" commands as last reported.
  "provider-catalogs": excluded(DOWNLOADED), "managed-engines": excluded(DOWNLOADED), "team-library": excluded(DOWNLOADED),
  "memory-model": excluded(DOWNLOADED), "tools": excluded(DOWNLOADED), "announcements-cache": excluded(DOWNLOADED),
  "engine-commands.json": excluded(DOWNLOADED),

  // Trust Murage asks for again on a restored computer: the host identity,
  // folders the owner trusted, and the stop line's remembered recipients
  // (stop-line-state.ts), which decide when a send needs no card.
  "door-identity": excluded(TRUST), "folder-trust.json": excluded(TRUST), "stop-line": excluded(TRUST),

  // Credentials and pairings, made again on the restored computer: Claude
  // account config dirs, the Hermes engine home, the dev harness broker token,
  // local model servers with their keys, the browser engine's encryption key
  // (browser-engine.ts; it only opens browser state that is not restored
  // either), the Telegram pairing (telegram-service.ts; the token itself is
  // in the credential store) and restored connection profiles.
  "credentials.bin": excluded(CREDENTIAL), "companion": excluded(CREDENTIAL), "connection-profiles": excluded(CREDENTIAL),
  "providers": excluded(CREDENTIAL), "flux-hermes-home": excluded(CREDENTIAL), "flux-composio-broker-token.json": excluded(CREDENTIAL),
  "local-models": excluded(CREDENTIAL), "browser-engine-key": excluded(CREDENTIAL), "telegram": excluded(CREDENTIAL),

  // Written by a restore into the installation it made. Restore refuses these
  // names inside an archive (installation-restore-preparation.ts
  // RESERVED_RESTORE_FILES), so they can only ever be left out.
  "restore-review.json": excluded(RESTORE_MARKER), "restored-connections.json": excluded(RESTORE_MARKER),
  "recovery-quarantine": excluded(RESTORE_MARKER),

  ".DS_Store": excluded(OS_METADATA), "Thumbs.db": excluded(OS_METADATA), "desktop.ini": excluded(OS_METADATA),

  // Workspaces bind-mounted into a local VM also hold native browser
  // profiles the installation lease cannot quiesce.
  "vm-home": { backup: "refused", why: "VM workspace not quiesced; includes native browser credentials", code: "VM_WORKSPACE_BACKUP_UNSUPPORTED" },
  "vm-homes": { backup: "refused", why: "VM workspace not quiesced; includes native browser credentials", code: "VM_WORKSPACE_BACKUP_UNSUPPORTED" },
  // An interrupted bot-package import is recovered at the next start. Until
  // then bots.json may sit between two rosters, so it stays refused.
  ".package-import-transaction": { backup: "refused", why: "Bot import not yet recovered", code: "BACKUP_UNCLASSIFIED_COMPONENT" },
});

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** Names with a variable part. `example` is a real instance, checked by the test. */
export const DATA_DIR_PATTERNS: ReadonlyArray<{ pattern: RegExp; entry: DataDirEntry; example: string }> = Object.freeze([
  // Legacy per-thread transcripts, projected like the other records.
  { pattern: /^messages-[\w-]+\.json$/, entry: record(), example: "messages-thread-1.json" },
  // mkdtemp scratch for a memory evolution run (index.ts) and a package
  // import's staging (bot-package-import.ts), and a stale permission socket
  // (procs.ts brokerSocketPath).
  { pattern: /^(?:\.memory-evolution-|\.package-import-)[A-Za-z0-9]{6}$/, entry: excluded(LEFTOVER), example: ".memory-evolution-a1B2c3" },
  { pattern: /^perm-[\w-]+\.sock$/, entry: excluded(LEFTOVER), example: "perm-a1b2c3.sock" },
  // A skill index build stopped before its rename (skill-search.ts).
  { pattern: /^skill-index\.db\.\d+\.[a-z0-9]{1,8}\.tmp(?:-journal|-wal|-shm)?$/, entry: excluded(DERIVED_SKILLS), example: "skill-index.db.1268.ffjn5f.tmp" },
  // writeFileAtomic (atomic.ts) writes `<name>.<pid>.<uuid>.tmp` beside the
  // file and renames it over; a crash between the two leaves it behind.
  { pattern: new RegExp(`^[^/\\\\]+\\.\\d+\\.${UUID}\\.tmp$`), entry: excluded(LEFTOVER), example: "about-me.md.4242.0f8e2b1a-3c4d-4e5f-8a9b-0c1d2e3f4a5b.tmp" },
  // The desktop app saves config.json (secureComposioConfig,
  // secureWorkspaceConfig) and the startup settings (savePreferences) through
  // `<name>.<pid>.tmp` and a rename (electron/main.mjs). A crash between the
  // two leaves that name; it is a partial copy of a file that is backed up.
  { pattern: /^(?:config|startup-background)\.json\.\d+\.tmp$/, entry: excluded(LEFTOVER), example: "startup-background.json.48213.tmp" },
  // A bot-package import's per-file replacement (package-import-transaction.ts).
  { pattern: /^[^/\\]+\.package-[\w-]+\.tmp$/, entry: excluded(LEFTOVER), example: "bots.json.package-0f8e2b1a.tmp" },
  // A memory index that failed its integrity check is set aside and rebuilt
  // (memory/index.ts). The copy is derived from messages.db.
  { pattern: /^memory-index\.db\.corrupt-\d+$/, entry: excluded("Damaged memory search index set aside and rebuilt from messages.db; not restored"), example: "memory-index.db.corrupt-1790000000000" },
]);

/** What a backup does with this top-level data-folder name; undefined when unknown. */
export function classifyDataDirEntry(name: string): DataDirEntry | undefined {
  if (Object.hasOwn(DATA_DIR_ENTRIES, name)) return DATA_DIR_ENTRIES[name];
  return DATA_DIR_PATTERNS.find(item => item.pattern.test(name))?.entry;
}

const namesOf = (...kinds: DataDirBackup[]) => Object.freeze(Object.entries(DATA_DIR_ENTRIES).filter(([, entry]) => kinds.includes(entry.backup)).map(([name]) => name));
/** Required JSON records. */
export const DATA_DIR_RECORDS = namesOf("record");
/** Everything the restorable stage copies when present. */
export const DATA_DIR_RESTORABLE = namesOf("record", "owner-file", "owner-folder", "database");
