// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Removing a deleted conversation's copies from the coding engines' files, under real exclusion (r17): no engine file or database
// is changed unless the engine cannot write it meanwhile (its own lock, or the file out of reach and unheld, or on Windows opened with
// sharing off); otherwise the home is pending and the owner is told which engine. Each block below is one finding of the r16b review.
// The exclusion is modelled here (testing/engine-exclusion-fake.ts); engine-exclusion.test.ts runs the same flows against the real
// addon and real second processes.
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConversationDeletions, owedCodeOf, ownerNoticeText, runConversationDeletion } from "./conversation-deletion.ts";
import { executeEnginePlans } from "./engine-exec.ts";
import { exclOps, fsOps, mutOps } from "./engine-fs.ts";
import { engineHistoryTestHooks, type EngineHistoryJob } from "./engine-history-offthread.ts";
import { planEngineHistory, removeEngineHistoryFiles, runEngineHistoryJob } from "./engine-history-run.ts";
import { clearEdits, hasContentSteps, homeKey, isCleared, JSONL_FORMAT, type Step } from "./engine-plan-core.ts";
import { qwenProjectKey } from "./engine-history-deletion.ts";
import { useFakeExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { asExclusive, buildFixture, canaryHits, treeDigest, type Fixture } from "./testing/engine-history-fixtures.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-r17-")));
const openDatabases: DatabaseSync[] = [];
afterAll(() => { for (const db of openDatabases) db.close(); removeTempDirSync(scratch); });

let fake: FakeExclusion;
beforeEach(() => { fake = useFakeExclusion(); });
afterEach(() => {
  fake.restore();
  for (const name of Object.keys(engineHistoryTestHooks)) delete (engineHistoryTestHooks as Record<string, unknown>)[name];
});

const dump = (value: unknown) => `${JSON.stringify(value)}\n`;
const job = (fx: Fixture, extra: Record<string, unknown> = {}) => ({ homes: fx.homes, folders: fx.folders, memoryFolders: fx.memoryFolders, sessions: fx.sessions, kind: "plan" as const, ...extra });
const key = (fx: Fixture) => homeKey(fx.homes[0]!.engine, fx.homes[0]!.home);
const C = (engine: string) => `canary-${engine}-5521`;
const B = (engine: string) => `bystander-${engine}-9917`;
const run = (fx: Fixture, planned = planEngineHistory(job(fx))) => executeEnginePlans(structuredClone(planned.plans!));
const rewriteSteps = (plans: Record<string, { steps: Step[] }>) => Object.values(plans).flatMap((plan) => plan.steps).filter((step): step is Extract<Step, { k: "rewrite" }> => step.k === "rewrite");
const claudeProject = (fx: Fixture) => join(fx.homes[0]!.home, "projects", fx.folders[0]!.replace(/[^a-zA-Z0-9]/g, "-"));

// ── 1: the writer is kept off the file while it is compared, written, synced and verified ─────────────────────────────

describe("1: a file is changed only while the engine cannot write it", () => {
  it("Fuigo's log: the engine's lock is taken before the compare that decides each write and let go after the last sync and verify", () => {
    const fx = buildFixture("fuigo", scratch);
    const planned = planEngineHistory(job(fx));
    fake.calls.length = 0;
    expect(run(fx, planned).failed).toEqual([]);
    // (the window's own look at the lock, before and after the steps, is not the step's lock; the rows are read and journalled once
    // with no hold, and then compared again under the lock, just before each write)
    const write = fake.calls.indexOf("pwrite");
    const lock = fake.calls.slice(0, write).lastIndexOf("lock");
    const compare = fake.calls.indexOf("pread", lock);
    const sync = fake.calls.lastIndexOf("fsync");
    const lastRead = fake.calls.lastIndexOf("pread");
    const close = fake.calls.indexOf("close", lastRead);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(compare).toBeGreaterThan(lock);
    expect(compare).toBeLessThan(write);
    expect(sync).toBeGreaterThan(write);
    expect(lastRead).toBeGreaterThan(sync); // the verifying read is still under the lock
    expect(close).toBeGreaterThan(lastRead);
  });

  for (const [name, engine, file, how] of [
    ["Fuigo unified.jsonl", "fuigo", (fx: Fixture) => join(fx.homes[0]!.home, "logs", "unified.jsonl"), "lock"],
    ["Codex history.jsonl", "codex", (fx: Fixture) => join(fx.homes[0]!.home, "history.jsonl"), "lock"],
  ] as const) {
    it(`${name}: an engine that respects the lock cannot trim while Murage holds it, and the bystander rows are byte for byte`, () => {
      const fx = buildFixture(engine, scratch);
      const path = file(fx);
      const before = readFileSync(path, "utf8").split("\n");
      const planned = planEngineHistory(job(fx));
      expect(rewriteSteps(planned.plans!).filter((step) => step.path === path).map((step) => step.how)).toEqual([how]);
      // the engine tries to take its lock (to trim) at every read, before every write and after the sync. While Murage holds the lock it
      // never gets it; the first read (with no hold: the rows are read and journalled before the lock is taken) may find it free, and
      // then the engine lets go at once
      const attempts: Array<{ at: "read" | "write"; got: boolean }> = [];
      const tryNow = (at: "read" | "write") => { const got = fake.tryEngineLock(path); got?.(); attempts.push({ at, got: !!got }); };
      const real = { pread: mutOps.pread, pwrite: mutOps.pwrite, fsync: mutOps.fsync };
      const ino = lstatSync(path, { bigint: true }).ino;
      const onThisFile = (fd: number) => mutOps.idOfFd(fd).ino === ino;
      mutOps.pread = ((fd: number, length: number, position: number) => { if (onThisFile(fd)) tryNow("read"); return real.pread(fd, length, position); }) as typeof mutOps.pread;
      mutOps.pwrite = ((fd: number, bytes: Buffer, position: number) => { if (onThisFile(fd)) tryNow("write"); real.pwrite(fd, bytes, position); }) as typeof mutOps.pwrite;
      mutOps.fsync = ((fd: number) => { real.fsync(fd); if (onThisFile(fd)) tryNow("write"); }) as typeof mutOps.fsync;
      try { expect(run(fx, planned).failed).toEqual([]); } finally { Object.assign(mutOps, real); }
      const writes = attempts.filter((attempt) => attempt.at === "write");
      expect(writes.length).toBeGreaterThan(1);
      expect(writes.every((attempt) => !attempt.got)).toBe(true);
      expect(attempts.filter((attempt) => !attempt.got).length).toBeGreaterThan(2);
      // and once Murage has let go, the engine gets its lock
      expect(fake.tryEngineLock(path)).not.toBeNull();
      const after = readFileSync(path, "utf8").split("\n");
      expect(after).toHaveLength(before.length);
      for (const [index, line] of before.entries()) if (line.includes(B(engine))) expect(after[index]).toBe(line);
      expect(readFileSync(path, "utf8")).not.toContain(C(engine));
    });

    it(`${name}: while the engine keeps its lock nothing is written and the home is pending (engine-open), then it finishes`, () => {
      const fx = buildFixture(engine, scratch);
      const path = file(fx);
      const before = readFileSync(path);
      const planned = planEngineHistory(job(fx));
      const release = fake.keepLock(path);
      const refused = run(fx, planned);
      expect(refused.homeReasons[key(fx)]).toBe("engine-open");
      expect(refused.failedHomes).toEqual([key(fx)]);
      expect(refused.staleHomes).toEqual([]);
      expect(readFileSync(path).equals(before)).toBe(true);
      expect(owedCodeOf(refused.homeReasons[key(fx)])).toBe("engine-open");
      release();
      expect(run(fx, planned).failed).toEqual([]);
      expect(readFileSync(path, "utf8")).not.toContain(C(engine));
    });

    it(`${name}: a trim that rewrote the head after the plan and before the lock makes the step stale, and not one byte is written`, () => {
      const fx = buildFixture(engine, scratch);
      const path = file(fx);
      const planned = planEngineHistory(job(fx));
      const rows = readFileSync(path, "utf8").split("\n");
      const trimmed = [rows[rows.length - 2]!.padEnd(rows[0]!.length, " "), ...rows.slice(1)].join("\n");
      writeFileSync(path, trimmed);
      const ran = run(fx, planned);
      expect(ran.staleHomes).toEqual([key(fx)]);
      expect(readFileSync(path, "utf8")).toBe(trimmed);
    });
  }

  for (const [name, engine, file] of [
    ["Codex session_index.jsonl", "codex", (fx: Fixture) => join(fx.homes[0]!.home, "session_index.jsonl")],
    ["Kimi session_index.jsonl", "kimi", (fx: Fixture) => join(fx.homes[0]!.home, "session_index.jsonl")],
  ] as const) {
    it(`${name}: ${engine === "codex" ? "no lock and no aside: the rows are overwritten in place, the file keeps its name and inode" : "no lock protocol and no aside either: Kimi's index is overwritten in place on every install, like Codex's"}, and bystanders are byte for byte`, () => {
      const fx = buildFixture(engine, scratch);
      const path = file(fx);
      const before = readFileSync(path, "utf8").split("\n");
      const planned = planEngineHistory(job(fx));
      expect(rewriteSteps(planned.plans!).filter((step) => step.path === path).map((step) => step.how)).toEqual(["inplace"]);
      const reach: string[] = [];
      const real = mutOps.pwrite;
      const ino = lstatSync(path, { bigint: true }).ino;
      // a writer with no lock tries to open the file for an in-place trim, at every write to it
      mutOps.pwrite = ((fd: number, bytes: Buffer, position: number) => {
        if (mutOps.idOfFd(fd).ino === ino) { try { mutOps.openReadWrite(path); reach.push("opened"); } catch (error) { reach.push((error as NodeJS.ErrnoException).code ?? "?"); } }
        real(fd, bytes, position);
      }) as typeof mutOps.pwrite;
      try { expect(run(fx, planned).failed).toEqual([]); } finally { mutOps.pwrite = real; }
      expect(reach.length).toBeGreaterThan(0);
      // neither engine's index is ever moved out of sight: it stays where it is (its writer's appends and rename-over keep working)
      expect(reach.every((code) => code === "opened")).toBe(true);
      expect(lstatSync(path, { bigint: true }).ino).toBe(ino);
      expect(existsSync(`${path}.murage-deleting`)).toBe(false);
      const after = readFileSync(path, "utf8").split("\n");
      expect(after).toHaveLength(before.length);
      for (const [index, line] of before.entries()) if (line.includes(B(engine))) expect(after[index]).toBe(line);
    });

    it(`${name}: a process holding it open puts it back untouched under its own name and the home is pending`, () => {
      const fx = buildFixture(engine, scratch);
      const path = file(fx);
      const before = readFileSync(path);
      const inode = lstatSync(path).ino;
      const planned = planEngineHistory(job(fx));
      const release = fake.openEngine(engine);
      const refused = run(fx, planned);
      expect(refused.homeReasons[key(fx)]).toBe("engine-open");
      expect(readFileSync(path).equals(before)).toBe(true);
      expect(lstatSync(path).ino).toBe(inode);
      expect(existsSync(`${path}.murage-deleting`)).toBe(false);
      release();
      expect(run(fx, planned).failed).toEqual([]);
    });
  }

  it("on a file system with no hard links the file still goes back under its name, and a name that is taken is never replaced", () => {
    const fx = buildFixture("kimi", scratch);
    const history = join(fx.homes[0]!.home, "session_index.jsonl");
    const real = mutOps.link;
    mutOps.link = (() => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); }) as typeof mutOps.link;
    try { expect(run(fx, asExclusive(planEngineHistory(job(fx)))).failed).toEqual([]); } finally { mutOps.link = real; }
    expect(existsSync(history)).toBe(true);
    expect(existsSync(`${history}.murage-deleting`)).toBe(false);
    expect(readFileSync(history, "utf8")).not.toContain(C("kimi"));
    expect(readFileSync(history, "utf8")).toContain(B("kimi"));
  });

  it("a file a crash left aside is planned, cleared and put back first", () => {
    const fx = buildFixture("kimi", scratch);
    const history = join(fx.homes[0]!.home, "session_index.jsonl");
    const aside = `${history}.murage-deleting`;
    const first = asExclusive(planEngineHistory(job(fx)));
    const real = mutOps.link;
    mutOps.link = (() => { throw new Error("crash before the file goes back"); }) as typeof mutOps.link;
    try { run(fx, first); } finally { mutOps.link = real; }
    expect(existsSync(history)).toBe(false);
    expect(existsSync(aside)).toBe(true);
    const planned = planEngineHistory(job(fx, { known: first.discovery }));
    const steps = rewriteSteps(planned.plans!);
    expect(steps.map((step) => step.restoreTo ?? "main")).toEqual([history]);
    expect(run(fx, planned).failed).toEqual([]);
    expect(existsSync(history)).toBe(true);
    expect(existsSync(aside)).toBe(false);
    expect(readFileSync(history, "utf8")).toContain(B("kimi"));
    expect(canaryHits(fx.root, [C("kimi")])).toEqual([]);
  });
});

// ── 1b: the other changes ────────────────────────────────────────────────────────────────────────────────────────────

describe("1b: a transcript or folder an engine owns is removed only when nobody holds it and a full read matches the plan", () => {
  it("a transcript another process holds open is not removed, and is back under its name (pending)", () => {
    const fx = buildFixture("claude", scratch);
    const project = claudeProject(fx);
    const transcript = join(project, "sess-claude-1.jsonl");
    const planned = planEngineHistory(job(fx));
    const release = fake.openEngine("claude");
    const refused = run(fx, planned);
    expect(refused.homeReasons[key(fx)]).toBe("engine-open");
    expect(readFileSync(transcript, "utf8")).toContain(C("claude"));
    expect(existsSync(`${project}.murage-deleting`)).toBe(false);
    release();
    expect(run(fx, planned).failed).toEqual([]);
    expect(existsSync(transcript)).toBe(false);
  });

  it("2: a slug appended to the transcript after it was taken aside: it is put back, the step is stale, and the replay removes the new plan file too", () => {
    const fx = buildFixture("claude", scratch);
    const h = fx.homes[0]!.home;
    const project = claudeProject(fx);
    const transcript = join(project, "sess-claude-1.jsonl");
    writeFileSync(join(h, "plans", "late-slug.md"), C("claude"));
    const planned = planEngineHistory(job(fx));
    const real = mutOps.rename;
    mutOps.rename = ((from: string, to: string) => {
      real(from, to);
      if (from === project) appendFileSync(join(to, "sess-claude-1.jsonl"), dump({ type: "assistant", cwd: fx.folders[0], slug: "late-slug", message: "more" })); // lands in the aside
    }) as typeof mutOps.rename;
    let ran: ReturnType<typeof executeEnginePlans>;
    try { ran = run(fx, planned); } finally { mutOps.rename = real; }
    expect(ran.staleHomes).toEqual([key(fx)]);
    expect(readFileSync(transcript, "utf8")).toContain("late-slug"); // put back where its engine finds it
    expect(existsSync(`${project}.murage-deleting`)).toBe(false);
    expect(existsSync(join(h, "plans", "late-slug.md"))).toBe(true);
    const whole = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, planned.discovery ?? {}, true);
    expect(whole.failed).toEqual([]);
    expect(existsSync(transcript)).toBe(false);
    expect(existsSync(join(h, "plans", "late-slug.md"))).toBe(false);
    expect(canaryHits(fx.root, [C("claude")])).toEqual([]);
  });

  it("2: a foreign cwd appended to a session file that is removed on its own (its folder is kept whole) stops the removal", () => {
    const fx = buildFixture("claude", scratch);
    const project = claudeProject(fx);
    writeFileSync(join(project, "foreign.jsonl"), dump({ type: "user", cwd: "/somebody/elses/folder", sessionId: "sess-foreign", message: B("claude") }));
    const transcript = join(project, "sess-claude-1.jsonl");
    const planned = planEngineHistory(job(fx));
    expect(planned.plans![key(fx)]!.steps.some((step) => step.k === "remove" && step.target === transcript && step.fp !== undefined)).toBe(true);
    const real = mutOps.rename;
    mutOps.rename = ((from: string, to: string) => {
      real(from, to);
      if (from === transcript) appendFileSync(to, dump({ type: "user", cwd: "/another/folder", message: B("claude") }));
    }) as typeof mutOps.rename;
    let ran: ReturnType<typeof executeEnginePlans>;
    try { ran = run(fx, planned); } finally { mutOps.rename = real; }
    expect(ran.staleHomes).toEqual([key(fx)]);
    expect(readFileSync(transcript, "utf8")).toContain("/another/folder");
    expect(existsSync(`${transcript}.murage-deleting`)).toBe(false);
    expect(readFileSync(join(project, "foreign.jsonl"), "utf8")).toContain(B("claude"));
  });

  it("2: Qwen: a chat and a todo that arrive after the plan survive, and the project folder stays (it is removed only if empty)", () => {
    const fx = buildFixture("qwen", scratch);
    const h = fx.homes[0]!.home;
    const project = join(h, "projects", qwenProjectKey(fx.folders[0]!));
    const planned = planEngineHistory(job(fx));
    expect(planned.plans![key(fx)]!.steps.filter((step) => step.k === "rmdirIfEmpty")).toHaveLength(2);
    writeFileSync(join(project, "chats", "late.jsonl"), dump({ cwd: fx.folders[0], message: "late words" }));
    mkdirSync(join(h, "todos"), { recursive: true });
    writeFileSync(join(h, "todos", "late.json"), "late todo");
    const ran = run(fx, planned);
    expect(ran.staleHomes).toEqual([key(fx)]); // the folder gained a name
    expect(existsSync(join(project, "chats", "late.jsonl"))).toBe(true);
    expect(existsSync(join(h, "todos", "late.json"))).toBe(true);
    expect(existsSync(project)).toBe(true);
    expect(existsSync(join(project, "chats", "b2c6d1a0-1111-4222-8333-444455556666.jsonl"))).toBe(false); // the listed chat went on its own
    // the next plan sees the late chat as the conversation's own (its cwd) and removes it with its todo, then the folders
    const whole = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, planned.discovery ?? {}, true);
    expect(whole.failed).toEqual([]);
    expect(existsSync(project)).toBe(false);
    expect(existsSync(join(h, "todos", "late.json"))).toBe(false);
  });

  it("2: Qwen: a late chat that names ANOTHER folder keeps the project and every side file", () => {
    const fx = buildFixture("qwen", scratch);
    const h = fx.homes[0]!.home;
    const project = join(h, "projects", qwenProjectKey(fx.folders[0]!));
    const planned = planEngineHistory(job(fx));
    writeFileSync(join(project, "chats", "late.jsonl"), dump({ cwd: "/somewhere/else", message: B("qwen") }));
    mkdirSync(join(h, "todos"), { recursive: true });
    writeFileSync(join(h, "todos", "late.json"), B("qwen"));
    run(fx, planned);
    const whole = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, planned.discovery ?? {}, true);
    expect(whole.failed).toEqual([]);
    expect(readFileSync(join(project, "chats", "late.jsonl"), "utf8")).toContain(B("qwen"));
    expect(readFileSync(join(h, "todos", "late.json"), "utf8")).toBe(B("qwen"));
  });

  it("a folder removed from its listing is first checked for holders: a held file in it puts the folder back and the home is pending", () => {
    const fx = buildFixture("fuigo", scratch);
    const h = fx.homes[0]!.home;
    const planned = planEngineHistory(job(fx));
    const listed = (planned.plans![key(fx)]!.steps.find((step) => step.k === "remove" && step.expect) as Extract<Step, { k: "remove" }>).target;
    const release = fake.openEngine("fuigo");
    const refused = run(fx, planned);
    expect(refused.homeReasons[key(fx)]).toBe("engine-open");
    expect(existsSync(join(listed, "s-1", "chat_history.jsonl"))).toBe(true);
    expect(existsSync(`${listed}.murage-deleting`)).toBe(false);
    release();
    expect(run(fx, planned).failed).toEqual([]);
    expect(existsSync(listed)).toBe(false);
    expect(h).toBeTruthy();
  });

  it("without the helper nothing is changed at all, and the home says so (helper)", () => {
    const fx = buildFixture("claude", scratch);
    const before = treeDigest(fx.root);
    const planned = planEngineHistory(job(fx));
    Object.assign(exclOps, { available: () => false });
    const ran = run(fx, planned);
    expect(ran.homeReasons[key(fx)]).toBe("helper");
    expect(treeDigest(fx.root)).toBe(before);
    expect(owedCodeOf("helper")).toBe("helper");
    expect(ownerNoticeText("Claude Code", "helper")).toContain("cleanup helper");
  });
});

// ── 3: discovery reads everything ───────────────────────────────────────────────────────────────────────────────────────

describe("3: a transcript is read in full, and a read that cannot be done in full fails closed", () => {
  const bigTranscript = (fx: Fixture, bytes: number, tail: string) => {
    const file = join(claudeProject(fx), "sess-claude-1.jsonl");
    const line = dump({ type: "assistant", cwd: fx.folders[0], message: "x".repeat(900) });
    const count = Math.ceil(bytes / line.length);
    writeFileSync(file, line.repeat(count) + tail);
    return file;
  };

  it("a slug written after 32 MiB is found, and the plan removes its plan file", () => {
    const fx = buildFixture("claude", scratch);
    const h = fx.homes[0]!.home;
    bigTranscript(fx, 33 * 1024 * 1024, dump({ type: "assistant", cwd: fx.folders[0], slug: "deep-slug", message: "end" }));
    writeFileSync(join(h, "plans", "deep-slug.md"), C("claude"));
    const planned = planEngineHistory(job(fx));
    expect(planned.failedHomes).toEqual([]);
    expect(planned.discovery![key(fx)]!.slugs).toContain("deep-slug");
    expect(run(fx, planned).failed).toEqual([]);
    expect(existsSync(join(h, "plans", "deep-slug.md"))).toBe(false);
  }, 60_000);

  it("a single line over 64 MiB is not read: the home gets no plan and nothing in it is touched", () => {
    const fx = buildFixture("claude", scratch);
    const file = join(claudeProject(fx), "sess-claude-1.jsonl");
    writeFileSync(file, `{"cwd":${JSON.stringify(fx.folders[0])},"pad":"${"y".repeat(70 * 1024 * 1024)}"}\n`);
    const before = treeDigest(fx.homes[0]!.home);
    const planned = planEngineHistory(job(fx));
    expect(planned.failedHomes).toEqual([key(fx)]);
    expect(planned.plans![key(fx)]).toBeUndefined();
    expect(planned.homeReasons![key(fx)]).toMatch(/longer than/);
    expect(treeDigest(fx.homes[0]!.home)).toBe(before);
  }, 60_000);

  it("a read error at 17 MiB fails closed: no plan, nothing touched", () => {
    const fx = buildFixture("claude", scratch);
    bigTranscript(fx, 20 * 1024 * 1024, "");
    const before = treeDigest(fx.homes[0]!.home);
    const real = fsOps.readAt;
    fsOps.readAt = ((fd: number, buffer: Buffer, position: number) => {
      if (position >= 17 * 1024 * 1024) throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
      return real(fd, buffer, position);
    }) as typeof fsOps.readAt;
    let planned: ReturnType<typeof planEngineHistory>;
    try { planned = planEngineHistory(job(fx)); } finally { fsOps.readAt = real; }
    expect(planned.failedHomes).toEqual([key(fx)]);
    expect(planned.homeReasons![key(fx)]).toBe("EIO");
    expect(treeDigest(fx.homes[0]!.home)).toBe(before);
  }, 60_000);
});

// ── 4, 5, 7: what is cleared, per format ─────────────────────────────────────────────────────────────────────────────────

describe("4: a row whose key is written with an escape is the row it spells", () => {
  it("projec\\u0074 is `project`: the row is found, its words go, and an interruption at any write is finished by the crash journal before the next plan", () => {
    const row = (fx: Fixture) => `{"display":"${C("claude")}-escaped","pastedContents":{"1":{"contentHash":"0011223344556677"}},"timestamp":9,"projec\\u0074":${JSON.stringify(fx.folders[0])},"sessionId":"sess-not-ours"}\n`;
    let writes = 0;
    for (let crashAt = 1; crashAt < 20; crashAt++) {
      const fx = buildFixture("claude", scratch);
      const history = join(fx.homes[0]!.home, "history.jsonl");
      appendFileSync(history, row(fx));
      const planned = planEngineHistory(job(fx));
      const real = mutOps.pwrite;
      let seen = 0;
      mutOps.pwrite = ((fd: number, bytes: Buffer, position: number) => { if (++seen === crashAt) throw new Error("crash"); real(fd, bytes, position); }) as typeof mutOps.pwrite;
      try { run(fx, planned); } finally { mutOps.pwrite = real; }
      if (seen < crashAt) break;
      writes = crashAt;
      // planning begins by finishing the crash journal: whichever write the crash cut, the row is whole and cleared before it is planned
      const after = planEngineHistory(job(fx, { known: planned.discovery }));
      expect(readFileSync(history, "utf8"), `crash at write ${crashAt}`).not.toContain("-escaped");
      expect(rewriteSteps(after.plans!).some((step) => step.lines.length > 0), `crash at write ${crashAt}`).toBe(false);
      expect(run(fx, after).failed).toEqual([]);
      const done = readFileSync(history, "utf8");
      expect(done).not.toContain("-escaped");
      expect(done).not.toContain("0011223344556677");
      expect(done).toContain(B("claude"));
      expect(rewriteSteps(planEngineHistory(job(fx, { known: planned.discovery })).plans!).some((step) => step.lines.length > 0)).toBe(false);
    }
    expect(writes).toBeGreaterThan(0);
  });
});

describe("5: Fuigo's and Grok's structured context is cleared whole", () => {
  for (const engine of ["fuigo", "grok"] as const) {
    it(`${engine}: ctx holding content as keys and as number arrays becomes {} padded to the same length; the record is done only after`, () => {
      const fx = buildFixture(engine, scratch);
      const log = join(fx.homes[0]!.home, "logs", "unified.jsonl");
      const ctx = { [`${C(engine)}-key`]: [104, 105, 106, 107], nested: { more: 1 } };
      const row = JSON.stringify({ ts: "2026-10-12T00:00:00Z", src: "cli", pid: 4242, ver: "1.2.3", lvl: "info", sid: "s-1", msg: `${C(engine)}-msg`, ctx });
      appendFileSync(log, row + "\n");
      const planned = planEngineHistory(job(fx));
      expect(hasContentSteps(planned.plans![key(fx)]!)).toBe(true);
      expect(run(fx, planned).failed).toEqual([]);
      const cleared = readFileSync(log, "utf8").split("\n").find((line) => line.includes('"ctx"') && line.includes("4242"))!;
      expect(cleared.length).toBe(row.length);
      const parsed = JSON.parse(cleared) as Record<string, unknown>;
      expect(parsed.ctx).toEqual({});
      expect(cleared).toContain(`"ctx":{}`);
      expect(cleared).not.toContain(C(engine));
      expect(parsed).toMatchObject({ ts: "2026-10-12T00:00:00Z", src: "cli", pid: 4242, ver: "1.2.3", lvl: "info", sid: "s-1" }); // identifiers and meta stay
      expect(parsed.msg).toBe(" ".repeat(`${C(engine)}-msg`.length));
      expect(hasContentSteps(planEngineHistory(job(fx)).plans![key(fx)]!)).toBe(false);
    });
  }

  it("a payload of one byte becomes 0; an unknown field is content", () => {
    const format = JSONL_FORMAT["fuigo-unified"]!;
    const row = Buffer.from('{"sid":"a","ctx":7,"extra":[1,2],"flag":true,"note":"secret"}');
    const out = Buffer.from(row);
    for (const edit of clearEdits(row, format)!) edit.bytes.copy(out, edit.at);
    expect(JSON.parse(out.toString())).toEqual({ sid: "a", ctx: 0, extra: [], flag: true, note: "      " });
    expect(out.length).toBe(row.length);
    expect(isCleared(out, format)).toBe(true);
  });
});

describe("6: a lossy project key shared by two folders keeps the other folder's side files", () => {
  it("/work-a and /work_a: only the chat that names this folder, and its todo, debug log and plan, go", () => {
    const root = mkdtempSync(join(scratch, "qwen-lossy-"));
    const home = join(root, ".qwen");
    const a = join(root, "work-a"), b = join(root, "work_a");
    expect(qwenProjectKey(a)).toBe(qwenProjectKey(b));
    const chats = join(home, "projects", qwenProjectKey(a), "chats");
    const sidA = "aaaaaaaa-1111-4222-8333-444455556666", sidB = "bbbbbbbb-1111-4222-8333-444455556666";
    const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
    put(join(chats, `${sidA}.jsonl`), dump({ cwd: a, message: C("qwen") }));
    put(join(chats, `${sidB}.jsonl`), dump({ cwd: b, message: B("qwen") }));
    for (const sid of [sidA, sidB]) {
      put(join(home, "todos", `${sid}.json`), sid === sidA ? C("qwen") : B("qwen"));
      put(join(home, "debug", `${sid}.txt`), sid === sidA ? C("qwen") : B("qwen"));
      put(join(home, "plans", `${sid}.md`), sid === sidA ? C("qwen") : B("qwen"));
    }
    const homes = [{ engine: "qwen" as const, home, secondary: home }];
    const result = removeEngineHistoryFiles(homes, [a], [], {}, {}, true);
    expect(result.leftovers.length).toBeGreaterThan(0); // the other folder's chat is named, not hidden
    expect(existsSync(join(chats, `${sidA}.jsonl`))).toBe(false);
    for (const dir of ["todos", "debug", "plans"]) {
      const name = dir === "todos" ? `${sidA}.json` : dir === "debug" ? `${sidA}.txt` : `${sidA}.md`;
      expect(existsSync(join(home, dir, name)), `${dir} of this folder's chat`).toBe(false);
    }
    expect(readFileSync(join(chats, `${sidB}.jsonl`), "utf8")).toContain(B("qwen"));
    expect(readFileSync(join(home, "todos", `${sidB}.json`), "utf8")).toBe(B("qwen"));
    expect(readFileSync(join(home, "debug", `${sidB}.txt`), "utf8")).toBe(B("qwen"));
    expect(readFileSync(join(home, "plans", `${sidB}.md`), "utf8")).toBe(B("qwen"));
    expect(readdirSync(join(home, "projects"))).toContain(qwenProjectKey(a));
  });
});

describe("7: a cleared row is still a row the engine can read", () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const apply = (name: string, row: Record<string, unknown>) => {
    const bytes = Buffer.from(JSON.stringify(row));
    const out = Buffer.from(bytes);
    for (const edit of clearEdits(bytes, JSONL_FORMAT[name]!)!) edit.bytes.copy(out, edit.at);
    expect(out.length).toBe(bytes.length);
    return JSON.parse(out.toString()) as Record<string, unknown>;
  };

  it("Codex history: session_id still parses as a thread UUID, ts is a number, text is a string", () => {
    const row = apply("codex-history", { session_id: "019a0000-aaaa-7bbb-8ccc-000000000001", ts: 1760000000, text: "private words" });
    expect(String(row.session_id)).toMatch(UUID);
    expect(typeof row.ts).toBe("number");
    expect(row.text).toBe(" ".repeat("private words".length));
  });

  it("Codex session_index: id is still a UUID, updated_at stays, thread_name is a string", () => {
    const row = apply("codex-session-index", { id: "019a0000-aaaa-7bbb-8ccc-000000000001", thread_name: "private title", updated_at: "2026-10-12T00:00:00Z" });
    expect(String(row.id)).toMatch(UUID);
    expect(row.updated_at).toBe("2026-10-12T00:00:00Z");
    expect(row.thread_name).toBe(" ".repeat("private title".length));
  });

  it("Fuigo LogEntry: ts, src, pid, ver, lvl and sid are unchanged (the enums still deserialize); msg is a string; ctx is an object", () => {
    const entry = { ts: "2026-10-12T00:00:00.000Z", src: "cli", pid: 77, ver: "1.0.5", lvl: "warn", sid: "s-1", msg: "words", ctx: { a: "b" } };
    const row = apply("fuigo-unified", entry);
    for (const field of ["ts", "src", "pid", "ver", "lvl", "sid"] as const) expect(row[field]).toEqual(entry[field]);
    expect(typeof row.msg).toBe("string");
    expect(row.ctx).toEqual({});
  });

  it("Claude history: timestamp, project and sessionId are unchanged; display is a string; pastedContents is an object", () => {
    const entry = { display: "prompt", pastedContents: { 1: { id: 1, type: "text", content: "pasted" } }, timestamp: 1760000000000, project: "/work/a", sessionId: "6f3a8a3e-2b7c-4d54-9d0a-0d9f1e1c2b3a" };
    const row = apply("claude-history", entry);
    expect([row.timestamp, row.project, row.sessionId]).toEqual([entry.timestamp, entry.project, entry.sessionId]);
    expect(typeof row.display).toBe("string");
    expect(row.pastedContents).toEqual({});
  });

  it("Kimi session_index: ids, workDir, sessionDir and the times stay; the title, the last prompt and every other string go", () => {
    const entry = { sessionId: "s1", sessionDir: "/kimi/sessions/s1", workDir: "/work/a", createdAt: "2026-10-12T00:00:00Z", updatedAt: "2026-10-12T01:00:00Z", title: "t", lastPrompt: "p", summary: "extra words" };
    const row = apply("kimi-session-index", entry);
    for (const field of ["sessionId", "sessionDir", "workDir", "createdAt", "updatedAt"] as const) expect(row[field]).toEqual(entry[field]);
    expect(row.title).toBe(" ");
    expect(row.lastPrompt).toBe(" ");
    expect(row.summary).toBe(" ".repeat("extra words".length));
  });
});

// ── Windows: the same flows, through the share-none handle (held by the addon) ───────────────────────────────────────────────────────────────

describe("Windows: nothing is changed unless the file is opened with sharing off and held", () => {
  beforeEach(() => { fake.restore(); fake = useFakeExclusion("win32"); });

  it("Kimi's session index is cleared in place through a handle shared with every other opener (no aside, no rename, no share-none open), and the same inode", () => {
    const fx = buildFixture("kimi", scratch);
    const history = join(fx.homes[0]!.home, "session_index.jsonl");
    const inode = lstatSync(history).ino;
    const planned = planEngineHistory(job(fx));
    const renames: string[] = [];
    const real = mutOps.rename;
    mutOps.rename = ((from: string, to: string) => { renames.push(from); real(from, to); }) as typeof mutOps.rename;
    try { expect(run(fx, planned).failed).toEqual([]); } finally { mutOps.rename = real; }
    expect(fake.calls.filter((call) => call === `openFile exclusive ${history}`)).toHaveLength(0);
    expect(fake.calls.filter((call) => call === `openFile shared ${history}`).length).toBeGreaterThan(0);
    expect(renames.includes(history)).toBe(false);
    expect(lstatSync(history).ino).toBe(inode);
    expect(readFileSync(history, "utf8")).not.toContain(C("kimi"));
  });

  it("Codex's session index is cleared in place through a handle shared with every other opener (no aside, no rename, no lock), and the same inode", () => {
    const fx = buildFixture("codex", scratch);
    const history = join(fx.homes[0]!.home, "session_index.jsonl");
    const inode = lstatSync(history).ino;
    const planned = planEngineHistory(job(fx));
    const renames: string[] = [];
    const real = mutOps.rename;
    mutOps.rename = ((from: string, to: string) => { renames.push(from); real(from, to); }) as typeof mutOps.rename;
    try { expect(run(fx, planned).failed).toEqual([]); } finally { mutOps.rename = real; }
    expect(fake.calls.filter((call) => call === `openFile exclusive ${history}`)).toHaveLength(0);
    expect(fake.calls.filter((call) => call === `openFile shared ${history}`).length).toBeGreaterThan(0);
    expect(renames.includes(history)).toBe(false);
    expect(lstatSync(history).ino).toBe(inode);
    expect(readFileSync(history, "utf8")).not.toContain(C("codex"));
  });

  it("a file something else has open (sharing violation) is left alone and the home is pending", () => {
    const fx = buildFixture("kimi", scratch);
    const history = join(fx.homes[0]!.home, "session_index.jsonl");
    const before = readFileSync(history);
    const planned = asExclusive(planEngineHistory(job(fx)));
    fake.refuse.add(history);
    const refused = run(fx, planned);
    expect(refused.homeReasons[key(fx)]).toBe("held");
    expect(readFileSync(history).equals(before)).toBe(true);
  });

  it("a transcript is opened share-none with the right to delete, read in full through that handle, and removed; a held one is not", () => {
    const fx = buildFixture("claude", scratch);
    const project = claudeProject(fx);
    const transcript = join(project, "sess-claude-1.jsonl");
    const planned = planEngineHistory(job(fx));
    fake.refuse.add(transcript);
    expect(run(fx, planned).homeReasons[key(fx)]).toBe("held");
    expect(existsSync(transcript)).toBe(true);
    expect(existsSync(`${project}.murage-deleting`)).toBe(false);
    fake.refuse.clear();
    expect(run(fx, planned).failed).toEqual([]);
    expect(existsSync(transcript)).toBe(false);
  });

  it("the engine's lock files (Fuigo) still go through the lock call on a descriptor", () => {
    const fx = buildFixture("fuigo", scratch);
    fake.calls.length = 0;
    expect(run(fx).failed).toEqual([]);
    expect(fake.calls).toContain("lock");
    expect(fake.calls.some((call) => call.startsWith("openFile exclusive") && call.includes("unified.jsonl"))).toBe(false);
  });
});

// ── what the owner is told, and in what order ───────────────────────────────────────────────────────────────────────────

class ScriptedWorker extends EventEmitter {
  threadId = 11;
  readonly script: (job: EngineHistoryJob, worker: ScriptedWorker) => void;
  constructor(script: (job: EngineHistoryJob, worker: ScriptedWorker) => void) { super(); this.script = script; }
  postMessage(message: EngineHistoryJob) { setImmediate(() => this.script(message, this)); }
  terminate() { setImmediate(() => this.emit("exit", 0)); return Promise.resolve(0); }
}

describe("the owner is told on the first attempt that an engine has its files open, and when its copy is gone", () => {
  it("raises the engine-open line at once, with Try again now; clears it and says Removed when the engine lets go; the revision only goes up", async () => {
    const fx = buildFixture("fuigo", scratch);
    const log = join(fx.homes[0]!.home, "logs", "unified.jsonl");
    const data = join(fx.root, "data");
    mkdirSync(data, { recursive: true });
    const db = new DatabaseSync(join(data, "messages.db"));
    openDatabases.push(db);
    const seen: Array<{ texts: string[]; rev: number }> = [];
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [], owedGraceMs: 0, onOwed: (notices, rev) => seen.push({ texts: notices.map((item) => item.text), rev }) });
    engineHistoryTestHooks.createWorker = () => new ScriptedWorker((message, worker) => worker.emit("message", { type: "result", result: runEngineHistoryJob(message) })) as unknown as Worker;
    const release = fake.keepLock(log);
    const first = await runConversationDeletion(deletions, { threadIds: ["2e9018ee-1f45-46be-8ed1-7a02fc022807"], engineHomes: fx.homes }, () => true);
    expect(first.report.failed).toContain(fx.homes[0]!.home); // the engine holds the log's lock: the home is open
    const line = "Fuigo is open. Murage finishes removing this conversation from it by itself once Fuigo is closed. Nothing is needed from you.";
    expect(deletions.notices().map((item) => [item.text, item.tryAgain])).toEqual([[line, true]]);
    expect(seen.at(-1)!.texts).toEqual([line]);
    expect(deletions.pending()[0]!.owed?.items.map((item) => [item.engine, item.code, item.named])).toEqual(fx.homes.map(() => ["fuigo", "engine-open", true]));
    release();
    expect((await deletions.retryNow()).started).toBe(1);
    expect(deletions.pending()).toEqual([]);
    // F16: no "Removed from" line; nothing owed, nothing shown
    expect(deletions.notices()).toEqual([]);
    expect(seen.at(-1)!.texts).toEqual([]);
    const revs = seen.map((item) => item.rev);
    expect([...revs].sort((x, y) => x - y)).toEqual(revs);
    expect(new Set(revs).size).toBe(revs.length);
    expect(deletions.currentRev()).toBe(revs.at(-1));
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
    deletions.dispose();
  });
});

describe("the structure of a plan", () => {
  it("every rewrite step names its format and how the writer is kept off; asides are planned first", () => {
    for (const engine of ["fuigo", "grok", "claude", "codex", "kimi"] as const) {
      const fx = buildFixture(engine, scratch);
      const steps = rewriteSteps(planEngineHistory(job(fx)).plans!);
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(Object.keys(JSONL_FORMAT)).toContain(step.format);
        expect(["lock", "exclusive", "dirlock", "inplace"]).toContain(step.how);
      }
    }
  });
});
