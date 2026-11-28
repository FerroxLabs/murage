// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// DESIGN-JOURNEY-1024 W13 (sections 0C + 3; owner: q1024-journey build seat): the one per-bot grant `chrome` is read from the legacy
// route on a real boot of a store fixture, once per record; the screen bit is never inferred; a restore keeps Off and drops On, and
// the next boot does not give On back from the legacy fields a same-home restore keeps.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { consumeRestoreMarker } from "./email/restore-marker.ts";
import { writeInstallationArchive } from "./installation-archive.ts";
import { prepareInstallationRestore } from "./installation-restore-preparation.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { initializeImageOperations } from "./image-operations-schema.ts";
import { Store, type BotRecord } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
const BOTS = join(DATA_DIR, "bots.json");
/** What a build before 1.0.24 wrote: the legacy route fields only, no grant, no browser-modes.json yet. */
function bootLegacy(edit: Record<string, (record: BotRecord & Record<string, unknown>) => void>) {
  const store = new Store(selection);
  const ids = Object.fromEntries(Object.keys(edit).map(name => [name, store.createBot({ name }, { seedMessages: false }).id]));
  const legacy = JSON.parse(readFileSync(BOTS, "utf8")) as Array<BotRecord & Record<string, unknown>>;
  for (const record of legacy) {
    delete record.chrome; delete record.screenWithBrowser; delete record.browserGrantMigrated;
    const name = Object.keys(ids).find(key => ids[key] === record.id);
    if (name) edit[name]!(record);
  }
  writeFileSync(BOTS, JSON.stringify(legacy));
  rmSync(join(DATA_DIR, "browser-modes.json"), { force: true });
  const reloaded = new Store(selection);
  return { ids, reloaded, persisted: () => JSON.parse(readFileSync(BOTS, "utf8")) as Array<Record<string, unknown>> };
}

// Each behaviour is its own test, so the base run reaches every assertion (ASTRA r5 pass 1). RED on base (b99bdb6a0e: no grant field,
// no migration) at "W13 extension -> on" and "W13 direct -> on". Mutants: NOOP-W13 (migration does nothing) RED at "W13 extension -> on";
// M-W13d (the legacy inspect route migrates to unset) RED at "W13 direct -> on".
it("W13 boot: a legacy extension bot -> chrome=on, saved", () => {
  const { ids, reloaded, persisted } = bootLegacy({ Ext: r => { r.useMyChrome = true; r.browserTransport = "extension"; } });
  expect(reloaded.bot(ids.Ext!)?.chrome, "W13 extension -> on").toBe("on");
  expect(persisted().find(r => r.id === ids.Ext)).toMatchObject({ chrome: "on", browserGrantMigrated: true });
});
it("W13 boot: a legacy inspect-route (chrome-direct) bot -> chrome=on", () => {
  const { ids, reloaded } = bootLegacy({ Direct: r => { r.useMyChrome = true; } });
  expect(reloaded.bot(ids.Direct!)?.chrome, "W13 direct -> on").toBe("on");
});
// GUARD (fail closed; GREEN on base by nature: base grants nothing): own browser, an explicit Off, unknown values and a switched-off browser
// stay as they are, and the screen bit is never inferred. Mutants: M-W13s RED at "W13 no screen bit"; M-W13b RED at "W13 browser off -> unset".
it("W13 boot GUARD: own browser -> unset, Off stays Off, unknown dropped, browser off -> unset, the screen bit is never inferred", () => {
  const { ids, reloaded, persisted } = bootLegacy({
    Ext: r => { r.useMyChrome = true; r.browserTransport = "extension"; },
    Own: r => { delete r.useMyChrome; delete r.browserTransport; },
    Declined: r => { r.useMyChrome = true; r.browserTransport = "extension"; r.chrome = "off"; r.hostComputerConsent = "allowed"; },
    Garbled: r => { Object.assign(r, { chrome: "yes", screenWithBrowser: "true" }); },
    NoBrowser: r => { r.useMyChrome = true; r.browserTransport = "extension"; r.browser = false; },
  });
  expect(reloaded.bot(ids.Own!)?.chrome, "W13 own browser -> unset").toBeUndefined();
  expect(reloaded.bot(ids.Declined!)?.chrome, "W13 off stays off").toBe("off");
  expect(reloaded.bot(ids.Garbled!)?.chrome, "W13 unknown value dropped").toBeUndefined();
  expect(reloaded.bot(ids.NoBrowser!)?.chrome, "W13 browser off -> unset").toBeUndefined();
  expect(Object.values(ids).map(id => reloaded.bot(id)?.screenWithBrowser), "W13 no screen bit").toEqual(Object.values(ids).map(() => undefined));
  void persisted;
});

// GUARD (GREEN on base by nature), once per record: a record already migrated and undecided is never re-derived from the legacy route.
// Mutant M-W13once (the mark is ignored) RED at "W13 once per record".
it("W13 boot GUARD: the migration runs once; a bot undecided after it is not turned On by the legacy extension fields", () => {
  const { ids } = bootLegacy({ Ext: r => { r.useMyChrome = true; r.browserTransport = "extension"; } });
  const records = JSON.parse(readFileSync(BOTS, "utf8")) as Array<Record<string, unknown>>;
  for (const r of records) if (r.id === ids.Ext) { delete r.chrome; r.browserGrantMigrated = true; }
  writeFileSync(BOTS, JSON.stringify(records));
  expect(new Store(selection).bot(ids.Ext!)?.chrome, "W13 once per record").toBeUndefined();
});

// Upgrade from a 1.0.20+ home (browser-modes.json already written, nothing else to migrate): the grant migration alone must save bots.json.
// Mutant DROP-W13 (the migration's change is not saved) RED at "W13 persisted".
it("W13 boot: on a home that already has its browser choices, the migrated grant is written to bots.json", () => {
  const { ids } = bootLegacy({ Ext: r => { r.useMyChrome = true; r.browserTransport = "extension"; } });
  const records = JSON.parse(readFileSync(BOTS, "utf8")) as Array<Record<string, unknown>>;
  for (const r of records) if (r.id === ids.Ext) { delete r.chrome; delete r.browserGrantMigrated; }
  writeFileSync(BOTS, JSON.stringify(records));
  void new Store(selection);
  const saved = (JSON.parse(readFileSync(BOTS, "utf8")) as Array<Record<string, unknown>>).find(r => r.id === ids.Ext);
  expect(saved?.chrome, "W13 persisted").toBe("on");
});

// ASTRA d961956a02 High (browser-grant.ts:22): an AMBIGUOUS legacy record (BrowserModeStorage leaves it unmapped and warns "unchanged
// ambiguous selection") is not the owner's choice of their own Chrome: it stays undecided. Table: each ambiguity class load() refuses.
// RED on base d961956a02 at "W13 ambiguous <row> -> unset" (base re-read the raw fields: 'on'). Mutant M-W13amb (the migration reads the
// raw legacy fields again, base) RED at the same line; NOOP-W13 above covers "does nothing".
const AMBIGUOUS: Array<[string, (r: BotRecord & Record<string, unknown>) => void]> = [
  ["rejected extension profile id", r => { r.browserMode = "chrome-extension"; r.browserTransport = "extension"; r.browserExtensionProfileId = "not a profile/id"; }],
  ["unknown transport with the opt-in", r => { Object.assign(r, { useMyChrome: true, browserTransport: "carrier-pigeon" }); }],
];
for (const [row, edit] of AMBIGUOUS) {
  it(`W13 boot: ambiguous legacy record (${row}) -> undecided, never On`, () => {
    const { ids, reloaded } = bootLegacy({ Amb: edit });
    expect(reloaded.bot(ids.Amb!)?.chrome, `W13 ambiguous ${row} -> unset`).toBeUndefined();
  });
}

// Restore, through the two production entry points (ASTRA d961956a02 High: the helper alone proved nothing about either).
// 1) Desktop restore: prepareInstallationRestore on a real archive (profile "archive", installation-restore-preparation.ts:213).
// 2) Cloud reset / undo: consumeRestoreMarker(DATA_DIR), the exact boot call (index.ts bootStep "restore-marker"), before the store loads.
const legacyExt = { useMyChrome: true, browserTransport: "extension", browserMode: "chrome-extension", browserExtensionProfileId: "profile_1" };
const roster = () => [
  { id: "bot-on", threadId: "thread-on", name: "On", tasks: [], chrome: "on", screenWithBrowser: true, browserGrantMigrated: true, ...legacyExt },
  { id: "bot-off", threadId: "thread-off", name: "Off", tasks: [], chrome: "off", browserGrantMigrated: true, ...legacyExt },
];
async function desktopRestore() {
  const root = mkdtempSync(join(tmpdir(), "murage-w13-restore-")); roots.push(root);
  const data = join(root, "source"); mkdirSync(data);
  writeFileSync(join(data, "config.json"), JSON.stringify({ instances: {}, features: { browser: true } }));
  writeFileSync(join(data, "bots.json"), JSON.stringify(roster()));
  writeFileSync(join(data, "groups.json"), "[]");
  const db = new DatabaseSync(join(data, "messages.db"));
  try { initializeMessageTables(db); initializeImageOperations(db); } finally { db.close(); }
  const archive = join(root, "backup.zip");
  await writeInstallationArchive(data, archive);
  const result = await prepareInstallationRestore(archive, root);
  return JSON.parse(readFileSync(join(result.stateDirectory, "bots.json"), "utf8")) as Array<Record<string, unknown>>;
}
/** A Cloud reset swapped a same-home snapshot in: its roster and a marked messages.db; then the boot consumes the marker. */
function cloudReset() {
  writeFileSync(BOTS, JSON.stringify(roster()));
  const db = new DatabaseSync(join(DATA_DIR, "messages.db"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS email_bindings (bot_id TEXT PRIMARY KEY, state TEXT NOT NULL, step TEXT, revision INTEGER NOT NULL DEFAULT 0)");
    db.exec("CREATE TABLE restore_pending (reset_id TEXT PRIMARY KEY, operation TEXT NOT NULL, at INTEGER NOT NULL)");
    db.exec("INSERT INTO restore_pending VALUES ('r1','reset',1)");
  } finally { db.close(); }
  expect(consumeRestoreMarker(DATA_DIR), "W13 reset marker consumed").toBe(true);
  rmSync(join(DATA_DIR, "browser-modes.json"), { force: true });
  return new Store(selection);
}
// Desktop: RED on base b99bdb6a0e at "W13 desktop restore drops on" / "... drops the screen bit" (no grant rule); Off kept = GUARD.
// Mutants: M-W13r (restoredBrowserGrant keeps On) RED at "drops on"; M-W13rs (keeps the screen bit) RED at "drops the screen bit".
it("W13 desktop restore: On dropped, Off kept", async () => {
  const [on, off] = await desktopRestore();
  expect(on!.chrome, "W13 desktop restore drops on").toBeUndefined();
  expect(off!.chrome, "W13 desktop restore keeps off").toBe("off");
}, 60_000);
it("W13 desktop restore: the screen bit dropped", async () => {
  const [on] = await desktopRestore();
  expect(on!.screenWithBrowser, "W13 desktop restore drops the screen bit").toBeUndefined();
}, 60_000);
// Boot the desktop-restored records: On must not come back. RED on b99bdb6a0e at "W13 restored boot" (On restored as is). Mutant M-W13r
// RED at the same line. (An archive also turns the browser off, so the migrated mark is load-bearing only on the Cloud reset below.)
it("W13 desktop restore: the next boot of the restored records does not re-grant On", async () => {
  writeFileSync(BOTS, JSON.stringify(await desktopRestore()));
  rmSync(join(DATA_DIR, "browser-modes.json"), { force: true });
  const booted = new Store(selection);
  expect(booted.bot("bot-on")?.chrome, "W13 restored boot").toBeUndefined();
  expect(booted.bot("bot-off")?.chrome).toBe("off");
}, 60_000);
// Cloud reset / undo: RED on base d961956a02 at "W13 reset drops on" and "W13 reset drops the screen bit" (consumeRestoreMarker left the
// roster alone, the store booted On). Off kept = GUARD. RED at "W13 reset drops on": M-W13rc (no dropRestoredBrowserGrants call), NOOP-W13rc,
// DROP-W13rc (roster not written), M-W13r, M-W13m (unmigrated: the boot reads the kept legacy fields back into On); M-W13rs at the screen bit.
it("W13 Cloud reset: On dropped, Off kept, on the boot that consumes the marker", () => {
  const booted = cloudReset();
  expect(booted.bot("bot-on")?.chrome, "W13 reset drops on").toBeUndefined();
  expect(booted.bot("bot-off")?.chrome, "W13 reset keeps off").toBe("off");
});
it("W13 Cloud reset: the screen bit dropped", () => {
  const booted = cloudReset();
  expect(booted.bot("bot-on")?.screenWithBrowser, "W13 reset drops the screen bit").toBeUndefined();
});
// ASTRA 656f9e0447 High: the scrubbed roster must be durable before the marker's commit, or a power cut can keep the commit (no marker,
// no second scrub) and lose the rename (On back). Observed at the fsync syscall (the real fs, recorded, every call still made) around the
// exact boot call. RED on 656f9e0447 at "W13 reset roster durable" (the data folder is never fsynced). Mutant M-W13dur (syncDir dropped)
// RED at the same line.
it.skipIf(process.platform === "win32")("W13 Cloud reset: the scrubbed roster's rename is fsynced into the data folder before the marker commits (POSIX: Windows has no directory fsync, atomic.ts syncDirectory)", async () => {
  const { createRequire, syncBuiltinESMExports } = await import("node:module");
  const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
  const real = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, closeSync: fs.closeSync };
  writeFileSync(BOTS, JSON.stringify(roster()));
  const db = new DatabaseSync(join(DATA_DIR, "messages.db"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS email_bindings (bot_id TEXT PRIMARY KEY, state TEXT NOT NULL, step TEXT, revision INTEGER NOT NULL DEFAULT 0)");
    db.exec("CREATE TABLE restore_pending (reset_id TEXT PRIMARY KEY, operation TEXT NOT NULL, at INTEGER NOT NULL)");
    db.exec("INSERT INTO restore_pending VALUES ('r1','reset',1)");
  } finally { db.close(); }
  const handles = new Map<number, string>(), synced: string[] = [];
  fs.openSync = ((path: Parameters<typeof fs.openSync>[0], ...args: unknown[]) => { const fd = (real.openSync as (...a: unknown[]) => number)(path, ...args); handles.set(fd, String(path)); return fd; }) as typeof fs.openSync;
  fs.fsyncSync = fd => { real.fsyncSync(fd); synced.push(handles.get(fd) ?? "?"); };
  fs.closeSync = fd => { handles.delete(fd); real.closeSync(fd); };
  syncBuiltinESMExports();
  try { expect(consumeRestoreMarker(DATA_DIR)).toBe(true); } finally { Object.assign(fs, real); syncBuiltinESMExports(); }
  const rosterAt = synced.findIndex(path => path.startsWith(join(DATA_DIR, "bots.json")));
  expect(rosterAt, "W13 reset roster written").toBeGreaterThanOrEqual(0);
  expect(synced.slice(rosterAt + 1).includes(DATA_DIR), "W13 reset roster durable").toBe(true);
  expect((JSON.parse(readFileSync(BOTS, "utf8")) as Array<Record<string, unknown>>)[0]!.chrome).toBeUndefined();
});
// ASTRA 7bdb8d0f49 High: the first boot's directory fsync fails (EIO, after the rename), so the marker transaction rolls back; the retry boot
// must sync the data folder again before it commits, although the roster bytes are already scrubbed. RED on 7bdb8d0f49 at "W13 retry
// roster durable" (equal bytes skipped the write and its sync). Mutant M-W13retry (the equal-bytes skip back) RED at the same line.
it.skipIf(process.platform === "win32")("W13 Cloud reset: a retry after a failed directory fsync syncs the data folder again before the marker commits", async () => {
  const { createRequire, syncBuiltinESMExports } = await import("node:module");
  const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
  const real = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, closeSync: fs.closeSync };
  writeFileSync(BOTS, JSON.stringify(roster()));
  const db = new DatabaseSync(join(DATA_DIR, "messages.db"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS email_bindings (bot_id TEXT PRIMARY KEY, state TEXT NOT NULL, step TEXT, revision INTEGER NOT NULL DEFAULT 0)");
    db.exec("CREATE TABLE restore_pending (reset_id TEXT PRIMARY KEY, operation TEXT NOT NULL, at INTEGER NOT NULL)");
    db.exec("INSERT INTO restore_pending VALUES ('r1','reset',1)");
  } finally { db.close(); }
  const handles = new Map<number, string>();
  let synced: string[] = [], failDir = true;
  fs.openSync = ((path: Parameters<typeof fs.openSync>[0], ...args: unknown[]) => { const fd = (real.openSync as (...a: unknown[]) => number)(path, ...args); handles.set(fd, String(path)); return fd; }) as typeof fs.openSync;
  fs.fsyncSync = fd => {
    const path = handles.get(fd) ?? "?";
    if (path === DATA_DIR && failDir) { failDir = false; throw Object.assign(new Error("fixture directory sync failure"), { code: "EIO" }); }
    real.fsyncSync(fd); synced.push(path);
  };
  fs.closeSync = fd => { handles.delete(fd); real.closeSync(fd); };
  syncBuiltinESMExports();
  try {
    expect(() => consumeRestoreMarker(DATA_DIR), "W13 first boot fails on the directory sync").toThrow();
    expect((JSON.parse(readFileSync(BOTS, "utf8")) as Array<Record<string, unknown>>)[0]!.chrome, "W13 roster already scrubbed").toBeUndefined();
    synced = [];
    expect(consumeRestoreMarker(DATA_DIR), "W13 retry consumes the marker").toBe(true);
  } finally { Object.assign(fs, real); syncBuiltinESMExports(); }
  expect(synced.includes(DATA_DIR), "W13 retry roster durable").toBe(true);
});
// ASTRA 4b3ab21cf7 High: a restored roster saved with a byte order mark (the store's reader strips it) is scrubbed like any other.
// RED on 4b3ab21cf7 at "W13 BOM reset drops on" (the scrub's own JSON.parse threw and skipped; the store loaded On). Mutant M-W13bom
// (a raw JSON.parse that skips on error, base) RED at the same line.
it("W13 Cloud reset: a BOM-prefixed restored roster loses On too", () => {
  writeFileSync(BOTS, "\uFEFF" + JSON.stringify(roster()));
  const db = new DatabaseSync(join(DATA_DIR, "messages.db"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS email_bindings (bot_id TEXT PRIMARY KEY, state TEXT NOT NULL, step TEXT, revision INTEGER NOT NULL DEFAULT 0)");
    db.exec("CREATE TABLE restore_pending (reset_id TEXT PRIMARY KEY, operation TEXT NOT NULL, at INTEGER NOT NULL)");
    db.exec("INSERT INTO restore_pending VALUES ('r1','reset',1)");
  } finally { db.close(); }
  expect(consumeRestoreMarker(DATA_DIR)).toBe(true);
  rmSync(join(DATA_DIR, "browser-modes.json"), { force: true });
  const booted = new Store(selection);
  expect(booted.bot("bot-on")?.chrome, "W13 BOM reset drops on").toBeUndefined();
  expect(booted.bot("bot-on")?.screenWithBrowser).toBeUndefined();
});

// OPUS 2a3badd5ac Medium (new bots unmarked): a bot born on 1.0.24 has no legacy route to read, so it is migrated at birth. The owner
// later picks their own Chrome through the browser-choice writer (index.ts write -> Store.commitBrowserChoice); the next boot must not
// turn that choice into the grant (the grant is written only by an OK surface). Both creation paths: Store.createBot (POST /api/bots,
// create_bot) and Store.preparePackageAddition (the package import commit, index.ts packageImportAtomicCommit).
// RED on base 2a3badd5ac at "W13 new bot stays undecided" / "W13 package bot stays undecided" (unmarked: the boot migrated it to On).
// Mutants: M-W13n (no mark in createBot) RED at "W13 new bot stays undecided"; M-W13p (no grant rule in preparePackageAddition) RED at
// "W13 package bot stays undecided"; NOOP-W13once (the mark is ignored at boot) RED at both.
const pickOwnChrome = (store: Store, id: string) => store.commitBrowserChoice(id, { browserMode: "chrome-extension", useMyChrome: true,
  browserTransport: "extension", browserExtensionProfileId: "profile-7", selectionRevision: 1, browserSelectionRevision: 1 }, store.chromeDirectReservation);
it("W13 new bot: created on 1.0.24, then moved to the owner's Chrome, stays undecided after the next boot", () => {
  const store = new Store(selection);
  const id = store.createBot({ name: "Fresh" }, { seedMessages: false }).id;
  pickOwnChrome(store, id);
  expect(new Store(selection).bot(id)?.chrome, "W13 new bot stays undecided").toBeUndefined();
});
it("W13 package bot: imported on 1.0.24, then moved to the owner's Chrome, stays undecided after the next boot", () => {
  const store = new Store(selection);
  const id = "pkg-bot-1", at = Date.now();
  const record = { id, threadId: "pkg-thread-1", name: "Imported", title: "", description: "", color: "#888888", notifications: true, unread: false,
    modelSelection: selection(), resumeCursors: {}, createdAt: at, tasks: [{ threadId: "pkg-thread-1", title: "New task", createdAt: at, resumeCursors: {} }],
    composio: false, computer: "off", browser: false, autoApprove: false, fullAccess: false, noLimits: false, chiefOfStaff: false } as unknown as BotRecord;
  const batch = store.preparePackageAddition([record], []);
  writeFileSync(BOTS, batch.files.get("bots.json")!);
  batch.publish();
  store.patchBot(id, { browser: true });
  pickOwnChrome(store, id);
  expect(new Store(selection).bot(id)?.chrome, "W13 package bot stays undecided").toBeUndefined();
});
