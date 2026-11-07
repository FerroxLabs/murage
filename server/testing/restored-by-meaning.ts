// What a restore must give back (WIN-BACKUP-RT-1018). The comparison is DEFAULT-STRICT:
//   * every file in the source tree must come back byte for byte, except the files named in RESTORE_REWRITTEN_FILES;
//   * the file sets must match in both directions, except the files named in RESTORE_ADDED_FILES;
//   * each rewritten document is deep-equal to an expected value built from the SOURCE and the declared built-ins,
//     never from the restored result, so a field that restore adds, drops or changes without being named here fails;
//   * the messages.db schema (every table, index, trigger and view, user_version and application_id) is the source's
//     plus the named objects restore creates (RESTORE_MAY_ADD), each with the sql the product's own setup writes;
//   * every messages.db table is compared by full row content; the tables restore creates have full expected rows,
//     and only the named generated tokens and counters may vary, each checked for its form and its relationships;
//   * the two marker files restore writes are compared in full against the restore's own result and receipt.
// Anything new that restore starts rewriting therefore turns the test red until it is named here on purpose.
// The rules follow server/installation-restore-preparation.ts (config.json at 215-240, bots.json, pauseRestoredMemory,
// the markers at 405-478) and server/backup-restore-roundtrip.test.ts:195-208. They were checked against a real restore.
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { DEFAULT_INSTANCES } from "../default-instances.ts";
import { ensureAppWriteRevision } from "../memory/upgrade-app-tables.ts";
import { RESTORE_HOLDS_DDL } from "../restore-fence.ts";
import { RESTORE_GENERATION_DDL } from "../send-store.ts";
import { initializeChatsPreviewStorage } from "../thread-summary.ts";
import { restoredConnectionProfile } from "../../electron/restored-connections.mjs";

type Json = Record<string, unknown>;

/** Documents restore rewrites into the paused form. Everything else is byte-compared. */
export const RESTORE_REWRITTEN_FILES = ["bots.json", "config.json", "messages.db"];
/** Files restore creates beside the restored data: the review marker and fresh connection state. Compared in full. */
export const RESTORE_ADDED_FILES = ["restore-review.json", "restored-connections.json"];
/** The application's own SQLite sidecars. The snapshot checkpoints the WAL into messages.db (whose rows are compared
 * in full), so a restore does not reproduce them. Only these exact top-level names are left out of the inventories;
 * any other file, a workspace file ending in .db-wal included, is compared like every other file. */
export const APPLICATION_SIDECARS = ["messages.db-wal", "messages.db-shm"];
export const CREDENTIAL_CANARY = "FAKE-CREDENTIAL-CANARY";
/** The messages.db schema objects restore creates, by type and name. Nothing else may appear, and every source object
 * must come back with byte-equal sql. The expected sql of each is read from a fresh database made by the product's own
 * schema setup (expectedAddedSchema), never from the restored copy. No source object is rewritten by restore today; one
 * that is would be named here with its expected sql and a reason, never with a wildcard. */
export const RESTORE_MAY_ADD: readonly { type: string; name: string }[] = Object.freeze([
  { type: "table", name: "app_write_revision" },
  { type: "table", name: "chats_gen" },
  { type: "table", name: "restore_holds" },
  { type: "index", name: "sqlite_autoindex_restore_holds_1" }, // restore_holds' PRIMARY KEY (kind, row_id)
  { type: "table", name: "send_restore_generation" },
]);
/** PRAGMA user_version and application_id after restore equal the source; an exception would be listed here with its
 * expected value and the reason. schema_version is not compared: restore's own DDL legitimately changes it. */
export const RESTORE_DATABASE_IDENTITY_EXCEPTIONS: Readonly<Record<string, { value: number; reason: string }>> = Object.freeze({});
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX32 = /^[a-f0-9]{32}$/;

/** bot fields restore forces to a paused value (backup-restore-roundtrip.test.ts:195). */
const FORCED_BOT_FIELDS = { autoApprove: false, browser: false, computer: "off", resumeCursors: {} };
/** bot fields restore fills with a default when the owner's record lacks them (observed on a real restore). */
const DEFAULTED_BOT_FIELDS = { busy: false, activity: "idle", autoReview: "off", alwaysAllow: [], approvePeerComms: true, autoStartVps: false, useMyChrome: false, composio: false, speakReplies: false, rewound: true };
/** config.json keys restore carries over unchanged (installation-restore-preparation.ts:223). */
const KEPT_CONFIG_KEYS = ["profile", "language", "rooms", "localVm", "browserProfiles", "notifications"];
/** The new-bot effort levels a restore keeps (server/contracts.ts EFFORT_LEVELS), written out so the test does not
 * read the rule from the code it checks. */
const KEPT_EFFORT_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"];
/** A Hermes profile name (shared/hermes-profile-name.ts HERMES_PROFILE_NAME), written out for the same reason. */
const HERMES_PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The non-default settings the round trip seeds before the backup, so each preservation rule is exercised:
 * pinned Hermes profiles, a new-bot effort (and a key restore drops), the tool-call display setting, a display name
 * on the owner's engine, a Hermes engine with a profile (and a credential beside it), and a finished revoke job. */
export function seedPreservedSettings(dataDir: string, db: DatabaseSync) {
  const file = join(dataDir, "config.json"), config = JSON.parse(readFileSync(file, "utf8")) as Json & { instances: Record<string, Json> };
  config.hermesProfilesPinned = true;
  config.newBots = { effort: "high", engine: "fixture" };
  config.features = { showToolCalls: true, browser: true };
  config.instances.fixture.displayName = "Deal desk engine";
  config.instances.deskHermes = { driver: "hermesAgent", displayName: "Desk Hermes", enabled: true, config: { profile: "sales", profileOrigin: "sticky", apiKey: CREDENTIAL_CANARY } };
  writeFileSync(file, JSON.stringify(config) + "\n");
  db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,?,?,?,?,?,?,?)")
    .run(7, "policy", JSON.stringify({ kind: "policy", cause: "policy-bump" }), 1, 1, "done", "", "done");
}

export function listFiles(root: string, relative = "", into: string[] = []) {
  for (const name of readdirSync(join(root, relative)).sort()) {
    const next = relative ? `${relative}/${name}` : name;
    if (lstatSync(join(root, next)).isDirectory()) listFiles(root, next, into);
    else if (!APPLICATION_SIDECARS.includes(next)) into.push(next);
  }
  return into;
}

const jsonText = (row: unknown) => JSON.stringify(row, (_key, value) => (typeof value === "bigint" ? `${value}n` : value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value));
function tableRows(db: DatabaseSync, table: string): Json[] {
  const quoted = `"${table.replace(/"/g, '""')}"`;
  return (db.prepare(`SELECT * FROM ${quoted}`).all() as Json[]).sort((a, b) => jsonText(a).localeCompare(jsonText(b)));
}

/** Every table of a database, as sorted full rows. */
export function readTables(dbFile: string): Record<string, Json[]> {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map(row => row.name);
    return Object.fromEntries(names.map(name => [name, tableRows(db, name)]));
  } finally { db.close(); }
}

export interface SchemaObject { type: string; name: string; tbl_name?: string; sql?: string | null }
export interface DatabaseSchema { objects: SchemaObject[]; userVersion: number; applicationId: number }
const objectKey = (object: { type: string; name: string }) => `${object.type}:${object.name}`;
/** Every sqlite_master row: indexes, triggers and views as well as tables. SQLite's own sqlite_% objects (automatic
 * indexes, sqlite_sequence, sqlite_stat*) are kept by type and name only. */
function schemaOf(db: DatabaseSync): DatabaseSchema {
  const rows = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master").all() as unknown as Required<SchemaObject>[];
  const objects = rows.map(row => (row.name.startsWith("sqlite_") ? { type: row.type, name: row.name } : { type: row.type, name: row.name, tbl_name: row.tbl_name, sql: row.sql }))
    .sort((a, b) => objectKey(a).localeCompare(objectKey(b)));
  const userVersion = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  const applicationId = Number((db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id);
  return { objects, userVersion, applicationId };
}
export function readSchema(dbFile: string): DatabaseSchema {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try { return schemaOf(db); } finally { db.close(); }
}

/** The objects of RESTORE_MAY_ADD as the product's own schema setup writes them, in a fresh in-memory database. */
export function expectedAddedSchema(): SchemaObject[] {
  const db = new DatabaseSync(":memory:");
  try {
    initializeChatsPreviewStorage(db); ensureAppWriteRevision(db); db.exec(RESTORE_GENERATION_DDL); db.exec(RESTORE_HOLDS_DDL);
    const fresh = new Map(schemaOf(db).objects.map(object => [objectKey(object), object]));
    return RESTORE_MAY_ADD.map(object => {
      const made = fresh.get(objectKey(object));
      expect(made, `the product's schema setup creates ${objectKey(object)}`).toBeDefined();
      return made!;
    });
  } finally { db.close(); }
}

export function meaningOf(dataDir: string) {
  return {
    bots: JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")) as Json[],
    config: JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as Json,
    tables: readTables(join(dataDir, "messages.db")),
    schema: readSchema(join(dataDir, "messages.db")),
    files: listFiles(dataDir),
  };
}

/** The restored schema is the source schema, unchanged, plus exactly the objects restore creates; user_version and
 * application_id are the source's. */
function expectSchema(before: DatabaseSchema, after: DatabaseSchema) {
  const sourceKeys = new Set(before.objects.map(objectKey));
  for (const object of RESTORE_MAY_ADD) expect(sourceKeys.has(objectKey(object)), `the source has no ${objectKey(object)} (restore creates it)`).toBe(false);
  expect(before.objects.some(object => object.type === "trigger"), "the fixture database holds triggers, so the trigger check is exercised").toBe(true);
  const expected = [...before.objects, ...expectedAddedSchema()].sort((a, b) => objectKey(a).localeCompare(objectKey(b)));
  const afterKeys = new Set(after.objects.map(objectKey)), expectedKeys = new Set(expected.map(objectKey));
  const missing = [...expectedKeys].filter(key => !afterKeys.has(key)), extra = [...afterKeys].filter(key => !expectedKeys.has(key));
  expect({ missing, extra }, "messages.db schema objects: the source objects plus the ones restore creates, nothing missing, nothing else").toEqual({ missing: [], extra: [] });
  expect(after.objects, "messages.db schema: every object's sql byte-equal").toEqual(expected);
  const identity = (name: "userVersion" | "applicationId", pragma: string) =>
    expect(after[name], `PRAGMA ${pragma} after restore`).toBe(RESTORE_DATABASE_IDENTITY_EXCEPTIONS[pragma]?.value ?? before[name]);
  identity("userVersion", "user_version");
  identity("applicationId", "application_id");
}

/** The seeded settings really are in the source, so a preservation rule that stops working fails below. */
function expectSeededSource(before: ReturnType<typeof meaningOf>) {
  const config = before.config as Json & { instances: Record<string, Json>; newBots: Json; features: Json };
  expect(config.hermesProfilesPinned, "source: Hermes profiles pinned").toBe(true);
  expect(config.newBots.effort, "source: new-bot effort").toBe("high");
  expect(config.features.showToolCalls, "source: tool calls shown").toBe(true);
  expect(config.instances.fixture.displayName, "source: engine display name").toBe("Deal desk engine");
  expect(config.instances.deskHermes.config, "source: Hermes engine profile").toMatchObject({ profile: "sales", profileOrigin: "sticky" });
  expect(before.tables.memory_revoke_jobs.length, "source: an existing finished revoke job").toBeGreaterThan(0);
}

function expectedBots(before: Json[]) {
  // Every owner field survives; the forced fields come back paused; the defaulted fields appear when the record lacked them.
  return before.map(bot => ({ ...DEFAULTED_BOT_FIELDS, ...bot, ...FORCED_BOT_FIELDS }));
}

/** The one part of a Hermes engine's config a restore keeps: its profile (and a sticky origin). */
function hermesProfile(driver: unknown, config: unknown): Json | undefined {
  if (driver !== "hermesAgent" || !config || typeof config !== "object" || Array.isArray(config)) return undefined;
  const { profile, profileOrigin } = config as Json;
  if (typeof profile !== "string" || !HERMES_PROFILE.test(profile)) return undefined;
  return profileOrigin === "sticky" ? { profile, profileOrigin } : { profile };
}

function expectedConfig(before: Json) {
  const expected: Json = { engineDiscovery: "explicit" };
  for (const key of KEPT_CONFIG_KEYS) if (Object.hasOwn(before, key)) expected[key] = before[key];
  if (before.hermesProfilesPinned === true) expected.hermesProfilesPinned = true;
  const newBots = before.newBots as Json | undefined;
  if (newBots && typeof newBots.effort === "string" && KEPT_EFFORT_LEVELS.includes(newBots.effort)) expected.newBots = { effort: newBots.effort };
  // Browser and skill recorder are always off after a restore; only the tool-call display setting is the owner's.
  expected.features = { browser: false, skillRecorder: false, showToolCalls: (before.features as Json | undefined)?.showToolCalls === true };
  // The full engine map: every declared built-in, disabled and holding only its driver; then every engine the owner
  // defined, disabled, with its driver, its display name and (for Hermes) its profile, credentials dropped.
  const instances: Record<string, Json> = {};
  for (const [key, value] of Object.entries(DEFAULT_INSTANCES)) instances[key] = { driver: value.driver, enabled: false };
  const owner = (before.instances ?? {}) as Record<string, Json>;
  expect(Object.keys(owner).length, "the fixture defines at least one engine").toBeGreaterThan(0);
  for (const [key, value] of Object.entries(owner)) {
    const profile = hermesProfile(value.driver, value.config);
    instances[key] = { driver: value.driver, ...(typeof value.displayName === "string" ? { displayName: value.displayName } : {}), enabled: false, ...(profile ? { config: profile } : {}) };
  }
  expected.instances = instances;
  return expected;
}

/** Row-level comparison of every table: the full rows, with the named rewrites only. */
function expectTables(before: Record<string, Json[]>, after: Record<string, Json[]>) {
  const added = ["app_write_revision", "chats_gen", "restore_holds", "send_restore_generation"];
  expect(Object.keys(after).sort(), "messages.db tables: the source tables plus the ones restore creates, nothing else").toEqual([...Object.keys(before), ...added].sort());
  for (const table of added) expect(before[table], `the source has no ${table} table (restore creates it)`).toBeUndefined();
  expect(Object.keys(before), "the fixture database holds the transcript table").toContain("messages");
  const rewritten = new Set(["memory_meta", "memory_lsn", "memory_lineage_lsn_meta", "memory_revoke_jobs", "transcript_index_state"]);
  for (const [table, rows] of Object.entries(before)) if (!rewritten.has(table)) expect(after[table], `messages.db table ${table}: full row content`).toEqual(rows);
  // memory_meta: identity, schema, deletion epoch and data revision are preserved; memory comes back paused and the
  // policy revision moves by one (pauseRestoredMemory). An emptied or altered row fails here.
  expect(before.memory_meta, "the fixture holds the memory meta row").toHaveLength(1);
  expect(after.memory_meta, "memory_meta").toEqual([{ ...before.memory_meta[0], mode: "paused", policy_revision: (before.memory_meta[0].policy_revision as number) + 1 }]);
  expect(after.memory_meta[0].deletion_epoch, "the deletion history is preserved").toBe(1);
  // memory_lsn: one row, same id; the counter only moves forward (the pause consumed positions).
  expect(after.memory_lsn).toHaveLength(1);
  expect(after.memory_lsn[0].id).toBe(before.memory_lsn[0].id);
  const lsnBefore = before.memory_lsn[0].next as number, lsnAfter = after.memory_lsn[0].next as number;
  expect(lsnAfter).toBeGreaterThan(lsnBefore);
  // memory_revoke_jobs: the new job is found by primary key, never by sort order. The pause records one finished
  // policy-bump revoke with the next id, and that commit removes every older FINISHED job (state done or undone,
  // server/memory/revoke-commit.ts:138-139). So each existing unfinished job comes back equal to its source row,
  // each existing finished job is gone (the fixture seeds one, so the rule is exercised), and exactly one job is
  // added: its full row is the finished policy-bump revoke, started at a position the pause consumed (between the
  // source counter and the restored one) and recorded as the lineage's policy bump below.
  const key = (row: Json) => String(row.revoke_id);
  const finished = (row: Json) => row.state === "done" || row.state === "undone";
  const sourceJobs = new Map(before.memory_revoke_jobs.map(row => [key(row), row]));
  expect(before.memory_revoke_jobs.some(finished), "the fixture seeds a finished revoke job").toBe(true);
  expect(after.memory_revoke_jobs.filter(row => sourceJobs.has(key(row))), "memory_revoke_jobs: every existing unfinished job, full row; no finished one").toEqual(before.memory_revoke_jobs.filter(row => !finished(row)));
  const newJobs = after.memory_revoke_jobs.filter(row => !sourceJobs.has(key(row)));
  expect(newJobs, "memory_revoke_jobs: restore adds exactly one job").toHaveLength(1);
  const job = newJobs[0];
  expect(job.revoke_id, "the added job takes the next id").toBe(Math.max(0, ...before.memory_revoke_jobs.map(row => row.revoke_id as number)) + 1);
  expect(Number.isSafeInteger(job.root_lsn) && (job.root_lsn as number) >= lsnBefore && (job.root_lsn as number) <= lsnAfter, "the added job starts at a position the pause consumed").toBe(true);
  expect(job, "the added revoke job, full row").toEqual({ revoke_id: job.revoke_id, kind: "policy", root: JSON.stringify({ kind: "policy", cause: "policy-bump" }), root_lsn: job.root_lsn, started_lsn: job.root_lsn, phase: "done", cursor: "", state: "done" });
  // memory_lineage_lsn_meta: same keys; the policy bump is the added job's position, the deny generation only moves
  // forward, every other counter is unchanged.
  expect(after.memory_lineage_lsn_meta.map(row => row.key)).toEqual(before.memory_lineage_lsn_meta.map(row => row.key));
  before.memory_lineage_lsn_meta.forEach((row, index) => {
    const now = after.memory_lineage_lsn_meta[index];
    if (row.key === "policy_bump_lsn") expect(now, "policy_bump_lsn is the added revoke job's position").toEqual({ key: row.key, value: job.root_lsn });
    else if (row.key === "deny_generation") expect(now.value as number, "deny_generation only moves forward").toBeGreaterThan(row.value as number);
    else expect(now, `memory_lineage_lsn_meta ${String(row.key)}`).toEqual(row);
  });
  // transcript_index_state: the source rows stay equal; restore adds the one pending summary row.
  expect(after.transcript_index_state.filter(row => before.transcript_index_state.some(old => old.name === row.name)), "transcript_index_state source rows").toEqual(before.transcript_index_state);
  expect(after.transcript_index_state.filter(row => !before.transcript_index_state.some(old => old.name === row.name)), "transcript_index_state added rows").toEqual([{ name: "thread_summary", done: 0, cursor: 0, skipped: 0 }]);
  // The four tables restore creates, full rows. Only the freshly minted tokens vary, each checked for its form:
  // a new write epoch at count 0 (bumpWriteEpoch), a new chats epoch at revision 0 (remintChatsGen), one send
  // generation token, and no restore holds (the fixture has nothing to hold, so any row is unexpected).
  const writeEpoch = after.app_write_revision[0]?.epoch, chatsEpoch = after.chats_gen[0]?.epoch, token = after.send_restore_generation[0]?.token;
  expect(after.app_write_revision, "app_write_revision, full rows").toEqual([{ id: 1, epoch: writeEpoch, n: 0 }]);
  expect(String(writeEpoch), "the write epoch is a fresh UUID").toMatch(UUID);
  expect(after.chats_gen, "chats_gen, full rows").toEqual([{ id: 1, epoch: chatsEpoch, rev: 0 }]);
  expect(String(chatsEpoch), "the chats epoch is 16 fresh random bytes").toMatch(HEX32);
  expect(after.send_restore_generation, "send_restore_generation, full rows").toEqual([{ id: 1, token }]);
  expect(String(token), "the restore generation is a UUID").toMatch(UUID);
  expect(after.restore_holds, "restore_holds, full rows").toEqual([]);
  expect(new Set([writeEpoch, token]).size, "the write epoch and the restore generation are different tokens").toBe(2);
}

/** The modifications a restore of the round-trip fixture records, in order (installation-restore-preparation.ts). */
const EXPECTED_MODIFICATIONS = [
  { component: "config.json", action: "Provider/MCP credentials excluded; engine and experimental execution disabled" },
  { component: "bots.json", action: "Preserved identities/tasks; cleared active sessions and automatic authority" },
  { component: "groups.json", action: "Preserved identities/tasks; cleared active sessions and automatic authority" },
  { component: "messages.db", action: "Memory paused; worker leases and provider disclosures invalidated; indexes require rebuild" },
  { component: "restored-connections.json", action: "Fresh Murage credentials and companion/device state; native engine globals remain untouched" },
  { component: "messages.db", action: "Memory restore: backup-only; 0 destination tombstones retained" },
];

/** What restoreEncryptedInstallationNew returned: the recovery archive it restored from and its receipt file. */
export interface RestoreResult { status: string; snapshotId: string; archiveSha256: string; receipt: string; encryptedSha256: string }

/** The two marker files, in full. The review marker names the RECOVERY archive the restore was made from (not the
 * outer encrypted file), its snapshot and the restore transaction; the receipt beside the target says the same. */
function expectMarkers(restoredDir: string, result: RestoreResult) {
  const review = JSON.parse(readFileSync(join(restoredDir, "restore-review.json"), "utf8")) as Json;
  expect(result.snapshotId, "the restore names its snapshot").toMatch(UUID);
  expect(result.archiveSha256, "the restore names its recovery archive").toMatch(/^[a-f0-9]{64}$/);
  expect(result.archiveSha256, "the recovery archive is not the outer encrypted file").not.toBe(result.encryptedSha256);
  expect(review, "restore-review.json, in full").toEqual({ version: 1, status: "review-required", snapshotId: result.snapshotId, archiveSha256: result.archiveSha256, quarantined: [], modifications: EXPECTED_MODIFICATIONS, transactionId: review.transactionId });
  expect(String(review.transactionId), "the restore transaction id").toMatch(UUID);
  const receipt = JSON.parse(readFileSync(result.receipt, "utf8")) as Json;
  expect({ version: receipt.version, id: receipt.id, snapshotId: receipt.snapshotId, archiveSha256: receipt.archiveSha256, phase: receipt.phase }, "the restore receipt agrees with the review marker")
    .toEqual({ version: 1, id: review.transactionId, snapshotId: result.snapshotId, archiveSha256: result.archiveSha256, phase: "candidate-installed" });
  const connections = JSON.parse(readFileSync(join(restoredDir, "restored-connections.json"), "utf8")) as Json;
  expect(connections, "restored-connections.json, in full").toEqual({ version: 1, id: connections.id });
  expect(String(connections.id), "a fresh connection profile id").toMatch(UUID);
  expect(restoredConnectionProfile(restoredDir)?.id, "the product's own reader accepts the connection profile").toBe(connections.id);
}

export function expectRestoredByMeaning(before: ReturnType<typeof meaningOf>, sourceDir: string, restoredDir: string, result: RestoreResult, sameBytes: (file: string) => void) {
  expectSeededSource(before);
  const after = meaningOf(restoredDir);
  // File sets equal both ways: nothing lost, nothing extra, except the named files restore creates.
  expect(after.files, "restored file set equals the source set plus the files restore creates").toEqual([...before.files, ...RESTORE_ADDED_FILES].sort());
  for (const file of before.files) if (!RESTORE_REWRITTEN_FILES.includes(file)) sameBytes(file);
  // bots.json and config.json: whole-document deep equality against the expected form built from the source.
  expect(after.bots, "bots.json").toEqual(expectedBots(before.bots));
  expect(after.config, "config.json").toEqual(expectedConfig(before.config));
  expect(JSON.stringify(after.config)).not.toContain(CREDENTIAL_CANARY);
  expect(readFileSync(join(sourceDir, "config.json"), "utf8"), "the source did hold the credential canary (the drop is real)").toContain(CREDENTIAL_CANARY);
  // The restored cursor map is empty, asserted exactly (a partial matcher would let a retained cursor through).
  for (const bot of after.bots) expect(bot.resumeCursors).toEqual({});
  expectSchema(before.schema, after.schema);
  expectTables(before.tables, after.tables);
  expectMarkers(restoredDir, result);
}
