// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Engine-history deletion as plan / persist / execute / verify: content faults, an engine writing during the deletion, the
// saved plan and its step marks, and what a deletion that cannot finish says to the owner. The generic invariant over all 12
// engines is engine-history-invariant.test.ts.
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { ConversationDeletions, runConversationDeletion } from "./conversation-deletion.ts";
import { executeEnginePlans } from "./engine-exec.ts";
import { geminiNormalizedPath, qwenProjectKey } from "./engine-history-deletion.ts";
import { exclOps, fsOps } from "./engine-fs.ts";
import { engineHistoryTestHooks, type EngineHistoryJob } from "./engine-history-offthread.ts";
import { planEngineHistory, removeEngineHistoryFiles, runEngineHistoryJob } from "./engine-history-run.ts";
import { hasContentSteps, homeKey } from "./engine-plan-core.ts";
import { buildFixture, canaryHits, hasZstd, THREAD, treeDigest, type Fixture } from "./testing/engine-history-fixtures.ts";
import type { DeletionEngine } from "./conversation-deletion.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-plan-")));
const openDatabases: DatabaseSync[] = [];
afterAll(() => { for (const db of openDatabases) db.close(); removeTempDirSync(scratch); });
afterEach(() => { for (const name of Object.keys(engineHistoryTestHooks)) delete (engineHistoryTestHooks as Record<string, unknown>)[name]; });

const dump = (value: unknown) => `${JSON.stringify(value)}\n`;
const job = (fx: Fixture, extra: Record<string, unknown> = {}) => ({ homes: fx.homes, folders: fx.folders, memoryFolders: fx.memoryFolders, sessions: fx.sessions, kind: "plan" as const, ...extra });
const key = (fx: Fixture) => homeKey(fx.homes[0]!.engine, fx.homes[0]!.home);
const C = (engine: string) => `canary-${engine}-5521`;
const B = (engine: string) => `bystander-${engine}-9917`;
const raw = (file: string, text: string) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
/** A folder as an engine writes it inside a JSON string: a Windows backslash is escaped. */
const esc = (folder: string) => JSON.stringify(folder).slice(1, -1);
const gone = (file: string) => { try { lstatSync(file); return false; } catch { return true; } };

/** The whole deletion is refused for this fixture: nothing planned, nothing touched, the file named as the failure. */
function expectRefused(fx: Fixture, file: string): void {
  const before = treeDigest(fx.root);
  const planned = planEngineHistory(job(fx));
  expect(planned.failedHomes).toEqual([key(fx)]);
  expect(planned.plans).toEqual({});
  expect(planned.failed).toContain(file);
  const whole = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, {}, true);
  expect(whole.failed).toContain(file);
  expect(whole.removed).toEqual([]);
  expect(treeDigest(fx.root)).toBe(before);
}

describe("content that cannot be read is a failed read, never an empty one", () => {
  const rolloutZst = (fx: Fixture) => join(fx.homes[0]!.home, "archived_sessions", "rollout-2026-10-10T09-00-00-019a0000-aaaa-7bbb-8ccc-000000000002.jsonl.zst");

  it.skipIf(!hasZstd())("a corrupt zstd rollout", () => {
    const fx = buildFixture("codex", scratch);
    const file = rolloutZst(fx);
    writeFileSync(file, Buffer.from("this is not a zstd frame, and has no checksum"));
    expectRefused(fx, file);
  });

  it.skipIf(!hasZstd())("a Node without zstd support", () => {
    const fx = buildFixture("codex", scratch);
    const file = rolloutZst(fx);
    const real = fsOps.zstd;
    fsOps.zstd = () => { throw new Error("zstd support is not available in this Node"); };
    try { expectRefused(fx, file); } finally { fsOps.zstd = real; }
  });

  const tornCases: Array<[DeletionEngine, string, (fx: Fixture) => string, (fx: Fixture) => string]> = [
    ["claude", "history.jsonl", (fx) => join(fx.homes[0]!.home, "history.jsonl"), (fx) => `{"sessionId":"sess-claude-1","project":"${esc(fx.folders[0]!)}","display":"cut here`],
    ["codex", "history.jsonl", (fx) => join(fx.homes[0]!.home, "history.jsonl"), () => `{"session_id":"019a0000-aaaa-7bbb-8ccc-000000000001","text":"cut here`],
    ["kimi", "session_index.jsonl", (fx) => join(fx.homes[0]!.home, "session_index.jsonl"), (fx) => `{"sessionId":"s1","workDir":"${esc(fx.folders[0]!)}","title":"cut here`],
    ["grok", "logs/unified.jsonl", (fx) => join(fx.homes[0]!.home, "logs", "unified.jsonl"), () => `{"sid":"s-1","text":"cut here`],
    ["qwen", "a chat in the project", (fx) => join(fx.homes[0]!.home, "projects", qwenProjectKey(fx.folders[0]!), "chats", "b2c6d1a0-1111-4222-8333-444455556666.jsonl"), (fx) => `{"cwd":"${esc(fx.folders[0]!)}","message":"cut here`],
    ["gemini", "projects.json", (fx) => join(fx.homes[0]!.home, "projects.json"), (fx) => `{"projects":{"${esc(geminiNormalizedPath(fx.folders[0]!))}":"slug"`],
  ];
  for (const [engine, name, file, torn] of tornCases) {
    it(`${engine}: a torn line in ${name} that names the conversation`, () => {
      const fx = buildFixture(engine, scratch);
      const target = file(fx);
      if (engine === "gemini") writeFileSync(target, torn(fx));
      else appendFileSync(target, `${torn(fx)}\n`);
      expectRefused(fx, target);
    });
  }

  it("a torn line that names nothing of the conversation is kept as it is", () => {
    const fx = buildFixture("codex", scratch);
    const history = join(fx.homes[0]!.home, "history.jsonl");
    appendFileSync(history, `{"session_id":"someone-else","text":"cut here\n`);
    const result = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, {}, true);
    expect(result.failed).toEqual([]);
    const text = readFileSync(history, "utf8");
    expect(text).toContain(`{"session_id":"someone-else","text":"cut here`);
    expect(text).not.toContain(C("codex"));
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
  });

  const stores: Array<[DeletionEngine, (fx: Fixture) => string]> = [
    ["grok", (fx) => join(fx.homes[0]!.home, "sessions", "session_search.sqlite")],
    ["fuigo", (fx) => join(fx.homes[0]!.home, "sessions", "session_search.sqlite")],
    ["codex", (fx) => join(fx.homes[0]!.sqliteHome!, "state_1.sqlite")],
    ["opencode", (fx) => join(fx.homes[0]!.home, "opencode.db")],
    ["droid", (fx) => join(fx.homes[0]!.home, "cache", "session-index", "index.db")],
    ["hermes", (fx) => join(fx.homes[0]!.home, "state.db")],
    ["antigravity", (fx) => join(fx.homes[0]!.home, "conversation_summaries.db")],
  ];
  for (const [engine, file] of stores) {
    it(`${engine}: a SQLite file that is not a database`, () => {
      const fx = buildFixture(engine, scratch);
      const target = file(fx);
      writeFileSync(target, "this is not a database");
      rmSync(`${target}-wal`, { force: true });
      expectRefused(fx, target);
    });
  }
});

describe("an engine that keeps writing during the deletion", () => {
  it("Claude: a row appended after the plan that names a new paste is not touched by the step; nothing is destroyed until the new plan has the paste", () => {
    const fx = buildFixture("claude", scratch);
    const h = fx.homes[0]!.home, history = join(h, "history.jsonl"), late = "ee00ee00ee00ee00";
    const planned = planEngineHistory(job(fx));
    raw(join(h, "paste-cache", `${late}.txt`), C("claude"));
    appendFileSync(history, dump({ sessionId: "sess-claude-1", project: fx.folders[0], display: `${C("claude")}-late`, pastedContents: { 1: { contentHash: late } } }) + dump({ sessionId: "sess-new", project: "/other", display: `${B("claude")}-late` }));
    const ran = executeEnginePlans(structuredClone(planned.plans!));
    expect(ran.failed).toEqual([]);
    expect(ran.staleHomes).toEqual([]); // the planned rows were as planned; the late row is the next plan's
    expect(readFileSync(history, "utf8")).toContain(`${C("claude")}-late`); // the row it was not given is untouched, paste hash and all
    expect(existsSync(join(h, "paste-cache", `${late}.txt`))).toBe(true); // the paste is still there to be found
    const verify = planEngineHistory(job(fx, { known: planned.discovery }));
    expect(JSON.stringify(verify.discovery)).toContain(late); // the new plan names it
    expect(executeEnginePlans(structuredClone(verify.plans!)).failed).toEqual([]);
    expect(gone(join(h, "paste-cache", `${late}.txt`))).toBe(true);
    const text = readFileSync(history, "utf8");
    expect(text).not.toContain(C("claude"));
    expect(text).toContain(`${B("claude")}-late`);
    expect(text).toContain(B("claude"));
    expect(hasContentSteps(planEngineHistory(job(fx, { known: verify.discovery })).plans![key(fx)]!)).toBe(false);
    expect(fx.checkBystanders()).toEqual([]);
  });

  it("Codex: a row appended after the plan is neither cut nor skipped; a matching one is left for the next plan", () => {
    const fx = buildFixture("codex", scratch);
    const history = join(fx.homes[0]!.home, "history.jsonl");
    const tid = "019a0000-aaaa-7bbb-8ccc-000000000001";
    const planned = planEngineHistory(job(fx));
    appendFileSync(history, dump({ session_id: tid, text: "late-mine" }) + dump({ session_id: "newcomer", text: "late-other" }));
    const ran = executeEnginePlans(structuredClone(planned.plans!));
    expect(ran.failed).toEqual([]);
    expect(ran.staleHomes).toEqual([]);
    const text = readFileSync(history, "utf8");
    expect(text).toContain("late-mine"); // not in the plan, so not touched yet
    expect(text).toContain("late-other"); // another conversation's row survives byte for byte
    expect(text).toContain(B("codex"));
    const verify = planEngineHistory(job(fx, { known: planned.discovery }));
    expect(executeEnginePlans(structuredClone(verify.plans!)).failed).toEqual([]);
    expect(readFileSync(history, "utf8")).not.toContain("late-mine");
    expect(readFileSync(history, "utf8")).toContain("late-other");
  });

  it("Fuigo: the shared log is rewritten in place and never shortened; a row appended after the plan is neither cut nor skipped", () => {
    const fx = buildFixture("fuigo", scratch);
    const log = join(fx.homes[0]!.home, "logs", "unified.jsonl");
    const planned = planEngineHistory(job(fx));
    const sizeBefore = lstatSync(log).size;
    const ino = lstatSync(log).ino;
    appendFileSync(log, dump({ sid: "s-1", text: "tail-mine" }) + dump({ sid: "s-new", text: "tail-other" }));
    const ran = executeEnginePlans(structuredClone(planned.plans!));
    expect(ran.failed).toEqual([]);
    expect(ran.staleHomes).toEqual([]); // a matching row the plan did not list is the next plan's
    const text = readFileSync(log, "utf8");
    expect(text).not.toContain(C("fuigo")); // the planned rows are blank
    expect(text).toContain("tail-other");
    expect(text).toContain(B("fuigo"));
    expect(lstatSync(log).size).toBeGreaterThanOrEqual(sizeBefore); // nothing was cut
    expect(lstatSync(log).ino).toBe(ino); // and the file is the same file
    const verify = planEngineHistory(job(fx, { known: planned.discovery }));
    expect(executeEnginePlans(structuredClone(verify.plans!)).failed).toEqual([]);
    expect(readFileSync(log, "utf8")).not.toContain("tail-mine");
    expect(readFileSync(log, "utf8")).toContain("tail-other");
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
  });

  it("OpenCode: a child session added after the plan rolls the transaction back and goes, with its saved file, after the new plan", () => {
    const fx = buildFixture("opencode", scratch);
    const d = fx.homes[0]!.home;
    const planned = planEngineHistory(job(fx));
    const store = new DatabaseSync(join(d, "opencode.db"));
    store.prepare("INSERT INTO session VALUES(?,?,?,?)").run("ses_late", "ses_a", "/late", C("opencode"));
    store.prepare("INSERT INTO message VALUES(?,?,?)").run("m-late", "ses_late", C("opencode"));
    const sessionsBefore = Number((store.prepare("SELECT count(*) AS n FROM session").get() as { n: number }).n);
    store.close();
    raw(join(d, "storage", "session_diff", "ses_late.json"), C("opencode"));
    const ran = executeEnginePlans(structuredClone(planned.plans!));
    expect(ran.failed).toEqual([]);
    expect(ran.staleHomes).toEqual([key(fx)]);
    const check = new DatabaseSync(join(d, "opencode.db"));
    expect(Number((check.prepare("SELECT count(*) AS n FROM session").get() as { n: number }).n)).toBe(sessionsBefore); // ROLLBACK: nothing deleted
    check.close();
    expect(existsSync(join(d, "storage", "session_diff", "ses_late.json"))).toBe(true);
    const verify = planEngineHistory(job(fx, { known: planned.discovery }));
    expect(JSON.stringify(verify.discovery)).toContain("ses_late");
    expect(executeEnginePlans(structuredClone(verify.plans!)).failed).toEqual([]);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
    expect(fx.checkBystanders()).toEqual([]);
  });

  it("Hermes: a child session added after the plan makes the delete stale; the new plan removes it with its transcript", () => {
    const fx = buildFixture("hermes", scratch);
    const h = fx.homes[0]!.home, sid = "a1b2c3d4-1111-4222-8333-444455556666", late = "child-late-00001";
    const planned = planEngineHistory(job(fx));
    const store = new DatabaseSync(join(h, "state.db"));
    store.prepare("INSERT INTO sessions VALUES(?,?,?)").run(late, sid, "{}");
    store.prepare("INSERT INTO messages(session_id,content) VALUES(?,?)").run(late, C("hermes"));
    store.close();
    raw(join(h, "sessions", `${late}.jsonl`), C("hermes"));
    const ran = executeEnginePlans(structuredClone(planned.plans!));
    expect(ran.failed).toEqual([]);
    expect(ran.staleHomes).toEqual([key(fx)]);
    expect(existsSync(join(h, "sessions", `${late}.jsonl`))).toBe(true);
    const verify = planEngineHistory(job(fx, { known: planned.discovery }));
    expect(executeEnginePlans(structuredClone(verify.plans!)).failed).toEqual([]);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
    expect(fx.checkBystanders()).toEqual([]);
  });

  it("Fuigo: a session folder and its log row that appear after the plan are found by the folder moved aside; nothing is lost", () => {
    const fx = buildFixture("fuigo", scratch);
    const h = fx.homes[0]!.home, log = join(h, "logs", "unified.jsonl");
    const planned = planEngineHistory(job(fx));
    const bucket = Object.values(planned.plans!)[0]!.steps.find((step) => step.k === "remove" && step.expect)!;
    const target = (bucket as { target: string }).target;
    raw(join(target, "s-late", "events.jsonl"), C("fuigo"));
    appendFileSync(log, dump({ sid: "s-late", text: `${C("fuigo")}-late` }));
    const ran = executeEnginePlans(structuredClone(planned.plans!));
    expect(ran.staleHomes).toEqual([key(fx)]);
    expect(existsSync(join(target, "s-late", "events.jsonl"))).toBe(true); // kept, and put back where its engine finds it
    expect(existsSync(`${target}.murage-deleting`)).toBe(false);
    expect(existsSync(join(target, "s-1"))).toBe(false); // the listed entry did go, on its own
    const verify = planEngineHistory(job(fx, { known: planned.discovery }));
    expect(JSON.stringify(verify.discovery)).toContain("s-late"); // the folder was listed
    expect(executeEnginePlans(structuredClone(verify.plans!)).failed).toEqual([]);
    expect(existsSync(`${target}.murage-deleting`)).toBe(false);
    expect(readFileSync(log, "utf8")).not.toContain(`${C("fuigo")}-late`);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
    expect(fx.checkBystanders()).toEqual([]);
  });

  it("Fuigo: a crash right after the folder was moved aside leaves an aside the next plan lists and removes", () => {
    const fx = buildFixture("fuigo", scratch);
    const h = fx.homes[0]!.home;
    const planned = planEngineHistory(job(fx));
    const bucket = Object.values(planned.plans!)[0]!.steps.find((step) => step.k === "remove" && step.expect)! as { target: string };
    raw(join(bucket.target, "s-late", "events.jsonl"), C("fuigo"));
    appendFileSync(join(h, "logs", "unified.jsonl"), dump({ sid: "s-late", text: `${C("fuigo")}-late` }));
    const real = exclOps.renameNoReplace;
    exclOps.renameNoReplace = ((from: string, to: string) => { real(from, to); throw new Error("crash after the rename"); }) as typeof exclOps.renameNoReplace;
    try { executeEnginePlans(structuredClone(planned.plans!)); } finally { exclOps.renameNoReplace = real; }
    expect(existsSync(`${bucket.target}.murage-deleting`)).toBe(true);
    expect(existsSync(bucket.target)).toBe(false);
    const result = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, {}, true);
    expect(result.failed).toEqual([]);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
    expect(fx.checkBystanders()).toEqual([]);
  });
});

describe("what the plan decides", () => {
  it("Qwen: a project whose chats name another folder is a leftover for the owner, not a failure that never ends", () => {
    const fx = buildFixture("qwen", scratch);
    const project = join(fx.homes[0]!.home, "projects", fx.folders[0]!.replace(/[^a-zA-Z0-9]/g, "-"));
    raw(join(project, "chats", "shared.jsonl"), dump({ cwd: "/another/folder", message: "theirs" }));
    const result = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, {}, true);
    expect(result.failed).toEqual([]);
    expect(result.leftovers.map((item) => item.what)).toContain("Qwen Code's history of this conversation");
    expect(existsSync(project)).toBe(true);
    expect(gone(join(fx.homes[0]!.home, "todos", "b2c6d1a0-1111-4222-8333-444455556666.json"))).toBe(true);
  });

  it("Cursor: the session ids are saved with the plan, like every other engine's", () => {
    const fx = buildFixture("cursor", scratch);
    const planned = planEngineHistory(job(fx));
    expect(Object.values(planned.discovery!).some((facts) => facts.sessions?.includes("current-session"))).toBe(true);
  });

  it("Claude: debug/latest is unlinked only when it points at one of these sessions", () => {
    const fx = buildFixture("claude", scratch);
    expect(removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, {}, true).failed).toEqual([]);
    expect(gone(join(fx.homes[0]!.home, "debug", "latest"))).toBe(true);
    const other = buildFixture("claude", scratch);
    const debug = join(other.homes[0]!.home, "debug");
    rmSync(join(debug, "latest"));
    raw(join(debug, "elsewhere.txt"), "x");
    symlinkSync(join(debug, "elsewhere.txt"), join(debug, "latest"));
    expect(removeEngineHistoryFiles(other.homes, other.folders, other.memoryFolders, other.sessions, {}, true).failed).toEqual([]);
    expect(gone(join(debug, "latest"))).toBe(false);
  });
});

/** A worker the test scripts: it answers each job the way the script says. */
class ScriptedWorker extends EventEmitter {
  threadId = 9;
  readonly script: (job: EngineHistoryJob, worker: ScriptedWorker) => void;
  constructor(script: (job: EngineHistoryJob, worker: ScriptedWorker) => void) { super(); this.script = script; }
  postMessage(job: EngineHistoryJob) { setImmediate(() => this.script(job, this)); }
  terminate() { setImmediate(() => this.emit("exit", 0)); return Promise.resolve(0); }
}
const useScript = (script: (job: EngineHistoryJob, worker: ScriptedWorker) => void) => {
  engineHistoryTestHooks.createWorker = () => new ScriptedWorker(script) as unknown as Worker;
};
const answer = (worker: ScriptedWorker, job: EngineHistoryJob, onStep?: (key: string, index: number) => void) => worker.emit("message", { type: "result", result: runEngineHistoryJob(job, onStep) });

function serviceFor(fx: Fixture, retryDelaysMs: number[] = []) {
  const data = join(fx.root, "data");
  const db = new DatabaseSync(join(data, "messages.db"));
  openDatabases.push(db);
  return { data, db, deletions: new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs }) };
}
const resume = async (data: string, db: DatabaseSync) => new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [] }).reconcile(() => false, () => undefined);

describe("the saved plan", () => {
  it("is in the pending record, with the ids it found, before the first engine step runs; a worker that dies leaves it for the replay", async () => {
    const fx = buildFixture("codex", scratch);
    const { data, db, deletions } = serviceFor(fx);
    const homeTree = join(fx.root, "home");
    const before = treeDigest(homeTree);
    const seen: Array<{ plan: unknown; discovery: unknown; digest: string }> = [];
    useScript((job, worker) => {
      if (job.kind === "execute") {
        const [entry] = new ConversationDeletions({ dataDir: data, database: () => db }).pending();
        seen.push({ plan: entry?.enginePlan, discovery: entry?.engineDiscovery, digest: treeDigest(homeTree) });
        worker.emit("exit", 1); // the worker dies before running anything
      } else answer(worker, job);
    });
    const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    expect(report.failed.length).toBeGreaterThan(0);
    expect(seen).toHaveLength(1);
    const plan = (seen[0]!.plan as { homes: Record<string, { steps: Array<{ k: string; done?: boolean }> }> }).homes[key(fx)]!;
    expect(plan.steps.length).toBeGreaterThan(3);
    expect(plan.steps.every((step) => !step.done)).toBe(true);
    expect(JSON.stringify(seen[0]!.discovery)).toContain("019a0000-aaaa-7bbb-8ccc-000000000001"); // the thread ids are in the record already
    expect(seen[0]!.digest).toBe(before); // and nothing of the engine was touched yet
    expect(deletions.pending()).toHaveLength(1);
    delete (engineHistoryTestHooks as Record<string, unknown>).createWorker;
    expect(await resume(data, db)).toBe(1);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
    expect(fx.checkBystanders()).toEqual([]);
    expect(new ConversationDeletions({ dataDir: data, database: () => db }).pending()).toEqual([]);
  });

  it("keeps a done mark for every step that finished; the replay starts from a fresh plan and does only what is left", async () => {
    const fx = buildFixture("claude", scratch);
    const { data, db, deletions } = serviceFor(fx);
    const FINISHED = 3;
    let plannedSteps = 0;
    useScript((job, worker) => {
      if (job.kind !== "execute") return answer(worker, job);
      // the first FINISHED steps really run and are reported one by one; then the worker dies
      const [planKey, plan] = Object.entries(job.plans!)[0]!;
      plannedSteps = plan.steps.length;
      runEngineHistoryJob({ ...job, plans: { [planKey]: { ...plan, steps: plan.steps.slice(0, FINISHED) } } }, (stepKey, index) => worker.emit("message", { type: "step", key: stepKey, index }));
      worker.emit("exit", 1);
    });
    const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    expect(report.failed.length).toBeGreaterThan(0);
    const [saved] = deletions.pending();
    const marks = saved!.enginePlan!.homes[key(fx)]!.steps.map((step) => Boolean(step.done));
    expect(marks.slice(0, FINISHED)).toEqual([true, true, true]);
    expect(marks.slice(FINISHED).some(Boolean)).toBe(false);
    const executed: boolean[][] = [];
    useScript((job, worker) => {
      if (job.kind === "execute") for (const plan of Object.values(job.plans!)) executed.push(plan.steps.map((step) => Boolean(step.done)));
      answer(worker, job);
    });
    expect(await resume(data, db)).toBe(1);
    // nothing earlier counts as proof: the replay planned everything again, so what it ran is only what was still there
    expect(executed[0]!.every((done) => !done)).toBe(true);
    expect(executed[0]!.length).toBeLessThan(plannedSteps);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
  });

  it("is verified: an executor that reports success but removed nothing does not clear the deletion", async () => {
    const fx = buildFixture("codex", scratch);
    const { deletions } = serviceFor(fx);
    const kinds: string[] = [];
    useScript((job, worker) => {
      kinds.push(job.kind ?? "run");
      if (job.kind === "execute") worker.emit("message", { type: "result", result: { removed: [], failed: [], leftovers: [], failedHomes: [], factsDelta: {} } });
      else answer(worker, job);
    });
    const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    expect(report.failed).toContain(fx.homes[0]!.home);
    expect(deletions.pending()).toHaveLength(1);
    expect(kinds).toEqual(["probe", "plan", "execute", "plan", "execute", "plan", "execute", "plan"]); // three rounds, each verified, then given up
    expect(canaryHits(fx.root, fx.canaries).length).toBeGreaterThan(0);
  });

  it("after the retry schedule is used up, the owner gets a notice in authored words, saved with the record; the deletion is still not done", async () => {
    if (!hasZstd()) return;
    const fx = buildFixture("codex", scratch);
    const owed: string[][] = [];
    const data = join(fx.root, "data");
    const db = new DatabaseSync(join(data, "messages.db"));
    openDatabases.push(db);
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [20], slowRetryMs: 60_000, owedGraceMs: 0, onOwed: (notices) => owed.push(notices.map((item) => item.text)) });
    const zst = join(fx.homes[0]!.home, "archived_sessions", "rollout-2026-10-10T09-00-00-019a0000-aaaa-7bbb-8ccc-000000000002.jsonl.zst");
    writeFileSync(zst, "not a zstd frame");
    const first = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    expect(first.report.failed).toContain(zst);
    expect(deletions.notices()).toEqual([]); // the schedule is not used up yet
    await new Promise((resolve) => setTimeout(resolve, 300)); // the one retry runs and fails the same way
    const [notice] = deletions.notices();
    expect(notice?.text).toBe("Murage is still removing this conversation from Codex. It finishes this by itself. Nothing is needed from you.");
    expect(notice?.tryAgain).toBe(true);
    expect(owed.at(-1)).toEqual([notice!.text]); // broadcast once, when it appeared
    expect(deletions.pending()[0]!.owed?.items.map((item) => [item.engine, item.code, item.named])).toEqual([["codex", "other", true]]); // saved with the record, as a code
    expect(JSON.stringify(deletions.pending()[0])).not.toContain(zst.replace(fx.homes[0]!.home, "")); // no path in what is saved for the owner
    expect(deletions.pending()).toHaveLength(1);
    // Try again now replays at once; when the cause is gone it finishes and the notice goes away
    rmSync(zst, { force: true });
    expect((await deletions.retryNow()).line).toBe("Removed from Codex."); // the copy is gone and the owner is told, in the retry's answer
    expect(deletions.notices()).toEqual([]); // F16: no "Removed from" line stays behind
    expect(deletions.pending()).toEqual([]);
    expect(owed.at(-1)).toEqual([]);
    deletions.dispose();
  });
});
