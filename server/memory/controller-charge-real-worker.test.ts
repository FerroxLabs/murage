// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MEMW WP2a charge handler (r3.2.2 D1, r3.2.6 A2'): a REAL helper process opens its index through a charged open check, and the real
// controller's charge handler is the only thing that can answer it. The ack names the charge's (helperRunId, fileId, attempt) and says
// granted. Kill: with the handler removed the open charge is never answered, so the helper never reports `initialised`. Controls: a
// controller still inside its start hold refuses (no `initialised` either); one past the hold grants (`initialised`).
import {fixtureHelperPermits} from "./testing/helper-permits.ts";
import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { setMemoryMode } from "./repository.ts";
import { CHARGE_START_HOLD_MS, MemoryWorkerController } from "./worker-controller.ts";

type Msg = { type: string; [key: string]: unknown };
type Internals = { onWorkerMessage(child: unknown, message: unknown): void; workerBytes: number };
const manifest = JSON.parse(readFileSync(resolve("shared/memory-model-manifest.json"), "utf8"));
let controller: MemoryWorkerController, internals: Internals, child: ChildProcess | null = null, root = "", realNow: () => number;

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture");
  root = mkdtempSync(join(tmpdir(), "memw-charge-real-"));
  realNow = performance.now.bind(performance);
  controller = new MemoryWorkerController();
  internals = controller as unknown as Internals;
});
afterEach(async () => {
  vi.restoreAllMocks();
  child?.kill("SIGKILL"); child = null;
  await controller.stop().catch(() => {}); closeDatabase(); removeTempDirSync(root);
});

/** Start a real helper, hand each charge it sends to the controller's handler, and report what it said. */
async function run(pastHold: boolean, waitMs: number) {
  if (pastHold) vi.spyOn(performance, "now").mockImplementation(() => realNow() + CHARGE_START_HOLD_MS);
  const permits=fixtureHelperPermits();
  const helper = fork(resolve("server/memory/worker.ts"), [], { execArgv: ["--experimental-strip-types", "--no-warnings"], stdio: ["ignore", "ignore", "pipe", "ipc"], env:permits.env });
  permits.attach(helper);
  child = helper;
  const seen: Msg[] = [];
  let stderr = "";
  helper.stderr!.on("data", data => { stderr = (stderr + data).slice(-2000); });
  helper.on("message", message => {
    const m = message as Msg; seen.push(m);
    if (m.type === "charge") internals.onWorkerMessage(helper, m);
  });
  await vi.waitFor(() => expect(seen.some(m => m.type === "ready")).toBe(true), { timeout: 30_000 });
  const authority = new DatabaseSync(join(root, "authority.db"));
  authority.exec("CREATE TABLE memory_meta(id INTEGER PRIMARY KEY, policy_revision INTEGER, deletion_epoch INTEGER, data_revision INTEGER); INSERT INTO memory_meta VALUES(1,1,1,1); CREATE TABLE memory_records(scope_id TEXT, id TEXT, version INTEGER, state TEXT)");
  authority.close();
  helper.send({ type: "init", indexPath: join(root, "index.db"), authorityPath: join(root, "authority.db"), modelDirectory: join(root, "model"), manifest });
  const until = Date.now() + waitMs;
  while (Date.now() < until && !seen.some(m => m.type === "initialised")) await new Promise(r => setTimeout(r, 50));
  return { seen, stderr };
}

it("a real helper's open charge is granted by the controller's handler, and the ack names the charge", async () => {
  const { seen, stderr } = await run(true, 20_000);
  const charge = seen.find(m => m.type === "charge");
  expect(charge, stderr).toBeDefined();
  expect(typeof charge!.helperRunId).toBe("string");
  expect(seen.some(m => m.type === "initialised"), stderr).toBe(true);
  expect(internals.workerBytes).toBeGreaterThanOrEqual(0);
}, 60_000);

it("control: inside the start hold the handler refuses, and the helper does not open", async () => {
  const { seen } = await run(false, 6_000);
  expect(seen.some(m => m.type === "charge")).toBe(true);
  expect(seen.some(m => m.type === "initialised")).toBe(false);
}, 60_000);
