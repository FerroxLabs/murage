// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 q1022-sqlite (crash-safety witness; owner: q1022-sqlite-opus): with this lane's pragma and checkpoint changes, kill -9 in the middle
// of a run of message writes loses no committed message. The child is the production store (testing/sqlite-crash-writer-child.ts); every id it
// printed was printed after its commit returned; after SIGKILL the parent reopens the same data dir and finds every one of them.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f(); });

it("W-CRASH kill -9 mid-write loses no committed message", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "murage-sqlite-crash-")); cleanups.push(() => removeTempDirSync(dir));
  const dataDir = join(dir, "data"); mkdirSync(dataDir, { recursive: true });
  const thread = "fixture-crash-thread";
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "server/testing/sqlite-crash-writer-child.ts", thread],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MURAGE_DATA_DIR: dataDir } });
  cleanups.push(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let output = "", error = "";
  child.stdout.on("data", b => { output += String(b); }); child.stderr.on("data", b => { error += String(b); });
  const exit = once(child, "exit");
  const deadline = Date.now() + 60_000;
  while ((output.match(/^COMMITTED /gm)?.length ?? 0) < 200) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`writer did not reach 200 commits: ${output.slice(-200)} ${error.slice(-2000)}`);
    await new Promise(r => setTimeout(r, 5));
  }
  child.kill("SIGKILL"); await exit;
  const committed = [...output.matchAll(/^COMMITTED (\S+)$/gm)].map(m => m[1]);
  const db = new DatabaseSync(join(dataDir, "messages.db")); cleanups.push(() => db.close());
  expect(db.prepare("PRAGMA quick_check").get()!.quick_check).toBe("ok");
  const stored = new Set((db.prepare("SELECT id FROM messages WHERE thread_id=?").all(thread) as Array<{ id: string }>).map(row => row.id));
  const lost = committed.filter(id => !stored.has(id));
  console.log(`SQLITE-MEASURE W-CRASH committed=${committed.length} stored=${stored.size} lost=${lost.length}`);
  expect(lost, "W-CRASH: every message whose commit returned is in the file after kill -9").toEqual([]);
});
