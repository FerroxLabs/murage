// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// r21: every row a cut or failed write leaves half done is finished, whatever else ran on the same file since and whatever name the file
// has now; Kimi's two files are joined without losing a row an engine was still writing and without a second copy after a cut; Claude
// Code's prompts are found in its history after its transcripts are gone; "is open" is said only when an engine or its lock was seen; a
// file taken out of reach is removed only once nothing can still be writing to it; and the process check reads every engine (and only
// the engine) the way the systems really show it.
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConversationDeletions, runConversationDeletion } from "./conversation-deletion.ts";
import { engineState, processVerdict } from "./engine-closed.ts";
import type { NativeProcess } from "./engine-exclusion.ts";
import { executeEnginePlans, recoverAll } from "./engine-exec.ts";
import { exclOps, mutOps, realEngineFs } from "./engine-fs.ts";
import { engineHistoryTestHooks, type EngineHistoryJob } from "./engine-history-offthread.ts";
import { planEngineHistory, removeEngineHistoryFiles as removeRaw, runEngineHistoryJob } from "./engine-history-run.ts";
import { homeKey, Known, Planner, type HomePlanData } from "./engine-plan-core.ts";
import { redoDirectory } from "./engine-redo.ts";
import { useFakeExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { legacyRejoin, buildFixture, canaryHits, type Fixture } from "./testing/engine-history-fixtures.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const removeEngineHistoryFiles = legacyRejoin(removeRaw);
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-r21-")));
const openDatabases: DatabaseSync[] = [];
afterAll(() => { for (const db of openDatabases) db.close(); removeTempDirSync(scratch); });

let fake: FakeExclusion;
beforeEach(() => { fake = useFakeExclusion(); clearJournals(); });
afterEach(() => {
  fake.restore();
  for (const name of Object.keys(engineHistoryTestHooks)) delete (engineHistoryTestHooks as Record<string, unknown>)[name];
});

const dump = (value: unknown) => `${JSON.stringify(value)}\n`;
const job = (fx: Fixture) => ({ homes: fx.homes, folders: fx.folders, memoryFolders: fx.memoryFolders, sessions: fx.sessions, kind: "plan" as const });
const key = (fx: Fixture) => homeKey(fx.homes[0]!.engine, fx.homes[0]!.home);
const C = (engine: string) => `canary-${engine}-5521`;
const B = (engine: string) => `bystander-${engine}-9917`;
function clearJournals(): void { const dir = redoDirectory(); if (dir && existsSync(dir)) for (const name of readdirSync(dir)) rmSync(join(dir, name), { force: true }); }
const journalFiles = (): string[] => { const dir = redoDirectory(); return dir && existsSync(dir) ? readdirSync(dir) : []; };
const rows = (file: string): string[] => readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
const everyRowParses = (file: string): boolean => rows(file).every((line) => { try { JSON.parse(line); return true; } catch { return false; } });
const eio = () => Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });

/** A plan of one file's rows, made by the planner itself (whatever it keeps of a row is what the executor compares). */
function planRows(engine: string, home: string, file: string, format: string, how: "lock" | "exclusive", field: string, values: string[]): Record<string, HomePlanData> {
  const pl = new Planner(realEngineFs(), new Known());
  pl.rewrite(file, { pred: { any: [{ field, op: "in", values }] }, needles: values, format, how });
  return { [homeKey(engine, home)]: { engine, home, steps: pl.steps } as HomePlanData };
}

/** The next overwrite puts `keep` of its bytes on the disk and then fails (EIO), as a disk error or a pulled cable would. */
function failNextWrite(keep: number, when: (bytes: Buffer) => boolean = () => true): () => void {
  const real = mutOps.pwrite;
  let done = false;
  mutOps.pwrite = ((fd: number, bytes: Buffer, position: number) => {
    if (!done && when(bytes)) { done = true; if (keep > 0) writeSync(fd, bytes, 0, keep, position); throw eio(); }
    return real(fd, bytes, position);
  }) as typeof mutOps.pwrite;
  return () => { mutOps.pwrite = real; };
}

// ── P1: a journal is never overwritten, and it finds its file by identity ────────────────────────────────────────────────

describe("a row a failed write left torn is finished, whatever ran on the file since and whatever its name is now", () => {
  it("Fuigo: two deletions planned before either runs; the first tears its row and fails, the second runs; the first row is still finished", () => {
    const fx = buildFixture("fuigo", scratch);
    const home = fx.homes[0]!.home;
    const log = join(home, "logs", "unified.jsonl");
    // a value that starts with an escaped quote: two bytes of its fill break the row
    writeFileSync(log, dump({ sid: "s-1", text: `"PRIVATE-A ${C("fuigo")}` }) + dump({ sid: "s-other", text: B("fuigo") }) + dump({ sid: "s-2", text: "PRIVATE-B-CANARY" }));
    const planA = planRows("fuigo", home, log, "fuigo-unified", "lock", "sid", ["s-1"]);
    const planB = planRows("fuigo", home, log, "fuigo-unified", "lock", "sid", ["s-2"]);
    const restore = failNextWrite(2);
    let first: ReturnType<typeof executeEnginePlans>;
    try { first = executeEnginePlans(structuredClone(planA)); } finally { restore(); }
    expect(first.failed.length).toBeGreaterThan(0);
    expect(everyRowParses(log)).toBe(false); // the first row is torn, and only its journal can finish it
    executeEnginePlans(structuredClone(planB)); // the second deletion's own step: it never replaces the first one's journal
    const recovered = recoverAll();
    expect(recovered.pending).toEqual([]);
    expect(everyRowParses(log)).toBe(true);
    expect(readFileSync(log, "utf8")).not.toContain(C("fuigo"));
    // the second deletion, planned again, finishes too
    expect(executeEnginePlans(structuredClone(planRows("fuigo", home, log, "fuigo-unified", "lock", "sid", ["s-2"]))).failed).toEqual([]);
    expect(readFileSync(log, "utf8")).not.toContain("PRIVATE-B-CANARY");
    expect(rows(log).filter((line) => line.includes(B("fuigo")))).toEqual([JSON.stringify({ sid: "s-other", text: B("fuigo") })]);
    expect(journalFiles()).toEqual([]);
  });

  it("Kimi: a title that starts with an escaped quote is torn while the index is aside; the index is put back under its name; it is still finished", () => {
    const fx = buildFixture("kimi", scratch);
    const index = join(fx.homes[0]!.home, "session_index.jsonl");
    const title = `"PRIVATE-CRASH-CANARY ${C("kimi")}`;
    writeFileSync(index, dump({ sessionId: "s1", workDir: fx.folders[0], title }) + dump({ sessionId: "s2", workDir: "/other", title: B("kimi") }));
    const planned = planEngineHistory(job(fx));
    const restore = failNextWrite(2);
    let ran: ReturnType<typeof executeEnginePlans>;
    try { ran = executeEnginePlans(structuredClone(planned.plans!)); } finally { restore(); }
    expect(ran.failed.length).toBeGreaterThan(0);
    expect(existsSync(index)).toBe(true); // given back under its name after the failure
    expect(existsSync(`${index}.murage-deleting`)).toBe(false);
    expect(everyRowParses(index)).toBe(false);
    expect(recoverAll().pending).toEqual([]);
    expect(everyRowParses(index)).toBe(true);
    expect(readFileSync(index, "utf8")).not.toContain("PRIVATE-CRASH-CANARY");
    expect(journalFiles()).toEqual([]);
    const again = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(again.failedHomes).toEqual([]);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
    expect(fx.checkBystanders()).toEqual([]);
  });
});

// ── P1: REJOIN ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A Kimi home as an earlier attempt left it: the old index set aside, and the new one Kimi started at the name meanwhile. */
function forkedKimi(): { fx: Fixture; index: string; newer: string[] } {
  const fx = buildFixture("kimi", scratch);
  const index = join(fx.homes[0]!.home, "session_index.jsonl");
  writeFileSync(`${index}.murage-deleting`, readFileSync(index));
  const newer = [dump({ sessionId: "s3", workDir: "/third", title: "NEWER-ROW-ONE" }), dump({ sessionId: "s4", workDir: "/fourth", title: "NEWER-ROW-TWO" })];
  writeFileSync(index, newer.join(""));
  return { fx, index, newer };
}

describe("REJOIN: the engine's newer rows are joined once, whole, and never lost", () => {
  it("a join cut after ten bytes is completed in place at the next attempt: no torn fragment, no second copy", () => {
    const { fx, index, newer } = forkedKimi();
    const restore = failNextWrite(10, (bytes) => bytes.includes("NEWER-ROW-ONE"));
    try { removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions); } finally { restore(); }
    const again = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(again.failedHomes).toEqual([]);
    expect(everyRowParses(index)).toBe(true);
    const text = readFileSync(index, "utf8");
    for (const row of newer) expect(text.split(row).length - 1, row).toBe(1);
    expect(text).toContain(B("kimi"));
    expect(text).not.toContain(C("kimi"));
    expect(existsSync(`${index}.murage-rejoining`)).toBe(false);
    expect(journalFiles()).toEqual([]);
  });

  it("an engine that opened the new file before it was moved and writes to it after it was read: nothing is unlinked while it runs, and its row is joined once it ends", () => {
    const { fx, index, newer } = forkedKimi();
    const late = dump({ sessionId: "s5", workDir: "/fifth", title: "LOST-BYSTANDER" });
    const engineFd = openSync(index, "a"); // Kimi's own descriptor, opened just after the last look
    const realOpen = mutOps.openRead, realPread = mutOps.pread;
    let secondFd: unknown = null, wrote = false;
    mutOps.openRead = ((path: string) => { const fd = realOpen(path); if (path.endsWith(".murage-rejoining")) secondFd = fd; return fd; }) as typeof mutOps.openRead;
    mutOps.pread = ((fd: number, length: number, position: number) => {
      const bytes = realPread(fd, length, position);
      if (!wrote && fd === secondFd) { wrote = true; writeSync(engineFd, late); fake.openEngine("kimi"); } // the engine is running, and writes
      return bytes;
    }) as typeof mutOps.pread;
    let first: ReturnType<typeof removeEngineHistoryFiles>;
    try { first = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions); } finally { mutOps.openRead = realOpen; mutOps.pread = realPread; }
    expect(wrote).toBe(true);
    expect(first.failedHomes).toEqual([key(fx)]);
    expect(existsSync(`${index}.murage-rejoining`)).toBe(true); // not unlinked while an engine could still write to it
    closeSync(engineFd);
    fake.processes = []; // the engine ends
    const again = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(again.failedHomes).toEqual([]);
    const text = readFileSync(existsSync(index) ? index : `${index}.murage-deleting`, "utf8");
    for (const row of [...newer, late]) expect(text.split(row).length - 1, row).toBe(1);
    expect(everyRowParses(index)).toBe(true);
    expect(existsSync(`${index}.murage-rejoining`)).toBe(false);
  });

  it("three files (an older aside, a join cut before its unlink, and a third file Kimi made since) are all joined, oldest first", () => {
    const { fx, index, newer } = forkedKimi();
    // the earlier attempt moved the new file to the private name and stopped there; Kimi then made a third file at the name
    writeFileSync(`${index}.murage-rejoining`, newer.join(""));
    const third = dump({ sessionId: "s6", workDir: "/sixth", title: "THIRD-FILE-ROW" });
    writeFileSync(index, third);
    const ran = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(ran.failedHomes).toEqual([]);
    const text = readFileSync(index, "utf8");
    for (const row of [...newer, third]) expect(text.split(row).length - 1, row).toBe(1);
    expect(text.indexOf("NEWER-ROW-ONE")).toBeLessThan(text.indexOf("THIRD-FILE-ROW"));
    expect(existsSync(`${index}.murage-rejoining`)).toBe(false);
  });
});

// ── P1: Claude Code's history without its transcripts ────────────────────────────────────────────────────────────────

describe("Claude Code's history is cleared when the conversation's transcripts and project folder are already gone", () => {
  it("by the folder a row names, and by the session ids Murage recorded", () => {
    const root = mkdtempSync(join(scratch, "claude-orphan-"));
    const folder = join(root, "work");
    mkdirSync(folder);
    const home = join(root, ".claude");
    mkdirSync(home);
    const history = join(home, "history.jsonl");
    writeFileSync(history, dump({ sessionId: "s-gone", project: folder, display: "PRIVATE-ORPHAN" }) + dump({ sessionId: "s-moved", project: "/elsewhere", display: "PRIVATE-BY-ID" }) + dump({ sessionId: "o", project: "/other", display: B("claude") }));
    const result = removeEngineHistoryFiles([{ engine: "claude", home }], [folder], [], { claude: ["s-moved"] });
    expect(result.failedHomes).toEqual([]);
    const text = readFileSync(history, "utf8");
    expect(text).not.toContain("PRIVATE-ORPHAN");
    expect(text).not.toContain("PRIVATE-BY-ID");
    expect(text).toContain(B("claude"));
    expect(everyRowParses(history)).toBe(true);
  });
});

// ── P2: "is open" only when an engine or its lock was seen ───────────────────────────────────────────────────────────

class ScriptedWorker extends EventEmitter {
  threadId = 21;
  readonly script: (job: EngineHistoryJob, worker: ScriptedWorker) => void;
  constructor(script: (job: EngineHistoryJob, worker: ScriptedWorker) => void) { super(); this.script = script; }
  postMessage(message: EngineHistoryJob) { setImmediate(() => this.script(message, this)); }
  terminate() { setImmediate(() => this.emit("exit", 0)); return Promise.resolve(0); }
}

describe("the owner hears 'is open' only when an engine or its lock was seen", () => {
  it("the verifying plan cannot read the process list: the owner is told Murage could not check, not that the engine is open", async () => {
    const fx = buildFixture("claude", scratch);
    const data = join(fx.root, "data");
    mkdirSync(data, { recursive: true });
    const db = new DatabaseSync(join(data, "messages.db"));
    openDatabases.push(db);
    let executed = false;
    engineHistoryTestHooks.createWorker = () => new ScriptedWorker((message, worker) => {
      if (message.kind === "execute") executed = true;
      if (message.kind === "plan" && executed) fake.processesFail = true; // the list cannot be read while the result is checked
      worker.emit("message", { type: "result", result: runEngineHistoryJob(message) });
    }) as unknown as Worker;
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [], owedGraceMs: 0 });
    await runConversationDeletion(deletions, { threadIds: ["2e9018ee-1f45-46be-8ed1-7a02fc022807"], engineHomes: fx.homes }, () => true);
    expect(executed).toBe(true);
    expect(deletions.pending()[0]!.owed?.items.map((item) => [item.engine, item.code])).toEqual([["claude", "engine-unchecked"]]);
    const said = deletions.notices().map((item) => item.text).join(" ");
    expect(said).toContain("Murage could not check whether Claude Code is open. It checks again within 10 minutes");
    expect(said).not.toMatch(/^Claude Code is open\./);
    deletions.dispose();
  });
});

// ── P2: removed only once nothing can still be writing ──────────────────────────────────────────────────────────────

describe("a file taken out of reach is removed only once nothing can still be writing to it", () => {
  it("Codex: a resume that opened a rollout before it was moved aside, and writes to it after: the rollout goes back with its row, nothing is removed", () => {
    const fx = buildFixture("codex", scratch);
    const late = dump({ type: "response_item", payload: { text: "LATE-ROW-IN-FLIGHT" } });
    const realRename = exclOps.renameNoReplace;
    let moved: { from: string; to: string } | null = null;
    exclOps.renameNoReplace = ((from: string, to: string) => {
      const outcome = realRename(from, to);
      if (!moved && outcome === "ok" && /rollout-.*\.jsonl$/.test(from)) {
        moved = { from, to };
        writeFileSync(to, readFileSync(to, "utf8") + late); // the engine's descriptor, opened before the move, still writes
        fake.openEngine("codex"); // and the engine is running
      }
      return outcome;
    }) as typeof exclOps.renameNoReplace;
    const ran = executeEnginePlans(structuredClone(planEngineHistory(job(fx)).plans!));
    expect(moved).not.toBeNull();
    expect(ran.homeReasons[key(fx)]).toBe("engine-open");
    expect(readFileSync(moved!.from, "utf8")).toContain("LATE-ROW-IN-FLIGHT"); // back under its name, with the row
    expect(existsSync(moved!.to)).toBe(false);
  });

  it("Windows: the mark that deletes a held file is set only while the hold is young; a stall leaves every file where it is", () => {
    fake.restore();
    fake = useFakeExclusion("win32");
    const fx = buildFixture("gemini", scratch);
    const planned = planEngineHistory(job(fx));
    let clock = 0;
    const realNow = mutOps.now;
    mutOps.now = () => (clock += 600); // every look at the clock finds Murage stalled for 600 ms
    let ran: ReturnType<typeof executeEnginePlans>;
    try { ran = executeEnginePlans(structuredClone(planned.plans!)); } finally { mutOps.now = realNow; }
    expect(ran.staleHomes).toEqual([key(fx)]);
    for (const path of fx.gone) expect(existsSync(path), path).toBe(true);
  });

  it("a write the system cuts short is finished piece by piece, the guard asked before every piece", () => {
    const fx = buildFixture("fuigo", scratch);
    const log = join(fx.homes[0]!.home, "logs", "unified.jsonl");
    const planned = planEngineHistory(job(fx));
    const real = mutOps.pwrite;
    let pieces = 0;
    mutOps.pwrite = ((fd: number, bytes: Buffer, position: number) => { pieces++; return writeSync(fd, bytes, 0, 1, position); }) as typeof mutOps.pwrite;
    let ran: ReturnType<typeof executeEnginePlans>;
    try { ran = executeEnginePlans(structuredClone(planned.plans!)); } finally { mutOps.pwrite = real; }
    expect(ran.failed).toEqual([]);
    expect(readFileSync(log, "utf8")).not.toContain(C("fuigo"));
    expect(everyRowParses(log)).toBe(true);
    expect(pieces).toBe(JSON.stringify(C("fuigo")).length); // one byte a time: the whole value, every piece written
  });
});

// ── the saved plan keeps no hash of what it removes ────────────────────────────────────────────────────────────────

describe("the saved plan holds no hash of the words it is there to remove", () => {
  it("a planned row is named by its skeleton: no hash of the row, or of its content, is in the plan", () => {
    const fx = buildFixture("fuigo", scratch);
    const row = JSON.stringify({ sid: "s-1", text: C("fuigo") });
    const saved = JSON.stringify(planEngineHistory(job(fx)).plans);
    const full = createHash("sha256").update(row).digest("hex");
    expect(saved).not.toContain(full.slice(0, 16));
    expect(saved).not.toContain(createHash("sha256").update(C("fuigo")).digest("hex").slice(0, 16));
    expect(saved).not.toContain(C("fuigo"));
  });
});

// ── the gate reads what the systems really show ──────────────────────────────────────────────────────────────────

describe("the process check counts the engine, and only the engine, as the systems show it", () => {
  const P = (exe: string | null, argv: string[] | null, extra: Partial<NativeProcess> = {}): NativeProcess => ({ pid: 777, ppid: 1, mine: true, uid: 1000, start: 1, exe, argv, comm: exe ? exe.split(/[\\/]/).pop()!.slice(0, 15) : null, ...extra });

  it("Chrome's 'Claude in Chrome' helper inside Claude.app is not the Claude app; the app's own program is", () => {
    const helper = "/Applications/Claude.app/Contents/Helpers/chrome-native-host";
    expect(processVerdict("claude", [P(helper, [helper, "chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/"])], 1).state).toBe("closed");
    expect(processVerdict("claude", [P("/Applications/Claude.app/Contents/MacOS/Claude", ["/Applications/Claude.app/Contents/MacOS/Claude"])], 1)).toEqual({ state: "open", app: "Claude" });
    expect(processVerdict("claude", [P("/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper", ["x"])], 1)).toEqual({ state: "open", app: "Claude" });
  });

  it("Windows: the Claude app (AnthropicClaude) is told as the app", () => {
    const exe = "C:\\Users\\u\\AppData\\Local\\AnthropicClaude\\app-1.2.3\\Claude.exe";
    expect(processVerdict("claude", [P(exe, [exe])], 1)).toEqual({ state: "open", app: "Claude" });
  });

  it("Hermes' long-running gateway is not Hermes in use; Hermes itself is", () => {
    const python = "/home/u/.hermes/hermes-agent/venv/bin/python";
    expect(processVerdict("hermes", [P(python, [python, "-m", "hermes_cli.main", "--profile", "default", "gateway", "run"])], 1).state).toBe("closed");
    expect(processVerdict("hermes", [P(python, [python, "-m", "hermes_cli.main", "chat"])], 1).state).toBe("open");
  });

  it("another editor's language server (Windsurf, Codeium) is not Antigravity; Antigravity's own is", () => {
    const windsurf = "/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/bin/language_server_macos_arm";
    expect(processVerdict("antigravity", [P(windsurf, [windsurf])], 1).state).toBe("closed");
    const own = "/home/u/.antigravity/extensions/antigravity/bin/language_server_linux_x64";
    expect(processVerdict("antigravity", [P(own, [own])], 1).state).toBe("open");
  });

  it("Linux: another user's node whose program cannot be read, named MainThread by its own main thread, is judged by its arguments", () => {
    const base = mkdtempSync(join(scratch, "mainthread-"));
    mkdirSync(join(base, "bin"));
    writeFileSync(join(base, "bin", "claude"), "#!/usr/bin/env node\n");
    expect(processVerdict("claude", [P(null, ["node", join(base, "bin", "claude"), "--resume"], { comm: "MainThread", uid: 0 })], 1).state).toBe("open");
    expect(processVerdict("claude", [P(null, ["/usr/bin/node", "/srv/other/server.js"], { comm: "MainThread", uid: 0 })], 1).state).toBe("closed");
  });

  it("an interpreter that could not be read once, and is gone when the list is read again, does not make the engine unknown", () => {
    const home = mkdtempSync(join(scratch, "recheck-"));
    fake.onProcesses = (call) => (call === 1 ? [P("/usr/bin/node", null, { pid: 31337 })] : []);
    expect(engineState("claude", home).state).toBe("closed");
    fake.onProcesses = () => [P("/usr/bin/node", null, { pid: 31338 })];
    const verdict = engineState("claude", home);
    expect(verdict.state).toBe("unknown");
    expect(verdict.unknownBy?.map((item) => item.pid)).toEqual([31338]); // the log line can say which process
  });

  it("a FILE at Claude's lock name, however old, is neither given up nor moved: nothing is written and the home waits", () => {
    const fx = buildFixture("claude", scratch);
    const history = join(fx.homes[0]!.home, "history.jsonl");
    const before = readFileSync(history);
    writeFileSync(`${history}.lock`, "not a folder");
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${history}.lock`, old, old);
    const ran = executeEnginePlans(structuredClone(planEngineHistory(job(fx)).plans!));
    expect(ran.homeReasons[key(fx)]).toBe("held");
    expect(readFileSync(`${history}.lock`, "utf8")).toBe("not a folder");
    expect(statSync(`${history}.lock`).isFile()).toBe(true);
    expect(readFileSync(history).equals(before)).toBe(true);
    expect(readdirSync(fx.homes[0]!.home).filter((name) => name.includes(".lock.murage-"))).toEqual([]);
  });

});
