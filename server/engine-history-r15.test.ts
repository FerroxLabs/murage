// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Engine deletion with engines still writing (r15): what a rewrite does to a file another process is appending to, the hold
// Murage puts on its own sessions, every attempt planning everything again, and what the owner is told when an engine keeps
// its files busy. The component cases of r14 (a late paste, a late child, a late session folder) are in
// engine-history-plan.test.ts; the generic crash and fault matrices are in engine-history-invariant.test.ts.
import { EventEmitter } from "node:events";
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { ConversationDeletions, ENGINE_LABEL, owedCodeOf, ownerNoticeText, runConversationDeletion, type OwedCode } from "./conversation-deletion.ts";
import { executeEnginePlans } from "./engine-exec.ts";
import { exclOps, mutOps, parseJsonLines } from "./engine-fs.ts";
import { kimiWorkDirKey } from "./engine-history-deletion.ts";
import { engineHistoryTestHooks, type EngineHistoryJob } from "./engine-history-offthread.ts";
import { planEngineHistory, runEngineHistoryJob } from "./engine-history-run.ts";
import { homeKey, JSONL_FORMAT, type Step } from "./engine-plan-core.ts";
import { decorateHoldInstance, InstanceHolds, WAITING_NOTE } from "./harness/instance-holds.ts";
import { buildFixture, canaryHits, ENGINES, THREAD, type Fixture } from "./testing/engine-history-fixtures.ts";
import { keepOut } from "./testing/keep-out.ts";
import type { ProviderInstance, RuntimeEvent } from "./contracts.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-r15-")));
const openDatabases: DatabaseSync[] = [];
afterAll(() => { for (const db of openDatabases) db.close(); removeTempDirSync(scratch); });
afterEach(() => {
  for (const name of Object.keys(engineHistoryTestHooks)) delete (engineHistoryTestHooks as Record<string, unknown>)[name];
});

const dump = (value: unknown) => `${JSON.stringify(value)}\n`;
const job = (fx: Fixture, extra: Record<string, unknown> = {}) => ({ homes: fx.homes, folders: fx.folders, memoryFolders: fx.memoryFolders, sessions: fx.sessions, kind: "plan" as const, ...extra });
const key = (fx: Fixture) => homeKey(fx.homes[0]!.engine, fx.homes[0]!.home);
const C = (engine: string) => `canary-${engine}-5521`;
const B = (engine: string) => `bystander-${engine}-9917`;

class ScriptedWorker extends EventEmitter {
  threadId = 11;
  readonly script: (job: EngineHistoryJob, worker: ScriptedWorker) => void;
  constructor(script: (job: EngineHistoryJob, worker: ScriptedWorker) => void) { super(); this.script = script; }
  postMessage(message: EngineHistoryJob) { setImmediate(() => this.script(message, this)); }
  terminate() { setImmediate(() => this.emit("exit", 0)); return Promise.resolve(0); }
}
const useScript = (script: (job: EngineHistoryJob, worker: ScriptedWorker) => void) => { engineHistoryTestHooks.createWorker = () => new ScriptedWorker(script) as unknown as Worker; };
const answer = (worker: ScriptedWorker, message: EngineHistoryJob, onStep?: (k: string, i: number) => void) => worker.emit("message", { type: "result", result: runEngineHistoryJob(message, onStep) });
function open(data: string): DatabaseSync {
  mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(join(data, "messages.db"));
  openDatabases.push(db);
  return db;
}
const serviceFor = (fx: Fixture, options: Partial<ConstructorParameters<typeof ConversationDeletions>[0]> = {}) => {
  const data = join(fx.root, "data");
  const db = open(data);
  return { data, db, deletions: new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [], ...options }) };
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── blank-in-place: every JSONL file is rewritten the same way ─────────────────────────────────────────────────────

describe("every JSONL file is blanked in place, whatever the engine", () => {
  it("records what may stay, and why, for every JSONL file that is rewritten", () => {
    expect(Object.keys(JSONL_FORMAT).sort()).toEqual(["claude-history", "codex-history", "codex-session-index", "fuigo-unified", "kimi-session-index"]);
    for (const [name, entry] of Object.entries(JSONL_FORMAT)) expect(entry.basis.length, name).toBeGreaterThan(20);
  });

  it("the planners use exactly that: one blank rewrite per JSONL file, for Fuigo, Grok, Claude, Codex and Kimi", () => {
    const modes: Record<string, string[]> = {};
    for (const engine of ENGINES) {
      const fx = buildFixture(engine, scratch);
      const plan = planEngineHistory(job(fx)).plans![key(fx)]!;
      modes[engine] = plan.steps.filter((step): step is Extract<Step, { k: "rewrite" }> => step.k === "rewrite").map((step) => step.mode);
    }
    expect(modes.fuigo).toEqual(["blank"]);
    expect(modes.grok).toEqual(["blank"]);
    expect(modes.claude).toEqual(["blank"]);
    expect(modes.codex).toEqual(["blank", "blank"]);
    expect(modes.kimi).toEqual(["blank"]);
    for (const engine of ENGINES) if (!["fuigo", "grok", "claude", "codex", "kimi"].includes(engine)) expect(modes[engine], engine).toEqual([]);
  });

  it("a blank row is skipped by the strict reader, like a line that is not JSON", () => {
    const text = `${JSON.stringify({ sid: "a" })}\n${" ".repeat(30)}\n${JSON.stringify({ sid: "b" })}\n`;
    const lines = parseJsonLines("/x", text, ["a"]);
    expect(lines.map((line) => line.row?.sid ?? null)).toEqual(["a", null, "b", null]);
  });

  it("Fuigo: the file keeps its length, its inode and every other row byte for byte; the dropped row keeps its keys and its values are spaces", () => {
    const fx = buildFixture("fuigo", scratch);
    const log = join(fx.homes[0]!.home, "logs", "unified.jsonl");
    const before = readFileSync(log, "utf8").split("\n");
    const planned = planEngineHistory(job(fx));
    expect(executeEnginePlans(structuredClone(planned.plans!)).failed).toEqual([]);
    const after = readFileSync(log, "utf8").split("\n");
    expect(after).toHaveLength(before.length);
    expect(after[0]).toBe(JSON.stringify({ sid: (JSON.parse(before[0]!) as { sid: string }).sid, text: " ".repeat(C("fuigo").length) })); // same keys and length, the id stays, the words are blank
    expect(after.slice(1)).toEqual(before.slice(1));
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
  });
});

// ── interleavings: an unrelated writer at every point ─────────────────────────────────────────────────────────────

describe("an unrelated row appended at every injected point survives byte for byte", () => {
  const unrelated = dump({ sid: "s-unrelated", text: "UNRELATED-ROW" });

  // The planned rows are first read and journalled with NO hold (prepareRows: a slow disk under the journal never makes the engine
  // wait), then read again under the engine's lock just before they are overwritten. "before the read made with no hold" is the first
  // read of all; "before the first pread under the hold" is the first read through the held file (the descriptor the lock was taken on,
  // or on Windows the addon's handle opened to take it).
  for (const point of ["before the read made with no hold", "before the first pread under the hold", "between pread and pwrite", "after the last pwrite", "before the fsync"] as const) {
    it(`Fuigo, ${point}`, () => {
      const fx = buildFixture("fuigo", scratch);
      const log = join(fx.homes[0]!.home, "logs", "unified.jsonl");
      const planned = planEngineHistory(job(fx));
      const real = { pread: mutOps.pread, pwrite: mutOps.pwrite, fsync: mutOps.fsync };
      const realExcl = { lock: exclOps.lock, openFile: exclOps.openFile };
      let preads = 0, heldPreads = 0, refused = 0;
      const held = new Set<unknown>();
      // The writer appends without the engine's lock. macOS and Linux: the lock is advisory, so the row lands at once. Windows: the lock
      // Murage holds is mandatory, the system refuses the write (EBUSY), and the writer writes once the lock is let go.
      const write = (): void => {
        try { appendFileSync(log, unrelated); } catch (error) {
          if (process.platform !== "win32") throw error;
          expect((error as NodeJS.ErrnoException).code).toBe("EBUSY");
          refused++;
        }
      };
      exclOps.lock = ((fd: number) => { const taken = realExcl.lock(fd); if (taken) held.add(fd); return taken; }) as typeof exclOps.lock;
      exclOps.openFile = ((path: string, kind: Parameters<typeof exclOps.openFile>[1]) => { const file = realExcl.openFile(path, kind); if (file && kind !== "probe") held.add(file); return file; }) as typeof exclOps.openFile;
      mutOps.pread = ((fd: number, length: number, position: number) => {
        if (point === "before the read made with no hold" && preads === 0) write();
        if (point === "before the first pread under the hold" && held.has(fd) && heldPreads++ === 0) write();
        preads++;
        const bytes = real.pread(fd, length, position);
        if (point === "between pread and pwrite") write();
        return bytes;
      }) as typeof mutOps.pread;
      mutOps.pwrite = ((fd: number, bytes: Buffer, position: number) => { const put = real.pwrite(fd, bytes, position); if (point === "after the last pwrite") write(); return put; }) as typeof mutOps.pwrite;
      mutOps.fsync = ((fd: number) => { if (point === "before the fsync") write(); real.fsync(fd); }) as typeof mutOps.fsync;
      let ran: ReturnType<typeof executeEnginePlans>;
      try { ran = executeEnginePlans(structuredClone(planned.plans!)); } finally { Object.assign(mutOps, real); Object.assign(exclOps, realExcl); }
      if (point === "before the read made with no hold") expect(refused).toBe(0); // nothing is held yet: the row lands at once everywhere
      else if (process.platform === "win32") { expect(refused).toBeGreaterThan(0); appendFileSync(log, unrelated); } // it writes now
      if (point === "before the first pread under the hold") expect(heldPreads).toBeGreaterThan(0);
      expect(ran.failed).toEqual([]);
      const text = readFileSync(log, "utf8");
      expect(text).toContain(unrelated); // not cut, not skipped, not rewritten
      expect(text).toContain(B("fuigo"));
      expect(text).not.toContain(C("fuigo"));
      expect(text.endsWith(unrelated)).toBe(true);
    });
  }

  it("Fuigo: another writer that rewrote the head in place before our read makes the step stale, and nothing is overwritten", () => {
    const fx = buildFixture("fuigo", scratch);
    const log = join(fx.homes[0]!.home, "logs", "unified.jsonl");
    const planned = planEngineHistory(job(fx));
    const original = readFileSync(log, "utf8");
    const rows = original.split("\n");
    // Fuigo's own trim_file rewrites the file in place: the head now holds other bytes of the same length
    const rewritten = [rows[1]!.padEnd(rows[0]!.length, " "), ...rows.slice(1)].join("\n");
    writeFileSync(log, rewritten);
    const ran = executeEnginePlans(structuredClone(planned.plans!));
    expect(ran.staleHomes).toEqual([key(fx)]);
    expect(ran.failed).toEqual([]);
    expect(readFileSync(log, "utf8")).toBe(rewritten); // not one byte of it was changed by the step
  });

  const claudeHistory = (fx: Fixture) => join(fx.homes[0]!.home, "history.jsonl");

  it("Claude: the paste hash of a row that arrives after the plan is not destroyed; the next plan names it", () => {
    const fx = buildFixture("claude", scratch);
    const h = fx.homes[0]!.home, history = claudeHistory(fx), late = "ee00ee00ee00ee00";
    const planned = planEngineHistory(job(fx));
    writeFileSync(join(h, "paste-cache", `${late}.txt`), C("claude"));
    const fd = openSync(history, "a");
    const realPwrite = mutOps.pwrite;
    let appended = false;
    mutOps.pwrite = ((target: number, bytes: Buffer, position: number) => {
      realPwrite(target, bytes, position);
      if (!appended) { appended = true; writeSync(fd, dump({ sessionId: "sess-claude-1", project: fx.folders[0], display: "late-mine", pastedContents: { 1: { contentHash: late } } })); }
    }) as typeof mutOps.pwrite;
    let ran: ReturnType<typeof executeEnginePlans>;
    try { ran = executeEnginePlans(structuredClone(planned.plans!)); } finally { mutOps.pwrite = realPwrite; closeSync(fd); }
    // the row matches but the plan never listed it: the step did what it was given and the late row is the next plan's
    expect(ran.staleHomes).toEqual([]);
    expect(readFileSync(history, "utf8")).toContain("late-mine");
    expect(existsSync(join(h, "paste-cache", `${late}.txt`))).toBe(true);
    const verify = planEngineHistory(job(fx, { known: planned.discovery }));
    expect(JSON.stringify(verify.discovery)).toContain(late);
    expect(executeEnginePlans(structuredClone(verify.plans!)).failed).toEqual([]);
    expect(existsSync(join(h, "paste-cache", `${late}.txt`))).toBe(false);
    expect(readFileSync(history, "utf8")).not.toContain("late-mine");
  });
});

// ── the hold ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe("Murage's own sessions wait while a deleted conversation is removed from an engine's files", () => {
  const fakeInstance = (id: string) => {
    const listeners = new Set<(event: RuntimeEvent) => void>();
    const sent: string[] = [];
    const adapter = {
      capabilities: {},
      hasSession: () => true,
      onEvent: (listener: (event: RuntimeEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      sendTurn: async (input: { threadId: string }) => { sent.push(input.threadId); return { turnId: "t" }; },
    };
    const emit = (type: string, threadId: string) => { for (const listener of listeners) listener({ type, threadId } as unknown as RuntimeEvent); };
    return { instance: { instanceId: id, adapter, dispose: async () => {} } as unknown as ProviderInstance, sent, emit };
  };

  it("a turn sent during the hold waits with the authored note, then runs after the release", async () => {
    const holds = new InstanceHolds();
    const notes: string[] = [];
    holds.onWait = (_id, threadId) => notes.push(threadId);
    const fake = fakeInstance("claude-1");
    const decorated = decorateHoldInstance(fake.instance, holds);
    const held = await holds.hold(["claude-1"], 50, async () => undefined);
    expect(held.busy).toEqual([]);
    const sending = decorated.adapter.sendTurn({ threadId: "T1", text: "hi" } as never);
    await delay(40);
    expect(fake.sent).toEqual([]); // queued, not refused and not started
    expect(notes).toEqual(["T1"]);
    held.release();
    await sending;
    expect(fake.sent).toEqual(["T1"]);
    expect(WAITING_NOTE).toBe("Waiting while Murage finishes deleting a conversation.");
  });

  it("a running turn is never interrupted: the hold waits for it, and a home whose turn outlasts the wait is not held", async () => {
    const holds = new InstanceHolds();
    const fake = fakeInstance("claude-1");
    const decorated = decorateHoldInstance(fake.instance, holds);
    await decorated.adapter.sendTurn({ threadId: "T1", text: "long" } as never);
    fake.emit("turn.started", "T1");
    // finishes inside the wait
    const soon = holds.hold(["claude-1"], 500, async () => undefined);
    await delay(20);
    fake.emit("turn.completed", "T1");
    expect((await soon).busy).toEqual([]);
    (await soon).release();
    // and one that does not
    fake.emit("turn.started", "T1");
    const late = await holds.hold(["claude-1"], 30, async () => undefined);
    expect(late.busy).toEqual(["claude-1"]);
    expect(holds.isHeld("claude-1")).toBe(false); // not held: the owner's turn went on, and new turns are not blocked
    const next = await decorated.adapter.sendTurn({ threadId: "T2", text: "free" } as never);
    expect(next).toEqual({ turnId: "t" });
  });

  it("idle engine processes are closed for the hold and allowed again after it", async () => {
    const holds = new InstanceHolds();
    const events: string[] = [];
    const held = await holds.hold(["a", "b"], 10, async (id) => { events.push(`close ${id}`); return { confirmed: true, release: () => { events.push(`allow ${id}`); } }; });
    expect(events).toEqual(["close a", "close b"]);
    held.release();
    held.release();
    expect(events).toEqual(["close a", "close b", "allow a", "allow b"]);
  });

  it("the service takes the hold before the first plan (a warm idle engine reads as open), keeps it through the verifying plan, and releases it after", async () => {
    const fx = buildFixture("codex", scratch);
    const events: string[] = [];
    const { deletions } = serviceFor(fx, {
      holdHomes: async (homes) => { events.push(`hold ${homes.length}`); return { release: () => events.push("release"), skipped: [] }; },
    });
    useScript((message, worker) => { events.push(message.kind ?? "run"); answer(worker, message); });
    const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    expect(report.failed).toEqual([]);
    expect(events).toEqual(["probe", "hold 1", "plan", "execute", "plan", "release"]); // the read-only probe for other programs' holders (lane 106) comes first
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
    expect(deletions.pending()).toEqual([]);
  });

  it("a home whose own turn is still running after the wait is skipped this attempt: nothing is touched and the deletion stays pending", async () => {
    const fx = buildFixture("codex", scratch);
    const kinds: string[] = [];
    const { deletions } = serviceFor(fx, { holdHomes: async (homes) => ({ release: () => {}, skipped: homes }) });
    useScript((message, worker) => { kinds.push(message.kind ?? "run"); answer(worker, message); });
    const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    expect(report.failed).toContain(fx.homes[0]!.home);
    expect(kinds).toEqual(["probe"]); // the home is skipped before it is planned: only the read-only probe ran, neither a plan nor an execute job
    expect(canaryHits(fx.root, fx.canaries).length).toBeGreaterThan(0);
    expect(deletions.pending()).toHaveLength(1);
  });
});

// ── every attempt plans everything again ───────────────────────────────────────────────────────────────────────────

describe("nothing carries over from an earlier attempt as proof", () => {
  it("r14-3: Claude finishes, Kimi cannot be read, a Claude row appears, Kimi heals: the retry removes the Claude row before the record clears", async () => {
    const claude = buildFixture("claude", scratch);
    const folder = claude.folders[0]!;
    const kimiHome = join(claude.root, "home", ".kimi-code");
    const bucket = join(kimiHome, "sessions", kimiWorkDirKey(folder));
    mkdirSync(join(bucket, "s1"), { recursive: true });
    writeFileSync(join(bucket, "s1", "wire.jsonl"), C("kimi"));
    writeFileSync(join(kimiHome, "session_index.jsonl"), dump({ sessionId: "s1", workDir: folder, title: C("kimi") }) + dump({ sessionId: "s2", workDir: "/other", title: B("kimi") }));
    const homes = [...claude.homes, { engine: "kimi" as const, home: kimiHome }];
    const { data, db } = serviceFor(claude);
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [] });
    useScript((message, worker) => answer(worker, message));
    const letIn = keepOut(bucket, 0o000); // Kimi's sessions cannot be read (EACCES) or, on Windows, are held open by another program
    try {
      const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: homes }, () => true);
      expect(report.failed.some((item) => item.startsWith(kimiHome))).toBe(true); // the unreadable sessions folder
      expect(report.failed.some((item) => item.startsWith(claude.homes[0]!.home))).toBe(false);
    } finally { letIn(); }
    // Claude is clean now; its engine writes another row for this conversation
    const history = join(claude.homes[0]!.home, "history.jsonl");
    appendFileSync(history, dump({ sessionId: "sess-claude-1", project: folder, display: `${C("claude")}-after` }));
    expect(deletions.pending()).toHaveLength(1);
    const resumed = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [] });
    expect(await resumed.reconcile(() => false, () => undefined)).toBe(1);
    expect(readFileSync(history, "utf8")).not.toContain(`${C("claude")}-after`); // not skipped as "already verified"
    expect(readFileSync(history, "utf8")).toContain(B("claude"));
    expect(existsSync(bucket)).toBe(false);
    expect(resumed.pending()).toEqual([]);
  });

  it("an attempt that changes nothing but finds content in a fresh plan does not clear the record", async () => {
    const fx = buildFixture("codex", scratch);
    const { deletions } = serviceFor(fx);
    useScript((message, worker) => {
      if (message.kind === "execute") worker.emit("message", { type: "result", result: { removed: [], failed: [], leftovers: [], failedHomes: [], staleHomes: [], factsDelta: {} } });
      else answer(worker, message);
    });
    const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    expect(report.failed).toContain(fx.homes[0]!.home);
    expect(deletions.pending()).toHaveLength(1);
  });
});

// ── a home that keeps changing ─────────────────────────────────────────────────────────────────────────────────────

describe("a home that keeps going stale", () => {
  it("is planned again, waits for quiet inputs once it has gone stale twice, and then finishes", async () => {
    const fx = buildFixture("codex", scratch);
    const { deletions } = serviceFor(fx, { staleQuietMs: 30 });
    const kinds: string[] = [];
    let executes = 0;
    const started = Date.now();
    useScript((message, worker) => {
      kinds.push(message.kind ?? "run");
      if (message.kind === "execute" && ++executes <= 2) {
        // the engine changed the inputs under the step: nothing was done
        worker.emit("message", { type: "result", result: { removed: [], failed: [], leftovers: [], failedHomes: [], staleHomes: Object.keys(message.plans!), factsDelta: {} } });
      } else answer(worker, message);
    });
    const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    expect(report.failed).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    expect(kinds.filter((kind) => kind === "execute")).toHaveLength(3);
    expect(kinds.filter((kind) => kind === "plan").length).toBeGreaterThanOrEqual(4); // one per round, and the quiet check
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
  });

  it("is given up on after the rounds are used, as in use by the engine, and stays pending", async () => {
    const fx = buildFixture("codex", scratch);
    const { deletions } = serviceFor(fx, { staleQuietMs: 1 });
    useScript((message, worker) => {
      if (message.kind === "execute") worker.emit("message", { type: "result", result: { removed: [], failed: [], leftovers: [], failedHomes: [], staleHomes: Object.keys(message.plans!), factsDelta: {} } });
      else answer(worker, message);
    });
    const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    expect(report.failed).toContain(fx.homes[0]!.home);
    expect(deletions.pending()).toHaveLength(1);
  });
});

// ── what the owner is told ─────────────────────────────────────────────────────────────────────────────────────────

describe("when an engine keeps its files busy", () => {
  it("is bounded: the step goes stale each round, the retries run out, the owner gets the authored sentence, and the schedule goes on slowly", async () => {
    const fx = buildFixture("codex", scratch);
    const history = join(fx.homes[0]!.home, "history.jsonl");
    const tid = "019a0000-aaaa-7bbb-8ccc-000000000001";
    const owed: string[][] = [];
    const { deletions, data, db } = serviceFor(fx, { retryDelaysMs: [15], slowRetryMs: 40, staleQuietMs: 1, owedGraceMs: 0, onOwed: (notices) => owed.push(notices.map((item) => item.text)) });
    let appended = 0, plans = 0;
    useScript((message, worker) => {
      if (message.kind === "plan") plans++;
      answer(worker, message);
    });
    // the engine writes another row for the deleted conversation every time a blank is made durable, as soon as Murage lets go of the
    // file (on Windows the engine's lock keeps every writer out until then; elsewhere it would wait for the lock the same way)
    const real = { fsync: mutOps.fsync, close: mutOps.close };
    const synced = new Set<unknown>();
    mutOps.fsync = ((fd: number) => { real.fsync(fd); synced.add(fd); }) as typeof mutOps.fsync;
    mutOps.close = ((fd: number) => { real.close(fd); if (synced.delete(fd)) appendFileSync(history, dump({ session_id: tid, text: `line-${appended++}` })); }) as typeof mutOps.close;
    try {
      const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
      expect(report.failed).toContain(fx.homes[0]!.home);
      await delay(600);
    } finally { Object.assign(mutOps, real); }
    const sentence = "Codex was using its history. Murage tries again by itself and finishes removing this conversation.";
    expect(deletions.notices().map((item) => item.text)).toEqual([sentence]);
    expect(owed.filter((texts) => texts.length)).toEqual([[sentence]]); // broadcast once, when it appeared
    expect(deletions.pending()[0]!.owed?.items.map((item) => [item.engine, item.code, item.named])).toEqual([["codex", "using", true]]);
    expect(new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [], owedGraceMs: 0 }).notices().map((item) => item.text)).toEqual([sentence]); // it is in the record, so it survives a restart
    expect(plans).toBeGreaterThanOrEqual(4); // the first attempt, the one retry, then the slow repeats
    const text = readFileSync(history, "utf8");
    expect(text).toContain(B("codex"));
    for (const line of text.split("\n")) if (line.trim()) expect(() => JSON.parse(line), line).not.toThrow(); // nothing the engine wrote is cut or malformed
    deletions.dispose();
  });

  it("every sentence comes from the table: no path, no error, no em dash, never safe or unsafe", () => {
    const codes: OwedCode[] = ["using", "unreadable", "unopenable", "helper", "other"];
    for (const label of [...new Set(Object.values(ENGINE_LABEL)), "An engine"]) {
      for (const code of codes) {
        const text = ownerNoticeText(label, code);
        expect(text, `${label} ${code}`).not.toMatch(/—|–|[\\/]|\bsafe(ly|ty)?\b|\bunsafe\b|\bEIO\b|\bEACCES\b|\berror\b/i);
        // F16: short, and says Murage finishes this by itself
        expect(text).toMatch(/by itself|once it can/);
        expect(text).toContain(label);
      }
    }
    expect(ownerNoticeText("Claude Code", "using")).toBe("Claude Code was using its history. Murage tries again by itself and finishes removing this conversation.");
    expect(owedCodeOf("busy")).toBe("using");
    expect(owedCodeOf("changed")).toBe("using");
    expect(owedCodeOf("engine-running")).toBe("using");
    expect(owedCodeOf("/home/someone/.codex/history.jsonl is locked by its engine")).toBe("using");
    expect(owedCodeOf("EACCES")).toBe("unopenable");
    expect(owedCodeOf("EIO")).toBe("unreadable");
    expect(owedCodeOf("worker-unavailable")).toBe("helper");
    expect(owedCodeOf("helper")).toBe("helper");
    expect(owedCodeOf("engine-open")).toBe("engine-open");
    // the line for an engine that has its files open: exact words, with the engine named, same rules as the others
    for (const label of [...new Set(Object.values(ENGINE_LABEL))]) {
      const line = ownerNoticeText(label, "engine-open");
      expect(line).toBe(`${label} is open. Murage finishes removing this conversation from it by itself once ${label} is closed. Nothing is needed from you.`);
      expect(line).not.toMatch(/—|–|[\\/]|\bsafe(ly|ty)?\b|\bunsafe\b|\bEIO\b|\bEACCES\b|\berror\b|engine-open/i);
    }
    expect(owedCodeOf("something else: /home/someone/.codex/x")).toBe("other");
    expect(owedCodeOf(undefined)).toBe("other");
  });
});

