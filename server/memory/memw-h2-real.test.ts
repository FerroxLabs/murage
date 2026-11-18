import {fixtureHelperPermits} from "./testing/helper-permits.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW WP2a r3.2.8-H.1 1 and 6 on a REAL helper process: it announces index-opening first (process.send callback answered by Node), creates the
// index only after that callback, and every charge it sends carries opening: true while the open is pending. The helper answers the
// process.send callback on every path: success (null), a closed channel (error: it exits 0, worker.ts index-opening send) and no IPC (resolves).
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

type Msg = { type: string; [key: string]: unknown };
const manifest = JSON.parse(readFileSync(resolve("shared/memory-model-manifest.json"), "utf8"));
let child: ChildProcess | null = null, root = "";
afterEach(() => { child?.kill("SIGKILL"); child = null; if (root) rmSync(root, { recursive: true, force: true }); root = ""; });

it("a real helper sends index-opening before anything else about the index, then its open charges carry opening: true and it initialises", async () => {
  root = mkdtempSync(join(tmpdir(), "memw-h2-real-"));
  const permits=fixtureHelperPermits();
  const helper = fork(resolve("server/memory/worker.ts"), [], { execArgv: ["--experimental-strip-types", "--no-warnings"], stdio: ["ignore", "ignore", "pipe", "ipc"],env:permits.env });
  permits.attach(helper);
  child = helper;
  const seen: Msg[] = [];
  let stderr = "";
  helper.stderr!.on("data", data => { stderr = (stderr + data).slice(-2000); });
  helper.on("message", message => {
    const m = message as Msg; seen.push(m);
    if (m.type === "charge") helper.send({ type: "charge-ack", helperRunId: m.helperRunId, fileId: m.fileId, attempt: m.attempt, granted: true });
  });
  const until0 = Date.now() + 30_000;
  while (Date.now() < until0 && !seen.some(m => m.type === "ready")) await new Promise(r => setTimeout(r, 50));
  expect(seen.some(m => m.type === "ready"), stderr).toBe(true);
  const authority = new DatabaseSync(join(root, "authority.db"));
  authority.exec("CREATE TABLE memory_meta(id INTEGER PRIMARY KEY, policy_revision INTEGER, deletion_epoch INTEGER, data_revision INTEGER); INSERT INTO memory_meta VALUES(1,1,1,1); CREATE TABLE memory_records(scope_id TEXT, id TEXT, version INTEGER, state TEXT)");
  authority.close();
  helper.send({ type: "init", indexPath: join(root, "index.db"), authorityPath: join(root, "authority.db"), modelDirectory: join(root, "model"), manifest });
  const until = Date.now() + 30_000;
  while (Date.now() < until && !seen.some(m => m.type === "initialised")) await new Promise(r => setTimeout(r, 50));
  expect(seen.some(m => m.type === "initialised"), stderr).toBe(true);
  const types = seen.map(m => m.type);
  expect(types.indexOf("index-opening")).toBeGreaterThanOrEqual(0);
  expect(types.indexOf("index-opening")).toBeLessThan(types.indexOf("initialised"));
  const charges = seen.filter(m => m.type === "charge");
  const firstCharge = types.indexOf("charge");
  if (firstCharge >= 0) expect(types.indexOf("index-opening")).toBeLessThan(firstCharge);
  expect(charges.length).toBeGreaterThan(0);
  expect(charges.every(m => m.opening === true || m.opening === false)).toBe(true);
  expect(charges[0]!.opening).toBe(true);
}, 90_000);
