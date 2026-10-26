// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DELETION-WHILE-OPEN-107 (Sean, 10-25/26): his own Claude Code, Grok and Fuigo stay open all day, and the whole-home gate left every
// deleted conversation's engine copies owed for good. Now the conversation's OWN files (its Claude project folder, its session side
// files) are removed while the owner's CLI runs, each under the per-file hold; the shared history row and anything a database holds
// wait for the closed pass, which finishes the rest once the engine closes.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

import { ConversationDeletions, runConversationDeletion } from "./conversation-deletion.ts";
import { engineHistoryTestHooks, type EngineHistoryJob } from "./engine-history-offthread.ts";
import { runEngineHistoryJob } from "./engine-history-run.ts";
import { exclOps } from "./engine-fs.ts";
import { buildFixture, canaryHits, THREAD } from "./testing/engine-history-fixtures.ts";
import { proc, useFakeExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-open-pass-107-")));
const databases: DatabaseSync[] = [];
afterAll(() => { for (const db of databases) db.close(); removeTempDirSync(scratch); });

let fake: FakeExclusion;
/** What each fake process has (Linux /proc as the open pass reads it): its working folder and open files. A pid not here works in
 * the owner's own project and has nothing of the conversation open. */
const procView = new Map<number, { cwd?: string; fds?: string[]; unreadable?: true }>();
const proofPids: number[] = [];
beforeEach(() => {
  fake = useFakeExclusion();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  procView.clear();
  proofPids.length = 0;
  // what Linux /proc shows the open pass for each fake process (engine-closed.ts holdersClearOf)
  Object.assign(exclOps, {
    procView: "linux",
    procCwd: (pid: number) => { proofPids.push(pid); const view = procView.get(pid); return view?.unreadable ? null : view?.cwd ?? "/home/x/work/app"; },
    procFiles: (pid: number) => { const view = procView.get(pid); return view?.unreadable ? null : view?.fds ?? ["/dev/null"]; },
    lsofFiles: () => null,
  });
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
function running(exe: string, environment: Record<string, string>, argv: string[], ppid = 1): (() => void) & { pid: number } {
  const item = { ...proc(exe, argv, 8000 + next++), ppid };
  fake.processes.push(item);
  fake.environments.set(item.pid, environment);
  return Object.assign(() => { fake.processes.splice(fake.processes.indexOf(item), 1); fake.environments.delete(item.pid); }, { pid: item.pid });
}

function world() {
  const fx = buildFixture("claude", scratch);
  const home = fx.homes[0]!.home;
  engineHistoryTestHooks.createWorker = () => new InlineWorker() as unknown as Worker;
  const data = join(fx.root, "data");
  mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(join(data, "messages.db"));
  databases.push(db);
  const events: string[] = [];
  const deletions = new ConversationDeletions({
    dataDir: data, database: () => db, retryDelaysMs: [],
    pauseBackgroundRuns: async (engines) => { events.push(`pause ${engines.join(",")}`); return () => events.push("unpause"); },
    holdHomes: async (homes) => { events.push(`hold ${homes.length}`); return { release: () => events.push("release"), skipped: [] }; },
  });
  const project = fx.gone[0]!;
  const own = { transcript: join(project, "sess-claude-1.jsonl"), debug: join(home, "debug", "sess-claude-1.txt"), fileHistory: join(home, "file-history", "sess-claude-1"), plan: join(home, "plans", "cool-slug.md") };
  const history = join(home, "history.jsonl");
  return { fx, home, deletions, events, project, own, history };
}
const CANARY = "canary-claude-5521";
const ownerClaude = (home: string, argv = ["claude", "--resume"]) => running("/Users/x/.local/share/claude/versions/2.1.310", { HOME: scratch, CLAUDE_CONFIG_DIR: home }, argv);

it("the owner's Claude Code open on the home: the conversation's own files go now, the shared history row waits, nothing else is touched", async () => {
  const w = world();
  const close = ownerClaude(w.home);
  await runConversationDeletion(w.deletions, { threadIds: [THREAD], engineHomes: w.fx.homes }, () => true);
  expect(existsSync(w.project)).toBe(false);
  expect(existsSync(w.own.debug)).toBe(false);
  expect(existsSync(w.own.fileHistory)).toBe(false);
  expect(existsSync(w.own.plan)).toBe(false);
  // the shared history is written by the running CLI: its row for this conversation waits for the closed pass, and so does the
  // pasted text only that row uses (removed under Claude's own history lock)
  expect(readFileSync(w.history, "utf8")).toContain(CANARY);
  expect(w.fx.checkBystanders().filter((problem) => !problem.startsWith("history.jsonl"))).toEqual([]);
  expect(w.events).toEqual([]); // nothing of Murage's own is paused or held for it
  expect(w.deletions.pending()).toHaveLength(1); // still owed, honestly
  // the CLI closes: the closed pass finishes the rest and the deletion is done
  close();
  await w.deletions.retryNow();
  expect(canaryHits(w.fx.root, w.fx.canaries)).toEqual([]);
  expect(w.fx.checkBystanders()).toEqual([]);
  expect(w.deletions.pending()).toEqual([]);
});

it("a file of the conversation another process still has open for writing is kept, and owed (macOS, Linux)", async () => {
  const w = world();
  ownerClaude(w.home);
  const writer = fake.openForWriting(w.own.transcript);
  await runConversationDeletion(w.deletions, { threadIds: [THREAD], engineHomes: w.fx.homes }, () => true);
  expect(readFileSync(w.own.transcript, "utf8")).toContain(CANARY);
  expect(w.deletions.pending()).toHaveLength(1);
  writer.close();
});

it("a process whose command line names the conversation's session (claude --resume <id>) leaves the whole home to the closed pass", async () => {
  const w = world();
  ownerClaude(w.home, ["claude", "--resume", "sess-claude-1"]);
  await runConversationDeletion(w.deletions, { threadIds: [THREAD], engineHomes: w.fx.homes }, () => true);
  expect(existsSync(w.own.transcript)).toBe(true);
  expect(existsSync(w.own.debug)).toBe(true);
  expect(w.deletions.pending()).toHaveLength(1);
});

it("a process list that cannot be read leaves the whole home to the closed pass", async () => {
  const w = world();
  ownerClaude(w.home);
  fake.processesFail = true;
  await runConversationDeletion(w.deletions, { threadIds: [THREAD], engineHomes: w.fx.homes }, () => true);
  expect(existsSync(w.own.transcript)).toBe(true);
  expect(w.deletions.pending()).toHaveLength(1);
});

// ── Grok design r1: every process on the home is shown to have nothing of the conversation, or nothing is removed while it is open ──

it("a Claude Code working in the deleted conversation's folder (its cwd inside it) leaves the whole home to the closed pass", async () => {
  const w = world();
  const cli = ownerClaude(w.home);
  procView.set(cli.pid, { cwd: join(w.fx.folders[0]!, "src") });
  await runConversationDeletion(w.deletions, { threadIds: [THREAD], engineHomes: w.fx.homes }, () => true);
  expect(existsSync(w.own.transcript)).toBe(true);
  expect(existsSync(w.own.debug)).toBe(true);
  expect(w.deletions.pending()).toHaveLength(1);
  cli();
  await w.deletions.retryNow();
  expect(canaryHits(w.fx.root, w.fx.canaries)).toEqual([]);
  expect(w.deletions.pending()).toEqual([]);
});

it("a process that has a file of the conversation open only for READING keeps the home whole", async () => {
  const w = world();
  const cli = ownerClaude(w.home);
  procView.set(cli.pid, { fds: ["/dev/null", w.own.debug] });
  await runConversationDeletion(w.deletions, { threadIds: [THREAD], engineHomes: w.fx.homes }, () => true);
  expect(existsSync(w.own.transcript)).toBe(true);
  expect(existsSync(w.own.debug)).toBe(true);
  expect(w.deletions.pending()).toHaveLength(1);
});

it("a shell the CLI started is proven too: one reading the transcript keeps the home whole", async () => {
  const w = world();
  const cli = ownerClaude(w.home);
  const shell = running("/bin/zsh", { HOME: scratch }, ["zsh", "-c", "tail -f x"], cli.pid);
  procView.set(shell.pid, { fds: [w.own.transcript] });
  await runConversationDeletion(w.deletions, { threadIds: [THREAD], engineHomes: w.fx.homes }, () => true);
  expect(proofPids).toContain(shell.pid);
  expect(existsSync(w.own.transcript)).toBe(true);
  expect(w.deletions.pending()).toHaveLength(1);
});

it("a holder whose working folder or open files cannot be read is no proof: nothing is removed while it runs", async () => {
  const w = world();
  const cli = ownerClaude(w.home);
  procView.set(cli.pid, { unreadable: true });
  await runConversationDeletion(w.deletions, { threadIds: [THREAD], engineHomes: w.fx.homes }, () => true);
  expect(existsSync(w.own.transcript)).toBe(true);
  expect(existsSync(w.own.debug)).toBe(true);
  expect(w.deletions.pending()).toHaveLength(1);
});

it("every holder is proven, past the five the log keeps: a sixth Claude Code in the conversation's folder keeps the home whole", async () => {
  const w = world();
  const clis = Array.from({ length: 6 }, () => ownerClaude(w.home));
  procView.set(clis[5]!.pid, { cwd: w.fx.folders[0]! });
  await runConversationDeletion(w.deletions, { threadIds: [THREAD], engineHomes: w.fx.homes }, () => true);
  expect(existsSync(w.own.transcript)).toBe(true);
  expect(w.deletions.pending()).toHaveLength(1);
});

it("the open pass never unlinks a link: a folder holding one is put back whole, and the closed pass still finds and removes it", async () => {
  const w = world();
  const cli = ownerClaude(w.home);
  const link = join(w.own.fileHistory, "linked");
  symlinkSync(join(w.home, "settings.json"), link);
  await runConversationDeletion(w.deletions, { threadIds: [THREAD], engineHomes: w.fx.homes }, () => true);
  expect(existsSync(w.own.fileHistory)).toBe(true);
  expect(existsSync(w.own.debug)).toBe(false); // the rest of the conversation's own files still go now
  expect(w.deletions.pending()).toHaveLength(1);
  // its session id was saved before the transcript went, so the closed pass still knows this side folder is the conversation's
  cli();
  await w.deletions.retryNow();
  expect(existsSync(w.own.fileHistory)).toBe(false);
  expect(canaryHits(w.fx.root, w.fx.canaries)).toEqual([]);
  expect(w.deletions.pending()).toEqual([]);
});
