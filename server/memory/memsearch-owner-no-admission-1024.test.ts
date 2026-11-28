// SPDX-License-Identifier: AGPL-3.0-or-later
// Witness owner: q1024-memsearch-fable. Controller owner: scperf-p1 (worker-controller.ts); real helper owner: scperf-p1 (worker.ts);
// save path owner: memory (authority.ts, jobs.ts); ledger owner: scperf-p1 (io-budget.ts); ruling owner: MAIN.
//
// MAIN-RULING memint-3 (2026-11-28): (2) owner-turn memory work (search, helper start, index open, the owner's own save) never asks the
// io-budget / bg-grant / background admission; background keeps its budget. (3) the owner's own saved memory is indexed at save time; the
// 60 s start window must not hide a fresh save.
// Field (real store, 23,076 captures pending): the backlog had spent every minute's background room, so the helper's start and its index
// open were refused until the minute rolled, and a saved memory waited behind the start hold and the background batches.
// REAL helper process, nothing scripted: the controller forks the product's helper (SPAWNED_PROXIES.memoryWorker) and the real ledger
// answers. Only the ledger's clock is the fixture's (it follows real time, 50 s before the minute rolls), and the minute's background
// room is spent by one reserved background ticket, the way the capture backlog spends it.
import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
vi.hoisted(() => vi.resetModules());
const gate = vi.hoisted(() => ({ calls: new Map<object, any>() }));
// (the approval card's presentation only: the save, the approval and the index path under test are the product's own)
vi.mock("../decision/index.ts", () => ({
  openRequest: (source: any) => { const handle = {}; gate.calls.set(handle, structuredClone(source)); return handle; },
  decide: () => ({ kind: "card", ref: { approvalId: "approval" } }),
  executeServiceSync: (handle: object, operation: any) => ({ kind: "executed", value: operation(gate.calls.get(handle).call) }),
  attachQueue: () => {},
  presentApprovalSync: () => {},
}));
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { BG_MINUTE_BYTES, ioBudget } from "../io-budget.ts";
import { forgetExclusionAddon } from "../engine-exclusion.ts";
import { resetIoMeterForTest } from "../io-meter.ts";
import { appendMessage } from "../message-db.ts";
import { stopSearchIndex } from "../message-search-index.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { fixtureMemoryAccess } from "../testing/recall-access-fixture.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { claimMemoryJob, publishMemoryWork, resetProcessLeaseOwnersForTests } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { memoryAgentRoute } from "./routes.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { memoryOwnerRoute } from "./settings.ts";
import { closeMemoryIndexReader } from "./index-reader.ts";
import { MEMORY_BOOT_WARM_MS, MemoryWorkerController } from "./worker-controller.ts";
import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";

const root = mkdtempSync(join(tmpdir(), "memsearch-owner-"));
const prior = process.env.MURAGE_ENGINE_EXCLUSION_PATH;
const realRead = Reflect.get(ioBudget, "read") as () => unknown;
const realAdmissionRead = Reflect.get(ioBudget, "admissionRead") as () => unknown;
const controllers: MemoryWorkerController[] = [];
let origin = 0, t0 = 0;
beforeAll(() => {
  const binary = join(root, "meter.node");
  execFileSync("cc", ["-std=c11", "-D_GNU_SOURCE", "-O2", "-Wall", "-Werror", "-fPIC", "-shared", "-DNAPI_VERSION=9", "-I", resolve(dirname(process.execPath), "../include/node"), "native/engine-exclusion/exclusion.c", "native/engine-exclusion/meter.c", "-o", binary], { stdio: "pipe" });
  process.env.MURAGE_ENGINE_EXCLUSION_PATH = binary; forgetExclusionAddon(); resetIoMeterForTest();
});
beforeEach(async () => {
  closeMemoryIndexReader(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); gate.calls.clear();
  resetProcessLeaseOwnersForTests?.();
  await stopWalMaintenance(); await stopSearchIndex();
  // 10 s into the ledger's minute: it rolls 50 s from now, long after every wait below
  origin = 10_000; t0 = performance.now(); const read = () => ({ at: origin + Math.round(performance.now() - t0), fsWriteBlocks: 0, cpuMicros: 0 });
  Reflect.set(ioBudget, "read", read); Reflect.set(ioBudget, "admissionRead", read); ioBudget.resetAdmissionForFixture(); ioBudget.setIsIdle(() => false);
});
afterEach(async () => { for (const c of controllers.splice(0)) await c.stop(); closeMemoryIndexReader(); closeDatabase(); Reflect.set(ioBudget, "read", realRead); Reflect.set(ioBudget, "admissionRead", realAdmissionRead); ioBudget.setIsIdle(() => false); ioBudget.resetAdmissionForFixture(); });
afterAll(() => { if (prior === undefined) delete process.env.MURAGE_ENGINE_EXCLUSION_PATH; else process.env.MURAGE_ENGINE_EXCLUSION_PATH = prior; forgetExclusionAddon(); resetIoMeterForTest(); rmSync(root, { recursive: true, force: true }); });

useOutsideStoreFixture();
const roster = { bots: [{ id: "bot", threadId: "thread" }], groups: [] };
/** A store with memory active and one captured source to cite. */
function store() {
  reconcileMemoryRoster(roster); setMemoryMode("capture");
  appendMessage("thread", { id: "m", at: 1, role: "user", origin: "desktop", kind: "text", text: "Fixture owner note about the storage unit" });
  const work = claimMemoryJob("fixture")!; publishMemoryWork(work, "fixture", captureWork(work));
  setMemoryMode("active");
  return work;
}
/** The capture backlog's effect on the ledger: the minute's background room is reserved, so a background ask is refused until it rolls. */
function spendMinute() {
  // (whatever is left of it: reserved in halving tickets, since earlier work of the test may have used part of the minute)
  let held = 0;
  for (let bytes = BG_MINUTE_BYTES; bytes >= 4096 && held < 48; bytes = Math.floor(bytes / 2)) while (held < 48 && ioBudget.admit("BG", bytes)) held++;
  expect(held, "fixture: none of the minute's background room could be reserved").toBeGreaterThan(0);
  expect(ioBudget.admit("BG", 1024 * 1024), "fixture: a background megabyte is still admitted, the minute is not spent").toBeNull();
}
const helper = (c: MemoryWorkerController) => Reflect.get(c, "child") as ChildProcess | null;
const state = (c: MemoryWorkerController) => ({ forked: helper(c) !== null, ready: Reflect.get(c, "ready") === true });
const receipt = (id: string) => database().prepare("SELECT lexical_status AS s FROM memory_projection_receipts WHERE record_id=? ORDER BY record_version DESC LIMIT 1").get(id)?.s;
function controller() { const c = new MemoryWorkerController(); controllers.push(c); return c; }

it.each(["search", "turn"] as const)("W-START/W-OPEN %s: with the minute's background room spent and inside the start hold, the helper the owner waits on is forked at once and its index open finishes (ready), without waiting for the minute to roll", async trigger => {
  store(); spendMinute();
  const c = controller(); c.start();
  const stop = new AbortController();
  if (trigger === "search") void c.search({ query: "storage unit", scopeIds: ["none"], policyRevision: 0, deletionEpoch: 0, historical: false, cursor: "", limit: 5, semantic: false } as any, stop.signal).catch(() => {});
  else c.warmForIntent();
  try {
    await vi.waitFor(() => expect(state(c), JSON.stringify({ error: c.error })).toEqual({ forked: true, ready: true }), { timeout: 25_000, interval: 50 });
  } finally { stop.abort(); }
}, 90_000);

it("W-BOOT no owner: with the minute's background room spent, the boot warm alone forks no helper (background work keeps its budget)", async () => {
  store(); spendMinute();
  const c = controller(); c.start();
  await new Promise(resolve => setTimeout(resolve, MEMORY_BOOT_WARM_MS + 2_500));
  expect(state(c)).toEqual({ forked: false, ready: false });
}, 60_000);

it.each(["active", "idle"] as const)("W-SAVE %s minute: the owner's own save is indexed at save time: inside the 60 s start hold and with the minute's background room spent, the approved memory's index receipt is written within seconds", async minute => {
  const work = store();
  const c = controller(); c.start();
  // the helper is up first, on a free minute, so the save itself is what is measured
  c.warmForIntent();
  await vi.waitFor(() => expect(state(c), JSON.stringify({ error: c.error })).toEqual({ forked: true, ready: true }), { timeout: 60_000, interval: 50 });
  const registry = new InternalCapabilities(); registry.begin("bot", "thread", "generation");
  const token = registry.mint({ botId: "bot", threadId: "thread", generation: "generation", depth: 99, kind: "memory", skillAuthoring: false });
  const access = fixtureMemoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  const evidence = [{ sourceId: work.sourceId, revision: 1, startByte: 0, endByte: Buffer.byteLength(work.text) }];
  const authority = { claim: { fixture: true }, proof: { reference: "fake-source" }, identity: { threadId: "thread", generation: "generation" } };
  const saved = await (memoryAgentRoute("/api/internal/memory/save", { text: "Storage unit gate code is 4417 zebra", evidence, idempotencyKey: "k" }, access, { search: async () => ({ hits: [], vectorRows: 0 }) }, undefined, null, { authority } as any) as Promise<any>);
  expect(saved.state).toBe("candidate");
  const id = String(saved.candidateId);
  // the candidate exists; from here the minute's background room is spent, as the capture backlog spends it
  spendMinute(); if (minute === "idle") { ioBudget.setIsIdle(() => true); expect(ioBudget.admissionIdle(), "fixture: the ledger did not turn idle").toBe(true); }
  await memoryOwnerRoute("/api/memory/action", { action: "approve", id, version: 1 }, ownerMemoryTicket(), roster);
  expect(database().prepare("SELECT state FROM memory_records WHERE id=? AND version=1").get(id)?.state).toBe("active");
  expect(receipt(id)).toBe("pending");
  await vi.waitFor(() => expect(receipt(id), JSON.stringify({ error: c.error })).toBe("indexed"), { timeout: 20_000, interval: 50 });
}, 120_000);
