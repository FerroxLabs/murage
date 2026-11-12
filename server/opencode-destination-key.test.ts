import { afterEach, expect, it, vi } from "vitest";
import { accessSync, copyFileSync, chmodSync, chownSync, mkdtempSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { permissionFixture } from "./testing/opencode-permission-fixture.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OpenCodeDestinationKey } from "./opencode-destination-key.ts";
import { OpenCodeDestinationResolver } from "./opencode-destination.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
vi.mock("node:sqlite", async original => {
  const sqlite = await original<typeof import("node:sqlite")>();
  return { ...sqlite, DatabaseSync: vi.fn(function (path, options) { return new sqlite.DatabaseSync(path, options ?? {}); }) };
});
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, accessSync: vi.fn(fs.accessSync) };
});
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });
function fixture(schema = true) {
  const root = mkdtempSync(join(tmpdir(), "x4-db-")); chmodSync(root, 0o755);
  cleanups.push(() => removeTempDirSync(root));
  const path = join(root, "account.db"), cli = join(root, "cli"); writeFileSync(cli, "fixture");
  const writer = new DatabaseSync(path); cleanups.push(() => { try { writer.close(); } catch {} });
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  if (schema) writer.exec("CREATE TABLE account_state(id INTEGER PRIMARY KEY, active_account_id TEXT, active_org_id TEXT); INSERT INTO account_state VALUES(1, NULL, NULL)");
  const key = new OpenCodeDestinationKey(); cleanups.push(() => key.close());
  const env = { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, OPENCODE_TEST_MANAGED_CONFIG_DIR: root, OPENCODE_DB: path };
  const read = () => key.read(env, root, cli);
  const handles = () => (key as unknown as { accounts: Map<string, unknown> }).accounts.size;
  return { root, path, cli, writer, key, env, read, handles };
}
const retained = it.skipIf(process.platform === "win32");
retained("D1 reuses one read-only WAL connection", () => {
  const f = fixture(); vi.mocked(DatabaseSync).mockClear();
  f.read(); f.read(); expect(DatabaseSync).toHaveBeenCalledTimes(1);
  expect(DatabaseSync).toHaveBeenCalledWith(f.path, { readOnly: true }); expect(f.handles()).toBe(1);
});
retained("D2 committed account flip changes the same key's cacheable", () => {
  const f = fixture(); expect(f.read().cacheable).toBe(true);
  f.writer.exec("UPDATE account_state SET active_account_id='a', active_org_id='org'");
  expect(f.read().cacheable).toBe(false);
});
retained("D3 distinct inode replacement reopens without an absent read", () => {
  const f = fixture(); f.writer.close(); expect(f.read().cacheable).toBe(true);
  const replacement = join(f.root, "replacement"), db = new DatabaseSync(replacement);
  db.exec("CREATE TABLE control_account(active INTEGER); INSERT INTO control_account VALUES(1)"); db.close();
  expect(statSync(replacement).ino).not.toBe(statSync(f.path).ino);
  renameSync(replacement, f.path); expect(f.read().cacheable).toBe(false); expect(f.handles()).toBe(1);
});
retained("D4 deletion closes and recreation reopens", () => {
  const f = fixture(); f.writer.close(); f.read(); unlinkSync(f.path);
  expect(f.read().cacheable).toBe(true); expect(f.handles()).toBe(0);
  const db = new DatabaseSync(f.path); db.exec("CREATE TABLE control_account(active INTEGER); INSERT INTO control_account VALUES(1)"); db.close();
  expect(f.read().cacheable).toBe(false); expect(f.handles()).toBe(1);
});
retained("D5 warm unreadable database closes under an unprivileged identity and restores", async () => {
  const root = mkdtempSync(join(tmpdir(), "x4-unprivileged-"));
  try {
    chmodSync(root, 0o755);
    const fixtureRoot = mkdtempSync(join(root, "permission-"));
    if (process.getuid!() !== 0) { return await permissionFixture(fixtureRoot); }
    chownSync(fixtureRoot, 65534, 65534);
    // Copy the exact production module so uid 65534 need not traverse a root-owned checkout.
    copyFileSync(new URL("./opencode-destination-key.ts", import.meta.url), join(root, "opencode-destination-key.ts"));
    copyFileSync(new URL("./testing/opencode-permission-fixture.ts", import.meta.url), join(root, "fixture.ts"));
    // The fixture selects that copy in the child, and the original module in-process.
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
      'import { permissionFixture } from "./fixture.ts"; await permissionFixture(process.env.X4_PERMISSION_ROOT);'], {
      windowsHide: true,
      cwd: root, uid: 65534, gid: 65534, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL",
      env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, X4_PERMISSION_ROOT: fixtureRoot, X4_PERMISSION_MODULE: "./opencode-destination-key.ts" },
    });
    expect((result.error as NodeJS.ErrnoException | undefined)?.code, "permission fixture timed out after 20000 ms (child killed with SIGKILL)").not.toBe("ETIMEDOUT");
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  } finally { removeTempDirSync(root); }
}, 30_000);

retained("D5 lazy schemas, memory, independent ownership, errors, eviction and close", () => {
  const f = fixture(false); expect(f.read().cacheable).toBe(true);
  f.writer.exec("CREATE TABLE control_account(active INTEGER); INSERT INTO control_account VALUES(1)");
  expect(f.read().cacheable).toBe(false);
  f.writer.exec("CREATE TABLE account_state(id INTEGER, active_account_id TEXT, active_org_id TEXT)");
  expect(f.read().cacheable).toBe(true);
  const other = new OpenCodeDestinationKey(); cleanups.push(() => other.close());
  vi.mocked(DatabaseSync).mockClear(); other.read(f.env, f.root, f.cli); expect(DatabaseSync).toHaveBeenCalledTimes(1);
  f.key.close(); f.key.close(); expect(f.handles()).toBe(0);
  expect(other.read(f.env, f.root, f.cli).cacheable).toBe(true);
  f.env.OPENCODE_DB = ":memory:"; expect(f.read().cacheable).toBe(true); expect(f.handles()).toBe(0);
  let evicted: DatabaseSync | undefined;
  for (let i = 0; i < 5; i++) {
    f.env.OPENCODE_DB = join(f.root, `db-${i}`); const db = new DatabaseSync(f.env.OPENCODE_DB); db.close(); f.read();
    if (i === 0) evicted = (f.key as unknown as { accounts: Map<string, { conn: DatabaseSync }> }).accounts.get(f.env.OPENCODE_DB)!.conn;
  }
  expect(f.handles()).toBe(4);
  expect(() => evicted!.prepare("SELECT 1")).toThrow();
  const entries = (f.key as unknown as { accounts: Map<string, { conn: DatabaseSync }> }).accounts;
  expect(entries.has(join(f.root, 'db-0'))).toBe(false);
  const connections = [...entries.values()].map(v => v.conn);
  f.key.close(); for (const conn of connections) expect(() => conn.prepare("SELECT 1")).toThrow();
  f.env.OPENCODE_DB = f.path; f.read(); f.writer.exec("DROP TABLE account_state; CREATE TABLE account_state(broken TEXT)");
  expect(f.read().cacheable).toBe(false); expect(f.handles()).toBe(0);
});
retained("D7 idle retained reader pins no WAL snapshot", () => {
  const f = fixture(); f.writer.exec("UPDATE account_state SET active_account_id='a', active_org_id='org'");
  expect(f.read().cacheable).toBe(false); expect(f.handles()).toBe(1);
  expect(statSync(`${f.path}-wal`).size).toBeGreaterThan(0);
  expect(f.writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy).toBe(0);
  expect(statSync(`${f.path}-wal`).size).toBe(0); expect(f.handles()).toBe(1);
});
it.skipIf(process.platform !== "win32")("D8 Windows opens per read and permits replacement between reads", () => {
  const f = fixture(); f.writer.close();
  const next = join(f.root, "next"), db = new DatabaseSync(next);
  db.exec("CREATE TABLE control_account(active INTEGER); INSERT INTO control_account VALUES(1)"); db.close();
  vi.mocked(DatabaseSync).mockClear();
  expect(f.read().cacheable).toBe(true);
  expect(DatabaseSync).toHaveBeenCalledTimes(1); expect(f.handles()).toBe(0);
  renameSync(next, f.path);
  expect(f.read().cacheable).toBe(false);
  expect(DatabaseSync).toHaveBeenCalledTimes(2); expect(f.handles()).toBe(0);
});
retained("D9 idle timer rearms, unrefs, and resolver disposal closes", () => {
  vi.useFakeTimers(); const f = fixture(); f.read();
  const timer = (f.key as unknown as { idleTimer: NodeJS.Timeout }).idleTimer; expect(timer.hasRef()).toBe(false);
  vi.advanceTimersByTime(59_999); expect(f.handles()).toBe(1); f.read();
  vi.advanceTimersByTime(59_999); expect(f.handles()).toBe(1);
  vi.advanceTimersByTime(1); expect(f.handles()).toBe(0);
  const resolver = new OpenCodeDestinationResolver();
  const key = (resolver as unknown as { keys: OpenCodeDestinationKey }).keys;
  key.read(f.env, f.root, f.cli); const close = vi.spyOn(key, "close");
  resolver.dispose(); resolver.dispose(); expect(close).toHaveBeenCalledTimes(2);
  expect((key as unknown as { accounts: Map<string, unknown> }).accounts.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
});

retained("D5 access failure drops the warm handle", () => {
  const f = fixture(); expect(f.read().cacheable).toBe(true);
  vi.mocked(accessSync).mockImplementationOnce(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
  expect(f.read().cacheable).toBe(false); expect(f.handles()).toBe(0);
  expect(f.read().cacheable).toBe(true);
});
