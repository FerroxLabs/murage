// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The revocation tombstones are the only copy of a phone's revocations once a backup downgrade drops the tables, so each file write must reach the disk
// (file synced, renamed, folder synced) before the downgrade transaction begins, and an unreadable file keeps phones off and is never touched.
import fs, { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { downgradePhoneObjectsTo108 } from "../installation-app-schema-downgrade.ts";
import { AskRevocations } from "./ask-revocations.ts";
import { ensurePhonesTables } from "./gate.ts";
import { initializePhones, PhoneRevocations } from "./registry.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

// Resolved: on macOS the temp folder is a symlink (/var -> /private/var), and SQLite names the database file (PRAGMA database_list,
// which the writer takes the folder from) by its real path, so the watched folder must be the real path too.
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), "murage-tombstone-durable-")));
afterAll(() => removeTempDirSync(SCRATCH));
let n = 0;
const newDir = () => { const dir = join(SCRATCH, `d${++n}`); mkdirSync(dir, { recursive: true }); return dir; };
const real = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync };
afterEach(() => { Object.assign(fs, real); syncBuiltinESMExports(); });

/** Record every file sync, rename and folder sync under `dir`, in order, by what they touched. */
function watch(dir: string, events: string[], dirSyncError?: string) {
  const opened = new Map<number, string>();
  const label = (p: string) => (p === dir ? "<dir>" : p.endsWith(".tmp") ? `<tmp ${p.slice(dir.length + 1).split(".")[0]}>` : p);
  fs.openSync = ((path: import("node:fs").PathLike, ...rest: unknown[]) => {
    const fd = (real.openSync as (...a: unknown[]) => number)(path, ...rest);
    opened.set(fd, String(path));
    return fd;
  }) as typeof fs.openSync;
  fs.fsyncSync = ((fd: number) => {
    const path = opened.get(fd) ?? "";
    if (path === dir || path.startsWith(`${dir}/`) || path.startsWith(`${dir}\\`)) events.push(`fsync ${label(path)}`);
    if (path === dir && dirSyncError) throw Object.assign(new Error(`${dirSyncError}: simulated`), { code: dirSyncError });
    real.fsyncSync(fd);
  }) as typeof fs.fsyncSync;
  fs.renameSync = ((from: import("node:fs").PathLike, to: import("node:fs").PathLike) => {
    if (String(to).startsWith(`${dir}/`)) events.push(`rename ${label(String(from))}`);
    real.renameSync(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
}

function seeded(dir: string) {
  const db = new DatabaseSync(join(dir, "messages.db"));
  initializePhones(db);
  new PhoneRevocations(db, () => 1000).bar("dev-a", "removed");
  new AskRevocations(db).apply("dev-a", 3);
  return db;
}
function recordBegin(db: DatabaseSync, events: string[]) {
  const exec = db.exec.bind(db);
  db.exec = ((sql: string) => { if (/^\s*(BEGIN|SAVEPOINT)/i.test(sql)) events.push("BEGIN"); return exec(sql); }) as typeof db.exec;
}

describe.skipIf(process.platform === "win32")("tombstone writes reach the disk before the downgrade transaction", () => {
  it("both files are synced, renamed and folder-synced before BEGIN", () => {
    const dir = newDir();
    const db = seeded(dir);
    const events: string[] = [];
    recordBegin(db, events);
    watch(dir, events);
    downgradePhoneObjectsTo108(db);
    const begin = events.indexOf("BEGIN");
    expect(begin).toBeGreaterThan(0);
    const before = events.slice(0, begin);
    expect(before.filter((e) => e === "fsync <dir>")).toHaveLength(2);
    // per file: temp synced, then renamed, then the folder synced
    for (const file of ["phone-revocations", "phone-ask-revocations"]) {
      const tmp = before.findIndex((e) => e === `fsync <tmp ${file}>`);
      const rename = before.findIndex((e) => e === `rename <tmp ${file}>`);
      expect(tmp).toBeGreaterThanOrEqual(0);
      expect(rename).toBeGreaterThan(tmp);
      expect(before.indexOf("fsync <dir>", rename)).toBeGreaterThan(rename);
    }
    expect(before[before.length - 1]).toBe("fsync <dir>");
    db.close();
  });

  it("a folder sync that fails stops the downgrade before BEGIN, with every table kept", () => {
    const dir = newDir();
    const db = seeded(dir);
    const events: string[] = [];
    recordBegin(db, events);
    watch(dir, events, "EIO");
    expect(() => downgradePhoneObjectsTo108(db)).toThrow(/EIO/);
    expect(events).not.toContain("BEGIN");
    expect(db.prepare("SELECT COUNT(*) AS c FROM phone_revocations").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM phone_ask_revocations").get()).toEqual({ c: 1 });
    db.close();
  });

  it("taking a phone out of the tombstone (a jobs mint) also syncs the folder", () => {
    const dir = newDir();
    const db = seeded(dir);
    downgradePhoneObjectsTo108(db);
    const again = new DatabaseSync(join(dir, "messages.db"));
    initializePhones(again);
    const events: string[] = [];
    watch(dir, events);
    new PhoneRevocations(again, () => 1000).clear("dev-a");
    expect(events.at(-1)).toBe("fsync <dir>");
    again.close(); db.close();
  });
});

describe("an unreadable tombstone keeps phones off and the file untouched", () => {
  const cases: Array<[string, string]> = [["phone-revocations.tombstone.json", "revocation"], ["phone-ask-revocations.tombstone.json", "ask"]];
  for (const [file, name] of cases) {
    it(`${name}: ensurePhonesTables stays false, the bytes do not change, and the log never offers removal`, () => {
      const dir = newDir();
      const path = join(dir, file);
      const bytes = "{this is not json, and it is the only copy";
      writeFileSync(path, bytes);
      const db = new DatabaseSync(join(dir, "messages.db"));
      const lines: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
      try {
        expect(ensurePhonesTables(() => db, { phoneTools: true })).toBe(false);
        expect(ensurePhonesTables(() => db, { phoneTools: true })).toBe(false);
      } finally { spy.mockRestore(); }
      expect(readFileSync(path, "utf8")).toBe(bytes);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(path);
      expect(lines[0]).toMatch(/restore/i);
      expect(lines[0].replace(path, "")).not.toMatch(/remov|delet|safe|safety|—/i);
      db.close();
    });
  }
});
