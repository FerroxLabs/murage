// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The shared restore prep core, same-home profile (Cloud reset prep P1, Astra A-H2, A-H3, A-M1, Ruling F5, decision D2).
import { MEMORY_SCHEMA_VERSION } from "./memory/schema.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { initializeMessageTables } from "./message-tables.ts";
import { initializeImageOperations } from "./image-operations-schema.ts";
import { initializePendingDelegations } from "./pending-delegations-schema.ts";
import { downgradeMemorySchema, migrateMemorySchema, validateMemorySchema } from "./memory/schema.ts";
import { prepareRestoredDatabase, prepareRestoredRecords, readRestoreJson, writeRestoreJsonAtomic, type RestoreProfile } from "./restore-prep-core.ts";
import { CANARY_BROWSER_ID } from "../shared/bot-identity.ts";
import { BotTurnState, readBotRecords } from './bot-turn-state.ts';
import { removeTempDirSync } from "./testing/cleanup.ts";

vi.mock("./settle-copy.ts", async importOriginal => ({ ...await importOriginal<typeof import("./settle-copy.ts")>(), settleFtsCopy: vi.fn() }));
import { settleFtsCopy } from "./settle-copy.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); vi.mocked(settleFtsCopy).mockClear(); });

const BOT = { id: "bot", threadId: "thread", name: "Bot", autoApprove: true, alwaysAllow: ["Bash:sh"], computer: "cloud", autoStartVps: true, browser: true, useMyChrome: true, browserTransport: "extension", busy: true, tasks: [] };
const CONFIG = { instances: { fake: { driver: "claudeAgent", enabled: true } }, features: { browser: true, skillRecorder: true } };

/** A data folder the way a home holds it: rosters, a config with a live engine, and messages.db. */
function home(prepare?: (db: DatabaseSync) => void, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "murage-core-"));
  roots.push(dir);
  const files = new Set<string>();
  const put = (path: string, value: unknown) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), JSON.stringify(value)); files.add(path); };
  put("bots.json", [{ ...BOT }]);
  put("groups.json", [{ id: "room", threadId: "room-thread", name: "Room", memberIds: ["bot"], working: true, busyBotId: "bot" }]);
  put("config.json", CONFIG);
  for (const [path, value] of Object.entries(extra)) put(path, value);
  const db = new DatabaseSync(join(dir, "messages.db"));
  try { initializeMessageTables(db); initializeImageOperations(db); db.exec("INSERT INTO thread_state VALUES('thread','pending')"); prepare?.(db); } finally { db.close(); }
  files.add("messages.db");
  return { dir, files, put };
}
const io = (dir: string, files: Set<string>) => ({
  state: dir, files,
  read: (path: string) => readRestoreJson(dir, files, path),
  write: (path: string, value: unknown) => writeRestoreJsonAtomic(join(dir, path), value),
  quarantine: (path: string) => { const to = join(dir, "recovery-quarantine", "q1", ...path.split("/")); mkdirSync(dirname(to), { recursive: true }); renameSync(join(dir, ...path.split("/")), to); },
});
const onDisk = (dir: string, path: string) => JSON.parse(readFileSync(join(dir, path), "utf8"));

/** Records then database, as a consumer runs them. `between` runs after the records and before the database (a repair of the rosters). */
function run(h: ReturnType<typeof home>, profile: RestoreProfile, hooks: { between?: (r: { sharingBots: Record<string, unknown>[] }) => void; beforeCommit?: () => void } = {}) {
  const modifications: Array<{ component: string; action: string }> = [];
  const records = prepareRestoredRecords(io(h.dir, h.files), { generation: "g1", profile, quarantineId: "q1", modifications, quarantined: [] });
  hooks.between?.(records);
  const db = new DatabaseSync(join(h.dir, "messages.db"));
  try {
    prepareRestoredDatabase(db, { generation: "g1", profile, quarantineId: "q1", modifications, state: h.dir, files: h.files, ...records,
      persistRosters: () => { writeRestoreJsonAtomic(join(h.dir, "bots.json"), records.sharingBots); writeRestoreJsonAtomic(join(h.dir, "groups.json"), records.sharingGroups); },
      beforeCommit: hooks.beforeCommit ? () => hooks.beforeCommit!() : undefined });
  } finally { db.close(); }
  return { modifications, ...records };
}
const version = (dir: string) => { const db = new DatabaseSync(join(dir, "messages.db"), { readOnly: true }); try { return Number(db.prepare("SELECT schema_version FROM memory_meta WHERE id=1").get()?.schema_version); } finally { db.close(); } };

it.each(['archive','same-home'] as const)('folds task deltas before the %s session scrub, with no cursor resurrection at boot',profile=>{
  const h=home(),bots=onDisk(h.dir,'bots.json');
  bots[0].turnStateBase='fixture-base';bots[0].resumeCursors={};
  bots[0].tasks=[{threadId:'thread',title:'Before',resumeCursors:{}}];h.put('bots.json',bots);
  const deltas=new BotTurnState(h.dir);deltas.checkpoint(bots,'fixture-base');
  const task=bots[0].tasks[0];task.title='Durable title';task.resumeCursors={fixture:'task-session-canary'};
  task.lastInstanceId='fixture';task.usage={input:7,output:3,turns:1,costUsd:0.25};task.usageTurnKeys=['fixture-usage'];
  bots[0].usageMonths={'2026-01':{input:7,output:3,replies:1}};deltas.writeTask(bots[0],task);
  for(const name of readdirSync(join(h.dir,'bot-task-state')))h.files.add('bot-task-state/'+name);
  run(h,profile);
  const prepared=onDisk(h.dir,'bots.json')[0];
  expect(prepared.turnStateBase).toBeUndefined();expect(prepared.tasks[0].title).toBe('Durable title');
  expect(prepared.tasks[0].usage.input).toBe(7);expect(prepared.usageMonths['2026-01'].input).toBe(7);
  expect(prepared.tasks[0].resumeCursors).toEqual({});expect(prepared.tasks[0].lastInstanceId).toBeUndefined();
  const boot=readBotRecords(h.dir)[0];expect(boot.tasks![0].resumeCursors).toEqual({});
  expect(boot.tasks![0].usage!.input).toBe(7);
});

// A-H2: the memory migration and the development upgrades open their own transactions, so they run before the core's BEGIN.
const OLDER: Record<string, (db: DatabaseSync) => void> = {
  "an older schema (v4)": db => { migrateMemorySchema(db); downgradeMemorySchema(db, 4); },
  "a development v5 (its lessons and feedback tables in the earlier shape)": db => {
    migrateMemorySchema(db); downgradeMemorySchema(db, 5);
    db.exec(`DROP INDEX memory_lessons_bot_state; DROP INDEX memory_feedback_bot_created; DROP TABLE memory_lessons; DROP TABLE memory_feedback;
      CREATE TABLE memory_lessons (id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>=1), parent_id TEXT, bot_id TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('bot','bots','team')), recipients TEXT, kind TEXT NOT NULL CHECK(kind IN ('preference','tone','timing','tool-hint','priority')), text TEXT NOT NULL, origin TEXT NOT NULL, state TEXT NOT NULL, evidence TEXT, prospect_derived INTEGER NOT NULL DEFAULT 0, learning_event_id TEXT, created_at INTEGER NOT NULL, decided_at INTEGER, PRIMARY KEY(id,version));
      CREATE TABLE memory_feedback (id TEXT PRIMARY KEY NOT NULL, bot_id TEXT NOT NULL, thread_id TEXT, message_id TEXT, target_message_id TEXT, target_turn_id TEXT, target_action TEXT, polarity TEXT NOT NULL, strength INTEGER NOT NULL, correction TEXT, confidence REAL, state TEXT NOT NULL, scope TEXT NOT NULL, acknowledged_at INTEGER, created_at INTEGER NOT NULL);
      CREATE INDEX memory_lessons_bot_state ON memory_lessons(bot_id,state); CREATE INDEX memory_feedback_bot_created ON memory_feedback(bot_id,created_at);
      INSERT INTO memory_lessons(id,version,bot_id,scope,kind,text,origin,state,created_at) VALUES('l1',1,'b','bot','tone','No emojis','typed','suggested',1);`);
  },
  "a development v9 (no open-turns table)": db => {
    migrateMemorySchema(db); downgradeMemorySchema(db, 9);
    for (const row of db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE '%open_turns%'").all() as Array<{ name: string }>) db.exec(`DROP TRIGGER "${row.name}"`);
    for (const row of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'memory_open_turns%'").all() as Array<{ name: string }>) db.exec(`DROP TABLE "${row.name}"`);
  },
};
for (const [label, older] of Object.entries(OLDER)) {
  it(`A-H2 a same-home reset of ${label} migrates before the transaction, commits, and a fresh open then boots`, () => {
    const h = home(older);
    expect(version(h.dir)).toBeLessThan(13);
    let committed = 0;
    run(h, "same-home", { beforeCommit: () => { committed++; } });
    expect(committed).toBe(1);
    // restart: a new connection on the same file, the boot-time migration and validation both pass
    const db = new DatabaseSync(join(h.dir, "messages.db"));
    try { expect(() => migrateMemorySchema(db)).not.toThrow(); expect(() => validateMemorySchema(db)).not.toThrow(); } finally { db.close(); }
    expect(version(h.dir)).toBe(MEMORY_SCHEMA_VERSION);
  }, 60_000);
}

// A-H3: the repaired rosters are on disk, whole, before the commit; a crash right after the COMMIT leaves them there.
it("A-H3 the repaired rosters are on disk before COMMIT (atomic, no temp file left), and a fresh read right after the commit sees them", () => {
  const h = home();
  let seenAtCommit: unknown;
  run(h, "same-home", {
    between: records => { records.sharingBots[0]!.repairedMarker = "from-the-shared-repair"; },
    beforeCommit: () => { seenAtCommit = onDisk(h.dir, "bots.json")[0].repairedMarker; },
  });
  expect(seenAtCommit).toBe("from-the-shared-repair");
  // "crash right after the COMMIT": nothing runs after prepareRestoredDatabase returns; a fresh process only reads the files
  expect(onDisk(h.dir, "bots.json")[0]).toMatchObject({ repairedMarker: "from-the-shared-repair", autoApprove: false, alwaysAllow: [] });
  expect(readdirSync(h.dir).filter(name => name.endsWith(".restore-tmp"))).toEqual([]);
});

// A-M1: a fixed evidence name for the table rows, never chosen by which files the home held.
it("A-M1 the queued handoffs of the table are kept as delegations-table.json; a legacy delegations.json keeps its own name", () => {
  const queue = (db: DatabaseSync) => {
    initializePendingDelegations(db);
    const insert = db.prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item) VALUES(?,?,?,?,?,?,?)");
    for (let i = 0; i < 3; i++) insert.run(`q-${i}`, "src", "peer", "bot", "fresh", null, JSON.stringify({ message: `queued ${i}`, depth: 0, attempts: 0 }));
  };
  const sqlOnly = home(queue);
  run(sqlOnly, "same-home");
  const evidence = join(sqlOnly.dir, "recovery-quarantine", "q1");
  expect(Object.values(onDisk(evidence, "delegations-table.json")).flat()).toHaveLength(3);
  expect(existsSync(join(evidence, "delegations.json"))).toBe(false);
  const both = home(queue, { "delegations.json": { thread: [{ id: "legacy", message: "x" }] } });
  run(both, "same-home");
  expect(onDisk(join(both.dir, "recovery-quarantine", "q1"), "delegations.json").thread[0].id).toBe("legacy");
  expect(Object.values(onDisk(join(both.dir, "recovery-quarantine", "q1"), "delegations-table.json")).flat()).toHaveLength(3);
});

// F5 (MurageMain ruling 2026-11-11): the deliberate difference between a same-home run and a desktop restore.
it("F5 a same-home run keeps each bot's browser and useMyChrome; computer use and autoStartVps turn off; a desktop restore turns all four off", () => {
  const same = home();
  const sameResult = run(same, "same-home");
  expect(onDisk(same.dir, "bots.json")[0]).toMatchObject({ browser: true, useMyChrome: true, computer: "off", autoStartVps: false, autoApprove: false });
  expect(sameResult.modifications).toContainEqual({ component: "bots.json", action: "Kept: each bot's browser access. Turned off: computer use and starting a cloud computer automatically." });
  // The DELIBERATE DIFFERENCE. The desktop restore turns browser and useMyChrome off, and that stays as it is: see the test
  // "prepares a blocked candidate preserving terminal identities and suspending consequential work" at
  // server/installation-restore-preparation.test.ts:103 (browser: false, useMyChrome: false). They differ because a desktop restore
  // moves a backup to a different machine, whose browser and extension profile are not the one the bot was set up with, while a
  // same-home reset or undo is the same machine with the same browser, so the owner's choice is still true.
  const archive = home();
  const archiveResult = run(archive, "archive");
  expect(onDisk(archive.dir, "bots.json")[0]).toMatchObject({ browser: false, useMyChrome: false, computer: "off", autoStartVps: false });
  expect(archiveResult.modifications.some(note => note.action.startsWith("Kept: each bot's browser"))).toBe(false);
});

// D2: what a same-home run never does. Each skipped step proves its skip; each has a mutant in the lane's mutants.sh.
it("D2 a same-home run writes no review marker, leaves config.json byte-for-byte, and never settles the search index", () => {
  const h = home();
  const config = readFileSync(join(h.dir, "config.json"));
  run(h, "same-home");
  expect(existsSync(join(h.dir, "restore-review.json"))).toBe(false);
  expect(readdirSync(h.dir).filter(name => name.includes("restore-review"))).toEqual([]);
  expect(readFileSync(join(h.dir, "config.json")).equals(config)).toBe(true);
  expect(settleFtsCopy).not.toHaveBeenCalled();
});
it("D2 a same-home run accepts the home's own reserved bot id; an archive refuses it", () => {
  const reserved = { ...BOT, id: CANARY_BROWSER_ID };
  const h = home(); writeFileSync(join(h.dir, "bots.json"), JSON.stringify([reserved])); writeFileSync(join(h.dir, "groups.json"), "[]");
  expect(() => run(h, "same-home")).not.toThrow();
  const a = home(); writeFileSync(join(a.dir, "bots.json"), JSON.stringify([reserved])); writeFileSync(join(a.dir, "groups.json"), "[]");
  expect(() => run(a, "archive")).toThrowError(expect.objectContaining({ code: "RESERVED_RESTORE_ID" }));
});

it("a fresh same-home database without messages still prepares its rosters", () => {
  const h = home();
  unlinkSync(join(h.dir, "messages.db"));
  new DatabaseSync(join(h.dir, "messages.db")).close();
  h.put("bots.json", []); h.put("groups.json", []);
  expect(() => run(h, "same-home")).not.toThrow();
  expect(onDisk(h.dir, "bots.json")).toEqual([]);
  expect(onDisk(h.dir, "groups.json")).toEqual([]);
});
