// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The real server, spawned as the app spawns it, with a pending conversation deletion on disk. The window gives a silent server a limit and then
// gives up: a deletion that has to read a large engine history must never stand between the start and the first /api/health. The slow engine
// folder is planted (MURAGE_TEST_ENGINE_JOB_HOLD_MS holds every engine job on a timer), so the first test fails on any build that waits for it.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const BOT = "f25024c1-a18e-4251-acf1-0c1713d9b6d9", THREAD = "2e9018ee-1f45-46be-8ed1-7a02fc022807";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** How long the planted job holds, and well inside it the bound the server must answer by: a start that waits for one job cannot pass. */
const JOB_HOLD_MS = 60_000, HEALTH_BOUND_MS = 45_000;

const children: ChildProcess[] = [], homes: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) await waitForExit(child, { signal: "SIGKILL" });
  for (const home of homes.splice(0)) await removeTempDir(home);
});

function plantedHome(): { home: string; data: string; desk: string; journal: string } {
  const home = mkdtempSync(join(tmpdir(), "murage-startup-cleanup-"));
  homes.push(home);
  const data = join(home, ".murage"), desk = join(data, "workspaces", BOT, "threads", THREAD);
  mkdirSync(desk, { recursive: true });
  writeFileSync(join(desk, "note.md"), "x");
  writeFileSync(join(data, "config.json"), JSON.stringify({ instances: {} }));
  const journal = join(data, "pending-deletions.json");
  writeFileSync(journal, JSON.stringify([{ id: "9b1c7c6e-6a3f-4a55-8a11-0f4e6c1d2b3a", createdAt: Date.now() - 86_400_000, threadIds: [THREAD], desks: [{ botId: BOT, threadId: THREAD }], botIds: [], engineSessions: {}, engineHomes: [], attachments: [], artifactBlobs: [], leftovers: [] }]));
  return { home, data, desk, journal };
}

async function boot(home: string, env: Record<string, string> = {}): Promise<{ child: ChildProcess; base: string; healthMs: Promise<number> }> {
  const port = await freePortBlock([0, 1], 19_599, 200);
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  const child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    windowsHide: true,
    cwd: join(SERVER_DIR, ".."),
    env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let log = "";
  child.stdout!.on("data", chunk => (log += chunk));
  child.stderr!.on("data", chunk => (log += chunk));
  const healthMs = (async () => {
    while (Date.now() - started < JOB_HOLD_MS * 2) {
      try { if ((await fetch(`${base}/api/health`)).ok) return Date.now() - started; } catch { /* not up yet */ }
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}:\n${log.slice(-2000)}`);
      await sleep(50);
    }
    throw new Error(`server never came up:\n${log.slice(-2000)}`);
  })();
  return { child, base, healthMs };
}

const journalled = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Array<{ lastTriedAt?: number }>;

it("answers /api/health while every engine job is held, with the deletion still pending", async () => {
  const { home, journal, desk } = plantedHome();
  const { healthMs } = await boot(home, { MURAGE_TEST_ENGINE_JOB_HOLD_MS: String(JOB_HOLD_MS) });
  expect(await healthMs).toBeLessThan(HEALTH_BOUND_MS);
  expect(journalled(journal)).toHaveLength(1);
  expect(existsSync(desk)).toBe(true);
}, JOB_HOLD_MS * 2 + 30_000);

it("finishes the pending deletion after the port opens, with no restart", async () => {
  const { home, journal, desk } = plantedHome();
  const { healthMs } = await boot(home);
  await healthMs;
  const deadline = Date.now() + 90_000;
  while (journalled(journal).length && Date.now() < deadline) await sleep(100);
  expect(journalled(journal)).toEqual([]);
  expect(existsSync(desk)).toBe(false);
}, 150_000);

it("a kill in the middle of the pass loses nothing: the next start finishes the record", async () => {
  const { home, journal, desk } = plantedHome();
  const first = await boot(home, { MURAGE_TEST_ENGINE_JOB_HOLD_MS: "30000" });
  await first.healthMs;
  const deadline = Date.now() + 90_000;
  while (!journalled(journal)[0]?.lastTriedAt && Date.now() < deadline) await sleep(100);
  expect(journalled(journal)[0]?.lastTriedAt, "the pass began").toBeGreaterThan(0);
  await waitForExit(first.child, { signal: "SIGKILL" });
  expect(existsSync(desk)).toBe(true);

  const second = await boot(home);
  await second.healthMs;
  const end = Date.now() + 90_000;
  while (journalled(journal).length && Date.now() < end) await sleep(100);
  expect(journalled(journal)).toEqual([]);
  expect(existsSync(desk)).toBe(false);
}, 300_000);
