// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as atomic from "../atomic.ts";
import * as checkpoint from "../sqlite-checkpoint.ts";
import * as threads from "node:worker_threads";
import { DatabaseSync } from "../sqlite-open.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import * as boot from "./boot-id.ts";
import * as winAcl from "../win-acl.ts";
import { inheritableOwnerOnlyVerdict } from "../sentinel/win-acl.ts";
import { DurableDelivery } from "./durable-delivery.ts";
import { committedLedgerRecords, exportChannelLedgersForDowngrade, LedgerStore } from "./delivery-ledger-store.ts";
import { metaOf, putState, rowOf, stored, writeV1 } from "./delivery-ledger-test-support.ts";

const workerProbe = vi.hoisted(() => ({
  rewrite: undefined as ((source: string | URL) => string | URL) | undefined,
  observe: undefined as ((worker: import("node:worker_threads").Worker) => void) | undefined,
}));
vi.mock("node:worker_threads", async importOriginal => {
  const real = await importOriginal<typeof threads>();
  return { ...real, Worker: class extends real.Worker {
    constructor(source: string | URL, options?: threads.WorkerOptions) {
      super(workerProbe.rewrite?.(source) ?? source, options); workerProbe.observe?.(this);
    }
  } };
});
const roots: string[] = [];
const closings: Promise<void>[] = [];
beforeEach(() => {
  const stop = DurableDelivery.prototype.stop;
  vi.spyOn(DurableDelivery.prototype, "stop").mockImplementation(function (this: DurableDelivery) {
    const closing = stop.call(this); closings.push(closing); return closing;
  });
  const release = LedgerStore.prototype.release;
  vi.spyOn(LedgerStore.prototype, "release").mockImplementation(function (this: LedgerStore) {
    const closing = release.call(this); closings.push(closing); return closing;
  });
});
afterEach(async () => { await Promise.all(closings.splice(0)); vi.restoreAllMocks(); for (const p of roots.splice(0)) removeTempDirSync(p); });
function setup(name = "ledger.json") {
  const root = mkdtempSync(join(tmpdir(), "murage-ledger-store-")); roots.push(root);
  let now = 1_000_000_000;
  const options = { file: join(root, name), bindingKey: "binding", recipient: "owner", isCurrent: () => true,
    runs: { enqueue: () => ({ id: "run" }), result: () => ({ status: "completed", output: "answer" }) },
    send: async () => ({ recipient: "owner", messageId: "m1" }), now: () => now };
  const v1 = (file = options.file) => writeV1(file, { version: 1, bindingKey: "binding", recipient: "owner", tombstones: [],
    records: [{ deliveryId: "a", prompt: "p", occurredAt: now, state: "uncertain", attempts: 1, response: "x" }] });
  return { root, options, v1, advance: (ms: number) => { now += ms; } };
}
const unsupported = () => Object.assign(new Error("not supported"), { code: "EINVAL" });
const allGone = (files: string[]) => files.every(file => !existsSync(file));
/** Migrates the v1 fixture and leaves a stopped instance behind, so the next open is a different instance. */
function migrate(f: ReturnType<typeof setup>) { const files = f.v1(); new DurableDelivery(f.options).stop(); return files; }

it("W-NAME-UNPROVEN: no directory sync and no restart keeps v1 files, whatever the clock does", async () => {
  vi.spyOn(atomic, "syncDirectory").mockImplementation(() => { throw unsupported(); });
  const f = setup(), files = migrate(f), before = files.map(file => readFileSync(file, "utf8"));
  const ledger = new DurableDelivery(f.options);
  for (let i = 0; i < 3; i++) { f.advance(48 * 3600_000); expect(await ledger.sweepPages()).toEqual({ removed: 0, failed: 0 }); }
  expect(files.map(file => readFileSync(file, "utf8"))).toEqual(before);
  expect(rowOf(f.options.file)?.legacy).toBe("kept");
  expect(metaOf(f.options.file, "name_proof")).toBeUndefined();
  ledger.stop();
});
it("W-LATER-BOOT: a different boot id proves the name; the same boot id does not", async () => {
  vi.spyOn(atomic, "syncDirectory").mockImplementation(() => { throw unsupported(); });
  const spy = vi.spyOn(boot, "bootId").mockReturnValue("boot-one");
  const f = setup(), files = migrate(f);
  expect(rowOf(f.options.file)?.migrated_boot).toBe("boot-one");
  const ledger = new DurableDelivery(f.options);
  expect((await ledger.sweepPages()).removed).toBe(0);
  spy.mockReturnValue("boot-two");
  expect((await ledger.sweepPages()).removed).toBe(files.length); expect(allGone(files)).toBe(true);
  expect(rowOf(f.options.file)?.legacy).toBe("removed");
  ledger.stop();
});
it("W-NAME-WIN: Windows never infers a restart, even with differing boot ids", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    vi.spyOn(winAcl, "windowsDirectoryInheritCheck").mockReturnValue("owner-only"); // fixture: the folder carries the inheritable owner-only entries
    const spy = vi.spyOn(boot, "bootId");
    const f = setup(), files = migrate(f);
    const ledger = new DurableDelivery(f.options);
    expect(metaOf(f.options.file, "name_proof")).toBeUndefined();
    spy.mockReturnValue("boot-two");
    expect((await ledger.sweepPages()).removed).toBe(0); expect(files.every(file => existsSync(file))).toBe(true);
    ledger.stop();
  } finally { Object.defineProperty(process, "platform", platform); }
});
it("W-NAME-DIRSYNC: a directory sync that ran is recorded and a second open retires", async () => {
  const f = setup(), files = migrate(f);
  expect(metaOf(f.options.file, "name_proof")).toBe("dirsync");
  const ledger = new DurableDelivery(f.options);
  expect((await ledger.sweepPages()).removed).toBe(files.length); expect(allGone(files)).toBe(true);
  ledger.stop();
});
it("the boot id is only read where a boot-session identifier exists", () => {
  expect(boot.bootId("win32")).toBeNull();
  expect(boot.bootId("freebsd")).toBeNull();
  if (process.platform === "linux") expect(boot.bootId("linux")).toMatch(/^[0-9a-f-]{36}$/);
});
it("W-RETIRE-BACKOFF: a failed retirement step backs off exponentially and is not retried per turn", async () => {
  const f = setup(), files = migrate(f);
  const stray = join(f.root, `ledger.json.${"1".repeat(8)}-1111-1111-1111-${"1".repeat(12)}`);
  mkdirSync(stray);
  const ledger = new DurableDelivery(f.options);
  expect(await ledger.sweepPages()).toEqual({ removed: 0, failed: 1 });
  for (let i = 0; i < 50; i++) ledger.redact("nothing");
  await ledger.sweepPages();
  for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
  expect(ledger.pageSweepFailures).toBe(1);
  expect(files.every(file => existsSync(file))).toBe(true);
  f.advance(60_000);
  expect((await ledger.sweepPages()).failed).toBe(1); expect(ledger.pageSweepFailures).toBe(2);
  expect(rowOf(f.options.file)).toMatchObject({ retire_attempts: 2, retire_after: f.options.now() + 120_000 });
  for (let attempts = 3; attempts <= 12; attempts++) { f.advance(48 * 3600_000); await ledger.sweepPages(); }
  expect(rowOf(f.options.file)!.retire_after! - f.options.now()).toBe(24 * 3600_000);
  rmSync(stray, { recursive: true });
  f.advance(48 * 3600_000);
  expect((await ledger.sweepPages()).failed).toBe(0);
  expect(rowOf(f.options.file)?.legacy).toBe("removed"); expect(allGone(files)).toBe(true);
  ledger.stop();
});
it("W-DIVERGED-AFTER-RETIRE: a v1 file an older build writes after retirement is kept and reported", async () => {
  for (const created of [false, true]) {
    const f = setup(`ledger-${created}.json`);
    if (created) { const first = new DurableDelivery(f.options); first.accept({ deliveryId: "e1", prompt: "p", occurredAt: f.options.now() }); first.stop(); }
    else { const files = migrate(f); const second = new DurableDelivery(f.options); expect((await second.sweepPages()).removed).toBe(files.length); second.stop(); }
    const state = stored(f.options.file);
    const files = writeV1(f.options.file, { version: 1, bindingKey: "binding", recipient: "owner", tombstones: [], records: [{ deliveryId: "old-build", prompt: "q", occurredAt: f.options.now(), state: "uncertain", attempts: 1 }] });
    const bytes = readFileSync(f.options.file, "utf8");
    const reopened = new DurableDelivery(f.options);
    expect(reopened.legacyDiverged).toBe(1);
    expect(rowOf(f.options.file)?.legacy).toBe("diverged");
    expect(readFileSync(f.options.file, "utf8")).toBe(bytes); expect(files.every(file => existsSync(file))).toBe(true);
    expect(stored(f.options.file)).toEqual(state);
    expect((await reopened.sweepPages()).removed).toBe(0); expect(existsSync(f.options.file)).toBe(true);
    reopened.stop();
  }
});
it("W-STOP-IDEMP: stop and revoke are idempotent and leave the shared handle to its last user", async () => {
  const f = setup("a.json"), other = { ...f.options, file: join(f.root, "b.json") };
  const a = new DurableDelivery(f.options), b = new DurableDelivery(other);
  a.accept({ deliveryId: "e1", prompt: "p", occurredAt: f.options.now() });
  a.stop(); a.stop();
  expect(() => { a.revoke(); a.revoke(); }).not.toThrow();
  expect(stored(f.options.file).records[0].state).toBe("cancelled");
  expect(b.accept({ deliveryId: "e2", prompt: "p", occurredAt: f.options.now() })).toBe("accepted");
  expect(existsSync(join(f.root, "delivery-ledger.db-wal"))).toBe(true);
  await b.stop();
  expect(existsSync(join(f.root, "delivery-ledger.db-wal"))).toBe(false);
});
it("W-STOP-REVOKE-CUSTODY: stop after a completed stop and repeated revoke joins every reopened handle and worker", async () => {
  const f = setup(), ledger = new DurableDelivery(f.options), workers = new Set<threads.Worker>();
  ledger.accept({ deliveryId: "e1", prompt: "p", occurredAt: f.options.now() });
  await ledger.stop();
  expect(existsSync(join(f.root, "delivery-ledger.db-wal"))).toBe(false);
  workerProbe.observe = worker => { workers.add(worker); worker.once("exit", () => workers.delete(worker)); };
  try {
    ledger.revoke();
    const first = ledger.stop();
    ledger.revoke();
    await ledger.stop(); await first;
    expect(existsSync(join(f.root, "delivery-ledger.db-wal"))).toBe(false);
    expect(workers.size).toBe(0);
    expect(stored(f.options.file).records[0].state).toBe("cancelled");
  } finally { workerProbe.observe = undefined; await ledger.stop(); }
});

it.each(["sweep", "redact"] as const)("W-STOP-TRANSIENT-SWEEP: stopped %s joins a new transient fold and its last close", async operation => {
  const f = setup(), ledger = new DurableDelivery(f.options);
  ledger.accept({ deliveryId: "e1", prompt: "p", occurredAt: f.options.now() });
  await ledger.stop();
  let sweeping: ReturnType<DurableDelivery["sweepPages"]> | undefined;
  try {
    if (operation === "redact") ledger.redact("e1");
    sweeping = ledger.sweepPages();
    await ledger.stop();
    expect(existsSync(join(f.root, "delivery-ledger.db-wal"))).toBe(false);
    expect(stored(f.options.file).records[0].state).toBe(operation === "redact" ? "cancelled" : "accepted");
  } finally { await sweeping; await ledger.stop(); }
});

it.each(["accept", "settle", "resend", "redact", "revoke", "sending"] as const)("W-COMMIT-FAIL-ALL: %s rolls back an exact COMMIT failure without publishing state or sending", async operation => {
  const f = setup(), send = vi.fn(f.options.send), ledger = new DurableDelivery({ ...f.options, send });
  ledger.accept({ deliveryId: "e1", prompt: "p", response: "answer", occurredAt: f.options.now() });
  try {
    const before = stored(f.options.file), memory = ledger.snapshotRecords(), status = ledger.status(), capacity = ledger.admissionCapacity();
    const exec = DatabaseSync.prototype.exec, statements: string[] = [];
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      statements.push(sql);
      if (sql === "COMMIT") throw Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR", errcode: 10 });
      return exec.call(this, sql);
    });
    try {
      if (operation === "sending") await expect(ledger.drain()).rejects.toThrow("disk I/O error");
      else expect(() => {
        if (operation === "accept") ledger.accept({ deliveryId: "e2", prompt: "p", occurredAt: f.options.now() });
        else if (operation === "settle") ledger.settle("e1");
        else if (operation === "resend") ledger.resend("e1");
        else if (operation === "redact") ledger.redact("e1");
        else ledger.revoke();
      }).toThrow("disk I/O error");
      expect(statements.filter(sql => sql === "COMMIT")).toHaveLength(1);
      expect(statements.filter(sql => sql === "ROLLBACK")).toHaveLength(1);
    } finally { spy.mockRestore(); }
    expect(stored(f.options.file)).toEqual(before);
    expect(ledger.snapshotRecords()).toEqual(memory);
    expect(ledger.status()).toEqual(status); expect(ledger.admissionCapacity()).toEqual(capacity);
    expect(ledger.has("e1")).toBe(true); expect(ledger.has("e2")).toBe(false);
    expect(send).not.toHaveBeenCalled();
    await ledger.stop();
    const recovered = new DurableDelivery(f.options);
    try { expect(stored(f.options.file)).toEqual(before); expect(recovered.snapshotRecords()).toEqual(memory); }
    finally { await recovered.stop(); }
  } finally { await ledger.stop(); }
});

it("W-COMMIT-FAIL: a COMMIT that fails leaves neither the rows nor the in-memory state changed", () => {
  const f = setup(), ledger = new DurableDelivery(f.options);
  ledger.accept({ deliveryId: "e1", prompt: "p", occurredAt: f.options.now() });
  const before = JSON.stringify(stored(f.options.file));
  const exec = DatabaseSync.prototype.exec;
  const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql === "COMMIT") throw Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR", errcode: 10 });
    return exec.call(this, sql);
  });
  expect(() => ledger.accept({ deliveryId: "e2", prompt: "p", occurredAt: f.options.now() })).toThrow("disk I/O error");
  expect(() => ledger.settle("e1")).toThrow("disk I/O error");
  expect(() => ledger.revoke()).toThrow("disk I/O error");
  spy.mockRestore();
  expect(JSON.stringify(stored(f.options.file))).toBe(before);
  expect(ledger.has("e2")).toBe(false); expect(ledger.status().pending).toBe(1);
  const recovered = new DurableDelivery(f.options);
  expect(recovered.status().pending).toBe(1); recovered.stop();
});
it("rows keep insertion order, not key order, and a ledger beyond the page bounds reloads whole", () => {
  const f = setup(), ledger = new DurableDelivery(f.options);
  for (const id of ["z-9", "m-5", "a-1"]) ledger.accept({ deliveryId: id, prompt: "p", occurredAt: f.options.now() });
  ledger.stop();
  expect(stored(f.options.file).records.map((r: { deliveryId: string }) => r.deliveryId)).toEqual(["z-9", "m-5", "a-1"]);
  // The reload itself (not the helper above) keeps insertion order, and an aggregate beyond the old page bounds loads whole.
  const reopened = new DurableDelivery(f.options);
  expect(reopened.snapshotRecords().map(r => r.deliveryId)).toEqual(["z-9", "m-5", "a-1"]);
  expect(reopened.pendingRunIds()).toEqual([]); reopened.stop();
  const big = setup("big.json"), records = Array.from({ length: 210 }, (_, i) => ({ deliveryId: `held-${String(210 - i).padStart(3, "0")}`, prompt: "p", response: "r", occurredAt: 1, attempts: 1, state: "uncertain" }));
  putState(big.options.file, { version: 1, bindingKey: "binding", recipient: "owner", tombstones: [], records });
  const whole = new DurableDelivery(big.options);
  expect(whole.snapshotRecords().map(r => r.deliveryId)).toEqual(records.map(r => r.deliveryId)); expect(whole.status().uncertain).toBe(210); whole.stop();
});

/** W-KILL (M8): a child process is killed at each commit of one drain; the parent's reopen must never send a record twice. */
function killFixture() {
  const f = setup("kill.json"), now = 1_000_000_000;
  putState(f.options.file, { version: 1, bindingKey: "binding", recipient: "owner", tombstones: [], records: [
    { deliveryId: "a", prompt: "p", occurredAt: now, attempts: 0, state: "accepted" },
    { deliveryId: "b", prompt: "p", occurredAt: now, attempts: 1, state: "uncertain", response: "x" },
    { deliveryId: "c", prompt: "p", occurredAt: now, attempts: 1, state: "sent" }] });
  const child = (mode: "commit" | "begin", n: number) => {
    const run = spawnSync(process.execPath, ["--experimental-transform-types", fileURLToPath(new URL("./delivery-kill-child.fixture.ts", import.meta.url)), f.options.file, mode, String(n)],
      { stdio: ["ignore", "ignore", "inherit", "pipe"] });
    return { killed: run.signal === "SIGKILL", sends: String(run.output?.[3] ?? "").split("\n").filter(Boolean) };
  };
  return { ...f, child };
}
async function parentDrain(f: ReturnType<typeof killFixture>) {
  const send = vi.fn(async () => ({ recipient: "owner", messageId: "m1" })), enqueue = vi.fn(() => ({ id: "run" }));
  const ledger = new DurableDelivery({ ...f.options, send, runs: { enqueue, result: () => ({ status: "completed", output: "answer" }) } });
  await ledger.drain(); await ledger.drain(); ledger.stop();
  return { sends: send.mock.calls.length, enqueues: enqueue.mock.calls.length };
}
// After COMMIT n: 1 queued, 2 response, 3 sending, 4 sent. The persisted state and the parent's drain outcome per boundary:
it.each([
  [1, "queued", 0, 1, 0], [2, "queued", 0, 1, 0], [3, "uncertain", 0, 0, 0], [4, "sent", 1, 0, 0],
] as const)("W-KILL: killed right after commit %i leaves %s, the child sent %i, the parent sends %i", async (n, persisted, childSends, parentSends, enqueues) => {
  const f = killFixture(), run = f.child("commit", n);
  expect(run.killed).toBe(true); expect(run.sends).toHaveLength(childSends);
  const parent = await parentDrain(f);
  expect(parent.sends).toBe(parentSends); expect(parent.enqueues).toBe(enqueues);
  expect(run.sends.length + parent.sends).toBeLessThanOrEqual(1);
  const rows = stored(f.options.file).records as Array<{ deliveryId: string; state: string }>;
  expect(rows.find(r => r.deliveryId === "a")?.state).toBe(persisted === "queued" ? "sent" : persisted);
  expect(rows.find(r => r.deliveryId === "b")?.state).toBe("uncertain"); expect(rows.find(r => r.deliveryId === "c")?.state).toBe("sent");
});
it.each([1, 2, 3, 4])("W-KILL: killed before commit %i rolls back whole and sends at most once", async n => {
  const f = killFixture(), run = f.child("begin", n);
  expect(run.killed).toBe(true);
  const parent = await parentDrain(f);
  expect(run.sends.length + parent.sends).toBe(1);
  const rows = stored(f.options.file).records as Array<{ deliveryId: string; state: string }>;
  expect(rows.map(r => r.deliveryId)).toEqual(["a", "b", "c"]); expect(rows.find(r => r.deliveryId === "a")?.state).toBe(n === 4 ? "uncertain" : "sent");
});

const USER = "S-1-5-21-1-2-3-1001";
const sddl = (...aces: string[]) => `O:${USER}D:P${aces.join("")}`;
it("W-WIN-ACL: only a folder whose entries are owner-only AND inheritable passes", () => {
  const OICI = `(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)`;
  expect(inheritableOwnerOnlyVerdict(sddl(OICI), USER)).toBe("owner-only");
  expect(inheritableOwnerOnlyVerdict(`O:${USER}D:(A;OICIID;FA;;;${USER})(A;OICIID;FA;;;SY)`, USER)).toBe("owner-only"); // inherited from an owner-only parent
  expect(inheritableOwnerOnlyVerdict(sddl(`(A;;FA;;;${USER})(A;;FA;;;SY)`), USER)).toBe("broad"); // not inheritable: -wal/-shm would not receive it
  expect(inheritableOwnerOnlyVerdict(sddl(`(A;OI;FA;;;${USER})`), USER)).toBe("broad"); // objects only, no containers
  expect(inheritableOwnerOnlyVerdict(sddl(OICI, "(A;OICI;FR;;;BU)"), USER)).toBe("broad"); // a foreign group
  expect(inheritableOwnerOnlyVerdict(sddl("(A;OICI;FA;;;SY)"), USER)).toBe("unknown"); // the owner is not granted
  expect(inheritableOwnerOnlyVerdict("garbage", USER)).toBe("unknown");
});
it.each(["broad", "unknown"] as const)("W-WIN-ACL: an existing folder with a %s ACL refuses the store and creates nothing (mutant: no check)", verdict => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    vi.spyOn(winAcl, "windowsDirectoryInheritCheck").mockReturnValue(verdict);
    const f = setup();
    expect(() => new DurableDelivery(f.options)).toThrow("Channel receipt data is invalid");
    expect(existsSync(join(f.root, "delivery-ledger.db"))).toBe(false);
  } finally { Object.defineProperty(process, "platform", platform); }
});

it("W-LEASE-RELEASE: a second release of one lease never closes the handle another lease still uses (mutant: release without the flag)", () => {
  const f = setup("a.json"), first = new LedgerStore(f.options.file), second = new LedgerStore(join(f.root, "b.json"));
  first.release(); first.release(); first.release();
  expect(() => second.row()).not.toThrow();
  second.release(); expect(() => second.release()).not.toThrow();
});

it("W-RETIRE-NOCONTINUE: a failed step schedules no continuation, even when every turn is past the backoff window (mutant: continue after a failure)", async () => {
  const f = setup(), files = migrate(f);
  mkdirSync(join(f.root, `ledger.json.${"2".repeat(8)}-2222-2222-2222-${"2".repeat(12)}`));
  let clock = f.options.now();
  const ledger = new DurableDelivery({ ...f.options, now: () => (clock += 48 * 3600_000) });
  for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
  await ledger.sweepPages();
  expect(ledger.pageSweepFailures).toBe(1); expect(files.every(file => existsSync(file))).toBe(true);
  ledger.stop();
});

it("W-FOLD-NOWAIT: the receipts' WAL fold never waits on a reader, keeps its connection's busy timeout, and empties the log once the reader is gone (mutants: no busy_timeout=0, no restore)", async () => {
  const f = setup("fold.json"), store = new LedgerStore(f.options.file);
  try {
    store.commit({ version: 1, bindingKey: "binding", recipient: "owner", tombstones: [],
      records: [{ deliveryId: "a", prompt: "p", occurredAt: 1, state: "uncertain", attempts: 1, response: "x" }] } as never);
    const wal = join(f.root, "delivery-ledger.db-wal");
    expect((store as unknown as { db: DatabaseSync }).db.prepare("PRAGMA wal_autocheckpoint").get()!.wal_autocheckpoint).toBe(0);
    expect(readFileSync(wal).length).toBeGreaterThan(0);
    const reader = new DatabaseSync(join(f.root, "delivery-ledger.db"), { readOnly: true });
    try {
      reader.exec("BEGIN"); reader.prepare("SELECT COUNT(*) AS n FROM delivery_entry").get();
      const started = performance.now();
      expect(await store.checkpoint()).toBe(false);
      expect(performance.now() - started).toBeLessThan(500);
      reader.exec("COMMIT");
    } finally { reader.close(); }
    const busy = (store as unknown as { db: DatabaseSync }).db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    expect(busy.timeout).toBe(1000);
    expect(await store.checkpoint()).toBe(true);
    expect(readFileSync(wal).length).toBe(0);
  } finally { store.release(); }
});

it("W-FOLD-LARGE: a large receipts WAL folds off-thread while the server heartbeat keeps its existing 200 ms bound", async () => {
  const f = setup("large.json"), store = new LedgerStore(f.options.file);
  const db = (store as unknown as { db: DatabaseSync }).db;
  let drift = 0, last = performance.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    db.exec("PRAGMA wal_autocheckpoint=0; CREATE TABLE large_receipt (body BLOB); INSERT INTO large_receipt VALUES (zeroblob(33554432))");
    const wal = join(f.root, "delivery-ledger.db-wal");
    expect(readFileSync(wal).length).toBeGreaterThan(32 * 1024 * 1024);
    const seen: string[] = [], prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(sql => { seen.push(sql); return prepare(sql); });
    last = performance.now();
    timer = setInterval(() => { const now = performance.now(); drift = Math.max(drift, now - last - 10); last = now; }, 10);
    expect(await store.checkpoint()).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(drift).toBeLessThan(200);
    expect(seen.filter(sql => /wal_checkpoint/i.test(sql))).toEqual([]);
    expect(readFileSync(wal).length).toBe(0);
  } finally { if (timer) clearInterval(timer); store.release(); }
});

it("W-INSPECT-V1: read-only inspection validates and includes every paged receipt; corrupt or missing data never becomes an empty ledger", () => {
  const f = setup("paged.json");
  const state = { version: 1 as const, bindingKey: "binding", recipient: "owner", tombstones: [],
    records: Array.from({ length: 110 }, (_, i) => ({ deliveryId: `item-${i}`, prompt: "fixture", occurredAt: 1, state: "uncertain" as const, attempts: 1, response: "x".repeat(20000) })) };
  const files = writeV1(f.options.file, state);
  expect(files.length).toBeGreaterThan(1);
  expect(committedLedgerRecords(f.options.file)).toEqual(state.records);
  expect(existsSync(join(f.root, "delivery-ledger.db"))).toBe(false);
  rmSync(files.find(file => file !== f.options.file)!);
  expect(() => committedLedgerRecords(f.options.file)).toThrow();
  atomic.writeFileAtomic(f.options.file, "{}");
  expect(() => committedLedgerRecords(f.options.file)).toThrow();
});

it.each(["stop", "state", "row"])("W-FOLD-REVALIDATE: %s during the worker fold preserves every legacy file", async change => {
  const f = setup(), files = migrate(f), store = new LedgerStore(f.options.file);
  try {
    const current = store.load(20000, { migrate: false })!.state;
    const retiring = store.retire(20000, current, "next-owner", f.options.now());
    if (change === "stop") store.release();
    else if (change === "row") store.setLegacy("diverged");
    else store.commit({ ...current, records: [] });
    expect(await retiring).toEqual({ removed: 0, failed: 0, more: false });
    expect(files.every(file => existsSync(file))).toBe(true);
  } finally { store.release(); }
});

it("W-FOLD-STOP: stopping a ledger joins its live fold before a custody move can use the folder", async () => {
  const f = setup(), legacy = migrate(f), ledger = new DurableDelivery(f.options);
  ledger.accept({ deliveryId: "a", prompt: "fixture", occurredAt: f.options.now() });
  const folding = ledger.sweepPages();
  let stopped = false;
  const stop = Promise.resolve(ledger.stop()).then(() => { stopped = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(stopped).toBe(false);
  } finally { await Promise.all([folding, stop]); }
  expect(existsSync(join(f.root, "delivery-ledger.db-wal"))).toBe(false);
  expect(legacy.every(file => existsSync(file))).toBe(true);
  expect(ledger.pageSweepFailures).toBe(0);
});


it("W-TRAFFIC-FOLD: ordinary fresh and retired ledgers fold without Signal sweeps", async () => {
  const f = setup(), store = new LedgerStore(f.options.file);
  try {
    const state = { version: 1 as const, bindingKey: "binding", recipient: "owner", records: [], tombstones: [] };
    for (const legacy of [null, "removed"] as const) {
      store.commit(state, { legacy, sha: null, by: null });
      const wal = join(f.root, "delivery-ledger.db-wal");
      expect(readFileSync(wal).length).toBeGreaterThan(0);
      await expect.poll(() => readFileSync(wal).length, { timeout: 1000 }).toBe(0);
    }
  } finally { await store.release(); }
});

it("W-LAST-CLOSE: the serving connection is never the last connection folding a large WAL", async () => {
  const f = setup(), store = new LedgerStore(f.options.file), db = (store as unknown as { db: DatabaseSync }).db;
  db.exec("CREATE TABLE close_receipt (body BLOB); INSERT INTO close_receipt VALUES (zeroblob(33554432))");
  const wal = join(f.root, "delivery-ledger.db-wal");
  let closed = false, bytesAfterMainClose = 0;
  const close = db.close.bind(db);
  vi.spyOn(db, "close").mockImplementation(() => { close(); closed = true; bytesAfterMainClose = existsSync(wal) ? readFileSync(wal).length : 0; });
  const closing = store.release();
  try { expect(closed).toBe(false); } finally { await closing; }
  expect(closed).toBe(true);
  expect(bytesAfterMainClose).toBeGreaterThan(32 * 1024 * 1024);
  expect(existsSync(wal)).toBe(false);
});

it("W-FOLD-REVISION: a second ledger writing after a fold gets a new fold before retirement", async () => {
  const f = setup(), files = migrate(f), store = new LedgerStore(f.options.file), other = new LedgerStore(join(f.root, "other.json"));
  const original = checkpoint.checkpointFile;
  let retiring: ReturnType<LedgerStore["retire"]> | undefined;
  const state = store.load(20000, { migrate: false })!.state;
  const spy = vi.spyOn(checkpoint, "checkpointFile").mockImplementationOnce(async (...args) => {
    const folded = await original(...args);
    store.commit(state);
    retiring = store.retire(20000, state, "later-owner", f.options.now());
    return folded;
  });
  try {
    expect(await other.checkpoint()).toBe(true);
    expect((await retiring)!.removed).toBe(files.length);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(readFileSync(join(f.root, "delivery-ledger.db-wal")).includes(Buffer.from('"prompt":"p"'))).toBe(false);
  } finally { await Promise.all([store.release(), other.release()]); }
});

it("W-RETIRE-AWAIT: legacy bytes stay until a successful fold and redacted bytes are absent after retirement", async () => {
  const f = setup(), files = migrate(f), store = new LedgerStore(f.options.file);
  const state = store.load(20000, { migrate: false })!.state;
  const secret = "receipt-content-to-remove";
  store.commit({ ...state, records: [{ ...state.records[0], prompt: secret, response: secret }] });
  store.commit({ ...state, records: [] });
  let resume!: () => void;
  const wait = new Promise<void>(resolve => { resume = resolve; });
  const original = checkpoint.checkpointFile;
  vi.spyOn(checkpoint, "checkpointFile").mockImplementationOnce(async (...args) => { await wait; return original(...args); });
  let finished = false;
  const retiring = store.retire(20000, { ...state, records: [] }, "later-owner", f.options.now()).then(result => { finished = true; return result; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(finished).toBe(false);
    expect(files.every(file => existsSync(file))).toBe(true);
    resume();
    expect((await retiring).removed).toBe(files.length);
    for (const file of [join(f.root, "delivery-ledger.db"), join(f.root, "delivery-ledger.db-wal")]) expect(readFileSync(file).includes(Buffer.from(secret))).toBe(false);
  } finally { resume(); await retiring; await store.release(); }
});


it("W-FOLD-INTAKE: concurrent receipt commits stay within 200 ms during a slow large fold, with no BUSY or lost receipt", async () => {
  const f = setup(), store = new LedgerStore(f.options.file), db = (store as unknown as { db: DatabaseSync }).db;
  db.exec("CREATE TABLE intake_receipt (body BLOB); INSERT INTO intake_receipt VALUES (zeroblob(33554432))");
  let committed = 0, elapsed = 0;
  const errors: string[] = [];
  workerProbe.rewrite = source => String(source).replace("let folded = false;", "let folded = false; let firstCopy = true;")
        .replace(/db\.prepare\('PRAGMA wal_checkpoint\((PASSIVE|TRUNCATE)\)'\)\.get\(\)/g, (query, mode: string) => `(() => {
          if (firstCopy) {
            firstCopy = false;
            if ('${mode}' === 'TRUNCATE') db.exec('BEGIN IMMEDIATE');
            parentPort.postMessage('copying');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
            if ('${mode}' === 'TRUNCATE') db.exec('COMMIT');
          }
          if ('${mode}' === 'TRUNCATE' && typeof gate !== 'undefined' && Atomics.load(gate, 0) !== token) throw new Error('reset without writer reservation');
          return ${query};
        })()`)
        .replace("db.close()", "(() => { if (Atomics.load(gate, 0) !== token) throw new Error('close without writer reservation'); db.close(); })()");
  workerProbe.observe = worker => {
      worker.on("error", error => { errors.push(String(error)); });
      worker.on("message", message => {
        if (message !== "copying" || committed) return;
        const started = performance.now();
        store.commit({ version: 1, bindingKey: "binding", recipient: "owner", tombstones: [], records: [
          { deliveryId: "during-fold", prompt: "fixture", occurredAt: 1, state: "accepted", attempts: 0 }] });
        elapsed = Math.max(elapsed, performance.now() - started); committed++;
      });
  };
  try {
    const folded = await store.checkpoint();
    expect(errors).toEqual([]);
    expect(folded).toBe(true);
    expect(committed).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(200);
    expect(committedLedgerRecords(f.options.file)).toMatchObject([{ deliveryId: "during-fold" }]);
  } finally { workerProbe.rewrite = undefined; workerProbe.observe = undefined; await store.release(); }
});

it("W-SWEEP-REVISION: a redaction during an older sweep gets its own privacy fold", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const f = setup(), store = new LedgerStore(f.options.file), secret = "second-receipt-content-to-remove";
  store.commit({ version: 1, bindingKey: "binding", recipient: "owner", tombstones: [], records: [
    { deliveryId: "first", prompt: "first-content", occurredAt: f.options.now(), state: "uncertain", attempts: 1 },
    { deliveryId: "second", prompt: secret, occurredAt: f.options.now(), state: "uncertain", attempts: 1 }] });
  const ledger = new DurableDelivery(f.options);
  let releaseRetirement!: () => void, folded!: () => void;
  const retirement = new Promise<void>(resolve => { releaseRetirement = resolve; });
  const firstFold = new Promise<void>(resolve => { folded = resolve; });
  vi.spyOn(LedgerStore.prototype, "retire").mockImplementationOnce(async () => { await retirement; return { removed: 0, failed: 0, more: false }; });
  const checkpoint = LedgerStore.prototype.checkpoint;
  const spy = vi.spyOn(LedgerStore.prototype, "checkpoint").mockImplementationOnce(async function (this: LedgerStore) {
    const result = await checkpoint.call(this); folded(); return result;
  });
  try {
    ledger.redact("first");
    await firstFold;
    expect(readFileSync(join(f.root, "delivery-ledger.db-wal")).length).toBe(0);
    ledger.redact("second");
    const later = ledger.sweepPages();
    releaseRetirement();
    await later;
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const path of [join(f.root, "delivery-ledger.db"), join(f.root, "delivery-ledger.db-wal")]) expect(readFileSync(path).includes(Buffer.from(secret))).toBe(false);
  } finally { releaseRetirement(); await ledger.stop(); await store.release(); vi.useRealTimers(); }
});

it("W-CLOSE-REOPEN: the last release joins a pin cancelled by a competing lease", async () => {
  const f = setup(), first = new LedgerStore(f.options.file);
  let second!: LedgerStore, later: Promise<void> | undefined, observed = false;
  workerProbe.observe = worker => worker.on("message", message => {
    if (message === "ready" && !observed) {
      observed = true;
      queueMicrotask(() => { later = second.release(); });
    }
  });
  const closing = first.release(); second = new LedgerStore(f.options.file);
  try {
    await closing;
    await later;
    expect(observed).toBe(true);
    expect(existsSync(join(f.root, "delivery-ledger.db-wal"))).toBe(false);
    expect(() => (second as unknown as { db: DatabaseSync }).db.prepare("SELECT 1")).toThrow();
  } finally { workerProbe.observe = undefined; await second.release(); }
});


it("W-EXPORT-CLOSE: downgrade preservation joins receipt connections before moving custody", async () => {
  const f = setup(), dir = join(f.root, "channels", "adapter");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "chat.json"), store = new LedgerStore(file);
  store.commit({ version: 1, bindingKey: "binding", recipient: "owner", tombstones: [], records: [
    { deliveryId: "saved", prompt: "fixture", occurredAt: 1, state: "uncertain", attempts: 1 }] });
  await store.release();
  let done = false;
  const exporting = Promise.resolve(exportChannelLedgersForDowngrade(f.root)).then(count => { done = true; return count; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(done).toBe(false);
    expect(await exporting).toBe(1);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(join(dir, "delivery-ledger.db-wal"))).toBe(false);
  } finally { await exporting; }
});


it("W-CLOSE-PIN-FAILURE: a failed worker pin keeps custody pending until an off-thread close succeeds", async () => {
  const f = setup(), store = new LedgerStore(f.options.file);
  let fail = true, done = false;
  workerProbe.rewrite = source => { if (fail) { fail = false; throw new Error("worker unavailable"); } return source; };
  const closing = store.release().then(() => { done = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(done).toBe(false);
    expect(existsSync(join(f.root, "delivery-ledger.db-wal"))).toBe(true);
    await closing;
    expect(done).toBe(true);
    expect(existsSync(join(f.root, "delivery-ledger.db-wal"))).toBe(false);
  } finally { workerProbe.rewrite = undefined; await closing; }
});

it("W-WRITER-RESET: an unavailable reset reservation never admits a conflicting write or waits beyond 200 ms", async () => {
  const f = setup(), store = new LedgerStore(f.options.file);
  const state = { version: 1 as const, bindingKey: "binding", recipient: "owner", records: [], tombstones: [] };
  store.commit(state);
  const gate = (store as unknown as { handle: { coordination: { gate: Int32Array } } }).handle.coordination.gate;
  Atomics.store(gate, 0, -99);
  try {
    const started = performance.now();
    expect(() => store.commit({ ...state, recipient: "other" })).toThrow();
    expect(performance.now() - started).toBeLessThan(200);
    expect(store.row()!.recipient).toBe("owner");
  } finally { Atomics.store(gate, 0, 0); Atomics.notify(gate, 0); await store.release(); }
});


it("W-PERIODIC-IDLE: ordinary maintenance keeps the existing adapter idle promise false until its worker exits", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const f = setup(), ledger = new DurableDelivery(f.options);
  try {
    ledger.accept({ deliveryId: "ordinary", prompt: "fixture", occurredAt: f.options.now() });
    vi.advanceTimersByTime(250);
    expect(ledger.maintenancePending).toBe(true);
  } finally { await ledger.stop(); vi.useRealTimers(); }
  expect(ledger.maintenancePending).toBe(false);
});
