import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
const url = new URL("./release-transaction.ts", import.meta.url);
// An absent module is explicitly contract/infrastructure RED, separately from
// release-atomic and the three learning real-sink behavioral witnesses.
const loaded = existsSync(url) ? await import(url.href) : undefined;
type Context = object;
type Options = { validate?: (context: Context) => void; emit: (context: Context) => unknown; onRelease?: () => void };
type Api = { releaseTransaction(db: DatabaseSync, options: Options): unknown; joinReleaseTransaction(context: Context, db: DatabaseSync, validate: () => unknown): unknown };
function api(): Api { expect(loaded, "C0 owned synchronous release transaction must exist").toBeDefined(); return loaded as Api; }
let dir: string | undefined; const handles: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of handles.splice(0)) db.close(); if (dir) removeTempDirSync(dir); dir = undefined; });
function pair() {
  dir = mkdtempSync(join(tmpdir(), "scopes7c-release-"));
  const db = new DatabaseSync(join(dir, "messages.db")), other = new DatabaseSync(join(dir, "messages.db")); handles.push(db, other);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE deny(id INTEGER PRIMARY KEY)"); other.exec("PRAGMA busy_timeout=0");
  return { db, other };
}
it("C0 validates and enqueues under one real writer lock, then releases it", () => {
  const a = api(), { db, other } = pair(), order: string[] = [];
  const compete = () => other.exec("INSERT INTO deny VALUES(1)");
  a.releaseTransaction(db, { validate: context => a.joinReleaseTransaction(context, db, () => { expect(db.isTransaction).toBe(true); order.push("checked"); }), onRelease: () => order.push("reserved"), emit: () => { expect(compete).toThrow(/locked|busy/i); order.push("bytes"); } });
  expect(order).toEqual(["checked", "reserved", "bytes"]); expect(db.isTransaction).toBe(false); compete();
});
it.each(["forged", "cross-connection", "expired", "recursive"])("C0 rejects %s contexts before the joined callback", kind => {
  const a = api(), { db, other } = pair(), write = vi.fn(); let saved: Context = {};
  a.releaseTransaction(db, { validate: context => {
    saved = context;
    if (kind === "forged") expect(() => a.joinReleaseTransaction({}, db, write)).toThrow();
    if (kind === "cross-connection") expect(() => a.joinReleaseTransaction(context, other, write)).toThrow();
    if (kind === "recursive") a.joinReleaseTransaction(context, db, () => expect(() => a.joinReleaseTransaction(context, db, write)).toThrow());
  }, emit: () => undefined });
  if (kind === "expired") expect(() => a.joinReleaseTransaction(saved, db, write)).toThrow();
  expect(write).not.toHaveBeenCalled();
});
it("C0 refuses an unrelated transaction and does not roll it back", () => {
  const a = api(), { db } = pair(), emit = vi.fn(); db.exec("BEGIN IMMEDIATE");
  expect(() => a.releaseTransaction(db, { emit })).toThrow(); expect(db.isTransaction).toBe(true); expect(emit).not.toHaveBeenCalled(); db.exec("ROLLBACK");
});
it("C0 refuses reentry even through a second connection", () => {
  const a = api(), { db, other } = pair(), nested = vi.fn();
  a.releaseTransaction(db, { emit: () => expect(() => a.releaseTransaction(other, { emit: nested })).toThrow() });
  expect(nested).not.toHaveBeenCalled();
});
it("C0 validation failure rolls back without reserving or writing", () => {
  const a = api(), { db } = pair(), emit = vi.fn(), reserve = vi.fn();
  expect(() => a.releaseTransaction(db, { validate: () => { db.exec("INSERT INTO deny VALUES(1)"); throw new Error("revoked"); }, onRelease: reserve, emit })).toThrow("revoked");
  expect(emit).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled(); expect(db.prepare("SELECT * FROM deny").all()).toEqual([]);
});
it("C0 conservatively commits accounting when a sink throws after possible acceptance", () => {
  const a = api(), { db } = pair(), reserve = vi.fn();
  expect(() => a.releaseTransaction(db, { onRelease: reserve, emit: () => { db.exec("INSERT INTO deny VALUES(1)"); throw new Error("native write failed"); } })).toThrow("native write failed");
  expect(reserve).toHaveBeenCalledTimes(1); expect(db.prepare("SELECT * FROM deny").all()).toHaveLength(1);
});
it("C0 commit failure after enqueue does not refund or retry bytes", () => {
  const a = api(), { db } = pair(), emit = vi.fn(), reserve = vi.fn(), exec = db.exec.bind(db);
  vi.spyOn(db, "exec").mockImplementation(sql => { if (sql === "COMMIT") throw new Error("fixture commit failure"); return exec(sql); });
  expect(() => a.releaseTransaction(db, { emit, onRelease: reserve })).toThrow(/COMMIT/);
  expect(emit).toHaveBeenCalledTimes(1); expect(reserve).toHaveBeenCalledTimes(1); expect(db.isTransaction).toBe(false);
});
it("C0 rejects thenable validators before any write and thenable emitters without refund", () => {
  const a = api(), { db } = pair(), emit = vi.fn(), reserve = vi.fn();
  expect(() => a.releaseTransaction(db, { validate: (() => Promise.resolve()) as () => void, emit, onRelease: reserve })).toThrow(/ASYNC/);
  expect(emit).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  expect(() => a.releaseTransaction(db, { emit: () => Promise.resolve(), onRelease: reserve })).toThrow(/ASYNC/);
  expect(reserve).toHaveBeenCalledTimes(1);
});
