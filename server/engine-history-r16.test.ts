// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The fix round after the r15 review of engine-history deletion. Each describe block reproduces one finding first (the shape of
// its reproduction is in the block), then shows the change: every JSONL file is blanked in place and nothing is renamed,
// replaced or cut; a current ownership conflict wins over saved names; discovery inputs are compared by what they name and a
// folder is removed entry by entry from its re-listing; a hold is atomic with the running count and needs a confirmed teardown;
// a thrown retry arms the next one.
import { fileURLToPath } from "node:url";
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { ConversationDeletions } from "./conversation-deletion.ts";
import { executeEnginePlans } from "./engine-exec.ts";
import { mutOps } from "./engine-fs.ts";
import { engineHistoryTestHooks } from "./engine-history-offthread.ts";
import { planEngineHistory, removeEngineHistoryFiles, runEngineHistoryJob } from "./engine-history-run.ts";
import { clearEdits, homeKey, isCleared, JSONL_FORMAT, type Step } from "./engine-plan-core.ts";
import { decorateHoldInstance, InstanceHolds } from "./harness/instance-holds.ts";
import { buildFixture, canaryHits, ENGINES, THREAD, type Fixture } from "./testing/engine-history-fixtures.ts";
import type { ProviderInstance, RuntimeEvent } from "./contracts.ts";
import type { EngineHistoryJob } from "./engine-history-offthread.ts";
import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-r16-")));
const openDatabases: DatabaseSync[] = [];
afterAll(() => { for (const db of openDatabases) db.close(); removeTempDirSync(scratch); });
afterEach(() => { for (const name of Object.keys(engineHistoryTestHooks)) delete (engineHistoryTestHooks as Record<string, unknown>)[name]; });

const dump = (value: unknown) => `${JSON.stringify(value)}\n`;
const job = (fx: Fixture, extra: Record<string, unknown> = {}) => ({ homes: fx.homes, folders: fx.folders, memoryFolders: fx.memoryFolders, sessions: fx.sessions, kind: "plan" as const, ...extra });
const key = (fx: Fixture) => homeKey(fx.homes[0]!.engine, fx.homes[0]!.home);
const C = (engine: string) => `canary-${engine}-5521`;
const B = (engine: string) => `bystander-${engine}-9917`;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const plain = (text: string) => text.split("\n").filter((line) => line.trim() !== "");
const keysOf = (value: unknown): string[] => value && typeof value === "object" ? Object.entries(value as Record<string, unknown>).flatMap(([name, inner]) => [name, ...keysOf(inner).map((item) => `${name}.${item}`)]).sort() : [];

// ── A: every JSONL file is blanked in place ───────────────────────────────────────────────────────────────────────────

interface JsonlCase { engine: "fuigo" | "claude" | "codex" | "kimi"; file: (fx: Fixture) => string; ids: string[] }
const JSONL: Array<[string, JsonlCase]> = [
  ["Fuigo unified.jsonl", { engine: "fuigo", file: (fx) => join(fx.homes[0]!.home, "logs", "unified.jsonl"), ids: [] }],
  ["Claude history.jsonl", { engine: "claude", file: (fx) => join(fx.homes[0]!.home, "history.jsonl"), ids: [] }],
  ["Codex history.jsonl", { engine: "codex", file: (fx) => join(fx.homes[0]!.home, "history.jsonl"), ids: [] }],
  ["Codex session_index.jsonl", { engine: "codex", file: (fx) => join(fx.homes[0]!.home, "session_index.jsonl"), ids: [] }],
  ["Kimi session_index.jsonl", { engine: "kimi", file: (fx) => join(fx.homes[0]!.home, "session_index.jsonl"), ids: [] }],
];

const WINDOWS_MANDATORY_LOCK = new Set(["Fuigo unified.jsonl", "Codex history.jsonl"]);

describe("A: a dropped row keeps its shape, and nothing about the file's handle lifecycle changes", () => {
  for (const [name, one] of JSONL) {
    it(`${name}: every row still parses strictly with its keys; the dropped ones hold spaces; the others are byte for byte; same inode and length`, () => {
      const fx = buildFixture(one.engine, scratch);
      const file = one.file(fx);
      const before = readFileSync(file, "utf8");
      const ino = lstatSync(file).ino;
      const planned = planEngineHistory(job(fx));
      expect(executeEnginePlans(structuredClone(planned.plans!)).failed).toEqual([]);
      const after = readFileSync(file, "utf8");
      expect(after.length).toBe(before.length);
      expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
      expect(lstatSync(file).ino).toBe(ino);
      const was = before.split("\n"), now = after.split("\n");
      expect(now).toHaveLength(was.length);
      let blanked = 0;
      was.forEach((line, index) => {
        if (!line) { expect(now[index]).toBe(""); return; }
        const parsed = JSON.parse(now[index]!) as unknown; // a strict parse: still one JSON object per line
        expect(Object.keys(parsed as object), `row ${index}`).toEqual(Object.keys(JSON.parse(line) as object)); // the top-level keys all stay (a payload is emptied whole)
        if (now[index] === line) return; // a bystander row: byte for byte
        blanked++;
        expect(Buffer.byteLength(now[index]!)).toBe(Buffer.byteLength(line));
        expect(now[index]).not.toContain(C(one.engine));
      });
      expect(blanked).toBeGreaterThan(0);
      expect(canaryHits(fx.root, fx.canaries.filter((canary) => !fx.homes.some((home) => home.engine === "claude") || canary === C("claude") || canary.length === 16))).toEqual([]);
      expect(after).toContain(B(one.engine));
    });
  }

  it("ids and meta stay; every string and every structure in a content or payload field is emptied to its own type, padded to the same length", () => {
    const row = Buffer.from(JSON.stringify({ display: "secret é text", n: 7, ok: true, none: null, timestamp: "2026-10-11T10:00:00Z", project: "/work/a", sessionId: "s-1", pastedContents: { 1: { id: 1, type: "text", content: "pasted secret", contentHash: "ab12cd34ef56ab12" }, list: ["x", { deep: "y" }] } }));
    const format = JSONL_FORMAT["claude-history"]!;
    const out = Buffer.from(row);
    for (const edit of clearEdits(row, format)!) edit.bytes.copy(out, edit.at);
    const parsed = JSON.parse(out.toString()) as Record<string, unknown>;
    expect(out.length).toBe(row.length);
    expect(Object.keys(parsed)).toEqual(Object.keys(JSON.parse(row.toString())));
    expect(parsed.ok).toBe(true); expect(parsed.none).toBeNull();
    expect(parsed.n).toBe(0); // an unknown field is content: a number becomes 0
    expect(parsed.timestamp).toBe("2026-10-11T10:00:00Z"); expect(parsed.project).toBe("/work/a"); expect(parsed.sessionId).toBe("s-1");
    expect(parsed.display).toBe(" ".repeat(Buffer.byteLength("secret é text")));
    expect(parsed.pastedContents).toEqual({}); // the payload is replaced whole
    expect(out.toString()).not.toMatch(/secret|ab12cd34/);
    expect(isCleared(out, format)).toBe(true);
    expect(clearEdits(out, format)).toEqual([]); // applying it again changes nothing
    expect(clearEdits(Buffer.from("not json"), format)).toBeNull();
  });

  for (const [name, one] of JSONL) {
    for (const point of ["before the first pread", "between rows", "after the last write", "before the fsync"] as const) {
      // Fuigo's unified.jsonl and Codex's history.jsonl are cleared under the engine's own lock. On Windows that lock is a
      // mandatory byte-range lock (LockFileEx), so a writer that skips the lock cannot write while it is held: its append inside
      // the hold fails (the OS refuses it), which is what the engines' own writers, taking the lock first, never meet.
      it.skipIf(process.platform === "win32" && WINDOWS_MANDATORY_LOCK.has(name) && point !== "before the first pread")(`${name}: a writer holding its own O_APPEND handle, appending ${point}, loses nothing and corrupts nothing`, () => {
        const fx = buildFixture(one.engine, scratch);
        const file = one.file(fx);
        const planned = planEngineHistory(job(fx));
        const writer = openSync(file, "a"); // opened before the deletion, kept open throughout
        const mine = (n: number) => dump({ sid: `s-live-${n}`, session_id: `live-${n}`, id: `live-${n}`, sessionId: `live-${n}`, workDir: "/live", text: `LIVE-${n}`, project: "/live" });
        let n = 0;
        const append = () => { writeSync(writer, mine(n++)); };
        const real = { pread: mutOps.pread, pwrite: mutOps.pwrite, fsync: mutOps.fsync };
        let reads = 0;
        mutOps.pread = ((fd: number, length: number, position: number) => { if (point === "before the first pread" && reads++ === 0) append(); return real.pread(fd, length, position); }) as typeof mutOps.pread;
        mutOps.pwrite = ((fd: number, bytes: Buffer, position: number) => { real.pwrite(fd, bytes, position); if (point === "between rows") append(); }) as typeof mutOps.pwrite;
        mutOps.fsync = ((fd: number) => { if (point === "before the fsync") append(); real.fsync(fd); if (point === "after the last write") append(); }) as typeof mutOps.fsync;
        try { executeEnginePlans(structuredClone(planned.plans!)); } finally { Object.assign(mutOps, real); }
        append(); // and once more, after everything
        closeSync(writer);
        const text = readFileSync(file, "utf8");
        for (let i = 0; i < n; i++) expect(text, `row ${i}`).toContain(`LIVE-${i}`); // every appended row is there, in order, whole
        for (const line of plain(text)) expect(() => JSON.parse(line), line).not.toThrow();
        expect(text.endsWith("\n")).toBe(true);
      });
    }
  }

  it("a last row that has no newline yet is its writer's: planned around, left untouched, and complete when the writer finishes it", () => {
    const fx = buildFixture("codex", scratch);
    const file = join(fx.homes[0]!.home, "history.jsonl");
    appendFileSync(file, '{"session_id":"someone-else","ts":5,"te'); // unfinished, unrelated
    const planned = planEngineHistory(job(fx));
    expect(planned.failedHomes).toEqual([]);
    const writer = openSync(file, "a");
    expect(executeEnginePlans(structuredClone(planned.plans!)).failed).toEqual([]);
    expect(readFileSync(file, "utf8").endsWith('{"session_id":"someone-else","ts":5,"te')).toBe(true);
    writeSync(writer, 'xt":"done"}\n');
    closeSync(writer);
    const last = plain(readFileSync(file, "utf8")).pop()!;
    expect(JSON.parse(last)).toEqual({ session_id: "someone-else", ts: 5, text: "done" });
    // and one that names the deleted conversation is a row still being written: the home is not planned, so it waits
    const tid = "019a0000-aaaa-7bbb-8ccc-000000000001";
    appendFileSync(file, `{"session_id":"${tid}","te`);
    const again = planEngineHistory(job(fx, { known: planned.discovery }));
    expect(again.failedHomes).toEqual([key(fx)]);
    expect(Object.values(again.homeReasons ?? {})[0]).toMatch(/still being written/);
  });

  it("a complete last row without a newline is blanked in place, and the newline its writer adds later lands after it", () => {
    const fx = buildFixture("codex", scratch);
    const file = join(fx.homes[0]!.home, "history.jsonl");
    const tid = "019a0000-aaaa-7bbb-8ccc-000000000001";
    appendFileSync(file, JSON.stringify({ session_id: tid, text: "tail-secret" }));
    const planned = planEngineHistory(job(fx));
    const writer = openSync(file, "a");
    expect(executeEnginePlans(structuredClone(planned.plans!)).failed).toEqual([]);
    writeSync(writer, "\n");
    closeSync(writer);
    expect(readFileSync(file, "utf8")).not.toContain("tail-secret");
    for (const line of plain(readFileSync(file, "utf8"))) expect(() => JSON.parse(line)).not.toThrow();
  });

  for (const [name, one] of JSONL) {
    it(`${name}: a crash after any write leaves a file of valid rows, and the replay finishes with the text gone`, () => {
      let writes = 0;
      for (let crashAt = 1; crashAt < 60; crashAt++) {
        const fx = buildFixture(one.engine, scratch);
        const file = one.file(fx);
        const before = readFileSync(file, "utf8");
        const planned = planEngineHistory(job(fx));
        const real = mutOps.pwrite;
        let seen = 0;
        mutOps.pwrite = ((fd: number, bytes: Buffer, position: number) => {
          if (++seen === crashAt) throw new Error("crash");
          real(fd, bytes, position);
        }) as typeof mutOps.pwrite;
        try { executeEnginePlans(structuredClone(planned.plans!)); } finally { mutOps.pwrite = real; }
        if (seen < crashAt) break; // the run needed fewer writes than this: every crash point was covered
        writes = crashAt;
        const interrupted = readFileSync(file, "utf8");
        expect(interrupted.length).toBe(before.length);
        for (const line of plain(interrupted)) expect(() => JSON.parse(line), `crash at write ${crashAt}`).not.toThrow(); // the original, or a blanked, row: never torn
        const whole = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, planned.discovery ?? {}, true);
        expect(whole.failed, `replay after a crash at write ${crashAt}`).toEqual([]);
        expect(canaryHits(fx.root, fx.canaries), `crash at write ${crashAt}`).toEqual([]);
      }
      expect(writes).toBeGreaterThan(0);
    });
  }

  it("Claude: a row whose pasted-content hash is blanked leaves no trace of the hash, and the paste file goes with the replay", () => {
    const fx = buildFixture("claude", scratch);
    const history = join(fx.homes[0]!.home, "history.jsonl");
    const planned = planEngineHistory(job(fx));
    expect(executeEnginePlans(structuredClone(planned.plans!)).failed).toEqual([]);
    expect(readFileSync(history, "utf8")).not.toContain("ab12cd34ef56ab12");
    expect(existsSync(join(fx.homes[0]!.home, "paste-cache", "ab12cd34ef56ab12.txt"))).toBe(false);
    expect(existsSync(join(fx.homes[0]!.home, "paste-cache", "1122334455667788.txt"))).toBe(true); // shared with the other session
    expect(fx.checkBystanders()).toEqual([]);
  });

  it("no engine file is replaced: the executor has no rename, atomic write or salvage left for JSONL", () => {
    const src = readFileSync(join(__dirname_(), "engine-exec.ts"), "utf8");
    expect(src).not.toMatch(/writeFileAtomic|rewriteJsonlAtomic|salvage|pinned/);
    const steps = ENGINES.flatMap((engine) => { const fx = buildFixture(engine, scratch); return planEngineHistory(job(fx)).plans![key(fx)]!.steps; });
    for (const step of steps.filter((item): item is Extract<Step, { k: "rewrite" }> => item.k === "rewrite")) expect(step.mode).toBe("blank");
  });
});

function __dirname_(): string { return fileURLToPath(new URL(".", import.meta.url)); }

// ── B: a current ownership conflict wins over a saved name ────────────────────────────────────────────────────────────

describe("B: a folder that holds another conversation's session is kept, whatever was saved", () => {
  const claudeKey = (fx: Fixture) => fx.folders[0]!.replace(/[^a-zA-Z0-9]/g, "-");

  it("foreign.jsonl added after the plan: the first run stops and puts the folder back, and no later run deletes the foreign transcript", () => {
    const fx = buildFixture("claude", scratch);
    const h = fx.homes[0]!.home;
    const project = join(h, "projects", claudeKey(fx));
    const planned = planEngineHistory(job(fx));
    const foreign = join(project, "foreign.jsonl");
    writeFileSync(foreign, dump({ type: "user", cwd: "/somebody/elses/folder", sessionId: "sess-foreign", message: B("claude") }));
    const first = executeEnginePlans(structuredClone(planned.plans!));
    expect(first.failed).toEqual([]);
    expect(first.staleHomes).toEqual([key(fx)]);
    expect(existsSync(foreign)).toBe(true); // put back where its engine finds it, not left in an aside
    expect(existsSync(`${project}.murage-deleting`)).toBe(false);
    // replanned from the persisted names: the current conflict wins
    const again = planEngineHistory(job(fx, { known: planned.discovery }));
    expect(again.leftovers.length).toBeGreaterThan(0);
    expect(JSON.stringify(again.discovery?.[key(fx)] ?? {})).not.toContain(claudeKey(fx));
    for (let round = 0; round < 3; round++) {
      const plan = planEngineHistory(job(fx, { known: again.discovery })).plans![key(fx)]!;
      expect(executeEnginePlans(structuredClone({ [key(fx)]: plan })).failed).toEqual([]);
      expect(existsSync(foreign), `round ${round}`).toBe(true);
    }
    expect(readFileSync(foreign, "utf8")).toContain(B("claude"));
    // and only what independently names this conversation went: its session file, not the folder
    expect(existsSync(join(project, "sess-claude-1.jsonl"))).toBe(false);
    expect(canaryHits(fx.root, [C("claude")])).toEqual([]);
  });

  it("the same, in a single removeEngineHistoryFiles run from persisted names (the shape of a replay after a crash)", () => {
    const fx = buildFixture("claude", scratch);
    const project = join(fx.homes[0]!.home, "projects", claudeKey(fx));
    const planned = planEngineHistory(job(fx));
    writeFileSync(join(project, "foreign.jsonl"), dump({ type: "user", cwd: "/somebody/elses/folder", sessionId: "sess-foreign", message: B("claude") }));
    const result = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, planned.discovery ?? {}, true);
    expect(result.failed).toEqual([]);
    expect(existsSync(join(project, "foreign.jsonl"))).toBe(true);
    expect(existsSync(join(project, "sess-claude-1.jsonl"))).toBe(false);
  });
});

// ── C: discovery inputs are compared by what they name; a folder goes entry by entry ──────────────────────────────────

describe("C: a changed input is stale, and nothing arriving later is deleted unseen", () => {
  it("a new slug in an already listed session file: the transcript is kept this run, the next plan learns the slug and removes its plan file", () => {
    const fx = buildFixture("claude", scratch);
    const h = fx.homes[0]!.home;
    const project = join(h, "projects", fx.folders[0]!.replace(/[^a-zA-Z0-9]/g, "-"));
    const transcript = join(project, "sess-claude-1.jsonl");
    const planned = planEngineHistory(job(fx));
    appendFileSync(transcript, dump({ type: "assistant", cwd: fx.folders[0], slug: "late-slug", message: "more" }));
    mkdirSync(join(h, "plans"), { recursive: true });
    writeFileSync(join(h, "plans", "late-slug.md"), C("claude"));
    const ran = executeEnginePlans(structuredClone(planned.plans!));
    expect(ran.failed).toEqual([]);
    expect(ran.staleHomes).toEqual([key(fx)]);
    expect(existsSync(transcript)).toBe(true); // not deleted: it names something the plan never saw
    const whole = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, planned.discovery ?? {}, true);
    expect(whole.failed).toEqual([]);
    expect(existsSync(transcript)).toBe(false);
    expect(existsSync(join(h, "plans", "late-slug.md"))).toBe(false);
    expect(canaryHits(fx.root, [C("claude")])).toEqual([]);
    expect(fx.checkBystanders()).toEqual([]);
  });

  it("a Fuigo session folder that appears after the re-listing is not deleted: it stays, the run is stale, and the next plan learns its id and its shared-log row", () => {
    const fx = buildFixture("fuigo", scratch);
    const h = fx.homes[0]!.home;
    const sessions = join(h, "sessions");
    const dir = join(sessions, readdirSync(sessions).find((name) => name !== "other-key" && !name.endsWith(".sqlite") && !name.includes("sqlite"))!);
    const log = join(h, "logs", "unified.jsonl");
    const planned = planEngineHistory(job(fx));
    const real = mutOps.rmdir;
    let injected = false;
    mutOps.rmdir = ((path: string) => {
      if (!injected && path.endsWith(".murage-deleting")) {
        injected = true;
        // a process that kept the renamed folder as its working directory creates a session in it, and logs it
        mkdirSync(join(path, "s-late"), { recursive: true });
        writeFileSync(join(path, "s-late", "chat_history.jsonl"), dump({ text: C("fuigo") }));
        appendFileSync(log, dump({ sid: "s-late", text: C("fuigo") }));
      }
      return real(path);
    }) as typeof mutOps.rmdir;
    let ran: ReturnType<typeof executeEnginePlans>;
    try { ran = executeEnginePlans(structuredClone(planned.plans!)); } finally { mutOps.rmdir = real; }
    expect(injected).toBe(true);
    expect(ran.failed).toEqual([]);
    expect(ran.staleHomes).toEqual([key(fx)]);
    expect(existsSync(join(dir, "s-late", "chat_history.jsonl")) || existsSync(join(`${dir}.murage-deleting`, "s-late", "chat_history.jsonl"))).toBe(true); // not removed unseen
    const whole = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, planned.discovery ?? {}, true);
    expect(whole.failed).toEqual([]);
    expect(canaryHits(fx.root, [C("fuigo")])).toEqual([]);
    expect(fx.checkBystanders()).toEqual([]);
  });

  it("the folder is removed from its re-listing entry by entry: files one at a time, folders only when empty, never recursively", () => {
    const fx = buildFixture("fuigo", scratch);
    const planned = planEngineHistory(job(fx));
    const listed = (planned.plans![key(fx)]!.steps.find((step) => step.k === "remove" && step.expect) as Extract<Step, { k: "remove" }>).target;
    const realTree = mutOps.removeTree, realUnlink = mutOps.unlink, realRmdir = mutOps.rmdir;
    const trees: string[] = [], unlinked: string[] = [], rmdirs: string[] = [];
    mutOps.removeTree = ((path: string) => { trees.push(path); realTree(path); }) as typeof mutOps.removeTree;
    mutOps.unlink = ((path: string) => { unlinked.push(path); realUnlink(path); }) as typeof mutOps.unlink;
    mutOps.rmdir = ((path: string) => { rmdirs.push(path); realRmdir(path); }) as typeof mutOps.rmdir;
    try { expect(executeEnginePlans(structuredClone(planned.plans!)).failed).toEqual([]); } finally { Object.assign(mutOps, { removeTree: realTree, unlink: realUnlink, rmdir: realRmdir }); }
    expect(trees, "nothing is removed recursively").toEqual([]);
    const inside = `${listed}.murage-deleting${sep}`;
    // On Windows a file inside goes when the handle that marked it for deletion closes, never by name (engine-exec.ts deleteTree);
    // its folder's rmdir below succeeds only once every file is gone.
    if (process.platform === "win32") expect(unlinked.filter((path) => path.startsWith(inside)), "no file inside it is unlinked by name").toEqual([]);
    else expect(unlinked.some((path) => path.startsWith(inside)), "the files inside it are unlinked one by one").toBe(true);
    expect(rmdirs, "its folders go only as empty folders, the entry's own folder before the aside").toContain(`${listed}.murage-deleting`);
  });

  it("an entry the plan did not list stays, and the folder is put back with it", () => {
    const fx = buildFixture("fuigo", scratch);
    const h = fx.homes[0]!.home;
    const sessions = join(h, "sessions");
    const planned = planEngineHistory(job(fx));
    const dir = (planned.plans![key(fx)]!.steps.find((step) => step.k === "remove" && step.expect) as Extract<Step, { k: "remove" }>).target;
    mkdirSync(join(dir, "s-unlisted"), { recursive: true });
    writeFileSync(join(dir, "s-unlisted", "chat_history.jsonl"), dump({ text: "unlisted" }));
    const ran = executeEnginePlans(structuredClone(planned.plans!));
    expect(ran.staleHomes).toEqual([key(fx)]);
    expect(readFileSync(join(dir, "s-unlisted", "chat_history.jsonl"), "utf8")).toContain("unlisted");
    expect(existsSync(join(dir, "s-1"))).toBe(false); // the listed, unchanged entry did go
    expect(existsSync(`${dir}.murage-deleting`)).toBe(false);
    expect(readdirSync(sessions)).toContain("other-key");
  });
});

// ── D: the hold ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("D: a hold and a running turn cannot miss each other, and an idle teardown must be confirmed", () => {
  const fakeInstance = (id: string, events: string[] = []) => {
    const listeners = new Set<(event: RuntimeEvent) => void>();
    const adapter = {
      capabilities: {},
      hasSession: () => true,
      onEvent: (listener: (event: RuntimeEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      sendTurn: async (input: { threadId: string }) => { events.push(`send ${input.threadId}`); return { turnId: "t" }; },
    };
    return { instance: { instanceId: id, adapter, dispose: async () => {} } as unknown as ProviderInstance, events };
  };

  it("a hold taken in the same tick as a send sees that turn running and does not hold a home with a turn in it", async () => {
    const holds = new InstanceHolds();
    const fake = fakeInstance("claude-1");
    const decorated = decorateHoldInstance(fake.instance, holds);
    const sending = decorated.adapter.sendTurn({ threadId: "T1", text: "hi" } as never); // admission is synchronous when nothing is held
    const held = await holds.hold(["claude-1"], 30, async () => { fake.events.push("holdIdle"); return undefined; });
    await sending;
    expect(held.busy).toEqual(["claude-1"]);
    expect(fake.events).toEqual(["send T1"]); // the idle teardown never ran beside a running turn
    expect(holds.isHeld("claude-1")).toBe(false);
  });

  it("a send that arrives while the hold is being installed waits for it instead of slipping between the check and the count", async () => {
    const holds = new InstanceHolds();
    const fake = fakeInstance("claude-1");
    const decorated = decorateHoldInstance(fake.instance, holds);
    const held = holds.hold(["claude-1"], 30, async () => undefined); // installed synchronously
    const sending = decorated.adapter.sendTurn({ threadId: "T1", text: "hi" } as never);
    const result = await held;
    expect(result.busy).toEqual([]);
    await delay(20);
    expect(fake.events).toEqual([]); // waiting
    result.release();
    await sending;
    expect(fake.events).toEqual(["send T1"]);
  });

  it("an idle teardown that is not confirmed leaves the instance busy, lets the adapter start engines again, and holds nothing", async () => {
    const holds = new InstanceHolds();
    const calls: string[] = [];
    const held = await holds.hold(["a", "b"], 10, async (id) => ({ confirmed: id === "a", release: () => { calls.push(`release ${id}`); } }));
    expect(held.busy).toEqual(["b"]);
    expect(holds.isHeld("a")).toBe(true);
    expect(holds.isHeld("b")).toBe(false);
    expect(calls).toEqual(["release b"]);
    held.release();
    expect(calls).toEqual(["release b", "release a"]);
    expect(holds.isHeld("a")).toBe(false);
  });

  it("an adapter whose holdIdle throws is not trusted either", async () => {
    const holds = new InstanceHolds();
    const held = await holds.hold(["a"], 10, async () => { throw new Error("close failed"); });
    expect(held.busy).toEqual(["a"]);
    expect(holds.isHeld("a")).toBe(false);
  });
});

// ── E: a thrown retry arms the next one ───────────────────────────────────────────────────────────────────────────────

class ScriptedWorker extends EventEmitter {
  threadId = 11;
  readonly script: (job: EngineHistoryJob, worker: ScriptedWorker) => void;
  constructor(script: (job: EngineHistoryJob, worker: ScriptedWorker) => void) { super(); this.script = script; }
  postMessage(message: EngineHistoryJob) { setImmediate(() => this.script(message, this)); }
  terminate() { setImmediate(() => this.emit("exit", 0)); return Promise.resolve(0); }
}
const useScript = (script: (job: EngineHistoryJob, worker: ScriptedWorker) => void) => { engineHistoryTestHooks.createWorker = () => new ScriptedWorker(script) as unknown as Worker; };
const answer = (worker: ScriptedWorker, message: EngineHistoryJob) => worker.emit("message", { type: "result", result: runEngineHistoryJob(message) });

describe("E: a retry that throws while the record is pending arms the next one", () => {
  function setup(fx: Fixture, options: Partial<ConstructorParameters<typeof ConversationDeletions>[0]> = {}) {
    const data = join(fx.root, "data");
    mkdirSync(data, { recursive: true });
    const db = new DatabaseSync(join(data, "messages.db"));
    openDatabases.push(db);
    let failures = 0, calls = 0;
    const deletions = new ConversationDeletions({
      dataDir: data,
      database: () => { calls++; if (failures > 0) { failures--; throw new Error("database is busy"); } return db; },
      retryDelaysMs: [15], slowRetryMs: 25, ...options,
    });
    return { deletions, fail: (times: number) => { failures = times; }, calls: () => calls };
  }
  const stuckOnce = () => {
    let executes = 0;
    useScript((message, worker) => {
      if (message.kind === "execute" && executes++ === 0) worker.emit("message", { type: "result", result: { removed: [], failed: ["x"], leftovers: [], failedHomes: Object.keys(message.plans!), staleHomes: [], factsDelta: {} } });
      else answer(worker, message);
    });
  };

  it("a scheduled retry that throws on a transient database fault is retried by the schedule, and the record clears", async () => {
    const fx = buildFixture("codex", scratch);
    const { deletions, fail } = setup(fx);
    stuckOnce();
    const entry = deletions.begin({ threadIds: [THREAD], engineHomes: fx.homes });
    const first = await deletions.finish(entry);
    expect(first.failed.length).toBeGreaterThan(0);
    expect(deletions.pending()).toHaveLength(1);
    fail(1); // the first scheduled attempt meets a busy database
    await delay(400);
    expect(deletions.pending()).toEqual([]); // the second scheduled attempt ran after the throw
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
    deletions.dispose();
  });

  it("Try again now that throws leaves a scheduled attempt in place", async () => {
    const fx = buildFixture("codex", scratch);
    const { deletions, fail } = setup(fx);
    stuckOnce();
    const entry = deletions.begin({ threadIds: [THREAD], engineHomes: fx.homes });
    await deletions.finish(entry);
    fail(1);
    expect(await deletions.retryNow()).toBe(1); // clears the timer, then the attempt throws on the busy database
    expect(deletions.pending()).toHaveLength(1);
    await delay(400);
    expect(deletions.pending()).toEqual([]);
    deletions.dispose();
  });

  it("an interrupted delete that throws at start-up is retried too", async () => {
    const fx = buildFixture("codex", scratch);
    const { deletions } = setup(fx);
    stuckOnce();
    const entry = deletions.begin({ threadIds: [THREAD], engineHomes: fx.homes });
    await deletions.finish(entry);
    deletions.dispose();
    const second = setup(fx);
    second.fail(1);
    expect(await second.deletions.reconcile(() => false, () => undefined)).toBe(0); // it threw
    expect(second.deletions.pending()).toHaveLength(1);
    await delay(400);
    expect(second.deletions.pending()).toEqual([]);
    second.deletions.dispose();
  });
});

