// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// THRUST-BACKUP 1.0.19 witnesses (thrust-backup/DESIGN.md W2-W5): a backup keeps bot identity, fenced action state, box state and the
// connected-app waits, and a restore brings each back only in its fail-closed form: no revoked grant, no replayed or re-sent work.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { classifyDataDirEntry, classifyDataDirEntryForBackup, isRestorableDataDirName } from "./data-dir-inventory.ts";
import { stageInstallationState } from "./installation-state-snapshot.ts";
import { prepareRestoredRecords, readRestoreJson, writeRestoreJsonAtomic } from "./restore-prep-core.ts";
import { ADMISSION_HOLDS_FILE, BOX_STATE_ARCHIVE_FILE, BOX_STATE_CALLS_FILE, restoredBoxState } from "./restore-owner-state.ts";
import { backupFixture } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

// The store's own file name, read from its source (the .mjs has no declaration file).
const COMPOSIO_ADMISSION_FILE = /export const COMPOSIO_ADMISSION_FILE = "([^"]+)";/.exec(readFileSync(join(import.meta.dirname, "..", "electron", "composio-release-config.mjs"), "utf8"))![1];
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });

const UUID = "0f8e2b1a-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const HOLDS = { version: 1, holds: [{ scope: "a".repeat(64), notBefore: 1_900_000_000_000, failureStreak: 2, generation: 3, status: 429 }] };
const FENCED_BOT = {
  id: "bot-archived", threadId: "thread-archived", name: "Archived", hidden: true, tasks: [],
};
const ARCHIVING_BOT = {
  id: "bot-archiving", threadId: "thread-archiving", name: "Archiving", tasks: [], archivingAt: "2026-11-17T10:00:00.000Z",
  archiveBlocked: { at: "2026-11-17T10:00:05.000Z", reason: "unconfirmed", targets: [{ kind: "engine", threadId: "thread-archiving", engine: "claude" }] },
};

function home(extra: Record<string, unknown | string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "murage-thrust-backup-"));
  roots.push(dir);
  const files = new Set<string>();
  const put = (path: string, value: unknown) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof value === "string" ? value : JSON.stringify(value));
    files.add(path);
  };
  put("bots.json", [FENCED_BOT, ARCHIVING_BOT]);
  put("groups.json", []);
  for (const [path, value] of Object.entries(extra)) put(path, value);
  return { dir, files };
}
function prepare(h: ReturnType<typeof home>) {
  const modifications: Array<{ component: string; action: string }> = [], quarantined: string[] = [];
  prepareRestoredRecords({
    state: h.dir, files: h.files,
    read: path => readRestoreJson(h.dir, h.files, path),
    write: (path, value) => writeRestoreJsonAtomic(join(h.dir, path), value),
    quarantine: path => { const to = join(h.dir, "recovery-quarantine", "q1", path); mkdirSync(dirname(to), { recursive: true }); renameSync(join(h.dir, path), to); },
  }, { generation: "g1", profile: "archive", quarantineId: "q1", modifications, quarantined });
  return { modifications, quarantined };
}
const onDisk = (dir: string, path: string) => JSON.parse(readFileSync(join(dir, path), "utf8"));

// W2: one classification table.
it("W2 classifies the connected-app waits and their interrupted save as kept and restored, and pins the store's own file name", () => {
  expect(ADMISSION_HOLDS_FILE).toBe(COMPOSIO_ADMISSION_FILE);
  for (const name of [COMPOSIO_ADMISSION_FILE, `${COMPOSIO_ADMISSION_FILE}.${UUID}.tmp`]) {
    expect(classifyDataDirEntry(name)?.backup).toBe("owner-file");
    expect(classifyDataDirEntryForBackup(name).skip).toBeUndefined();
    expect(isRestorableDataDirName(name)).toBe(true);
  }
  // Only the store's own temp spelling borrows the row.
  expect(classifyDataDirEntry(`${COMPOSIO_ADMISSION_FILE}.not-a-uuid.tmp`)).toBeUndefined();
});

it("W2 keeps the box state in a backup and restores it, while the prompts handed to a cloud computer never travel", () => {
  for (const name of [BOX_STATE_ARCHIVE_FILE, BOX_STATE_CALLS_FILE]) {
    expect(classifyDataDirEntry(name)?.backup).toBe("owner-file");
    expect(isRestorableDataDirName(name)).toBe(true);
  }
  expect(classifyDataDirEntry("cloud-computer-turns.json")?.backup).toBe("excluded");
});

it("W2 never stores an interrupted save of the script access grants, so a revoked grant cannot come back", () => {
  const entry = classifyDataDirEntryForBackup("mcp-grants.json.0f8e2b1a.tmp");
  expect(entry.backup).toBe("excluded");
  expect(entry.skip).toBeUndefined();
  expect(isRestorableDataDirName("mcp-grants.json.0f8e2b1a.tmp")).toBe(false);
  expect(isRestorableDataDirName("mcp-grants.json")).toBe(false);
});

// W2 + W3 through the real backup stage.
it("W3 a backup stage keeps bot identity, fenced action state, box state and the waits, and leaves revocable grants out", async () => {
  const f = backupFixture(); roots.push(f.parent); f.db.close();
  writeFileSync(join(f.data, "bots.json"), JSON.stringify([FENCED_BOT, ARCHIVING_BOT]) + "\n");
  writeFileSync(join(f.data, COMPOSIO_ADMISSION_FILE), JSON.stringify(HOLDS));
  writeFileSync(join(f.data, `${COMPOSIO_ADMISSION_FILE}.${UUID}.tmp`), "{\"version\":1,\"ho");
  writeFileSync(join(f.data, BOX_STATE_ARCHIVE_FILE), JSON.stringify({ version: 1, bots: { "bot-archiving": "had" }, calls: {} }));
  writeFileSync(join(f.data, BOX_STATE_CALLS_FILE), JSON.stringify({ version: 1, calls: { box1: "open" } }));
  writeFileSync(join(f.data, "mcp-grants.json"), "{}");
  writeFileSync(join(f.data, "mcp-grants.json.0f8e2b1a.tmp"), "{}");
  const { directory, manifest } = await stageInstallationState(f.data, f.parent);
  const stored = new Set(manifest.files.map(file => file.path));
  for (const name of [COMPOSIO_ADMISSION_FILE, `${COMPOSIO_ADMISSION_FILE}.${UUID}.tmp`, BOX_STATE_ARCHIVE_FILE, BOX_STATE_CALLS_FILE]) expect(stored.has(name)).toBe(true);
  for (const name of ["mcp-grants.json", "mcp-grants.json.0f8e2b1a.tmp"]) expect(stored.has(name)).toBe(false);
  expect((manifest.skipped ?? []).map(item => item.path)).not.toContain("mcp-grants.json.0f8e2b1a.tmp");
  const bots = JSON.parse(readFileSync(join(directory, "state", "bots.json"), "utf8"));
  expect(bots[0]).toMatchObject({ id: FENCED_BOT.id, threadId: FENCED_BOT.threadId, hidden: true });
  expect(bots[1]).toMatchObject({ id: ARCHIVING_BOT.id, threadId: ARCHIVING_BOT.threadId, archivingAt: ARCHIVING_BOT.archivingAt, archiveBlocked: ARCHIVING_BOT.archiveBlocked });
});

// W3: restore preparation.
it("W3 restore keeps each bot's identity and its archive fence: archived stays archived, mid-archive stays fenced and blocked", () => {
  const h = home();
  prepare(h);
  const [archived, archiving] = onDisk(h.dir, "bots.json");
  expect(archived).toMatchObject({ id: FENCED_BOT.id, threadId: FENCED_BOT.threadId, hidden: true });
  expect(archiving).toMatchObject({ id: ARCHIVING_BOT.id, threadId: ARCHIVING_BOT.threadId, archivingAt: ARCHIVING_BOT.archivingAt, archiveBlocked: ARCHIVING_BOT.archiveBlocked });
});

// W4: box state.
it("W4 box state comes back fail-closed: had kept, an old never forgotten, every unanswered call lost, nothing re-sent", () => {
  const h = home({
    [BOX_STATE_ARCHIVE_FILE]: { version: 1, bots: { "bot-archiving": "had", "bot-new": "never" }, calls: { box1: "open", box2: "lost" } },
    [BOX_STATE_CALLS_FILE]: { version: 1, calls: { box3: "open" }, incomplete: true },
  });
  const { modifications } = prepare(h);
  expect(onDisk(h.dir, BOX_STATE_ARCHIVE_FILE)).toEqual({ version: 1, bots: { "bot-archiving": "had" }, calls: { box1: "lost", box2: "lost" } });
  expect(onDisk(h.dir, BOX_STATE_CALLS_FILE)).toEqual({ version: 1, calls: { box3: "lost" }, incomplete: true });
  expect(modifications.some(note => note.component === "cloud computers")).toBe(true);
});

it("W4 an unreadable or invalid box record comes back unknown and incomplete, never as nothing", () => {
  const h = home({ [BOX_STATE_ARCHIVE_FILE]: "{not json", [BOX_STATE_CALLS_FILE]: { version: 2, calls: {} } });
  prepare(h);
  expect(onDisk(h.dir, BOX_STATE_ARCHIVE_FILE)).toEqual({ version: 1, bots: {}, calls: {}, incomplete: true });
  expect(onDisk(h.dir, BOX_STATE_CALLS_FILE)).toEqual({ version: 1, calls: {}, incomplete: true });
  expect(restoredBoxState(BOX_STATE_ARCHIVE_FILE, { version: 1, bots: { b: "maybe" }, calls: {} })).toEqual({ version: 1, bots: {}, calls: {}, incomplete: true });
  expect(restoredBoxState(BOX_STATE_CALLS_FILE, { version: 1, calls: { box: "open" } })).toEqual({ version: 1, calls: { box: "lost" } });
});

it("W4 a backup without box state restores none", () => {
  const h = home();
  prepare(h);
  expect(existsSync(join(h.dir, BOX_STATE_ARCHIVE_FILE))).toBe(false);
  expect(existsSync(join(h.dir, BOX_STATE_CALLS_FILE))).toBe(false);
});

// W5: connected-app waits.
it("W5 valid connected-app waits are restored exactly as written, with their interrupted save", () => {
  const raw = JSON.stringify(HOLDS), partial = "{\"version\":1,\"ho";
  const h = home({ [COMPOSIO_ADMISSION_FILE]: raw, [`${COMPOSIO_ADMISSION_FILE}.${UUID}.tmp`]: partial });
  const { quarantined } = prepare(h);
  expect(readFileSync(join(h.dir, COMPOSIO_ADMISSION_FILE), "utf8")).toBe(raw);
  expect(readFileSync(join(h.dir, `${COMPOSIO_ADMISSION_FILE}.${UUID}.tmp`), "utf8")).toBe(partial);
  expect(quarantined).toEqual([]);
});

it("W5 waits the store would refuse to load are set aside, never installed", () => {
  const h = home({ [COMPOSIO_ADMISSION_FILE]: { version: 1, holds: [{ scope: "not-a-hash", notBefore: 1, failureStreak: 0, generation: 0, status: 429 }] } });
  const { quarantined, modifications } = prepare(h);
  expect(existsSync(join(h.dir, COMPOSIO_ADMISSION_FILE))).toBe(false);
  expect(existsSync(join(h.dir, "recovery-quarantine", "q1", COMPOSIO_ADMISSION_FILE))).toBe(true);
  expect(quarantined).toContain(COMPOSIO_ADMISSION_FILE);
  expect(modifications.some(note => note.component === COMPOSIO_ADMISSION_FILE)).toBe(true);
});
