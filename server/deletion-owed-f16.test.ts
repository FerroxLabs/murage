// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F16 phase 1: what the owner sees about engine copies still owed after a Delete. One line per engine whatever the number of
// deletions or homes; a dismiss that is saved, survives a restart and a retry in flight, and never hides a newer deletion; "Try again
// now" that answers with what changed; no "Removed from" lines; a short grace before anything shows; and a journal that cannot be
// read is never shown as nothing owed. The process list is modelled (testing/engine-exclusion-fake.ts).
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, realpathSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationDeletions, runConversationDeletion, type DeletionServiceOptions } from "./conversation-deletion.ts";
import { engineHistoryTestHooks, type EngineHistoryJob } from "./engine-history-offthread.ts";
import { runEngineHistoryJob } from "./engine-history-run.ts";
import { useFakeExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { buildFixture, THREAD, type Fixture } from "./testing/engine-history-fixtures.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-f16-")));
const openDatabases: DatabaseSync[] = [];
afterAll(() => { for (const db of openDatabases) db.close(); removeTempDirSync(scratch); });

let fake: FakeExclusion;
beforeEach(() => { fake = useFakeExclusion(); });
afterEach(() => {
  fake.restore();
  vi.restoreAllMocks();
  for (const name of Object.keys(engineHistoryTestHooks)) delete (engineHistoryTestHooks as Record<string, unknown>)[name];
});

class ScriptedWorker extends EventEmitter {
  threadId = 16;
  readonly script: (job: EngineHistoryJob, worker: ScriptedWorker) => void;
  constructor(script: (job: EngineHistoryJob, worker: ScriptedWorker) => void) { super(); this.script = script; }
  postMessage(message: EngineHistoryJob) { setImmediate(() => this.script(message, this)); }
  terminate() { setImmediate(() => this.emit("exit", 0)); return Promise.resolve(0); }
}

/** The worker runs each job in this thread; while `held` is set, a job's answer waits until the test lets it go. */
function scriptWorker(): { hold: (on: boolean) => void; waiting: () => (() => void) | undefined } {
  let holding = false;
  let parked: (() => void) | undefined;
  engineHistoryTestHooks.createWorker = () => new ScriptedWorker((message, worker) => {
    const answer = () => worker.emit("message", { type: "result", result: runEngineHistoryJob(message) });
    if (holding) parked = () => { parked = undefined; answer(); }; else answer();
  }) as unknown as Worker;
  return { hold: (on) => { holding = on; }, waiting: () => parked };
}

function service(fx: Fixture, extra: Partial<DeletionServiceOptions> = {}): { deletions: ConversationDeletions; data: string; db: DatabaseSync } {
  const data = join(fx.root, "data");
  mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(join(data, "messages.db"));
  openDatabases.push(db);
  return { deletions: new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [], ...extra } as DeletionServiceOptions), data, db };
}

/** A data folder whose journal already holds deletions owed by engines (the record as 1.0.3 wrote it). */
function journalWith(entries: Array<{ id: string; owed: Array<{ engine: string; code: string; app?: string }> }>): { data: string; db: DatabaseSync } {
  const data = realpathSync.native(mkdtempSync(join(scratch, "journal-")));
  const db = new DatabaseSync(join(data, "messages.db"));
  openDatabases.push(db);
  const since = Date.now() - 30 * 60_000;
  writeFileSync(join(data, "pending-deletions.json"), JSON.stringify(entries.map((entry) => ({
    id: entry.id, createdAt: since, threadIds: [], desks: [], engineHomes: [], attachments: [], artifactBlobs: [], leftovers: [],
    owed: { since, homes: entry.owed },
  }))));
  return { data, db };
}
const appendEntry = (data: string, id: string, owed: Array<{ engine: string; code: string }>) => {
  const file = join(data, "pending-deletions.json");
  const entries = JSON.parse(readFileSync(file, "utf8")) as unknown[];
  const since = Date.now() - 30 * 60_000;
  entries.push({ id, createdAt: since, threadIds: [], desks: [], engineHomes: [], attachments: [], artifactBlobs: [], leftovers: [], owed: { since, homes: owed } });
  writeFileSync(file, JSON.stringify(entries));
};
const coversOf = (notice: unknown): string[] => (notice as { covers?: string[] }).covers ?? [];
const NO_DASH = /[–—]|\bsafe(ly|ty)?\b|\bunsafe\b/i;

describe("one line per engine", () => {
  it("two deletions both owed by Claude Code show ONE line, which counts them", () => {
    const { data, db } = journalWith([
      { id: "a1", owed: [{ engine: "claude", code: "engine-open" }] },
      { id: "b2", owed: [{ engine: "claude", code: "engine-open" }] },
    ]);
    const notices = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [] }).notices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toMatch(/Claude Code/);
    expect(notices[0]!.text).toMatch(/2 /);
    expect(notices[0]!.text).not.toMatch(NO_DASH);
    expect(coversOf(notices[0]).sort()).toEqual(["a1:claude", "b2:claude"]);
  });

  it("one deletion owed by two homes of the same engine, and by a second engine, shows one line per engine", () => {
    const { data, db } = journalWith([{ id: "c3", owed: [{ engine: "fuigo", code: "engine-open" }, { engine: "fuigo", code: "held" }, { engine: "codex", code: "engine-open" }] }]);
    const notices = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [] }).notices();
    expect(notices.map((item) => item.id)).toEqual(["owed:fuigo", "owed:codex"]);
    for (const notice of notices) expect(notice.text).not.toMatch(NO_DASH);
  });
});

describe("dismiss is saved", () => {
  it("a dismissed line stays gone after a reload and after a restart of the service", async () => {
    const { data, db } = journalWith([{ id: "d4", owed: [{ engine: "codex", code: "engine-open" }] }]);
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [] });
    const [notice] = deletions.notices();
    await deletions.dismiss(coversOf(notice));
    expect(deletions.notices()).toEqual([]);
    const restarted = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [] });
    expect(restarted.notices()).toEqual([]);
    // the deletion itself is still owed: it keeps being retried, it is only not shown
    expect(restarted.pending()).toHaveLength(1);
  });

  it("a NEWER deletion owed by the same engine shows again after a dismiss", async () => {
    const { data, db } = journalWith([{ id: "e5", owed: [{ engine: "claude", code: "engine-open" }] }]);
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [] });
    await deletions.dismiss(coversOf(deletions.notices()[0]));
    expect(deletions.notices()).toEqual([]);
    appendEntry(data, "f6", [{ engine: "claude", code: "engine-open" }]);
    const shown = deletions.notices();
    expect(shown).toHaveLength(1);
    expect(coversOf(shown[0])).toEqual(["f6:claude"]);
  });

  it("a dismiss made while a retry is in flight survives the retry", async () => {
    const fx = buildFixture("fuigo", scratch);
    const worker = scriptWorker();
    const { deletions, data, db } = service(fx, { owedGraceMs: 0 } as Partial<DeletionServiceOptions>);
    const release = fake.openEngine("fuigo");
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    const [notice] = deletions.notices();
    expect(coversOf(notice)).toHaveLength(1);
    worker.hold(true);
    const retrying = deletions.retryNow();
    await vi.waitFor(() => expect(worker.waiting()).toBeDefined());
    await deletions.dismiss(coversOf(notice));
    worker.hold(false);
    worker.waiting()!();
    await retrying;
    expect(deletions.notices()).toEqual([]);
    expect(new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [] }).notices()).toEqual([]);
    release();
    deletions.dispose();
  });
});

describe("Try again now answers with what changed", () => {
  it("returns { finished, still, unchanged } and leaves no 'Removed from' line behind", async () => {
    const fx = buildFixture("fuigo", scratch);
    scriptWorker();
    const { deletions } = service(fx, { owedGraceMs: 0 } as Partial<DeletionServiceOptions>);
    const release = fake.openEngine("fuigo");
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    const again = await deletions.retryNow() as unknown as { finished: string[]; still: Array<{ engine: string; code: string }>; unchanged: boolean; line: string };
    expect(again.finished).toEqual([]);
    expect(again.still.map((item) => [item.engine, item.code])).toEqual([["fuigo", "engine-open"]]);
    expect(again.unchanged).toBe(true);
    expect(again.line).not.toMatch(NO_DASH);
    release();
    const done = await deletions.retryNow() as unknown as { finished: string[]; still: unknown[]; unchanged: boolean; line: string };
    expect(done.finished).toEqual(["fuigo"]);
    expect(done.still).toEqual([]);
    expect(done.unchanged).toBe(false);
    expect(done.line).toBe("Removed from Fuigo.");
    expect(deletions.pending()).toEqual([]);
    // no done line: nothing owed, nothing shown
    expect(deletions.notices()).toEqual([]);
    deletions.dispose();
  });
});

describe("a grace period before anything shows", () => {
  it("the first attempt shows nothing; the line appears once the grace has passed, and the window is told", async () => {
    const fx = buildFixture("fuigo", scratch);
    scriptWorker();
    const told: string[][] = [];
    const { deletions } = service(fx, { owedGraceMs: 150, onOwed: (notices) => told.push(notices.map((item) => item.text)) } as Partial<DeletionServiceOptions>);
    const release = fake.openEngine("fuigo");
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    expect(deletions.notices()).toEqual([]);
    expect(deletions.pending()).toHaveLength(1);
    await vi.waitFor(() => expect(deletions.notices()).toHaveLength(1), { timeout: 3000 });
    await vi.waitFor(() => expect(told.at(-1)).toHaveLength(1), { timeout: 3000 });
    release();
    deletions.dispose();
  });

  it("the default grace hides the line after the first attempt", async () => {
    const fx = buildFixture("fuigo", scratch);
    scriptWorker();
    const { deletions } = service(fx);
    const release = fake.openEngine("fuigo");
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    expect(deletions.notices()).toEqual([]);
    release();
    deletions.dispose();
  });
});

describe("a journal that cannot be read is never shown as nothing owed", () => {
  it("notices say Murage could not read its list; pending and begin refuse; the file is left as it was", () => {
    const data = realpathSync.native(mkdtempSync(join(scratch, "torn-")));
    const db = new DatabaseSync(join(data, "messages.db"));
    openDatabases.push(db);
    const file = join(data, "pending-deletions.json");
    writeFileSync(file, '[{"id":"g7","threadIds":[], "owed":');
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [] });
    const notices = deletions.notices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.tryAgain).toBe(true);
    expect(notices[0]!.text).not.toMatch(NO_DASH);
    expect(() => deletions.pending()).toThrow();
    expect(() => deletions.begin({ threadIds: ["h8"] })).toThrow();
    expect(readFileSync(file, "utf8")).toBe('[{"id":"g7","threadIds":[], "owed":');
  });
});

describe("saved before it is published", () => {
  it("a dismiss that cannot be saved throws, tells nobody, and the line stays", async () => {
    const { data, db } = journalWith([{ id: "j9", owed: [{ engine: "codex", code: "engine-open" }] }]);
    const told: unknown[] = [];
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [], onOwed: (notices) => told.push(notices) });
    const [notice] = deletions.notices();
    // the journal's save fails as a full disk or a folder Murage may not write fails it (on every platform: a folder's read-only mode
    // does not stop a write on Windows)
    const saving = vi.spyOn(deletions as unknown as { save(entries: unknown[]): void }, "save").mockImplementation(() => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); });
    try {
      await expect(deletions.dismiss(coversOf(notice))).rejects.toThrow("EACCES");
      expect(saving).toHaveBeenCalledTimes(1);
    } finally { saving.mockRestore(); }
    expect(told).toEqual([]);
    expect(deletions.notices()).toHaveLength(1);
  });
});

describe("an owed line is told again on every attempt (GrokBuild deletion-gate High)", () => {
  it("a retry whose owed list did not change broadcasts the line again; a dismissed line is not broadcast again", async () => {
    const fx = buildFixture("fuigo", scratch);
    scriptWorker();
    const told: Array<{ texts: string[]; rev: number }> = [];
    const { deletions } = service(fx, { owedGraceMs: 0, onOwed: (notices: Array<{ text: string }>, rev: number) => told.push({ texts: notices.map((item) => item.text), rev }) } as Partial<DeletionServiceOptions>);
    const release = fake.openEngine("fuigo");
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    await vi.waitFor(() => expect(told.at(-1)?.texts).toHaveLength(1));
    const before = told.length;
    const lastRev = told.at(-1)!.rev;
    // a window that dropped the last broadcast (a dismiss answered while this deletion became owed) gets the line on the next attempt
    await deletions.retryNow();
    expect(told.length).toBeGreaterThan(before);
    expect(told.at(-1)!.texts).toHaveLength(1);
    expect(told.at(-1)!.rev).toBeGreaterThan(lastRev);
    // once the owner dismissed it, an unchanged retry stays quiet about it
    await deletions.dismiss(coversOf(deletions.notices()[0]));
    const afterDismiss = told.length;
    await deletions.retryNow();
    expect(told.slice(afterDismiss).every((frame) => frame.texts.length === 0)).toBe(true);
    release();
  });
});

describe("a dropped broadcast is told again on an automatic retry, not on every one (rc1 Grok High)", () => {
  it("an unchanged automatic retry tells an undismissed line again once the retell interval has passed, and stops once dismissed", async () => {
    const fx = buildFixture("fuigo", scratch);
    scriptWorker();
    const told: string[][] = [];
    const { deletions } = service(fx, { owedGraceMs: 0, owedRetellMs: 0, retryDelaysMs: [10, 10, 10], slowRetryMs: 60_000, onOwed: (notices: Array<{ text: string }>) => told.push(notices.map((item) => item.text)) } as Partial<DeletionServiceOptions>);
    const release = fake.openEngine("fuigo");
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    // the window dropped the first frame: only the automatic retries (no Try again, no reconnect) can tell it
    await vi.waitFor(() => expect(told.filter((texts) => texts.length).length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    await deletions.dismiss(coversOf(deletions.notices()[0]));
    const afterDismiss = told.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(told.slice(afterDismiss).every((texts) => texts.length === 0)).toBe(true);
    release();
    deletions.dispose();
  });
});
