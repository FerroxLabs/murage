// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW r3.2.8-H.1 5 / H.2 2: probeIndexFile (read-only, never waiting, whole-set lstat) and quarantineIndexAny (any member type).
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexProbeRefusedError, probeIndexFile, quarantineIndexAny } from "./index-quarantine.ts";

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "memw-probe-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) { try { chmodSync(d, 0o755); } catch { /* gone */ } rmSync(d, { recursive: true, force: true }); } });
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
function healthy(path: string, resetDone?: number) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;");
  if (resetDone !== undefined) db.prepare("INSERT INTO index_meta VALUES('reset_done',?)").run(String(resetDone));
  db.close();
}

describe("probeIndexFile", () => {
  it("refuses a messages.db path (and its -wal/-shm) with a typed throw before any look or open", () => {
    const d = dir();
    for (const name of ["messages.db", "messages.db-wal", "messages.db-shm"]) {
      const path = join(d, name);
      healthy(path);
      expect(() => probeIndexFile(path)).toThrow(IndexProbeRefusedError);
    }
  });
  it("absent: no main file; a log beside no main file is still absent", () => {
    const d = dir(), path = join(d, "i.db");
    expect(probeIndexFile(path)).toBe("absent");
    writeFileSync(`${path}-wal`, "x");
    expect(probeIndexFile(path)).toBe("absent");
  });
  it("healthy: an empty file, a file without index_meta, a file without a reset_done row, a reset_done for another R", () => {
    const d = dir(), path = join(d, "i.db");
    writeFileSync(path, "");
    expect(probeIndexFile(path, 7)).toBe("healthy");
    rmSync(path); const db = new DatabaseSync(path); db.exec("CREATE TABLE other(a)"); db.close();
    expect(probeIndexFile(path, 7)).toBe("healthy");
    rmSync(path); healthy(path);
    expect(probeIndexFile(path, 7)).toBe("healthy");
    rmSync(path); healthy(path, 6);
    expect(probeIndexFile(path, 7)).toBe("healthy");
    expect(probeIndexFile(path)).toBe("healthy"); // no R asked: never holds-R
  });
  it("holds-R: reset_done equals the asked R", () => {
    const d = dir(), path = join(d, "i.db");
    healthy(path, 7);
    expect(probeIndexFile(path, 7)).toBe("holds-R");
  });
  it("damaged: random bytes (NOTADB) and a truncated header", () => {
    const d = dir(), path = join(d, "i.db");
    writeFileSync(path, randomBytes(64 * 1024));
    expect(probeIndexFile(path, 7)).toBe("damaged");
  });
  it("unsafe: a live link, a dangling link, and a link at each log member (-wal, -shm, -walok, -walattempt, -walstop) beside a healthy main", () => {
    const d = dir(), target = join(d, "target.db"); healthy(target, 7);
    const live = join(d, "a.db"); symlinkSync(target, live);
    expect(probeIndexFile(live, 7)).toBe("unsafe");
    const dangling = join(d, "b.db"); symlinkSync(join(d, "nowhere"), dangling);
    expect(probeIndexFile(dangling, 7)).toBe("unsafe");
    for (const suffix of ["-wal", "-shm", "-walok", "-walattempt", "-walstop"]) {
      const path = join(d, `c${suffix.slice(1)}.db`); healthy(path, 7);
      symlinkSync(target, `${path}${suffix}`);
      expect(probeIndexFile(path, 7), suffix).toBe("unsafe");
    }
  });
  it.skipIf(process.platform === "win32")("busy: an lstat fault other than ENOENT (EACCES) is never unsafe, damaged or absent", () => {
    const d = dir(), inner = join(d, "sub"), path = join(inner, "i.db");
    rmSync(inner, { recursive: true, force: true }); writeFileSync(join(d, "x"), "");
    require_mkdir(inner); healthy(path, 7);
    chmodSync(inner, 0o000);
    try { expect(probeIndexFile(path, 7)).toBe("busy"); } finally { chmodSync(inner, 0o755); }
  });
  it("never waits and never writes: a write-locked healthy file answers at once and the probe creates no file", () => {
    const d = dir(), path = join(d, "i.db"); healthy(path, 7);
    const holder = new DatabaseSync(path);
    holder.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
    const before = readdirSync(d).sort(), started = Date.now();
    try { expect(["busy", "holds-R"]).toContain(probeIndexFile(path, 7)); } finally { holder.exec("ROLLBACK"); holder.close(); }
    expect(Date.now() - started).toBeLessThan(1000);
    expect(readdirSync(d).sort()).toEqual(before);
  });
});

describe("quarantineIndexAny", () => {
  it("moves a live link and a dangling link themselves, never their target; rolls back when a rename fails", () => {
    const d = dir(), target = join(d, "target.db"); healthy(target, 7); const before = sha(target);
    const path = join(d, "i.db"); symlinkSync(target, path); writeFileSync(`${path}-wal`, "w");
    const aside = quarantineIndexAny(path, 5);
    expect(aside).toBe(`${path}.corrupt-5`);
    expect(existsSync(path)).toBe(false); expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}.corrupt-5-wal`)).toBe(true);
    expect(sha(target)).toBe(before);
    const dangling = join(d, "j.db"); symlinkSync(join(d, "nowhere"), dangling);
    expect(() => quarantineIndexAny(dangling, 6)).not.toThrow();
    expect(readdirSync(d).some(f => f.startsWith("j.db.corrupt-6"))).toBe(true);
    const k = join(d, "k.db"); healthy(k, 1); writeFileSync(`${k}-wal`, "w");
    expect(() => quarantineIndexAny(k, 7, (from, to) => { if (from === k) throw new Error("EBUSY"); require_rename(from, to); })).toThrow("EBUSY");
    expect(existsSync(k)).toBe(true); expect(existsSync(`${k}-wal`)).toBe(true); // the log went back
  });
});
import { mkdirSync, renameSync } from "node:fs";
function require_mkdir(p: string) { mkdirSync(p, { recursive: true }); }
function require_rename(a: string, b: string) { renameSync(a, b); }
