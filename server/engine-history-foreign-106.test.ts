// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lane 106 engine-history-home: a deleted conversation's engine home that a program Murage did not start keeps open (the owner's own
// Claude Code on ~/.claude, all day) is left alone before anything is paused or held. Sean's 1.0.3 log: about 200 `home not read`
// lines a day, one per home every ten minutes, and on every one of those tries Murage paused its background runs and closed its own
// idle sessions on the home first, only for the plan to find the home open again. Now: one line per change of holder, no pause and
// no hold while another program holds the home, one whole attempt an hour, and Murage's own warm engine is still closed by the hold.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

import { ConversationDeletions, runConversationDeletion } from "./conversation-deletion.ts";
import { engineState } from "./engine-closed.ts";
import { engineHistoryTestHooks, type EngineHistoryJob } from "./engine-history-offthread.ts";
import { runEngineHistoryJob } from "./engine-history-run.ts";
import { BOT, buildFixture, canaryHits, THREAD } from "./testing/engine-history-fixtures.ts";
import { proc, useFakeExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-foreign-106-")));
const databases: DatabaseSync[] = [];
afterAll(() => { for (const db of databases) db.close(); removeTempDirSync(scratch); });

let fake: FakeExclusion;
let lines: string[];
beforeEach(() => {
  fake = useFakeExclusion();
  lines = [];
  vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => { const line = args.map(String).join(" "); if (line.includes("home not read")) lines.push(line); });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fake.restore();
  for (const name of Object.keys(engineHistoryTestHooks)) delete (engineHistoryTestHooks as Record<string, unknown>)[name];
});

class InlineWorker extends EventEmitter {
  threadId = 7;
  postMessage(message: EngineHistoryJob) { setImmediate(() => this.emit("message", { type: "result", result: runEngineHistoryJob(message) })); }
  terminate() { setImmediate(() => this.emit("exit", 0)); return Promise.resolve(0); }
}

let next = 0;
/** An engine process on `home`, started by Murage (`ppid` this process) or by someone else (`ppid` 1). */
function running(exe: string, environment: Record<string, string>, argv: string[], ppid = 1): () => void {
  const item = { ...proc(exe, argv, 7000 + next++), ppid };
  fake.processes.push(item);
  fake.environments.set(item.pid, environment);
  return () => { fake.processes.splice(fake.processes.indexOf(item), 1); fake.environments.delete(item.pid); };
}

function world(foreignRelogMs?: number, owedGraceMs?: number) {
  const fx = buildFixture("claude", scratch);
  const home = fx.homes[0]!.home;
  engineHistoryTestHooks.createWorker = () => new InlineWorker() as unknown as Worker;
  const data = join(fx.root, "data"); // the fixture's data folder: its desks name the conversation's workspace folders
  mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(join(data, "messages.db"));
  databases.push(db);
  const events: string[] = [];
  let onHold: (() => void) | undefined;
  const deletions = new ConversationDeletions({
    dataDir: data, database: () => db, retryDelaysMs: [], ...(foreignRelogMs !== undefined ? { foreignRelogMs } : {}), ...(owedGraceMs !== undefined ? { owedGraceMs } : {}),
    pauseBackgroundRuns: async (engines) => { events.push(`pause ${engines.join(",")}`); return () => events.push("unpause"); },
    holdHomes: async (homes) => { events.push(`hold ${homes.length}`); onHold?.(); onHold = undefined; return { release: () => events.push("release"), skipped: [] }; },
  });
  return { fx, home, deletions, events, setOnHold: (fn: () => void) => { onHold = fn; } };
}

it("another program on the home: no pause, no hold, one log line over many tries, owed as open", async () => {
  const w = world();
  const prompt = "PRIVATE_FOREIGN_HOLDER_PROMPT_CANARY";
  // the owner's own Claude Code in a terminal, on THIS home, for the whole test (Claude Code's tool child too)
  running("/Users/x/.local/share/claude/versions/2.1.308", { HOME: scratch, CLAUDE_CONFIG_DIR: w.home }, ["claude", "-p", prompt]);
  running("/Users/x/.local/share/claude/versions/2.1.308", { HOME: scratch, CLAUDE_CONFIG_DIR: w.home }, ["ugrep", "-G"]);
  expect(engineState("claude", w.home).state).toBe("open");
  expect(engineState("claude", w.home).holders?.[0]?.argv).toContain(prompt);
  const { report } = await runConversationDeletion(w.deletions, { threadIds: [THREAD], engineHomes: w.fx.homes }, () => true);
  expect(report.failed.length).toBeGreaterThan(0);
  for (let n = 0; n < 3; n++) await w.deletions.retryNow();
  // base: "pause claude", "hold 1", "release", "unpause" on each of the 4 tries, and a `home not read` line on each
  expect(w.events).toEqual([]);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/engine history: claude home not read: open by process holders .*install path.*another program/);
  expect(lines[0]).not.toContain('"argv"');
  expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(prompt);
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(prompt);
  expect(vi.mocked(console.warn).mock.calls.some((args) => args.some((arg) => String(arg).includes("home not read")))).toBe(false);
  expect(w.deletions.pending()).toHaveLength(1);
  expect(canaryHits(w.fx.root, w.fx.canaries).length).toBeGreaterThan(0); // nothing of the home was touched
  const owed = (await w.deletions.retryNow()).still;
  expect(owed.map((item) => [item.engine, item.code])).toEqual([["claude", "engine-open"]]);
});

it("the planner reports an open home at info level and respects an already logged home", () => {
  const fx = buildFixture("claude", scratch);
  const home = fx.homes[0]!.home;
  const prompt = "PRIVATE_PLANNER_HOLDER_PROMPT_CANARY";
  running("/usr/local/bin/claude", { HOME: scratch, CLAUDE_CONFIG_DIR: home }, ["claude", "-p", prompt]);
  expect(engineState("claude", home).holders?.[0]?.argv).toContain(prompt);
  const job: EngineHistoryJob = { ...fx, kind: "plan", redoDir: join(fx.root, "redo"), nativeDir: join(fx.root, "native") };
  const planned = runEngineHistoryJob(job);
  expect(planned.homeReasons?.[`claude\0${home}`]).toBe("engine-open");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("home not read: open");
  runEngineHistoryJob({ ...job, quiet: [`claude\0${home}`] });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('"by":"program name"');
  expect(lines[0]).not.toContain('"argv"');
  expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(prompt);
  expect(console.warn).not.toHaveBeenCalled();
});

it("a new holder logs again once the hour since the last line has passed; one whole attempt is still made every sixth try", async () => {
  const w = world(0);
  running("/Users/x/.local/share/claude/versions/2.1.308", { HOME: scratch, CLAUDE_CONFIG_DIR: w.home }, ["claude"]);
  await runConversationDeletion(w.deletions, { threadIds: [THREAD], engineHomes: w.fx.homes }, () => true);
  for (let n = 0; n < 4; n++) await w.deletions.retryNow();
  expect(w.events).toEqual([]);
  // try 6: the whole attempt (pause, hold, plan); the plan finds the owner's program open, as the gate always did
  await w.deletions.retryNow();
  expect(w.events.filter((event) => event.startsWith("hold"))).toEqual(["hold 1"]);
  expect(w.deletions.pending()).toHaveLength(1);
  expect(lines).toHaveLength(1); // the whole try writes no second line for the holder already logged
  const before = lines.length;
  running("/opt/homebrew/bin/claude", { HOME: scratch, CLAUDE_CONFIG_DIR: w.home }, ["claude", "-p", "x"]);
  await w.deletions.retryNow();
  expect(lines.length).toBe(before + 1); // a different holder is a new line
});

it("1.0.7: the owner's Claude Code starting a shell or a search on every tool call writes no new line within the hour", async () => {
  const w = world(undefined, 0);
  running("/Users/x/.local/share/claude/versions/2.1.308", { HOME: scratch, CLAUDE_CONFIG_DIR: w.home }, ["claude", "--resume"]);
  await runConversationDeletion(w.deletions, { threadIds: [THREAD], engineHomes: w.fx.homes }, () => true);
  expect(lines).toHaveLength(1);
  for (let n = 0; n < 3; n++) {
    const gone = running(`/Users/x/.local/share/claude/versions/2.1.31${n}`, { HOME: scratch, CLAUDE_CONFIG_DIR: w.home }, ["ugrep", "-G"]);
    await w.deletions.retryNow();
    gone();
    await w.deletions.retryNow();
  }
  expect(lines).toHaveLength(1);
  expect(w.deletions.pending()).toHaveLength(1);
  // the line it owes is about this bot's conversation (its chats show it, not every chat), and an open engine offers no Try again
  // now (Murage finishes by itself once it closes)
  expect(w.deletions.notices().map((notice) => [notice.id, notice.tryAgain, notice.byItself, notice.botIds])).toEqual([["owed:claude", true, true, [BOT]]]);
});

it("Murage's own warm engine on the home (its child) is not another program: the hold closes it and the deletion completes", async () => {
  const w = world();
  const warm = running("/usr/local/bin/claude", { HOME: scratch, CLAUDE_CONFIG_DIR: w.home }, ["claude", "--input-format", "stream-json"], process.pid);
  w.setOnHold(warm);
  const { report } = await runConversationDeletion(w.deletions, { threadIds: [THREAD], engineHomes: w.fx.homes }, () => true);
  expect(report.failed).toEqual([]);
  expect(w.events[0]).toBe("pause claude");
  expect(w.events).toContain("hold 1");
  expect(canaryHits(w.fx.root, w.fx.canaries)).toEqual([]);
  expect(w.deletions.pending()).toEqual([]);
  expect(lines).toEqual([]);
});

it("a grandchild of Murage (an engine under a wrapper it started) is Murage's own too", async () => {
  const w = world();
  const wrapper = { ...proc("/bin/sh", ["sh", "-c", "claude"], 7900), ppid: process.pid };
  fake.processes.push(wrapper);
  const warm = running("/usr/local/bin/claude", { HOME: scratch, CLAUDE_CONFIG_DIR: w.home }, ["claude"], wrapper.pid);
  w.setOnHold(warm);
  const { report } = await runConversationDeletion(w.deletions, { threadIds: [THREAD], engineHomes: w.fx.homes }, () => true);
  expect(report.failed).toEqual([]);
  expect(w.events).toContain("hold 1");
});

it("a home open only by Murage's own process the hold does not cover (another instance's turn): not read, no `home not read` line, Murage's own turn", async () => {
  const w = world();
  // a turn of another instance whose engine resolves the same home: Murage's child, still running, not closed by this home's hold
  running("/usr/local/bin/claude", { HOME: scratch, CLAUDE_CONFIG_DIR: w.home }, ["claude", "-p", "turn"], process.pid);
  const { report } = await runConversationDeletion(w.deletions, { threadIds: [THREAD], engineHomes: w.fx.homes }, () => true);
  expect(report.failed.length).toBeGreaterThan(0);
  expect(w.events).toContain("hold 1"); // the whole attempt ran: the probe left Murage's own process to the hold and the gate
  expect(lines).toEqual([]); // base: one `home not read` line per try, naming Murage's own turn
  expect(canaryHits(w.fx.root, w.fx.canaries).length).toBeGreaterThan(0);
  const owed = (await w.deletions.retryNow()).still;
  expect(owed.map((item) => [item.engine, item.code])).toEqual([["claude", "using"]]);
  expect(lines).toEqual([]);
});
