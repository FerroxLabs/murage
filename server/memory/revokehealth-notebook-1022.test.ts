// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: q1022-revokehealth-opus (worker-controller.ts syncNotebooks backoff, worker-log.ts forgetSwallowed, import.ts deferred look).
// Consumer: server/index.ts onNotebookSync (syncTrackedMemoryImports), owned by the memory lane; io-budget.ts (the gate) by scperf-p1.
//
// 1.0.22 revokehealth item 4 (HIDDEN-COST-opus 9): a notebook sync the gate refused re-read and re-hashed its files every 10 s, its log line
// added up refusals across syncs that got through ("count=1619 since 16:29"), and a change deferred while the evidence index was built was
// read and hashed again on every pass.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BgDeferred } from "../bg-admission.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ioBudget } from "../io-budget.ts";
import { setObserveSink } from "../observe.ts";
import { ensureWorkspace } from "../workspace.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { commitMemoryImport, previewMemoryImport, syncTrackedMemoryImports } from "./import.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import { resetWorkerLog } from "./worker-log.ts";

const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => { reads.count++; return actual.readFileSync(...args); }) as typeof actual.readFileSync };
});
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), fork: vi.fn() }));
class Helper extends EventEmitter {
  send = vi.fn((message: { type?: string }) => { if (message.type === "init") setTimeout(() => this.emit("message", { type: "initialised" }), 0); return true; });
  kill = vi.fn(() => { this.emit("exit", 0); return true; });
  disconnect() { this.emit("exit", 0); }
}
let controller: MemoryWorkerController | undefined;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); resetWorkerLog();
  vi.mocked(fork).mockImplementation(() => { const helper = new Helper(); setTimeout(() => helper.emit("message", { type: "ready" }), 0); return helper as unknown as ReturnType<typeof fork>; });
});
afterEach(async () => { await controller?.stop(); controller = undefined; setObserveSink(); closeDatabase(); vi.useRealTimers(); vi.restoreAllMocks(); });

/** A started controller whose notebook sync is refused by the gate while `state.refuse` is set (the production timer drives it). */
function notebookController(state: { refuse: boolean }) {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-25T00:00:00Z")); setMemoryMode("capture");
  const calls: number[] = [];
  controller = new MemoryWorkerController({ onNotebookSync: () => { calls.push(Date.now()); if (state.refuse) throw new BgDeferred(1_000); } });
  // only the owner's notebook passes the pacing gate (the idle passes stay out of the way, as idle-wake.test.ts does)
  vi.spyOn(ioBudget, "shouldDefer").mockImplementation(source => source !== "owner-notebook");
  controller.start();
  return calls;
}

it("W-NB-BACKOFF a refused notebook sync backs off (1, 2, 4 ... at most 12 ticks), never stops, and runs every tick again once one gets through", async () => {
  const state = { refuse: true }, calls = notebookController(state);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(calls.length, "a refused sync is not tried on every 10 s tick").toBeLessThanOrEqual(5);
  await vi.advanceTimersByTimeAsync(480_000);
  const gaps = calls.slice(1).map((at, i) => at - calls[i]!);
  expect(calls.length, "it keeps trying while refused").toBeGreaterThanOrEqual(6);
  expect(Math.max(...gaps), "the wait is capped (an edit reaches memory within minutes)").toBeLessThanOrEqual(130_000);
  state.refuse = false;
  await vi.advanceTimersByTimeAsync(130_000);
  const after = calls.length;
  await vi.advanceTimersByTimeAsync(50_000);
  expect(calls.length - after, "a sync that got through resets the backoff").toBe(5);
});

it("W-NB-LOG-RESET a sync that gets through starts the refusal log line again: the next refusal says count=1 since its own time", async () => {
  const lines: string[] = [];
  setObserveSink(line => { lines.push(line); });
  const state = { refuse: true }, calls = notebookController(state);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(calls.length, "fixture: refused more than once").toBeGreaterThan(1);
  state.refuse = false;
  await vi.advanceTimersByTimeAsync(130_000);
  await vi.advanceTimersByTimeAsync(13 * 60_000 - 250_000);
  state.refuse = true; lines.length = 0;
  const refusedAt = Date.now();
  await vi.advanceTimersByTimeAsync(10_001);
  const line = lines.filter(text => text.includes("cause=BG_DEFERRED")).pop() ?? "";
  const since = Date.parse(/since=(\S+)/.exec(line)?.[1] ?? "");
  expect(line.match(/count=\d+/)?.[0], "the refusal after a sync that got through is counted from one").toBe("count=1");
  expect(since, "and since its own time").toBeGreaterThanOrEqual(refusedAt);
});

it("W-NB-DEFER-LOOK a change deferred while the evidence index is built is not re-read on every pass, and is imported on the first pass once it is ready", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const roster = { bots: [{ id: "a", threadId: "thread-a" }], groups: [] };
  reconcileMemoryRoster(roster); database().exec("UPDATE memory_meta SET mode='active'");
  const root = ensureWorkspace("a"), path = join(root, "MEMORY.md"), ticket = ownerMemoryTicket();
  writeFileSync(path, "Original notebook");
  commitMemoryImport(ticket, previewMemoryImport(ticket, [{ kind: "bot", botId: "a" }], roster).previewId, roster, true);
  const pass = () => { vi.setSystemTime(Date.now() + 11_000); return syncTrackedMemoryImports(roster); };
  pass();
  database().prepare("INSERT OR REPLACE INTO memory_late_build(name,ready,cursor) VALUES('evidence',0,NULL)").run();
  writeFileSync(path, "Original notebook, now with a second line of context");
  expect(pass(), "fixture: the change is deferred").toBe(0);
  reads.count = 0;
  for (let i = 0; i < 5; i++) pass();
  expect(reads.count, "a deferred change is not read and hashed again while the index is built").toBe(0);
  database().prepare("UPDATE memory_late_build SET ready=1 WHERE name='evidence'").run();
  expect(pass(), "the first pass once the index is ready imports it").toBe(1);
  expect(Number(database().prepare("SELECT count(*) AS n FROM memory_sources WHERE kind='legacy-import' AND revision=2").get()!.n)).toBe(1);
});
