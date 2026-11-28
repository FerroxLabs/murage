// SPDX-License-Identifier: AGPL-3.0-or-later
// Witness owner: cause-idlecap-fable (1.0.21). Controller owner: scperf-p1 (worker-controller.ts); job store owner: memory (jobs.ts);
// idle allowance owner: scperf-p1 ledger (io-budget.ts); ruling owner: MAIN.
//
// MAIN-RULING 2026-11-22T19:35:00Z idle-relaunch: "no capture may wait on the owner returning. When deferred captures are pending and
// the owner is idle, the controller starts the memory worker itself, at most once per idle window and inside the idle allowance; the
// queue drains, then the worker idles again. Durable queue: a restart before the drain loses nothing." ("At most once" is refined by the
// 20:47:34Z idle-retry ruling, quoted at its rows below.)
// Every row enters through MemoryWorkerController.start() and its own timers, on the real job store, the real instrumented connection
// and the real ledger (native meter built below). Only the helper process is scripted: it speaks the helper's protocol (boot grant
// settle, an index-open grant request it waits on, capture results). The server stays idle unless a row says the owner returned.
import { EventEmitter } from "node:events";
import { execFileSync, fork } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { IO_BUDGET_IDLE_BYTES_PER_MINUTE, ioBudget } from "../io-budget.ts";
import { forgetExclusionAddon } from "../engine-exclusion.ts";
import { ioMeterTotal, resetIoMeterForTest } from "../io-meter.ts";
import { appendMessage } from "../message-db.ts";
import { stopSearchIndex } from "../message-search-index.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { setMemoryMode } from "./repository.ts";
import { MEMORY_IDLE_BOOT_BYTES, MEMORY_IDLE_DRAIN_EXIT_MS, MEMORY_IDLE_SWEEP_MS, MEMORY_WORKER_INIT_MS, MemoryWorkerController } from "./worker-controller.ts";
import { resetProcessLeaseOwnersForTests } from "./jobs.ts";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), fork: vi.fn() }));
const root = mkdtempSync(join(tmpdir(), "idle-relaunch-"));
const prior = process.env.MURAGE_ENGINE_EXCLUSION_PATH;
const IDLE_ALLOWANCE = IO_BUDGET_IDLE_BYTES_PER_MINUTE - 65536;
let at = 0;
const controllers: MemoryWorkerController[] = [];
const realRead = Reflect.get(ioBudget, "read") as () => unknown;
const realAdmissionRead = Reflect.get(ioBudget, "admissionRead") as () => unknown;
type Work = { id: string; leaseGeneration: number; totalBytes: number; text: string };
type Boot = { id: string; bytes: number };
/** The scripted helper. Its start follows the real helper's order: it settles the boot grant, asks one grant for its index open and
 * is initialised only when that grant is given. Each capture it is sent is held until the row answers it. */
/** idle-receipt-design-1123 rule 9: a helper that leaves on the controller's ask leaves as the real one does, its FINAL receipt first
 * (an exit with no final receipt accepted is not a planned end: it reads as unknown and counts as a failed start). */
const leaveFinal = (controller: MemoryWorkerController, helper: Helper) => {
  const generation = (Reflect.get(controller, "childIo") as { receipts: { generation: string } } | null)?.receipts.generation;
  helper.emit("message", { type: "io", ioProtocol: 1, generation, sequence: 1_000_000, fsWriteBlocks: 0, ioBytes: 0, known: true, final: true });
  helper.crash(0);
};
class Helper extends EventEmitter {
  works: Work[] = []; startedAt = Date.now(); sent: Array<{ type?: string }> = []; refusedGrants = 0; connected = true; stderr = null; generation: string | null = null;
  constructor(readonly boot: Boot | null) { super(); }
  send = vi.fn((message: { type?: string; id?: string; ticket?: { id: string } | null }) => {
    this.sent.push(message);
    if (message.type === "init") setTimeout(() => {
      if (this.boot) this.emit("message", { type: "bg-grant-settle", id: this.boot.id, used: 16_384 });
      this.emit("message", { type: "index-opening" }); if (!holdOpen) this.emit("message", { type: "bg-grant-request", ...openAsk });
    }, 0);
    else if (message.type === "bg-grant") setTimeout(() => {
      if (!message.ticket) { this.refusedGrants++; return; }
      this.emit("message", { type: "bg-grant-settle", id: message.ticket.id, used: 4096 }); this.emit("message", { type: "initialised" });
    }, 0);
    else if (typeof message.id === "string" && "leaseGeneration" in message) this.works.push(message as unknown as Work);
    return true;
  });
  answer(work: Work) {
    this.emit("message", { type: "result", result: { id: work.id, leaseGeneration: work.leaseGeneration, status: "complete", nextCursor: work.totalBytes,
      chunks: [{ text: work.text, startByte: 0, endByte: Buffer.byteLength(work.text) }] } });
  }
  kill() { this.crash(0); return true; } disconnect() { this.crash(0); }
  crash(code: number) { if (!this.connected) return; this.connected = false; this.emit("exit", code, null); }
}
const helpers: Helper[] = [];
/** What the scripted helper asks for its index open. The default is a small fixed grant; REAL_OPEN_ASK is the real helper's ask on a
 * new index (an adaptive grant of 11,517,952 bytes, measured with the real helper: no idle minute admits it). */
const SMALL_OPEN_ASK = { ceiling: 8192, purpose: "bg" }, REAL_OPEN_ASK = { ceiling: 11_517_952, purpose: "bg", replan: true };
let openAsk: Record<string, unknown> = SMALL_OPEN_ASK; /** true: the helper has not reached its index open yet (it asks no step until the row sends the ask) */ let holdOpen = false;
beforeAll(() => {
  const binary = join(root, "meter.node");
  execFileSync("cc", ["-std=c11", "-D_GNU_SOURCE", "-O2", "-Wall", "-Werror", "-fPIC", "-shared", "-DNAPI_VERSION=9", "-I", resolve(dirname(process.execPath), "../include/node"), "native/engine-exclusion/exclusion.c", "native/engine-exclusion/meter.c", "-o", binary], { stdio: "pipe" });
  process.env.MURAGE_ENGINE_EXCLUSION_PATH = binary; forgetExclusionAddon(); resetIoMeterForTest();
});
beforeEach(async () => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture");
  await stopWalMaintenance(); await stopSearchIndex();
  // the ledger's clock is the fixture's: 10 s into minute 0, clear of the minute's closing guard
  at = 10_000; const read = () => ({ at, fsWriteBlocks: 0, cpuMicros: 0 });
  Reflect.set(ioBudget, "read", read); Reflect.set(ioBudget, "admissionRead", read); ioBudget.resetAdmissionForFixture(); ioBudget.setIsIdle(() => false);
  helpers.length = 0; openAsk = SMALL_OPEN_ASK; holdOpen = false;
  vi.mocked(fork).mockReset().mockImplementation((...args: unknown[]) => {
    const raw = (args[2] as { env?: Record<string, string> } | undefined)?.env?.MURAGE_BG_BOOT;
    const helper = new Helper(raw ? JSON.parse(raw) as Boot : null); helpers.push(helper);
    helper.generation = (args[2] as { env?: Record<string, string> } | undefined)?.env?.MURAGE_IO_GENERATION ?? null;
    setTimeout(() => helper.emit("message", { type: "ready" }), 0); return helper as unknown as ReturnType<typeof fork>;
  });
});
afterEach(async () => { for (const c of controllers.splice(0)) await c.stop(); closeDatabase(); Reflect.set(ioBudget, "read", realRead); Reflect.set(ioBudget, "admissionRead", realAdmissionRead); ioBudget.setIsIdle(() => false); ioBudget.resetAdmissionForFixture(); });
afterAll(() => { if (prior === undefined) delete process.env.MURAGE_ENGINE_EXCLUSION_PATH; else process.env.MURAGE_ENGINE_EXCLUSION_PATH = prior; forgetExclusionAddon(); resetIoMeterForTest(); rmSync(root, { recursive: true, force: true }); });

const start = () => { const c = new MemoryWorkerController({ startHoldMs: 0 }); controllers.push(c); c.start(); return c; };
/** `n` owner messages, each with its capture job, written while no controller runs: the captures are owed and nothing has claimed them. */
function owe(n: number): string[] {
  for (let k = 0; k < n; k++) appendMessage("fixture-thread", { id: `fixture-message-${k}`, at: k + 1, role: "user", kind: "text", text: `Remember fixture preference ${k}.` });
  return (database().prepare("SELECT id FROM memory_jobs ORDER BY rowid").all() as Array<{ id: string }>).map(r => String(r.id));
}
const jobs = () => (database().prepare("SELECT id,status,attempts,lease_owner FROM memory_jobs ORDER BY rowid").all() as Array<{ id: string; status: string; attempts: number; lease_owner: string | null }>);
/** The capture's own stored records for the job's message (kind 'source'; a thread checkpoint derived from it is not counted). */
const evidence = (id: string) => Number((database().prepare("SELECT count(*) AS n FROM memory_evidence e JOIN memory_jobs j ON j.source_id=e.source_id JOIN memory_records r ON r.id=e.record_id AND r.version=e.record_version WHERE j.id=? AND r.kind='source'").get(id) as { n: number }).n);
const handed = (from = 0) => helpers.slice(from).flatMap(h => h.works.map(w => w.id));
const settle = (ms: number) => new Promise(done => setTimeout(done, ms));
/** Answers every capture the helpers from `from` on are sent, until all of `ids` are complete. */
async function drain(ids: string[], from = 0) {
  const answered = new Set<Work>();
  await vi.waitFor(() => {
    for (const h of helpers.slice(from)) for (const w of h.works) if (!answered.has(w)) { answered.add(w); h.answer(w); }
    expect(jobs().filter(j => ids.includes(j.id)).map(j => j.status), JSON.stringify({ jobs: jobs(), helpers: helpers.length, refused: helpers.map(h => h.refusedGrants), admission: ioBudget.admissionState() })).toEqual(ids.map(() => "complete"));
  }, { timeout: 15_000, interval: 25 });
}
// CHANGED-EXPECTATION (MAIN-RULING 2026-11-25T05:54:59Z idle DO LESS; MAIN-RULING 2026-11-25T06:57:58Z): the rows marked it.skip
// below pinned the helper START on an idle minute and the drain/end life of a helper the idle rule started. Idle now starts no helper
// and writes no capture (io-budget.ts idleQuiet), so that helper no longer exists; the replacement is the table-driven
// "CHANGED-EXPECTATION idle DO LESS" row at the end of this file (idle: no start, nothing written; active minute: the ordinary start lands
// every capture). Rows that do not need an idle start (no capture owed, memory paused, stop(), after FINAL) still run unchanged.

it.skip("idle relaunch: captures owed at an idle start land with no owner turn, by the one helper the controller starts on a boot grant inside the idle allowance", async () => {
  const ids = owe(3);
  ioBudget.setIsIdle(() => true);
  const controller = start();
  await drain(ids);
  expect(ioBudget.admissionIdle(), "the owner never returned: the server was idle throughout").toBe(true);
  expect(helpers.length, "one helper start in the idle window").toBe(1);
  expect(helpers[0]!.boot?.bytes, "the idle start's boot grant").toBe(MEMORY_IDLE_BOOT_BYTES);
  expect(MEMORY_IDLE_BOOT_BYTES, "the boot grant fits the idle allowance").toBeLessThanOrEqual(IDLE_ALLOWANCE);
  // the helper's index open was granted while idle, so it finished its start (it is not left to the init timeout)
  expect({ ready: Reflect.get(controller, "ready"), refusedGrants: helpers[0]!.refusedGrants }, "the idle-started helper finished its start").toEqual({ ready: true, refusedGrants: 0 });
  for (const id of ids) expect(evidence(id), "captured").toBeGreaterThan(0);
  expect(jobs().map(j => j.attempts), "no attempt was spent").toEqual([0, 0, 0]);
  expect(handed(), "each capture went to the helper once").toEqual(ids);
  expect(ioBudget.admissionState().reserved, "every grant of the idle start was settled: nothing stays reserved in the idle minute").toBe(0);
}, 30_000);

// CHANGED-EXPECTATION (MAIN-RULING 2026-11-25T05:54:59Z idle DO LESS, 06:57:58Z): was "the relaunched IDLE server finishes the queue";
// the relaunched server is idle and does nothing; the durability (none lost, none doubled) is asserted when the next active minute finishes it.
it("idle relaunch: a restart in the middle of the drain loses no capture and doubles none; the relaunched server does nothing while idle and finishes the queue on the next active minute", async () => {
  const ids = owe(3);
  // the first run drains with the owner present: one capture lands, the second is in the helper's hands when the server goes down
  const first = start();
  await vi.waitFor(() => expect(helpers[0]?.works.length).toBe(1), { timeout: 8_000, interval: 25 });
  helpers[0]!.answer(helpers[0]!.works[0]!);
  await vi.waitFor(() => expect(helpers[0]!.works.length).toBe(2), { timeout: 8_000, interval: 25 });
  expect(jobs().map(j => j.status), "mid-drain: one landed, one leased, one queued").toEqual(["complete", "leased", "pending"]);
  const once = evidence(ids[0]!);
  expect(once, "the first capture landed before the restart").toBeGreaterThan(0);
  // the restart: a new process (its own lease-owner record, a fresh ledger in a later minute), idle as every relaunch begins
  await first.stop(); controllers.splice(controllers.indexOf(first), 1);
  closeDatabase(); resetProcessLeaseOwnersForTests();
  at = 3 * 60_000 + 10_000; ioBudget.resetAdmissionForFixture(); ioBudget.setIsIdle(() => true);
  const before = helpers.length;
  const relaunched = start();
  for (let k = 0; k < 6; k++) { relaunched.wake(); await settle(500); }
  // CHANGED-EXPECTATION (MAIN 2026-11-27 memory swarm cause C, "capture must never starve: foreground priority", newer than MAIN-RULING 2026-11-25T05:54:59Z idle DO LESS; lane q1024-memcapture):
  // was "the relaunched server is idle: no helper start, the two owed captures wait", landed on the next active minute; the owed
  // captures now land while idle, by one helper start. The capture the stop left leased is deferred to the next minute (worker-controller
  // stop(): a bounded wait), so the ledger and wall clocks move one minute, still idle
  const realNow = Date.now.bind(Date); const now = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 60_000);
  try { at += 60_000; relaunched.wake(); await drain(ids, before); } finally { now.mockRestore(); }
  expect({ started: helpers.length - before, idle: ioBudget.admissionIdle() }, "the idle relaunch lands the two owed captures on the idle minute by one helper start (cause C)").toEqual({ started: 1, idle: true });
  expect(handed(before).slice().sort(), "the relaunch ran exactly the two captures still owed, each once").toEqual(ids.slice(1).sort());
  expect({ once, all: ids.map(evidence) }, "none lost, none doubled: every message has exactly one captured record").toEqual({ once: 1, all: [1, 1, 1] });
}, 40_000);

// MAIN-RULING 2026-11-22T20:47:34Z idle-retry, option (b): "A failed idle start retries inside the same window on the existing start
// backoff (30 s, doubling, capped at 30 min). Each retry counts against the idle write allowance, a retry never runs while the owner is
// active (owner wins), and retries stop when the window ends. 'At most once per idle window' now means at most one LIVE worker per
// window, not one attempt." The three rows below replace the one-attempt row (which asserted the ruled-against behaviour).
/** A helper that dies before it says it is ready. */
const dying = (...args: unknown[]) => {
  const raw = (args[2] as { env?: Record<string, string> } | undefined)?.env?.MURAGE_BG_BOOT;
  const helper = new Helper(raw ? JSON.parse(raw) as Boot : null); helpers.push(helper);
  setTimeout(() => helper.crash(1), 0); return helper as unknown as ReturnType<typeof fork>;
};
it.skip("idle retry: the helper dies before it is ready; the controller itself starts it again when the start backoff has passed, not before, and the capture lands in the same idle window with no owner turn", async () => {
  const ids = owe(1);
  ioBudget.setIsIdle(() => true);
  // real time throughout, and the ledger's clock follows it from 45 s into minute 0: the 30 s backoff ends 15 s into minute 1
  const t0 = performance.now(); at = 45_000; const clock = setInterval(() => { at = 45_000 + Math.round(performance.now() - t0); }, 50);
  try {
    vi.mocked(fork).mockImplementationOnce(dying);
    const controller = start();
    await vi.waitFor(() => expect(helpers[0]?.connected, "the idle controller started a helper for the owed capture, and it died").toBe(false), { timeout: 8_000, interval: 25 });
    const respawnAt = Number(Reflect.get(controller, "respawnAt"));
    expect(Math.round((respawnAt - helpers[0]!.startedAt) / 1000), "the existing start backoff: 30 s after the first failure").toBe(30);
    // nothing wakes the controller and the owner does not return: until the backoff has passed there is no second start
    await settle(respawnAt - 1_500 - Date.now());
    expect({ helpers: helpers.length, job: jobs()[0]!.status, attempts: jobs()[0]!.attempts }, "no second start before the backoff has passed; the capture stays owed").toEqual({ helpers: 1, job: "pending", attempts: 0 });
    // the backoff passes: the retry is the controller's own, and the capture lands
    await drain(ids, 1);
    expect(ioBudget.admissionIdle(), "the same idle window: the owner never returned").toBe(true);
    expect(helpers.length, "one retry: one live helper").toBe(2);
    expect(helpers[1]!.startedAt - respawnAt, "the retry started when the backoff had ended, not before").toBeGreaterThanOrEqual(0);
    expect(helpers[1]!.startedAt - respawnAt, "and by the controller's next look (its 30 s sweep at the latest), with nothing waking it").toBeLessThan(31_000);
    expect(helpers[1]!.boot?.bytes, "the retry is an idle start: the boot grant inside the idle allowance").toBe(MEMORY_IDLE_BOOT_BYTES);
    expect(ioBudget.admissionState().idleUsed, "the retry counts against the idle allowance: what its boot used is not excused as an owed capture's bytes").toBeGreaterThanOrEqual(16_384);
    expect({ evidence: evidence(ids[0]!), attempts: jobs()[0]!.attempts, handed: handed() }, "captured once, no attempt spent").toEqual({ evidence: 1, attempts: 0, handed: ids });
  } finally { clearInterval(clock); }
}, 90_000);

it.skip("idle retry: a crash loop is bounded by the start backoff (30 s doubling) and by the idle allowance; woken inside the backoff the controller starts nothing", async () => {
  owe(1);
  ioBudget.setIsIdle(() => true);
  // the fixture moves the wall clock and the ledger's clock together; every helper of this row dies before it is ready
  const realNow = Date.now.bind(Date); let skew = 0; const now = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  const advance = (ms: number) => { skew += ms; at += ms; };
  vi.mocked(fork).mockImplementation(dying);
  const controller = start();
  const prod = async () => { for (let k = 0; k < 3; k++) { controller.wake(); await settle(150); } };
  try {
    const waits: number[] = [];
    for (let k = 1; k <= 4; k++) {
      await vi.waitFor(() => expect(helpers.length === k && helpers[k - 1]!.connected === false, `start ${k} was made and died`).toBe(true), { timeout: 8_000, interval: 25 });
      const diedIn = Math.floor(at / 60_000);
      expect(ioBudget.admissionState().idleUsed, "each failed start, the first and every retry, counts its boot grant against the idle allowance").toBe(MEMORY_IDLE_BOOT_BYTES);
      const wait = Number(Reflect.get(controller, "respawnAt")) - Date.now(); waits.push(Math.round(wait / 1000));
      // inside the backoff (from the second failure on this is already a later idle minute, with its whole allowance free): woken, no start
      advance(wait - 2_000); await prod();
      expect(helpers.length, "woken inside the start backoff: no start").toBe(k);
      // the backoff has passed
      advance(3_000);
      if (Math.floor(at / 60_000) === diedIn) {
        // still the minute the failed start was charged to: a second boot grant does not fit the idle allowance
        await prod();
        expect({ helpers: helpers.length, inside: ioBudget.admissionState().idleUsed + ioBudget.admissionState().reserved <= IDLE_ALLOWANCE }, "the backoff has passed, but the failed start spent this idle minute's allowance: no retry in it").toEqual({ helpers: k, inside: true });
        advance((diedIn + 1) * 60_000 + 10_000 - at);
      }
      const state = ioBudget.admissionState();
      expect(state.idleUsed + state.reserved, "fixture: a fresh idle minute").toBe(0);
      controller.wake();
    }
    await vi.waitFor(() => expect(helpers.length === 5 && helpers[4]!.connected === false, "start 5 was made and died").toBe(true), { timeout: 8_000, interval: 25 });
    expect(waits, "the waits double from 30 s").toEqual([30, 60, 120, 240]);
    expect({ helpers: helpers.length, minutes: Math.floor(at / 60_000) }, "5 starts in 8 idle minutes of crash loop").toEqual({ helpers: 5, minutes: 8 });
    expect(helpers.map(h => h.boot?.bytes), "every start was an idle start on the 512 KiB boot grant").toEqual(helpers.map(() => MEMORY_IDLE_BOOT_BYTES));
    expect(jobs()[0], "the capture is still owed, no attempt spent").toMatchObject({ status: "pending", attempts: 0 });
    expect(ioBudget.admissionIdle()).toBe(true);
  } finally { now.mockRestore(); }
}, 90_000);

it.skip("idle retry: the owner returning inside the backoff ends the idle window. No retry runs while the owner's turn is held; the capture lands by the ordinary start", async () => {
  const ids = owe(1);
  ioBudget.setIsIdle(() => true);
  const realNow = Date.now.bind(Date); let skew = 0; const now = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  vi.mocked(fork).mockImplementationOnce(dying);
  const controller = start();
  try {
    await vi.waitFor(() => expect(helpers[0]?.connected, "the idle controller started a helper for the owed capture, and it died").toBe(false), { timeout: 8_000, interval: 25 });
    const wait = Number(Reflect.get(controller, "respawnAt")) - Date.now();
    expect(Math.round(wait / 1000)).toBe(30);
    // the owner returns in the middle of the backoff and starts a turn; the backoff then runs out while that turn is on its way to the engine
    ioBudget.setIsIdle(() => false);
    const release = controller.holdForTurn();
    skew += wait + 1_000; at = 70_000;
    for (let k = 0; k < 3; k++) { controller.wake(); await settle(150); }
    expect(helpers.length, "owner wins: the backoff has passed, and no start is made while the owner's turn is held").toBe(1);
    release();
    await drain(ids, 1);
    expect(helpers.length).toBe(2);
    expect(helpers[1]!.boot?.bytes, "the start after the owner's return is the ordinary one (1 MiB boot grant), not an idle retry").toBe(1024 * 1024);
    expect({ evidence: evidence(ids[0]!), attempts: jobs()[0]!.attempts }).toEqual({ evidence: 1, attempts: 0 });
  } finally { now.mockRestore(); }
}, 60_000);

it("idle relaunch: with no capture owed the idle controller starts no helper (the boot warm asks, the idle rule refuses)", async () => {
  setMemoryMode("active"); ioBudget.setIsIdle(() => true);
  start();
  await settle(6_000); // past MEMORY_BOOT_WARM_MS (5 s)
  expect(helpers.length, "nothing is owed: no helper start while idle").toBe(0);
}, 20_000);

it.skip("idle relaunch: while idle with a capture still owed, the helper's idle-exit request is not granted (the queue drains first)", async () => {
  const first = owe(1);
  ioBudget.setIsIdle(() => true);
  const controller = start();
  await drain(first);
  await vi.waitFor(() => expect(Reflect.get(controller, "ready")).toBe(true), { timeout: 8_000, interval: 25 });
  const helper = helpers[0]!;
  // another writer spends the rest of this idle minute's allowance, then a second capture becomes owed: its claim waits for the roll
  const room = IDLE_ALLOWANCE - ioBudget.admissionState().idleUsed;
  const spender = ioBudget.admit("FGCOPY", room)!; expect(spender, "fixture: the idle minute's allowance is spent").not.toBeNull(); ioBudget.settle(spender, room);
  at = 59_000; // one second before the roll: the refused claim is retried at the roll
  appendMessage("fixture-thread", { id: "fixture-message-late", at: 9, role: "user", kind: "text", text: "Remember the late fixture preference." });
  const ids = jobs().map(j => j.id);
  await settle(600);
  expect({ work: Reflect.get(controller, "work"), statuses: jobs().map(j => j.status), sent: helper.works.length }, "fixture: nothing in flight, one capture owed and waiting for room").toEqual({ work: null, statuses: ["complete", "pending"], sent: 1 });
  helper.emit("message", { type: "idle-exit-request" });
  expect(helper.sent.filter(m => m.type === "idle-exit"), "the exit is not granted while a capture is owed").toEqual([]);
  // the minute rolls, still idle: the same helper lands the capture
  at = 70_000;
  await drain(ids);
  expect(helper.sent.filter(m => m.type === "idle-exit")).toEqual([]);
  expect({ helpers: helpers.length, idle: ioBudget.admissionIdle() }, "the same helper drained the queue, the owner still away").toEqual({ helpers: 1, idle: true });
  // the queue is drained: the worker idles again, so the same request is granted now
  await vi.waitFor(() => expect(Reflect.get(controller, "work")).toBeNull(), { timeout: 4_000, interval: 25 });
  helper.emit("message", { type: "idle-exit-request" });
  expect(helper.sent.filter(m => m.type === "idle-exit").length, "with nothing owed the helper may leave").toBe(1);
}, 40_000);

it("idle relaunch: a capture the controller cannot claim (memory paused) neither holds a helper back from leaving nor starts one while idle", async () => {
  // the first capture lands with the owner present, so this run's helper was not an idle start
  const first = owe(1);
  const controller = start();
  await drain(first);
  await vi.waitFor(() => expect(Reflect.get(controller, "ready")).toBe(true), { timeout: 8_000, interval: 25 });
  const helper = helpers[0]!;
  // the owner pauses memory and leaves; one more message arrives: its job is queued, and nothing may claim it while memory is paused
  setMemoryMode("paused"); ioBudget.setIsIdle(() => true);
  appendMessage("fixture-thread", { id: "fixture-message-paused", at: 9, role: "user", kind: "text", text: "Remember the paused fixture preference." });
  await settle(600);
  expect({ work: Reflect.get(controller, "work"), statuses: jobs().map(j => j.status), idle: ioBudget.admissionIdle() }, "fixture: idle, a job is queued and not claimed").toEqual({ work: null, statuses: ["complete", "pending"], idle: true });
  helper.emit("message", { type: "idle-exit-request" });
  expect(helper.sent.filter(m => m.type === "idle-exit").length, "a job nothing can claim does not keep the helper").toBe(1);
  // the helper leaves on that planned exit; a warm request (the path that restarts a helper after a planned exit) starts none while idle
  leaveFinal(controller, helper);
  await settle(100);
  controller.warmForIntent();
  await settle(300);
  expect(helpers.length, "no idle start for a job that cannot be claimed").toBe(1);
}, 40_000);

it.skip("idle relaunch: a capture that becomes owed after the drained helper left on its idle exit, in the same idle window, gets a start of its own and lands with no owner turn", async () => {
  const first = owe(1);
  ioBudget.setIsIdle(() => true);
  const controller = start();
  await drain(first);
  await vi.waitFor(() => expect({ ready: Reflect.get(controller, "ready"), work: Reflect.get(controller, "work") }).toEqual({ ready: true, work: null }), { timeout: 8_000, interval: 25 });
  // nothing is owed: the helper asks to leave, is let go, and exits (a planned exit, not a failed start)
  helpers[0]!.emit("message", { type: "idle-exit-request" });
  expect(helpers[0]!.sent.filter(m => m.type === "idle-exit").length, "fixture: the drained helper may leave").toBe(1);
  leaveFinal(controller, helpers[0]!);
  await settle(200);
  // later in the same idle window (a later idle minute) one more message arrives: its capture is owed, and no helper is running
  at = 2 * 60_000 + 10_000;
  appendMessage("fixture-thread", { id: "fixture-message-after-exit", at: 9, role: "user", kind: "text", text: "Remember the preference that came after the helper left." });
  const ids = jobs().map(j => j.id);
  await vi.waitFor(() => expect(helpers).toHaveLength(2), { timeout: 36_000, interval: 25 });
  await drain(ids, 1);
  expect({ helpers: helpers.length, idle: ioBudget.admissionIdle(), boot: helpers[1]?.boot?.bytes }, "a second idle start in the same window, the owner still away").toEqual({ helpers: 2, idle: true, boot: MEMORY_IDLE_BOOT_BYTES });
  expect(ids.map(evidence), "both captured once").toEqual([1, 1]);
}, 68_000);

it.skip("idle relaunch: a due capture behind more than 32 other due rows in the queue index is still owed: the idle controller starts the helper and it lands", async () => {
  const ids = owe(1);
  // fixture state only (the product enqueues no such rows; they stand for any due backlog that is not a capture): 40 due rows of
  // another stage, ahead of the capture in the queue index (status 'deferred' sorts before 'pending'), which no claim takes (attempts 3)
  const db = database();
  const row = db.prepare("SELECT source_id,source_revision,policy_revision,deletion_epoch FROM memory_jobs WHERE id=?").get(ids[0]!) as { source_id: string; source_revision: number; policy_revision: number; deletion_epoch: number };
  const add = db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,attempts,retry_at,policy_revision,deletion_epoch) VALUES(?,?,?,'fixture-other-stage',?,'deferred',3,0,?,?)");
  for (let k = 0; k < 40; k++) add.run(`fixture-other-${k}`, row.source_id, row.source_revision, String(k), row.policy_revision, row.deletion_epoch);
  expect(Number((db.prepare("SELECT count(*) AS n FROM (SELECT stage FROM memory_jobs INDEXED BY memory_jobs_pending WHERE status IN ('pending','partial','deferred') AND retry_at<=? LIMIT 32) WHERE stage='capture'").get(Date.now()) as { n: number }).n), "fixture: the first 32 due rows of the queue index hold no capture").toBe(0);
  ioBudget.setIsIdle(() => true);
  start();
  await drain(ids);
  expect({ helpers: helpers.length, idle: ioBudget.admissionIdle(), evidence: evidence(ids[0]!), handed: handed() }, "the capture landed by the idle start, once").toEqual({ helpers: 1, idle: true, evidence: 1, handed: ids });
}, 40_000);

// MAIN-RULING 2026-11-22T22:47:40Z idle-drained (1): "a DRAINED idle helper (no owed capture, nothing in flight) EXITS: end it, and never
// open a WASM step to reach idle exit. An exit costs no idle I/O allowance; the next owed capture spawns a fresh helper on the start
// backoff." The helper here asks what the real helper asks for its index open (more than any idle minute admits), so it never
// initialises while idle: it lands what is owed, then the controller ends it itself, and an idle window keeps no helper process.
const exits = (h: Helper) => h.sent.filter(m => m.type === "idle-exit").length;
const life = (c: MemoryWorkerController) => ({ child: Boolean(Reflect.get(c, "child")), failures: Reflect.get(c, "initFailures"), respawnAt: Reflect.get(c, "respawnAt") });

it.skip("idle drain end: an idle-started helper whose index open no idle minute admits lands the owed captures and is then ended by the controller; the exit is not a failed start and costs no idle allowance, nothing starts again with nothing owed, and the next owed capture lands by a fresh helper started one backoff step later", async () => {
  openAsk = REAL_OPEN_ASK;
  const ids = owe(2);
  ioBudget.setIsIdle(() => true);
  // real time, and the ledger's clock follows it from 10 s into minute 0
  const t0 = performance.now(); const clock = setInterval(() => { at = 10_000 + Math.round(performance.now() - t0); }, 50);
  try {
    const controller = start();
    await drain(ids);
    const helper = helpers[0]!;
    expect({ helpers: helpers.length, handed: handed() }, "one helper landed both, each handed once").toEqual({ helpers: 1, handed: ids });
    const before = ioBudget.admissionState();
    await vi.waitFor(() => expect(exits(helper), "the queue is drained: the controller ends the helper that cannot initialise while idle").toBe(1), { timeout: 8_000, interval: 25 });
    // a helper being ended that asks a step, even one small enough for the idle minute, is given none
    const refusedBefore = helper.refusedGrants; helper.emit("message", { type: "bg-grant-request", ...SMALL_OPEN_ASK }); await settle(100);
    expect({ refusedNow: helper.refusedGrants - refusedBefore, granted: helper.sent.filter(m => m.type === "bg-grant" && (m as { ticket?: unknown }).ticket).length }, "no step is opened for a helper the controller is ending").toEqual({ refusedNow: 1, granted: 0 });
    expect({ ready: Reflect.get(controller, "ready"), refused: helper.refusedGrants > 0, openGranted: helper.sent.filter(m => m.type === "bg-grant" && (m as { ticket?: unknown }).ticket).length, idle: ioBudget.admissionIdle() }, "its index open was refused and no step was opened to reach the exit: it never initialised, the owner is away").toEqual({ ready: false, refused: true, openGranted: 0, idle: true });
    leaveFinal(controller, helper); const endedAt = Date.now();
    expect(life(controller), "a planned end: no failed start, no backoff").toEqual({ child: false, failures: 0, respawnAt: 0 });
    expect(Reflect.get(controller, "idleExited"), "the ended helper never initialised: it is not kept as one that left on its own idle exit, which the owner's intent would bring back with memory capture-only").toBe(false);
    const after = ioBudget.admissionState();
    expect({ idleUsed: after.idleUsed, reserved: after.reserved }, "the exit costs no idle allowance").toEqual({ idleUsed: before.idleUsed, reserved: 0 });
    await settle(700);
    expect(helpers.length, "nothing owed: no helper starts again in the idle window").toBe(1);
    // a capture becomes owed in the same idle window: a fresh helper, one start-backoff step after the end, lands it
    appendMessage("fixture-thread", { id: "fixture-message-after-end", at: 9, role: "user", kind: "text", text: "Remember the fixture preference after the end." });
    const all = jobs().map(j => j.id);
    await settle(3_000);
    expect({ helpers: helpers.length, owed: jobs()[2]!.status }, "inside the backoff step after the end: no start yet, the capture stays owed").toEqual({ helpers: 1, owed: "pending" });
    await vi.waitFor(() => expect(helpers.length, "a fresh helper is started for the owed capture, the owner still away").toBe(2), { timeout: 60_000, interval: 50 });
    await drain(all, 1);
    expect(helpers[1]!.startedAt - endedAt, "the fresh helper started on the start backoff: one 30 s step after the drained one was ended").toBeGreaterThanOrEqual(MEMORY_IDLE_SWEEP_MS - 1_000);
    expect({ helpers: helpers.length, idle: ioBudget.admissionIdle(), attempts: jobs().map(j => j.attempts), stored: all.map(id => evidence(id) > 0), boot: helpers[1]!.boot?.bytes }, "landed by a second idle start, none lost, none doubled").toEqual({ helpers: 2, idle: true, attempts: [0, 0, 0], stored: [true, true, true], boot: MEMORY_IDLE_BOOT_BYTES });
  } finally { clearInterval(clock); }
}, 120_000);

// ASTRA 7f4bcf046d High, MAIN-PICK 2026-11-23T00:35:11Z idle (must-fix): "a drained exit must never lose the final write receipt (exit only
// after the last receipt is durable) and a late exit must not exhaust the respawn backoff." The rows below replace the 7f4bcf046d row
// that expected the start timeout to kill a drain-ended helper once work was owed: that kill is the loss the ruling forbids.
const stops = (h: Helper) => h.sent.filter(m => m.type === "io-stop").length;
const up = (c: MemoryWorkerController, h: Helper) => ({ ...life(c), connected: h.connected });
/** A drained idle-started helper the controller is ending, which answers no ask. `advance` moves the wall clock and puts the ledger 10 s into a new minute. */
async function endedAndSilent() {
  openAsk = REAL_OPEN_ASK;
  const ids = owe(1);
  ioBudget.setIsIdle(() => true);
  const realNow = Date.now.bind(Date); let skew = 0; const now = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  const advance = (ms: number) => { skew += ms; at = (Math.floor(at / 60_000) + 1 + Math.floor(ms / 60_000)) * 60_000 + 10_000; };
  const controller = start();
  await drain(ids);
  const helper = helpers[0]!;
  await vi.waitFor(() => expect(exits(helper)).toBe(1), { timeout: 8_000, interval: 25 });
  return { controller, helper, advance, restore: () => now.mockRestore() };
}
const oweOneMore = () => { appendMessage("fixture-thread", { id: "fixture-message-while-ending", at: 9, role: "user", kind: "text", text: "Remember the fixture preference that arrived during the end." }); return jobs().map(j => j.id); };

// RETARGET (MAIN 2026-11-25 FINISH (2), MAIN-RULING 05:54:59Z idle DO LESS): the no-lost-receipt rows above ran on a helper the IDLE rule
// started, and idle no longer starts one. The same ask/stop/kill timing (worker-controller.ts askIdleExit/updateIdleAsk/closeChild) is
// what ends the helper that is left: one the ordinary ACTIVE start made, that drained and asked its own idle exit (idle-exit-request),
// with the owner then away. The rows below run the receipt rules on that helper; where a capture is owed while idle, the fresh start
// waits for the next ACTIVE minute (DO LESS) and is the ordinary one (1 MiB boot grant).
async function activeEndedAndSilent() {
  const ids = owe(1);
  const realNow = Date.now.bind(Date); let skew = 0; const now = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  const advance = (ms: number) => { skew += ms; at = (Math.floor(at / 60_000) + 1 + Math.floor(ms / 60_000)) * 60_000 + 10_000; };
  const controller = start();
  await drain(ids);
  const helper = helpers[0]!;
  await vi.waitFor(() => expect(Reflect.get(controller, "ready"), "fixture: the active-started helper initialised").toBe(true), { timeout: 8_000, interval: 25 });
  expect({ boot: helper.boot?.bytes, idleStart: Reflect.get(controller, "idleStartChild") === helper }, "fixture: the ordinary active start, not an idle one").toEqual({ boot: 1024 * 1024, idleStart: false });
  ioBudget.setIsIdle(() => true);
  helper.emit("message", { type: "idle-exit-request" });
  await vi.waitFor(() => expect(exits(helper), "fixture: the drained helper's own idle exit is granted").toBe(1), { timeout: 8_000, interval: 25 });
  return { controller, helper, advance, restore: () => now.mockRestore() };
}
const ACTIVE_BOOT = 1024 * 1024;

it.each([["obeys the stop", true], ["answers the stop neither", false]] as const)("RETARGET active start, no lost receipt: a drained active-started helper that asked its idle exit and does not leave is asked again and no start deadline fails it; it is told to stop only after its place is needed for a whole start time; one that %s", async (_name, obeys) => {
  resetIoMeterForTest();
  const { controller, helper, advance, restore } = await activeEndedAndSilent();
  try {
    expect(ioMeterTotal(), "fixture: the write meter is valid while the helper is being ended").not.toBeNull();
    await vi.waitFor(() => expect(exits(helper), "not answered: the controller asks again").toBe(2), { timeout: MEMORY_IDLE_DRAIN_EXIT_MS + 4_000, interval: 50 });
    expect(up(controller, helper), "asked again, not killed: the helper is still up and is not a failed start").toEqual({ child: true, failures: 0, respawnAt: 0, connected: true });
    advance(MEMORY_WORKER_INIT_MS + 61_000);
    const asks = exits(helper);
    await vi.waitFor(() => expect({ ...up(controller, helper), stops: stops(helper), askedAgain: exits(helper) > asks }, "past the start time with nothing owed: asked again, neither stopped nor killed").toEqual({ child: true, failures: 0, respawnAt: 0, connected: true, stops: 0, askedAgain: true }), { timeout: MEMORY_IDLE_DRAIN_EXIT_MS + 4_000, interval: 50 });
    const all = oweOneMore(); controller.wake();
    const beforeNeed = exits(helper);
    await vi.waitFor(() => expect(exits(helper)).toBeGreaterThan(beforeNeed), { timeout: MEMORY_IDLE_DRAIN_EXIT_MS + 4_000 });
    advance(MEMORY_WORKER_INIT_MS);
    await vi.waitFor(() => expect({ stops: stops(helper), connected: helper.connected }, "a capture is owed past the start time: the helper being ended is told to stop, it is not killed by a start deadline").toEqual({ stops: 1, connected: true }), { timeout: MEMORY_IDLE_DRAIN_EXIT_MS + 4_000, interval: 50 });
    expect(up(controller, helper), "told to stop, not a failed start").toEqual({ child: true, failures: 0, respawnAt: 0, connected: true });
    if (obeys) {
      helper.emit("message", { type: "io", ioProtocol: 1, generation: helper.generation, sequence: 1, fsWriteBlocks: 0, ioBytes: 0, known: true, final: true });
      expect(helper.sent.filter(m => m.type === "io-final-ack").length, "the controller took the last receipt before the exit").toBe(1);
      helper.crash(0);
      expect({ meter: ioMeterTotal() !== null, ...life(controller) }, "the exit came after the last receipt: the write meter is still valid, and the exit is planned, not a failed start").toEqual({ meter: true, child: false, failures: 0, respawnAt: 0 });
      advance(MEMORY_IDLE_SWEEP_MS + 1_000);
      for (let k = 0; k < 6; k++) { controller.wake(); await settle(250); }
      // CHANGED-EXPECTATION (MAIN 2026-11-27 memory swarm cause C, "capture must never starve: foreground priority", newer than MAIN-RULING 2026-11-25T05:54:59Z idle DO LESS; lane q1024-memcapture): was "still idle (DO LESS): no fresh helper", then landed on the next active minute;
      // the capture owed during the end now lands on the idle minute by one fresh helper start
      await drain(all, 1);
      expect({ helpers: helpers.length, stored: all.map(id => evidence(id) > 0), attempts: jobs().map(j => j.attempts), idle: ioBudget.admissionIdle() }, "the capture owed during the end landed on the idle minute by one fresh start, none lost (cause C)").toEqual({ helpers: 2, stored: [true, true], attempts: [0, 0], idle: true });
    } else {
      await settle(MEMORY_IDLE_DRAIN_EXIT_MS + 1_000);
      expect(up(controller, helper), "inside the step after the stop: still not killed").toEqual({ child: true, failures: 0, respawnAt: 0, connected: true });
      advance(MEMORY_IDLE_SWEEP_MS + 1_000);
      await vi.waitFor(() => expect(helper.connected, "it answered no ask for a start time and the stop for one more step: it can send no receipt, and is ended as a failed start").toBe(false), { timeout: MEMORY_IDLE_DRAIN_EXIT_MS + 4_000, interval: 50 });
      expect({ child: Boolean(Reflect.get(controller, "child")), failures: Reflect.get(controller, "initFailures"), backoff: Math.round((Number(Reflect.get(controller, "respawnAt")) - Date.now()) / 1000) }, "a failed start, on the start backoff").toEqual({ child: false, failures: 1, backoff: 30 });
    }
  } finally { restore(); }
}, 120_000);

it("RETARGET active start, no lost receipt: a helper told to stop that reports a write after the stop is not killed while its final receipt is still to come; it is killed only after one whole step of silence counted from its last message", async () => {
  resetIoMeterForTest();
  const { controller, helper, advance, restore } = await activeEndedAndSilent();
  try {
    oweOneMore(); controller.wake();
    await vi.waitFor(() => expect(exits(helper)).toBe(2), { timeout: MEMORY_IDLE_DRAIN_EXIT_MS + 4_000 });
    advance(MEMORY_WORKER_INIT_MS);
    await vi.waitFor(() => expect({ stops: stops(helper), connected: helper.connected }, "fixture: its place is needed past the start time, so it is told to stop").toEqual({ stops: 1, connected: true }), { timeout: 2 * MEMORY_IDLE_DRAIN_EXIT_MS + 4_000, interval: 50 });
    advance(MEMORY_IDLE_SWEEP_MS - 2_000);
    helper.emit("message", { type: "io", ioProtocol: 1, generation: helper.generation, sequence: 1, fsWriteBlocks: 0, ioBytes: 0, known: true, final: false });
    advance(4_000);
    await settle(MEMORY_IDLE_DRAIN_EXIT_MS + 1_000);
    expect({ ...up(controller, helper), meter: ioMeterTotal() !== null }, "it has written since the stop: not killed one step after the stop, its final receipt can still arrive and the write meter is still valid").toEqual({ child: true, failures: 0, respawnAt: 0, connected: true, meter: true });
    advance(MEMORY_IDLE_SWEEP_MS - 14_000);
    helper.emit("message", { type: "io", ioProtocol: 1, generation: helper.generation, sequence: 2, fsWriteBlocks: 0, ioBytes: 4096, known: true, final: false });
    advance(6_000);
    await settle(MEMORY_IDLE_DRAIN_EXIT_MS + 1_000);
    expect({ ...up(controller, helper), meter: ioMeterTotal() !== null }, "it reported again: still not killed more than two steps after the stop").toEqual({ child: true, failures: 0, respawnAt: 0, connected: true, meter: true });
    advance(MEMORY_IDLE_SWEEP_MS);
    await vi.waitFor(() => expect({ connected: helper.connected, failures: Reflect.get(controller, "initFailures") }, "silent one whole step after its last message: ended as a failed start").toEqual({ connected: false, failures: 1 }), { timeout: MEMORY_IDLE_DRAIN_EXIT_MS + 4_000, interval: 50 });
  } finally { restore(); }
}, 120_000);

it("RETARGET active start, no lost receipt: a step the helper being ended asks starts no start watch: the helper is still up after the watch's whole time", async () => {
  const { controller, helper, restore } = await activeEndedAndSilent();
  try {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    helper.emit("message", { type: "bg-grant-request", ...SMALL_OPEN_ASK });
    await vi.advanceTimersByTimeAsync(60_000 + MEMORY_WORKER_INIT_MS + MEMORY_IDLE_SWEEP_MS + 5_000);
    expect(up(controller, helper), "no watch kills the helper being ended after a step it asked: its last receipt can still arrive").toEqual({ child: true, failures: 0, respawnAt: 0, connected: true });
  } finally { vi.useRealTimers(); restore(); }
}, 60_000);

it("RETARGET active start, no lost receipt: an error the helper being ended reports on its way out is not a failed start: the helper is not killed for it", async () => {
  const { controller, helper, restore } = await activeEndedAndSilent();
  try {
    helper.emit("message", { type: "error", reason: "INVALID_MEMORY_WORK" }); await settle(300);
    expect(up(controller, helper), "an error reported while being ended kills nothing: the helper can still send its last receipt and leave").toEqual({ child: true, failures: 0, respawnAt: 0, connected: true });
  } finally { restore(); }
}, 40_000);

it("RETARGET active start, no lost receipt: a helper being ended that still talks is alive and busy: talk cannot postpone io-stop once a capture has been owed for a full start window", async () => {
  const { controller, helper, advance, restore } = await activeEndedAndSilent();
  try {
    advance(MEMORY_WORKER_INIT_MS + 61_000);
    helper.emit("message", { type: "index-opening" });
    oweOneMore(); controller.wake();
    const asks = exits(helper);
    await vi.waitFor(() => expect({ ...up(controller, helper), stops: stops(helper), askedTwice: exits(helper) > asks + 1 }, "the helper said something inside the start time: asked again twice with a capture owed, not told to stop, not killed").toEqual({ child: true, failures: 0, respawnAt: 0, connected: true, stops: 0, askedTwice: true }), { timeout: 2 * MEMORY_IDLE_DRAIN_EXIT_MS + 4_000, interval: 50 });
    advance(MEMORY_WORKER_INIT_MS);
    helper.emit("message", { type: "index-opening" });
    await vi.waitFor(() => expect({ stops: stops(helper), connected: helper.connected }).toEqual({ stops: 1, connected: true }), { timeout: MEMORY_IDLE_DRAIN_EXIT_MS + 4_000 });
  } finally {
    if (helper.connected) leaveFinal(controller, helper);
    restore();
  }
}, 60_000);

// RETARGET of the :245 row's active half (MAIN 2026-11-25 FINISH (2)): idle starts nothing (DO LESS); the owner returning wins: no start
// while the owner's turn is held, then the ordinary start lands the capture.
it("RETARGET owner returns: idle lands the owed capture (cause C); once the owner is back no start runs while the owner's turn is held, and the capture lands by the ordinary start", async () => {
  const ids = owe(1);
  ioBudget.setIsIdle(() => true);
  const controller = start();
  for (let k = 0; k < 6; k++) { controller.wake(); await settle(250); }
  // CHANGED-EXPECTATION (MAIN 2026-11-27 memory swarm cause C, "capture must never starve: foreground priority", newer than MAIN-RULING 2026-11-25T05:54:59Z idle DO LESS; lane q1024-memcapture): was "idle (DO LESS): no helper start, the capture waits", then landed after the owner's return;
  // the capture now lands on the idle minute, and the owner returning still wins: no start while the turn is held
  await drain(ids);
  expect({ helpers: helpers.length, evidence: evidence(ids[0]!), attempts: jobs()[0]!.attempts, idle: ioBudget.admissionIdle() }, "idle minute: one start lands the capture once (cause C)").toEqual({ helpers: 1, evidence: 1, attempts: 0, idle: true });
  ioBudget.setIsIdle(() => false); at += 60_000;
  const release = controller.holdForTurn();
  for (let k = 0; k < 3; k++) { controller.wake(); await settle(150); }
  expect(helpers.length, "owner wins: no start is made while the owner's turn is held").toBe(1);
  release();
  for (let k = 0; k < 3; k++) { controller.wake(); await settle(150); }
  expect({ evidence: evidence(ids[0]!), status: jobs()[0]!.status }, "after the owner's return: none doubled").toEqual({ evidence: 1, status: "complete" });
}, 40_000);

it.skip.each([["obeys the stop", true], ["answers the stop neither", false]] as const)("idle drain end, no lost receipt: a drained helper that does not leave is asked again and no start deadline fails it; it is told to stop only after its place is needed for a whole start time; one that %s", async (_name, obeys) => {
  resetIoMeterForTest();
  const { controller, helper, advance, restore } = await endedAndSilent();
  try {
    expect(ioMeterTotal(), "fixture: the write meter is valid while the helper is being ended").not.toBeNull();
    await vi.waitFor(() => expect(exits(helper), "not answered: the controller asks again").toBe(2), { timeout: MEMORY_IDLE_DRAIN_EXIT_MS + 4_000, interval: 50 });
    expect(up(controller, helper), "asked again, not killed: the helper is still up and is not a failed start").toEqual({ child: true, failures: 0, respawnAt: 0, connected: true });
    // no ask is answered for the whole start time (and past every start deadline: the one a refused step sets is at most a minute
    // later), and nothing needs the helper's place: it is asked again, not stopped, not killed
    advance(MEMORY_WORKER_INIT_MS + 61_000);
    const asks = exits(helper);
    await vi.waitFor(() => expect({ ...up(controller, helper), stops: stops(helper), askedAgain: exits(helper) > asks }, "past the start time with nothing owed: asked again, neither stopped nor killed").toEqual({ child: true, failures: 0, respawnAt: 0, connected: true, stops: 0, askedAgain: true }), { timeout: MEMORY_IDLE_DRAIN_EXIT_MS + 4_000, interval: 50 });
    // a capture becomes owed: its place is needed. No start deadline kills the helper; it is told to stop, which lets it send its last receipt
    const all = oweOneMore(); controller.wake();
    const beforeNeed = exits(helper);
    await vi.waitFor(() => expect(exits(helper)).toBeGreaterThan(beforeNeed), { timeout: MEMORY_IDLE_DRAIN_EXIT_MS + 4_000 });
    advance(MEMORY_WORKER_INIT_MS);
    await vi.waitFor(() => expect({ stops: stops(helper), connected: helper.connected }, "a capture is owed past the start time: the helper being ended is told to stop, it is not killed by a start deadline").toEqual({ stops: 1, connected: true }), { timeout: MEMORY_IDLE_DRAIN_EXIT_MS + 4_000, interval: 50 });
    expect(up(controller, helper), "told to stop, not a failed start").toEqual({ child: true, failures: 0, respawnAt: 0, connected: true });
    if (obeys) {
      // the helper seals: its last receipt, then its exit
      helper.emit("message", { type: "io", ioProtocol: 1, generation: helper.generation, sequence: 1, fsWriteBlocks: 0, ioBytes: 0, known: true, final: true });
      expect(helper.sent.filter(m => m.type === "io-final-ack").length, "the controller took the last receipt before the exit").toBe(1);
      helper.crash(0); const endedAt = Date.now();
      expect({ meter: ioMeterTotal() !== null, ...life(controller) }, "the exit came after the last receipt: the write meter is still valid, and the exit is planned, not a failed start").toEqual({ meter: true, child: false, failures: 0, respawnAt: 0 });
      advance(MEMORY_IDLE_SWEEP_MS + 1_000); controller.wake();
      await vi.waitFor(() => expect(helpers.length, "a fresh helper is started for the owed capture").toBe(2), { timeout: 8_000, interval: 25 });
      await drain(all, 1);
      expect({ waited: helpers[1]!.startedAt - endedAt >= MEMORY_IDLE_SWEEP_MS, stored: all.map(id => evidence(id) > 0), attempts: jobs().map(j => j.attempts), idle: ioBudget.admissionIdle() }, "the capture owed during the end landed by the fresh helper, the owner still away").toEqual({ waited: true, stored: [true, true], attempts: [0, 0], idle: true });
    } else {
      await settle(MEMORY_IDLE_DRAIN_EXIT_MS + 1_000);
      expect(up(controller, helper), "inside the step after the stop: still not killed").toEqual({ child: true, failures: 0, respawnAt: 0, connected: true });
      advance(MEMORY_IDLE_SWEEP_MS + 1_000);
      await vi.waitFor(() => expect(helper.connected, "it answered no ask for a start time and the stop for one more step: it can send no receipt, and is ended as a failed start").toBe(false), { timeout: MEMORY_IDLE_DRAIN_EXIT_MS + 4_000, interval: 50 });
      expect({ child: Boolean(Reflect.get(controller, "child")), failures: Reflect.get(controller, "initFailures"), backoff: Math.round((Number(Reflect.get(controller, "respawnAt")) - Date.now()) / 1000) }, "a failed start, on the start backoff").toEqual({ child: false, failures: 1, backoff: 30 });
    }
  } finally { restore(); }
}, 120_000);

// ASTRA ab4a9f8f84 High, MAIN-RULING 2026-11-23T02:23:45Z idle-final-receipt (a): "never kills a worker that has written since io-stop
// (any output resets the kill timer; kill only after the full silence window with no pending receipt)". The helper here is the scripted
// one (the controller's timing is what is under test); what a real helper sends after the stop is the row in idle-relaunch-real-helper.test.ts.
it.skip("idle drain end, no lost receipt: a helper told to stop that reports a write after the stop is not killed while its final receipt is still to come; it is killed only after one whole step of silence counted from its last message", async () => {
  resetIoMeterForTest();
  const { controller, helper, advance, restore } = await endedAndSilent();
  try {
    oweOneMore(); controller.wake();
    await vi.waitFor(() => expect(exits(helper)).toBe(2), { timeout: MEMORY_IDLE_DRAIN_EXIT_MS + 4_000 });
    advance(MEMORY_WORKER_INIT_MS);
    await vi.waitFor(() => expect({ stops: stops(helper), connected: helper.connected }, "fixture: its place is needed past the start time, so it is told to stop").toEqual({ stops: 1, connected: true }), { timeout: 2 * MEMORY_IDLE_DRAIN_EXIT_MS + 4_000, interval: 50 });
    // it is finishing a write: it reports (not final) just before the kill would fall due, and the step is over 4 s later
    advance(MEMORY_IDLE_SWEEP_MS - 2_000);
    helper.emit("message", { type: "io", ioProtocol: 1, generation: helper.generation, sequence: 1, fsWriteBlocks: 0, ioBytes: 0, known: true, final: false });
    advance(4_000);
    await settle(MEMORY_IDLE_DRAIN_EXIT_MS + 1_000);
    expect({ ...up(controller, helper), meter: ioMeterTotal() !== null }, "it has written since the stop: not killed one step after the stop, its final receipt can still arrive and the write meter is still valid").toEqual({ child: true, failures: 0, respawnAt: 0, connected: true, meter: true });
    // it reports again just before one step after its first report is over, and is still up past two whole steps after the stop: every
    // message puts the kill off, it is not one longer fixed wait
    advance(MEMORY_IDLE_SWEEP_MS - 14_000);
    helper.emit("message", { type: "io", ioProtocol: 1, generation: helper.generation, sequence: 2, fsWriteBlocks: 0, ioBytes: 4096, known: true, final: false });
    advance(6_000);
    await settle(MEMORY_IDLE_DRAIN_EXIT_MS + 1_000);
    expect({ ...up(controller, helper), meter: ioMeterTotal() !== null }, "it reported again: still not killed more than two steps after the stop").toEqual({ child: true, failures: 0, respawnAt: 0, connected: true, meter: true });
    // then nothing at all for one whole step after that message: it can send no receipt, and is ended as a failed start
    advance(MEMORY_IDLE_SWEEP_MS);
    await vi.waitFor(() => expect({ connected: helper.connected, failures: Reflect.get(controller, "initFailures") }, "silent one whole step after its last message: ended as a failed start").toEqual({ connected: false, failures: 1 }), { timeout: MEMORY_IDLE_DRAIN_EXIT_MS + 4_000, interval: 50 });
  } finally { restore(); }
}, 120_000);

// The same rule where the controller's stop() tells a helper to stop (ASTRA pre-check 15059c79bd High: "stop() can cut the write short
// sooner because it still sends SIGKILL after five seconds regardless of progress"). Real time: the grace is 5 s.
it.each([["reports a write inside the grace: it is not killed at the grace, and leaves after its final receipt", true], ["says nothing for the whole grace: it is killed", false]] as const)("stop, no lost receipt: a helper told to stop by stop() that %s", async (_name, writes) => {
  resetIoMeterForTest();
  const ids = owe(1), controller = start();
  await drain(ids);
  const helper = helpers[0]!;
  expect({ child: Boolean(Reflect.get(controller, "child")), connected: helper.connected, idle: ioBudget.admissionIdle() }, "fixture: the owner is here and the helper is up").toEqual({ child: true, connected: true, idle: false });
  // it has reported before, as every real helper has by then: the stop is sent as io-stop
  helper.emit("message", { type: "io", ioProtocol: 1, generation: helper.generation, sequence: 1, fsWriteBlocks: 0, ioBytes: 0, known: true, final: false });
  controllers.splice(controllers.indexOf(controller), 1);
  let stopped = false; const stopping = controller.stop().then(() => { stopped = true; });
  await vi.waitFor(() => expect(stops(helper), "fixture: told to stop").toBe(1), { timeout: 4_000, interval: 10 });
  const toldAt = performance.now();
  if (writes) {
    // it is finishing a write: it reports (not final) 3.5 s after the stop; the grace from the stop alone ends at 5 s
    await settle(3_500);
    helper.emit("message", { type: "io", ioProtocol: 1, generation: helper.generation, sequence: 2, fsWriteBlocks: 0, ioBytes: 4096, known: true, final: false });
    await settle(3_000);
    expect({ connected: helper.connected, stopped, meter: ioMeterTotal() !== null }, "it has written since the stop: not killed 6.5 s after it, its final receipt can still arrive and the write meter is still valid").toEqual({ connected: true, stopped: false, meter: true });
    helper.emit("message", { type: "io", ioProtocol: 1, generation: helper.generation, sequence: 3, fsWriteBlocks: 0, ioBytes: 8192, known: true, final: true });
    helper.crash(0); await stopping;
    expect({ acked: helper.sent.filter(m => m.type === "io-final-ack").length, meter: ioMeterTotal() !== null }, "the controller took the final receipt before the exit: the write meter is valid").toEqual({ acked: 1, meter: true });
  } else {
    await Promise.race([stopping, settle(9_000)]);
    expect({ connected: helper.connected, after: performance.now() - toldAt >= 4_900 && performance.now() - toldAt < 8_000 }, "silent for the whole grace: ended at the grace, not before and not left up").toEqual({ connected: false, after: true });
  }
}, 40_000);

it.skip("idle drain end, no lost receipt: a step the helper being ended asks is refused and the refusal starts no start watch: the helper is still up after the watch's whole time", async () => {
  const { controller, helper, restore } = await endedAndSilent();
  try {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const refusedBefore = helper.refusedGrants; helper.emit("message", { type: "bg-grant-request", ...SMALL_OPEN_ASK });
    // the refused-step watch would fire at the next admission (at most a minute) plus the start time plus one sweep
    await vi.advanceTimersByTimeAsync(60_000 + MEMORY_WORKER_INIT_MS + MEMORY_IDLE_SWEEP_MS + 5_000);
    expect(helper.refusedGrants - refusedBefore, "the step was refused").toBe(1);
    expect(up(controller, helper), "no watch kills the helper being ended after a refused step: its last receipt can still arrive").toEqual({ child: true, failures: 0, respawnAt: 0, connected: true });
  } finally { vi.useRealTimers(); restore(); }
}, 60_000);

it.skip("idle drain end, late exit: the rest before the next idle start is counted from the helper's exit, not from the ask: a helper that leaves after more than one backoff step is not followed at once by the next start", async () => {
  const { controller, helper, advance, restore } = await endedAndSilent();
  try {
    // the helper takes longer than one start-backoff step to leave; a capture is owed by then
    advance(MEMORY_IDLE_SWEEP_MS + 10_000);
    const all = oweOneMore();
    // its place is needed, but the start time has not passed since the first ask: it is asked again, not told to stop (a stop sent to a busy helper would cut its receipt short)
    const asks = exits(helper);
    await vi.waitFor(() => expect({ ...up(controller, helper), stops: stops(helper), askedAgain: exits(helper) > asks }, "a capture is owed inside the start time: the helper is asked again, not stopped").toEqual({ child: true, failures: 0, respawnAt: 0, connected: true, stops: 0, askedAgain: true }), { timeout: MEMORY_IDLE_DRAIN_EXIT_MS + 4_000, interval: 50 });
    leaveFinal(controller, helper); const endedAt = Date.now();
    expect(life(controller), "a planned end: no failed start").toEqual({ child: false, failures: 0, respawnAt: 0 });
    await settle(2_000);
    expect({ helpers: helpers.length, owed: jobs()[1]!.status }, "the helper left late: the next idle start still waits one backoff step after the exit").toEqual({ helpers: 1, owed: "pending" });
    advance(MEMORY_IDLE_SWEEP_MS); controller.wake();
    await vi.waitFor(() => expect(helpers.length, "one backoff step after the exit: a fresh helper is started for the owed capture").toBe(2), { timeout: 8_000, interval: 25 });
    expect(helpers[1]!.startedAt - endedAt, "started one 30 s step after the exit").toBeGreaterThanOrEqual(MEMORY_IDLE_SWEEP_MS);
    await drain(all, 1);
    expect({ stored: all.map(id => evidence(id) > 0), attempts: jobs().map(j => j.attempts), idle: ioBudget.admissionIdle() }, "landed, none lost, the owner still away").toEqual({ stored: [true, true], attempts: [0, 0], idle: true });
  } finally { restore(); }
}, 60_000);

it.skip("idle drain end, no lost receipt: an error the helper being ended reports on its way out is not a failed start: the helper is not killed for it", async () => {
  const { controller, helper, restore } = await endedAndSilent();
  try {
    helper.emit("message", { type: "error", reason: "INVALID_MEMORY_WORK" }); await settle(300);
    expect(up(controller, helper), "an error reported while being ended kills nothing: the helper can still send its last receipt and leave").toEqual({ child: true, failures: 0, respawnAt: 0, connected: true });
  } finally { restore(); }
}, 40_000);

// ASTRA pre-check 7d238fa5a9 High: "the controller can send idle-exit before the worker has an index; exitPrepared() requires an index to
// send a final receipt" and "it can send io-stop to a responsive helper that is still busy".
it.skip("idle drain end, no lost receipt: a drained helper is not asked to leave before its index open has come back refused (before that it has no index to seal, and its exit would carry no final receipt)", async () => {
  openAsk = REAL_OPEN_ASK; holdOpen = true;
  const ids = owe(1);
  ioBudget.setIsIdle(() => true);
  const controller = start();
  await drain(ids);
  const helper = helpers[0]!;
  await settle(1_500);
  expect({ ...up(controller, helper), asked: exits(helper), idle: ioBudget.admissionIdle(), owed: jobs().filter(j => j.status !== "complete").length }, "drained, but the helper has not reached its index open: it is not asked to leave yet").toEqual({ child: true, failures: 0, respawnAt: 0, connected: true, asked: 0, idle: true, owed: 0 });
  // the helper's open reaches its step and is refused (no idle minute admits it): now it has its index, and the controller ends it
  helper.emit("message", { type: "bg-grant-request", ...REAL_OPEN_ASK });
  await vi.waitFor(() => expect({ asked: exits(helper), refused: helper.refusedGrants }, "its index open came back refused: the drained helper is asked to leave").toEqual({ asked: 1, refused: 1 }), { timeout: 8_000, interval: 25 });
}, 40_000);

it.skip("idle drain end, no lost receipt: a helper being ended that still talks is alive and busy: talk cannot postpone io-stop once a capture has been owed for a full start window", async () => {
  const { controller, helper, advance, restore } = await endedAndSilent();
  try {
    advance(MEMORY_WORKER_INIT_MS + 61_000);
    helper.emit("message", { type: "index-opening" });
    oweOneMore(); controller.wake();
    const asks = exits(helper);
    // While the new need is still young, the helper is asked again.
    await vi.waitFor(() => expect({ ...up(controller, helper), stops: stops(helper), askedTwice: exits(helper) > asks + 1 }, "the helper said something inside the start time: asked again twice with a capture owed, not told to stop, not killed").toEqual({ child: true, failures: 0, respawnAt: 0, connected: true, stops: 0, askedTwice: true }), { timeout: 2 * MEMORY_IDLE_DRAIN_EXIT_MS + 4_000, interval: 50 });
    advance(MEMORY_WORKER_INIT_MS);
    helper.emit("message", { type: "index-opening" });
    await vi.waitFor(() => expect({ stops: stops(helper), connected: helper.connected }).toEqual({ stops: 1, connected: true }), { timeout: MEMORY_IDLE_DRAIN_EXIT_MS + 4_000 });
  } finally {
    if(helper.connected)leaveFinal(controller,helper);
    restore();
  }
}, 60_000);

it.skip("idle drain end: a helper the idle rule started is not ended while a capture is still owed, nor once the owner is back", async () => {
  openAsk = REAL_OPEN_ASK;
  const ids = owe(1);
  ioBudget.setIsIdle(() => true);
  const controller = start();
  await vi.waitFor(() => expect(helpers[0]?.works.length).toBe(1), { timeout: 8_000, interval: 25 });
  const helper = helpers[0]!;
  // the owner returns while the capture is in flight; it lands with the owner present
  ioBudget.setIsIdle(() => false);
  await drain(ids);
  await settle(700);
  expect({ exits: exits(helper), child: Boolean(Reflect.get(controller, "child")) }, "the owner is back: the helper stays and finishes its start as it always has").toEqual({ exits: 0, child: true });
}, 40_000);

// ASTRA 354737bc26 High 2 (MAIN-RULING 20:47:34Z idle-retry b): a fork that throws while idle is a failed idle start: the next one waits
// on the start backoff (30 s, doubling); it is not made again at the next tick.
it.skip("idle retry: a fork that throws while idle is retried on the start backoff (30 s, doubling), not at every tick; when the fork works again the capture lands in the same idle window", async () => {
  const ids = owe(1);
  ioBudget.setIsIdle(() => true);
  const realNow = Date.now.bind(Date); let skew = 0; const now = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  const advance = (ms: number) => { skew += ms; at += ms; };
  let thrown = 0; vi.mocked(fork).mockImplementation(() => { thrown++; throw new Error("fixture: fork refused"); });
  const controller = start();
  const prod = async () => { for (let k = 0; k < 3; k++) { controller.wake(); await settle(150); } };
  try {
    const waits: number[] = [];
    for (let k = 1; k <= 3; k++) {
      await vi.waitFor(() => expect(thrown, `fork ${k} was tried while idle and threw`).toBe(k), { timeout: 8_000, interval: 25 });
      const wait = Number(Reflect.get(controller, "respawnAt")) - Date.now(); waits.push(Math.round(wait / 1000));
      advance(Math.max(0, wait - 2_000)); await prod();
      expect(thrown, "woken inside the start backoff after a fork that threw: no new fork").toBe(k);
      advance(3_000 + Math.max(0, (Math.floor(at / 60_000) + 1) * 60_000 + 10_000 - at));
      if (k === 3) vi.mocked(fork).mockImplementation((...args: unknown[]) => { const raw = (args[2] as { env?: Record<string, string> } | undefined)?.env?.MURAGE_BG_BOOT; const helper = new Helper(raw ? JSON.parse(raw) as Boot : null); helpers.push(helper); setTimeout(() => helper.emit("message", { type: "ready" }), 0); return helper as unknown as ReturnType<typeof fork>; });
      controller.wake();
    }
    expect(waits, "the waits double from 30 s").toEqual([30, 60, 120]);
    await drain(ids);
    expect({ thrown, helpers: helpers.length, idle: ioBudget.admissionIdle(), evidence: evidence(ids[0]!), attempts: jobs()[0]!.attempts, boot: helpers[0]!.boot?.bytes }, "the fork works again: the capture lands in the same idle window, once, on an idle boot grant").toEqual({ thrown: 3, helpers: 1, idle: true, evidence: 1, attempts: 0, boot: MEMORY_IDLE_BOOT_BYTES });
  } finally { now.mockRestore(); }
}, 90_000);


// ACTIVE TWIN (MAIN-RULING 2026-11-25T05:54:59Z idle DO LESS; OPUS rv-c42ae4c1af H2) of the skipped "idle retry" rows above (dies before
// ready, crash loop): the start backoff they pinned (30 s, doubling, worker-controller.ts waitBeforeNextStart) still runs for an ORDINARY
// active start. What DO LESS changed is only that a retry is no longer made on an idle minute: once the backoff has passed while the
// owner is away, nothing starts; the next active minute makes the ordinary start and the capture lands once. (Base 50c4d674fc: the idle
// rule makes the retry on the idle minute.)
it("ACTIVE TWIN retry: an active-started helper that dies before it is ready is retried on the start backoff (30 s, doubling), not before; once the backoff has passed on an idle minute no retry is made; the next active minute's ordinary start lands the capture once", async () => {
  const ids = owe(1);
  const realNow = Date.now.bind(Date); let skew = 0; const now = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  const advance = (ms: number) => { skew += ms; at += ms; };
  const nextMinute = () => advance(Math.max(0, (Math.floor(at / 60_000) + 1) * 60_000 + 10_000 - at));
  vi.mocked(fork).mockImplementation(dying);
  const controller = start();
  const prod = async () => { for (let k = 0; k < 3; k++) { controller.wake(); await settle(150); } };
  try {
    const waits: number[] = [];
    for (let k = 1; k <= 3; k++) {
      await vi.waitFor(() => expect(helpers.length === k && helpers[k - 1]!.connected === false, `active start ${k} was made and died`).toBe(true), { timeout: 8_000, interval: 25 });
      expect(helpers[k - 1]!.boot?.bytes, "fixture: an ordinary active start (1 MiB boot), not an idle one").toBe(ACTIVE_BOOT);
      const wait = Number(Reflect.get(controller, "respawnAt")) - Date.now(); waits.push(Math.round(wait / 1000));
      advance(Math.max(0, wait - 2_000)); await prod();
      expect(helpers.length, "woken inside the start backoff of an active start: no start").toBe(k);
      advance(3_000); nextMinute();
      if (k < 3) controller.wake();
    }
    expect(waits, "the waits double from 30 s").toEqual([30, 60, 120]);
    // the third backoff has passed, and the owner is now away: DO LESS, no retry on the idle minute
    vi.mocked(fork).mockImplementation((...args: unknown[]) => { const raw = (args[2] as { env?: Record<string, string> } | undefined)?.env?.MURAGE_BG_BOOT; const helper = new Helper(raw ? JSON.parse(raw) as Boot : null); helpers.push(helper); helper.generation = (args[2] as { env?: Record<string, string> } | undefined)?.env?.MURAGE_IO_GENERATION ?? null; setTimeout(() => helper.emit("message", { type: "ready" }), 0); return helper as unknown as ReturnType<typeof fork>; });
    ioBudget.setIsIdle(() => true);
    for (let k = 0; k < 4; k++) { await prod(); controller.warmForIntent(); }
    // CHANGED-EXPECTATION (MAIN 2026-11-27 memory swarm cause C, "capture must never starve: foreground priority", newer than MAIN-RULING 2026-11-25T05:54:59Z idle DO LESS; lane q1024-memcapture): was "backoff passed on an idle minute: no retry, nothing written (DO LESS)", landed on the next
    // active minute; the passed backoff now retries on the idle minute and lands the owed capture once
    await drain(ids, 3);
    expect({ helpers: helpers.length, evidence: evidence(ids[0]!), attempts: jobs()[0]!.attempts, idle: ioBudget.admissionIdle() }, "backoff passed on an idle minute: one retry lands the capture once, no attempt spent (cause C)").toEqual({ helpers: 4, evidence: 1, attempts: 0, idle: true });
  } finally { now.mockRestore(); }
}, 90_000);

it("after FINAL, a kill with no exit event frees the slot and a late exit cannot change it", async () => {
  const ids = owe(1), controller = start();
  await drain(ids);
  const helper = helpers[0]!;
  const kill = vi.spyOn(helper, "kill").mockReturnValue(true); // A real process cannot withhold this event.
  helper.emit("message", { type: "io", ioProtocol: 1, generation: helper.generation, sequence: 1, fsWriteBlocks: 0, ioBytes: 0, known: true, final: true });
  await vi.waitFor(() => expect(Reflect.get(controller, "child")).toBeNull(), { timeout: 7_000, interval: 25 });
  expect(kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  expect(life(controller)).toEqual({ child: false, failures: 0, respawnAt: 0 });
  const rest = Reflect.get(controller, "idleRestUntil");
  helper.crash(0);
  expect(life(controller)).toEqual({ child: false, failures: 0, respawnAt: 0 });
  expect(Reflect.get(controller, "idleRestUntil")).toBe(rest);
}, 30_000);

// CHANGED-EXPECTATION (MAIN-RULING 2026-11-25T05:54:59Z idle DO LESS, 06:57:58Z): was "captures owed at an idle start land with no owner
// turn" and "a due capture behind more than 32 other due rows ... the idle controller starts the helper". Idle: the controller starts no
// helper and no capture is written; the next ACTIVE minute: the ordinary start (1 MiB boot grant, not the idle one) lands every capture once.
it.each([["three captures owed at start", 3, false], ["one capture behind 40 due rows of another stage", 1, true]] as const)("CHANGED-EXPECTATION cause C: %s: an idle minute lands each owed capture once by one helper start", async (_name, n, backlog) => {
  const ids = owe(n);
  if (backlog) {
    const db = database();
    const row = db.prepare("SELECT source_id,source_revision,policy_revision,deletion_epoch FROM memory_jobs WHERE id=?").get(ids[0]!) as { source_id: string; source_revision: number; policy_revision: number; deletion_epoch: number };
    const add = db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,attempts,retry_at,policy_revision,deletion_epoch) VALUES(?,?,?,'fixture-other-stage',?,'deferred',3,0,?,?)");
    for (let k = 0; k < 40; k++) add.run(`fixture-other-${k}`, row.source_id, row.source_revision, String(k), row.policy_revision, row.deletion_epoch);
  }
  ioBudget.setIsIdle(() => true);
  const controller = start();
  for (let k = 0; k < 6; k++) { controller.wake(); controller.warmForIntent(); await settle(500); }
  const owed = () => jobs().filter(j => ids.includes(j.id));
  // CHANGED-EXPECTATION (MAIN 2026-11-27 memory swarm cause C, "capture must never starve: foreground priority", newer than MAIN-RULING 2026-11-25T05:54:59Z idle DO LESS; lane q1024-memcapture): was "idle minute: no helper start, no capture written, no BG ticket (DO LESS)" and the ordinary
  // start on the next active minute; every owed capture now lands once on the idle minute
  await drain(ids);
  expect({ helpers: helpers.length, idle: ioBudget.admissionIdle(), landed: ids.map(id => evidence(id) > 0), attempts: owed().map(j => j.attempts), handed: handed() }, "idle minute: one start lands every capture once (cause C)").toEqual({ helpers: 1, idle: true, landed: ids.map(() => true), attempts: ids.map(() => 0), handed: ids });
}, 40_000);
