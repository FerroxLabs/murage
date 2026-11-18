// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner-delete producer and regression consumer: c3-memory. Native admission owner: scperf-p1.
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { BG_MINUTE_BYTES, OWNER_DELETE_IDLE_BYTES_PER_MINUTE, ioBudget } from "../io-budget.ts";
import { REVOKE_WRITE_BUDGET } from "./revoke-budget.ts";
import { checkpointCeiling, commitCeiling, ioMeterPageSize } from "../io-meter.ts";
import { stopSearchIndex } from "../message-search-index.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { META_ENVELOPE_FRAMES } from "./index-wal.ts";
import { setMemoryMode } from "./repository.ts";
import { put } from "./testing/open-index.ts";
import { MemoryWorkerController } from "./worker-controller.ts";

const workerState = vi.hoisted(() => ({ pending: true, locked: false, attempts: [] as number[], grantWait: false, grantThrow: false, factory: null as null | (() => unknown) }));
vi.mock("./embeddings.ts", () => ({ MemoryEmbeddings: class { identity = "fixture"; embed() { return Promise.resolve([]); } } }));
vi.mock("./eligibility.ts", () => ({ MemoryEligibility: class { pipRecordIds() { return []; } warm() {} close() {} } }));
vi.mock("./index.ts", async original => ({ ...await original<typeof import("./index.ts")>(), MemoryIndex: { async create() {
  if (workerState.factory) return workerState.factory();
  const admission = await import("./helper-admission.ts");
  const { BgDeferred } = await import("../bg-admission.ts");
  return {
    rebuilt: false, resetDone() { return null; }, stopInfo() { return null; }, prepareModel() {},
    deletionScrubPending() { return workerState.pending; },
    get scrubBlocked() { return workerState.locked || workerState.grantWait; },
    scrubDeleted() {
      workerState.attempts.push(Date.now());
      // A write refused admission throws BG_DEFERRED with the controller's retry time.
      if (workerState.grantThrow && !admission.helperHasGrant(4096)) throw new BgDeferred(60_000);
      // Checkpoint admission returns false rather than throwing BG_DEFERRED.
      if (workerState.grantWait && !admission.helperHasGrant(4096)) return false;
      if (workerState.locked) return false;
      workerState.pending = false; return true;
    },
    maintenanceOwed() { return false; }, purgeRecords() {}, close() {},
  };
} } }));

class Child extends EventEmitter {
  send = vi.fn((_message: unknown) => true); connected = true;
  kill() { this.emit("exit", 0); return true; }
  disconnect() { this.emit("exit", 0); }
}
type Controller = { child: Child | null; ready: boolean; scrubOwed: boolean; onWorkerMessage(child: Child, message: unknown): void };
type Ticket = { id: string; bytes: number; expiresAt:number; cls: string; stepBytes?: number };
let controller: MemoryWorkerController | undefined;
const realRead = Reflect.get(ioBudget, "read");
// The train reads admission through its own fast process floor (io-budget.ts admissionRead); the fixture pins both readings.
const realAdmissionRead = Reflect.get(ioBudget, "admissionRead");
const minimum = () => { const p = ioMeterPageSize(); return commitCeiling(META_ENVELOPE_FRAMES + 32, 4096, p) + checkpointCeiling(META_ENVELOPE_FRAMES + 32, 4096, p) + 4 * p; };

beforeEach(async () => {
  closeDatabase(); await stopWalMaintenance(); await stopSearchIndex();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture");
  Reflect.set(ioBudget, "read", () => ({ at: 0, fsWriteBlocks: 0, cpuMicros: 0 }));
  Reflect.set(ioBudget, "admissionRead", () => ({ at: 0, fsWriteBlocks: 0, cpuMicros: 0 }));
  ioBudget.setIsIdle(() => false); ioBudget.resetAdmissionForFixture();
  workerState.pending = true; workerState.locked = false; workerState.grantWait = false; workerState.grantThrow = false; workerState.factory = null; workerState.attempts.length = 0;
});
afterEach(async () => {
  vi.unstubAllGlobals(); vi.useRealTimers();
  await controller?.stop(); controller = undefined;
  (await import("./helper-admission.ts")).configureHelperAdmission(undefined);
  vi.restoreAllMocks(); closeDatabase(); await stopWalMaintenance(); await stopSearchIndex();
  Reflect.set(ioBudget, "read", realRead); Reflect.set(ioBudget, "admissionRead", realAdmissionRead); ioBudget.setIsIdle(() => false); ioBudget.resetAdmissionForFixture();
  vi.resetModules();
});

function standIn() {
  controller = new MemoryWorkerController({ startHoldMs: 0 });
  const internal = controller as unknown as Controller, child = new Child();
  internal.child = child; internal.ready = true; internal.scrubOwed = true;
  const offer = (purpose: string, ceiling = 11 * 1024 * 1024) => {
    internal.onWorkerMessage(child, { type: "bg-grant-request", purpose, ceiling, replan: true });
    return (child.send.mock.calls.at(-1)![0] as { ticket: Ticket | null }).ticket;
  };
  const settle = (ticket: Pick<Ticket,'id'>) => internal.onWorkerMessage(child, { type: "bg-grant-settle", id: ticket.id, used: 0 });
  return { offer, settle };
}

it.each(["off", "paused"] as const)("memory %s: owner debt is admitted with the BG pool full; BG remains refused", mode => {
  setMemoryMode(mode);
  const full = ioBudget.admit("BG", BG_MINUTE_BYTES)!; expect(full).not.toBeNull(); ioBudget.settle(full, full.bytes);
  const { offer, settle } = standIn();
  const owner = offer("owner-delete");
  expect(owner).not.toBeNull(); expect(owner!.cls).toBe("FGCOPY");
  expect(offer("bg")).toBeNull(); settle(owner!);
});

it("production idle: the native minimum cannot fit and owner debt awaits the owner ruling", () => {
  ioBudget.setIsIdle(() => true);
  const { offer } = standIn();
  const room = Reflect.get(ioBudget, "copyRoom");
  expect(room).toBeTypeOf("function");
  const before = (room as () => number).call(ioBudget);
  expect(before).toBe(1024 * 1024 - 65536);
  // MAIN RULING 1114-C3-MEMORY-REV1 (MAIN addendum 2): idle progress = 0 pending SEAN.
  expect(before).toBeLessThan(minimum());
  expect(offer("owner-delete")).toBeNull();
  expect(offer("bg")).toBeNull();
});

async function worker() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const listeners = new Map<string, (m: unknown) => unknown>(), sent: Array<{ type: string }> = [];
  const realProcess = process, childProcess = Object.create(realProcess) as NodeJS.Process;
  Object.defineProperties(childProcess, {
    on: { value: (event: string, listener: (m: unknown) => unknown) => { listeners.set(event, listener); return childProcess; } },
    send: { value: (message: { type: string }, cb?: (e: Error | null) => void) => { sent.push(message); cb?.(null); return true; } },
    resourceUsage: { value: () => realProcess.resourceUsage() },
  });
  vi.stubGlobal("process", childProcess);
  await import("./worker.ts");
  const emit = listeners.get("message")!;
  await emit({ type: "init", indexPath: "/fixture/index", authorityPath: "/fixture/authority", modelDirectory: "/fixture/model", manifest: { model: "fixture", revision: "1", dimensions: 1, files: [] } });
  return { emit, sent };
}

it("truncate reader wait: existing backoff is preserved and release reaches CLEAN within one interval", async () => {
  const { index, path, wal } = await realIndex();
  await debt(index, "truncate");
  const reader = new DatabaseSync(path, { readOnly: true });
  reader.exec("BEGIN"); reader.prepare("SELECT value FROM index_meta LIMIT 1").get();
  const scrub = index.scrubDeleted.bind(index);
  vi.spyOn(index, "scrubDeleted").mockImplementation(() => { workerState.attempts.push(Date.now()); return scrub(); });
  workerState.factory = () => index;
  let readerOpen = true;
  try {
    const { sent } = await worker();
    (await import("./helper-admission.ts")).configureHelperAdmission(undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    const gaps = workerState.attempts.slice(1).map((at, n) => at - workerState.attempts[n]!);
    // MAIN RULING 1114-C3-MEMORY-REV1 (Revision 1 R3): blocked reader retries keep the existing backoff.
    expect(gaps).toEqual([1000, 2000, 4000]);
    reader.close(); readerOpen = false;
    await vi.advanceTimersByTimeAsync(8000);
    expect(index.deletionScrubPending()).toBe(false); expect(sent.some(m => m.type === "scrub-done")).toBe(true);
    const read = new DatabaseSync(path, { readOnly: true });
    try { expect(read.prepare("SELECT value FROM index_meta WHERE key='delete_scrub_merges'").get()?.value).toBe("3"); } finally { read.close(); }
  } finally {
    if (readerOpen) reader.close();
    vi.clearAllTimers(); await index.prepareExit(); index.close(); delete wal.walTestHooks.exit;
  }
});

it("grant wake: null then a ticket wakes a checkpoint wait within the 50 ms scrub gap", async () => {
  workerState.grantWait = true;
  const { emit, sent } = await worker();
  await vi.advanceTimersByTimeAsync(0);
  expect(sent.some(m => m.type === "bg-grant-request")).toBe(true);
  await emit({ type: "bg-grant", ticket: null, retryInMs: 60_000 });
  await vi.advanceTimersByTimeAsync(100);
  const count = workerState.attempts.length;
  const timer = vi.spyOn(globalThis, "setTimeout");
  await emit({ type: "bg-grant", ticket: { id: "owner-permit", bytes: 4096, expiresAt: Date.now() + 60_000 } });
  await vi.advanceTimersByTimeAsync(50);
  expect(workerState.attempts.length).toBeGreaterThan(count);
  expect(workerState.pending).toBe(false);
  expect(timer.mock.calls.every(([, delay]) => Number(delay) <= 1000)).toBe(true);
});

it("grant wake: a ticket arriving during a deferred admission wait wakes the scrub at once, not at the refused retry time", async () => {
  workerState.grantThrow = true;
  const { emit, sent } = await worker();
  await vi.advanceTimersByTimeAsync(0);
  expect(sent.some(m => m.type === "bg-grant-request")).toBe(true);
  await emit({ type: "bg-grant", ticket: null, retryInMs: 60_000 });
  await vi.advanceTimersByTimeAsync(200);
  const count = workerState.attempts.length;
  await emit({ type: "bg-grant", ticket: { id: "owner-permit", bytes: 4096, expiresAt: Date.now() + 60_000 } });
  await vi.advanceTimersByTimeAsync(100);
  expect(workerState.attempts.length).toBeGreaterThan(count);
  expect(workerState.pending).toBe(false);
});

it("no laundering: restoring BG settles the owner ticket before any BG write", async () => {
  const admission = await import("./helper-admission.ts");
  const purpose = Reflect.get(admission, "setAdmissionPurpose") as (p: "bg" | "owner-delete") => () => void;
  expect(purpose).toBeTypeOf("function");
  const requests: unknown[] = [], settled: string[] = [];
  admission.configureHelperAdmission({
    request: (ceiling, _replan, ...extra: unknown[]) => {
      requests.push(extra[0]);
      admission.acceptHelperTicket({ id: `permit-${requests.length}`, bytes: ceiling, expiresAt: Date.now() + 60_000 });
    },
    settle: ticket => { settled.push(ticket.id); },
  });
  const restore = purpose("owner-delete");
  try { admission.withHelperGrant(4096, () => {}); } finally { restore(); }
  expect(settled).toContain("permit-1");
  admission.withHelperGrant(4096, () => {});
  expect(requests).toEqual(["owner-delete", "bg"]);
});

it("no laundering: a real scrub step returns its owner ticket before the following SQLite write", async () => {
  const { index, wal } = await realIndex();
  await debt(index, "merge");
  const admission = await import("./helper-admission.ts"), requests: unknown[] = [], settled: string[] = [];
  admission.configureHelperAdmission({
    request: (_ceiling, _replan, ...extra: unknown[]) => {
      requests.push(extra[0]);
      admission.acceptHelperTicket({ id: `scrub-permit-${requests.length}`, bytes: 11 * 1024 * 1024, expiresAt: Date.now() + 60_000 });
    },
    settle: ticket => { settled.push(ticket.id); },
  });
  try {
    await index.scrubDeleted();
    expect(settled).toContain("scrub-permit-1");
    const db = Reflect.get(index, "db") as DatabaseSync;
    admission.withHelperGrant(1024 * 1024, () => db.prepare("INSERT OR REPLACE INTO index_meta VALUES('delete_scrub_completed','0')").run(), db);
    expect(requests).toEqual(["owner-delete", "bg"]);
  } finally { admission.configureHelperAdmission(undefined); index.close(); delete wal.walTestHooks.exit; }
});

async function realIndex() {
  const actual = await vi.importActual<typeof import("./index.ts")>("./index.ts");
  const wal = await import("./index-wal.ts");
  wal.walTestHooks.exit = code => { throw new Error(`FIXTURE_EXIT_${code}`); };
  const path = join(DATA_DIR, "scrub-index.db");
  const index = await actual.MemoryIndex.create(path, { charge: async () => true });
  return { actual, wal, path, index };
}

async function debt(index: import("./index.ts").MemoryIndex, phase: "merge" | "truncate") {
  const db = Reflect.get(index, "db") as DatabaseSync;
  const writer = Reflect.get(index, "writer") as { write(kind: "merge", reserve: number, body: () => void): void; check(): Promise<void> };
  writer.write("merge", 12 * 1024 * 1024, () => {
    for (const [key, value] of [["delete_scrub_owed", phase], ["delete_scrub_merge", JSON.stringify({ generation: 1, table: "lexical", started: true })], ["delete_scrub_target", "1"], ["delete_scrub_merges", "3"]]) {
      db.prepare("INSERT OR REPLACE INTO index_meta VALUES(?,?)").run(key!, value!);
    }
  });
  await writer.check();
}

it("restart mid-merge: the first resumed merge is positive and does not increment the merge count", async () => {
  const { actual, wal, path, index } = await realIndex();
  await index.prepareExit(); index.close();
  const fixture = new DatabaseSync(path);
  fixture.prepare("INSERT OR REPLACE INTO index_meta VALUES(?,?)").run("delete_scrub_owed", "merge");
  fixture.prepare("INSERT OR REPLACE INTO index_meta VALUES(?,?)").run("delete_scrub_merge", JSON.stringify({ generation: 1, table: "lexical", started: true }));
  fixture.prepare("INSERT OR REPLACE INTO index_meta VALUES(?,?)").run("delete_scrub_target", "1");
  fixture.prepare("INSERT OR REPLACE INTO index_meta VALUES(?,?)").run("delete_scrub_merges", "3"); fixture.close();
  const ranks: number[] = [], prepare = DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    if (/INSERT INTO lexical\(lexical,rank\) VALUES\('merge',\?\)/.test(sql)) {
      const run = statement.run;
      vi.spyOn(statement, "run").mockImplementation((...args: Parameters<typeof run>) => { ranks.push(Number(args[0])); return run.apply(statement, args); });
    }
    return statement;
  });
  const reopened = await actual.MemoryIndex.create(path, { charge: async () => true });
  try {
    await reopened.scrubDeleted();
    expect(ranks.length).toBeGreaterThan(0); expect(ranks[0]).toBeGreaterThan(0);
    const db = new DatabaseSync(path, { readOnly: true });
    try { expect(db.prepare("SELECT value FROM index_meta WHERE key='delete_scrub_merges'").get()?.value).toBe("3"); } finally { db.close(); }
  } finally { delete wal.walTestHooks.exit; await reopened.prepareExit(); reopened.close(); }
});

it.each(["after-commit", "before-truncate-result"])("crash at %s: durable scrub state resumes without another merge", async point => {
  const { actual, wal, path, index } = await realIndex();
  await debt(index, point === "after-commit" ? "merge" : "truncate");
  let injected = false;
  wal.walTestHooks.point = name => { if (name === point) { injected = true; throw new Error("FIXTURE_CRASH"); } };
  try { await expect(index.scrubDeleted()).rejects.toThrow("FIXTURE_CRASH"); expect(injected).toBe(true); }
  finally { delete wal.walTestHooks.point; index.close(); }
  const reopened = await actual.MemoryIndex.create(path, { charge: async () => true });
  try {
    for (let n = 0; n < 20 && reopened.deletionScrubPending(); n++) await reopened.scrubDeleted();
    expect(reopened.deletionScrubPending()).toBe(false);
    const read = new DatabaseSync(path, { readOnly: true });
    try { expect(read.prepare("SELECT value FROM index_meta WHERE key='delete_scrub_merges'").get()?.value).toBe("3"); } finally { read.close(); }
  } finally { delete wal.walTestHooks.exit; await reopened.prepareExit(); reopened.close(); }
});


it("truncate cleanup: one ticket covers the seal and metadata cleanup in one pass", async () => {
  const { index, wal } = await realIndex();
  await debt(index, "truncate");
  const admission = await import("./helper-admission.ts");
  const requests: number[] = [];
  // Enough for the real checkpoint and meta envelope, smaller than a merge cleanup.
  const bytes = minimum() + 1024 * 1024;
  admission.configureHelperAdmission({
    request: ceiling => {
      requests.push(ceiling);
      if (requests.length === 1) admission.acceptHelperTicket({ id: "cleanup-permit", bytes, expiresAt: Date.now() + 60_000 });
    },
    settle() {},
  });
  try {
    expect(await index.scrubDeleted()).toBe(true);
    expect(index.deletionScrubPending()).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toBeLessThanOrEqual(bytes);
  } finally { admission.configureHelperAdmission(undefined); index.close(); delete wal.walTestHooks.exit; }
});


it("no laundering: a late owner reply cannot satisfy a BG request", async () => {
  const admission = await import("./helper-admission.ts");
  const requests: string[] = [], settled: string[] = [];
  admission.configureHelperAdmission({
    request: (_ceiling, _replan, purpose) => { requests.push(purpose); },
    settle: ticket => { settled.push(ticket.id); },
  });
  const restore = admission.setAdmissionPurpose("owner-delete");
  try { expect(admission.helperHasGrant(4096)).toBe(false); } finally { restore(); }
  admission.acceptHelperTicket({ id: "late-owner", bytes: 4096, expiresAt: Date.now() + 60_000 });
  expect(admission.helperHasGrant(4096)).toBe(false);
  expect(settled).toEqual(["late-owner"]);
  expect(requests).toEqual(["owner-delete", "bg"]);
  admission.acceptHelperTicket({ id: "bg-reply", bytes: 4096, expiresAt: Date.now() + 60_000 });
  expect(admission.helperHasGrant(4096)).toBe(true);
});


it("an asynchronous owner reply remains usable by the resumed owner step", async () => {
  const admission = await import("./helper-admission.ts");
  const requests: string[] = [], settled: string[] = [];
  admission.configureHelperAdmission({
    request: (_ceiling, _replan, purpose) => { requests.push(purpose); },
    settle: ticket => { settled.push(ticket.id); },
  });
  let restore = admission.setAdmissionPurpose("owner-delete");
  try { expect(admission.helperHasGrant(4096)).toBe(false); } finally { restore(); }
  admission.acceptHelperTicket({ id: "owner-reply", bytes: 4096, expiresAt: Date.now() + 60_000 });
  restore = admission.setAdmissionPurpose("owner-delete");
  try { expect(admission.helperHasGrant(4096)).toBe(true); } finally { restore(); }
  expect(requests).toEqual(["owner-delete"]);
  expect(settled).toEqual(["owner-reply"]);
});

it("truncate generation: an expired seal ticket reaches CLEAN within three passes without resealing", async () => {
  const { index, wal } = await realIndex();
  await debt(index, "truncate");
  vi.useFakeTimers({ toFake: ["Date"] });
  const admission = await import("./helper-admission.ts");
  const writer = Reflect.get(index, "writer") as import("./index-wal.ts").IndexWalWriter;
  const seal = writer.sealAndTruncate.bind(writer), requests: number[] = [], used: number[] = [];
  let pending = 0, oldSealNeed = 0;
  const seals = vi.spyOn(writer, "sealAndTruncate").mockImplementation(async () => {
    oldSealNeed = checkpointCeiling(Math.ceil(writer.indexDebtBytes() / writer.pageSize), writer.pageSize, ioMeterPageSize()) + 4 * ioMeterPageSize();
    const result = await seal();
    // Stand-in seal timing: its real writes exceed the old estimate and the ticket expires before cleanup.
    if (result.truncated) vi.setSystemTime(Date.now() + 60_001);
    return result;
  });
  admission.configureHelperAdmission({
    request: ceiling => { requests.push(ceiling); pending = ceiling; },
    settle: (_ticket, bytes) => { used.push(bytes); },
  });
  try {
    for (let pass = 0; pass < 3 && index.deletionScrubPending(); pass++) {
      try { await index.scrubDeleted(); } catch (error) { expect((await import("../bg-admission.ts")).isBgDeferred(error)).toBe(true); }
      if (pending) {
        admission.acceptHelperTicket({ id: `truncate-pass-${pass}`, bytes: pending, expiresAt: Date.now() + 60_000, purpose: "owner-delete" });
        pending = 0;
      }
    }
    expect(index.deletionScrubPending()).toBe(false);
    expect(seals).toHaveBeenCalledTimes(1);
    expect(used.some(bytes => bytes > oldSealNeed)).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBeGreaterThan(requests[1]!);
    expect(requests[1]).toBe(minimum());
  } finally { admission.configureHelperAdmission(undefined); index.close(); delete wal.walTestHooks.exit; }
});

// SEAN 1114-MEM-DELETE-IDLE-WINDOW (REDESIGN-C3-MEMORY Revision 2 step 4): after an owner forget the physical erase counts as non-idle
// work until CLEAN or 60 minutes, paced at 20 MiB a minute. A very large index can outlast the window; it then continues at the next
// forget, the next boot, or whenever the app is active.
type Windowed = { openOwnerDeleteWindow(): void; ownerDeleteWindowOpen(): boolean };
function idleWindow() {
  ioBudget.setIsIdle(() => true);
  const made = standIn();
  (controller as unknown as Windowed).openOwnerDeleteWindow();
  return made;
}
it("idle window: an owner-delete request is admitted at idle while the window is open", () => {
  const { offer, settle } = idleWindow();
  const owner = offer("owner-delete");
  expect(owner).not.toBeNull(); expect(owner!.cls).toBe("FGCOPY"); expect(owner!.bytes).toBeGreaterThanOrEqual(minimum());
  settle(owner!);
});
it("idle window: a BG request in the same tick is still refused", () => {
  const { offer, settle } = idleWindow();
  const owner = offer("owner-delete");
  expect(owner).not.toBeNull();
  expect(offer("bg")).toBeNull();
  expect(ioBudget.admit("BG", 4096)).toBeNull();
  settle(owner!);
  expect(offer("bg")).toBeNull();
});
it("idle window: it closes 60 minutes after opening and at CLEAN, and only a new opening restores it", () => {
  const { offer, settle } = idleWindow();
  const internal = controller as unknown as Controller & Windowed, child = internal.child!;
  const opened = Date.now(), clock = vi.spyOn(Date, "now");
  clock.mockReturnValue(opened + 60 * 60_000 - 5_000);
  const inside = offer("owner-delete");
  expect(inside).not.toBeNull(); settle(inside!);
  clock.mockReturnValue(opened + 60 * 60_000 + 5_000);
  expect(internal.ownerDeleteWindowOpen()).toBe(false);
  expect(offer("owner-delete")).toBeNull();
  internal.openOwnerDeleteWindow();
  const again = offer("owner-delete");
  expect(again).not.toBeNull(); settle(again!);
  internal.onWorkerMessage(child, { type: "scrub-done" });
  expect(internal.ownerDeleteWindowOpen()).toBe(false);
  expect(offer("owner-delete")).toBeNull();
});
it("idle window: settled owner-delete bytes are held to 20 MiB a minute while the exemption is in use", () => {
  ioBudget.setIsIdle(() => true);
  expect(OWNER_DELETE_IDLE_BYTES_PER_MINUTE).toBe(REVOKE_WRITE_BUDGET.bytesPerMinute);
  const mib = 1024 * 1024;
  for (const bytes of [10 * mib, 10 * mib - 4096]) {
    const ticket = ioBudget.admit("FGCOPY", bytes, 0, { ownerDeletion: true });
    expect(ticket).not.toBeNull(); ioBudget.settle(ticket!, bytes);
  }
  expect(ioBudget.copyRoom(true)).toBe(4096);
  expect(ioBudget.admit("FGCOPY", 8192, 0, { ownerDeletion: true })).toBeNull();
  const last = ioBudget.admit("FGCOPY", 4096, 0, { ownerDeletion: true });
  expect(last).not.toBeNull();
  // A reservation counts until it settles; unused room comes back.
  expect(ioBudget.admit("FGCOPY", 4096, 0, { ownerDeletion: true })).toBeNull();
  ioBudget.settle(last!, 0);
  expect(ioBudget.copyRoom(true)).toBe(4096);
});
it("idle window: only purpose owner-delete on a foreground copy gets the exemption", async () => {
  const { offer } = idleWindow();
  expect(offer("bg")).toBeNull();
  expect(offer("revoke")).toBeNull();
  expect(offer("owner-delete-later")).toBeNull();
  expect(ioBudget.admit("BG", 4096, 0, { ownerDeletion: true })).toBeNull();
  expect(ioBudget.admit("FGCOPY", minimum())).toBeNull();
  // The helper carries the purpose only inside scrubDeleted and deletion-only batches: once restored it asks as BG again.
  const admission = await import("./helper-admission.ts");
  const restore = admission.setAdmissionPurpose("owner-delete");
  expect(admission.admissionPurpose()).toBe("owner-delete");
  restore();
  expect(admission.admissionPurpose()).toBe("bg");
});

it.each(['off','paused'] as const)('foreground memory %s: production scrub completes bounded owner deletion',async mode=>{
 const {index,path,wal}=await realIndex();
 const marker='OWNER_ERASE_CANARY_'.repeat(128);
 const erased={id:'erased',version:1,scopeId:'scope',text:marker,deleted:false};
 const retained={id:'retained',version:1,scopeId:'scope',text:'retained fixture words',deleted:false};
 try{
  await put(index,[erased,retained]);
  expect([path,path+'-wal'].some(file=>readFileSync(file).includes(Buffer.from(marker)))).toBe(true);
  await put(index,[{...erased,text:'',deleted:true}]);
  expect(index.deletionScrubPending()).toBe(true);
  const beforeScrub=new DatabaseSync(path,{readOnly:true});
  try{expect(Number(beforeScrub.prepare("SELECT value FROM index_meta WHERE key='delete_scrub_merges'").get()?.value??0)).toBe(0);}finally{beforeScrub.close();}
  setMemoryMode(mode);
  const {offer,settle}=standIn(),admission=await import('./helper-admission.ts');
  const grants:Ticket[]=[];
  admission.configureHelperAdmission({
   request:(ceiling,_replan,purpose)=>{
    const ticket=offer(purpose,ceiling);if(ticket)grants.push(ticket);
    admission.acceptHelperTicket(ticket);
   },settle:ticket=>settle(ticket),
  });
  let steps=0;
  for(;steps<20&&index.deletionScrubPending();steps++)await index.scrubDeleted();
  expect(steps).toBeGreaterThan(0);expect(steps).toBeLessThanOrEqual(20);
  expect(index.deletionScrubPending()).toBe(false);
  const check=new DatabaseSync(path,{readOnly:true});
  try{
   expect(check.prepare("SELECT text FROM entries WHERE id='retained'").get()?.text).toBe(retained.text);
   expect(check.prepare("SELECT text FROM entries WHERE id='erased'").all()).toEqual([]);
   expect(check.prepare("SELECT value FROM index_meta WHERE key='delete_scrub_completed'").get()?.value).toBe('1');
   expect(Number(check.prepare("SELECT value FROM index_meta WHERE key='delete_scrub_merges'").get()?.value??0)).toBeGreaterThan(0);
  }finally{check.close();}
  for(const file of [path,path+'-wal'])expect(readFileSync(file).includes(Buffer.from(marker))).toBe(false);
  expect(grants.length).toBeGreaterThan(0);expect(grants.every(ticket=>ticket.cls==='FGCOPY')).toBe(true);
 }finally{
  (await import('./helper-admission.ts')).configureHelperAdmission(undefined);
  await index.prepareExit();index.close();delete wal.walTestHooks.exit;
 }
});
