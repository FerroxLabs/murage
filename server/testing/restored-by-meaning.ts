// What a restore must give back (WIN-BACKUP-RT-1018). The comparison is DEFAULT-STRICT:
//   * every file in the source tree must come back byte for byte, except the files named in RESTORE_REWRITTEN_FILES;
//   * the file sets must match in both directions, except the files named in RESTORE_ADDED_FILES;
//   * each rewritten document is deep-equal to an expected value built from the source, so a field that restore
//     adds, drops or changes without being named here fails the test;
//   * every messages.db table is compared by full row content (sorted); only the tables and columns named
//     below may differ, each with the exact expected change.
// Anything new that restore starts rewriting therefore turns the test red until it is named here on purpose.
// The rules follow server/installation-restore-preparation.ts (config.json at 215-240, bots.json, pauseRestoredMemory)
// and server/backup-restore-roundtrip.test.ts:195-208. They were checked against a real restore.
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";

type Json = Record<string, unknown>;

/** Documents restore rewrites into the safe, paused form. Everything else is byte-compared. */
export const RESTORE_REWRITTEN_FILES = ["bots.json", "config.json", "messages.db"];
/** Files restore creates beside the restored data: the review marker and fresh connection state. Their presence is asserted. */
export const RESTORE_ADDED_FILES = ["restore-review.json", "restored-connections.json"];
/** messages.db tables restore creates (restore holds, write epochs); presence asserted. */
const ADDED_TABLES = ["app_write_revision", "chats_gen", "restore_holds", "send_restore_generation"];
/** SQLite sidecars are not reproduced by a restore (the snapshot checkpoints the WAL). */
export const SIDECAR = /\.db-(wal|shm)$/;
export const CREDENTIAL_CANARY = "FAKE-CREDENTIAL-CANARY";

/** bot fields restore forces to a paused, safe value (backup-restore-roundtrip.test.ts:195). */
const FORCED_BOT_FIELDS = { autoApprove: false, browser: false, computer: "off", resumeCursors: {} };
/** bot fields restore fills with a default when the owner's record lacks them (observed on a real restore). */
const DEFAULTED_BOT_FIELDS = { busy: false, activity: "idle", autoReview: "off", alwaysAllow: [], approvePeerComms: true, autoStartVps: false, useMyChrome: false, composio: false, speakReplies: false, rewound: true };
/** config.json keys restore carries over unchanged (installation-restore-preparation.ts:223). */
const KEPT_CONFIG_KEYS = ["profile", "language", "rooms", "localVm", "browserProfiles", "notifications"];

export function listFiles(root: string, relative = "", into: string[] = []) {
  for (const name of readdirSync(join(root, relative)).sort()) {
    const next = relative ? `${relative}/${name}` : name;
    if (lstatSync(join(root, next)).isDirectory()) listFiles(root, next, into);
    else if (!SIDECAR.test(next)) into.push(next);
  }
  return into;
}

function tableRows(db: DatabaseSync, table: string): Json[] {
  const quoted = `"${table.replace(/"/g, '""')}"`;
  const text = (row: unknown) => JSON.stringify(row, (_key, value) => (typeof value === "bigint" ? `${value}n` : value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value));
  return (db.prepare(`SELECT * FROM ${quoted}`).all() as Json[]).sort((a, b) => text(a).localeCompare(text(b)));
}

/** Every table of a database, as sorted full rows. */
export function readTables(dbFile: string): Record<string, Json[]> {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map(row => row.name);
    return Object.fromEntries(names.map(name => [name, tableRows(db, name)]));
  } finally { db.close(); }
}

export function meaningOf(dataDir: string) {
  return {
    bots: JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")) as Json[],
    config: JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as Json,
    tables: readTables(join(dataDir, "messages.db")),
    files: listFiles(dataDir),
  };
}

function expectedBots(before: Json[]) {
  // Every owner field survives; the forced fields come back paused; the defaulted fields appear when the record lacked them.
  return before.map(bot => ({ ...DEFAULTED_BOT_FIELDS, ...bot, ...FORCED_BOT_FIELDS }));
}

function expectedConfig(before: Json, afterInstances: Record<string, Json>) {
  const expected: Json = { engineDiscovery: "explicit" };
  for (const key of KEPT_CONFIG_KEYS) if (Object.hasOwn(before, key)) expected[key] = before[key];
  if (before.hermesProfilesPinned === true) expected.hermesProfilesPinned = true;
  const newBots = before.newBots as Json | undefined;
  if (newBots && typeof newBots.effort === "string") expected.newBots = { effort: newBots.effort };
  // Browser and skill recorder are always off after a restore; only the tool-call display setting is the owner's.
  expected.features = { browser: false, skillRecorder: false, showToolCalls: (before.features as Json | undefined)?.showToolCalls === true };
  // Every engine the owner defined comes back disabled with its driver (and display name), credentials dropped.
  // The built-in engine list is added by restore; those entries are all disabled and hold only a driver.
  const owner = (before.instances ?? {}) as Record<string, Json>;
  expect(Object.keys(owner).length, "the fixture defines at least one engine").toBeGreaterThan(0);
  const instances: Record<string, Json> = {};
  for (const [key, value] of Object.entries(afterInstances)) instances[key] = Object.hasOwn(owner, key)
    ? { driver: owner[key].driver, ...(typeof owner[key].displayName === "string" ? { displayName: owner[key].displayName } : {}), enabled: false, ...(owner[key].driver === "hermesAgent" && value.config ? { config: value.config } : {}) }
    : { driver: value.driver, enabled: false };
  for (const key of Object.keys(owner)) expect(afterInstances, `engine ${key} the owner defined is still defined`).toHaveProperty(key);
  expected.instances = instances;
  return expected;
}

/** Row-level comparison of one table: the full rows, with the named rewrites only. */
function expectTables(before: Record<string, Json[]>, after: Record<string, Json[]>) {
  expect(Object.keys(after).sort(), "messages.db tables: the source tables plus the ones restore creates, nothing else").toEqual([...Object.keys(before), ...ADDED_TABLES].sort());
  expect(Object.keys(before), "the fixture database holds the transcript table").toContain("messages");
  const rewritten = new Set(["memory_meta", "memory_lsn", "memory_lineage_lsn_meta", "memory_revoke_jobs", "transcript_index_state"]);
  for (const [table, rows] of Object.entries(before)) if (!rewritten.has(table)) expect(after[table], `messages.db table ${table}: full row content`).toEqual(rows);
  // memory_meta: identity, schema, deletion epoch and data revision are preserved; memory comes back paused and the
  // policy revision moves by one (pauseRestoredMemory). An emptied or altered row fails here.
  expect(before.memory_meta, "the fixture holds the memory meta row").toHaveLength(1);
  expect(after.memory_meta, "memory_meta").toEqual([{ ...before.memory_meta[0], mode: "paused", policy_revision: (before.memory_meta[0].policy_revision as number) + 1 }]);
  expect(after.memory_meta[0].deletion_epoch, "the deletion history is preserved").toBe(1);
  // memory_lsn: the counter only moves forward (the pause consumed positions).
  expect(after.memory_lsn).toHaveLength(1);
  expect(after.memory_lsn[0].id).toBe(before.memory_lsn[0].id);
  expect(after.memory_lsn[0].next as number).toBeGreaterThan(before.memory_lsn[0].next as number);
  // memory_lineage_lsn_meta: same keys; only the two counters the pause bumps may move, and only forward.
  expect(after.memory_lineage_lsn_meta.map(row => row.key)).toEqual(before.memory_lineage_lsn_meta.map(row => row.key));
  before.memory_lineage_lsn_meta.forEach((row, index) => {
    const now = after.memory_lineage_lsn_meta[index];
    if (row.key === "deny_generation" || row.key === "policy_bump_lsn") expect(now.value as number, `${String(row.key)} only moves forward`).toBeGreaterThanOrEqual(row.value as number);
    else expect(now, `memory_lineage_lsn_meta ${String(row.key)}`).toEqual(row);
  });
  // memory_revoke_jobs: the source rows stay; restore adds exactly one finished policy revoke (cause policy-bump).
  const jobs = after.memory_revoke_jobs;
  expect(jobs).toHaveLength(before.memory_revoke_jobs.length + 1);
  const added = jobs[jobs.length - 1];
  expect(added, "the added revoke job is the finished policy-bump job").toMatchObject({ kind: "policy", phase: "done", state: "done" });
  expect(JSON.parse(String(added.root)), "revoke root").toEqual({ kind: "policy", cause: "policy-bump" });
  // transcript_index_state: the source rows stay equal; restore adds the one pending summary row.
  expect(after.transcript_index_state.filter(row => before.transcript_index_state.some(old => old.name === row.name)), "transcript_index_state source rows").toEqual(before.transcript_index_state);
  expect(after.transcript_index_state.filter(row => !before.transcript_index_state.some(old => old.name === row.name)), "transcript_index_state added rows").toEqual([{ name: "thread_summary", done: 0, cursor: 0, skipped: 0 }]);
}

export function expectRestoredByMeaning(before: ReturnType<typeof meaningOf>, sourceDir: string, restoredDir: string, sameBytes: (file: string) => void) {
  const after = meaningOf(restoredDir);
  // File sets equal both ways: nothing lost, nothing extra, except the named files restore creates.
  expect(after.files, "restored file set equals the source set plus the files restore creates").toEqual([...before.files, ...RESTORE_ADDED_FILES].sort());
  for (const file of before.files) if (!RESTORE_REWRITTEN_FILES.includes(file)) sameBytes(file);
  // bots.json and config.json: whole-document deep equality against the expected form.
  expect(after.bots, "bots.json").toEqual(expectedBots(before.bots));
  const afterInstances = (after.config.instances ?? {}) as Record<string, Json>;
  expect(after.config, "config.json").toEqual(expectedConfig(before.config, afterInstances));
  expect(Object.values(afterInstances).every(instance => instance.enabled === false), "config.json every engine disabled").toBe(true);
  expect(JSON.stringify(after.config)).not.toContain(CREDENTIAL_CANARY);
  expect(readFileSync(join(sourceDir, "config.json"), "utf8"), "the source did hold the credential canary (the drop is real)").toContain(CREDENTIAL_CANARY);
  // The restored cursor map is empty, asserted exactly (a partial matcher would let a retained cursor through).
  for (const bot of after.bots) expect(bot.resumeCursors).toEqual({});
  expectTables(before.tables, after.tables);
  // The files restore creates exist and are valid JSON.
  for (const file of RESTORE_ADDED_FILES) expect(() => JSON.parse(readFileSync(join(restoredDir, file), "utf8")), `${file} is valid JSON`).not.toThrow();
}
