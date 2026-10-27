// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A helper that cannot load on this system (engine-exclusion.node refused by the loader, as on an older glibc): the copy still owed in
// an engine's own history is named at once with words that promise no finish, and no retry timer is armed. Every start still runs the
// deletion's own work in full (rows, records, Murage's own files); only a start of ANOTHER version plans that home again. A helper that
// loaded but gave no answer keeps the normal schedule.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConversationDeletions, owedCodeOf, ownerNoticeText, runConversationDeletion, type OwnerNotice } from "./conversation-deletion.ts";
import { exclOps, mutOps } from "./engine-fs.ts";
import { homeKey } from "./engine-plan-core.ts";
import { engineHistoryTestHooks, type EngineHistoryJob } from "./engine-history-offthread.ts";
import { runEngineHistoryJob } from "./engine-history-run.ts";
import { buildFixture, THREAD, type Fixture } from "./testing/engine-history-fixtures.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-unloadable-")));
const openDatabases: DatabaseSync[] = [];
const services: ConversationDeletions[] = [];
const realAvailable = exclOps.available;
const realBarriers = { fsyncFile: mutOps.fsyncFile, fsyncDir: mutOps.fsyncDir };
afterAll(() => { for (const db of openDatabases) db.close(); removeTempDirSync(scratch); });
beforeEach(() => { exclOps.available = () => false; });
afterEach(() => {
  exclOps.available = realAvailable;
  Object.assign(mutOps, realBarriers);
  for (const service of services.splice(0)) service.dispose();
  for (const name of Object.keys(engineHistoryTestHooks)) delete (engineHistoryTestHooks as Record<string, unknown>)[name];
});

class ScriptedWorker extends EventEmitter {
  threadId = 12;
  readonly script: (job: EngineHistoryJob, worker: ScriptedWorker) => void;
  constructor(script: (job: EngineHistoryJob, worker: ScriptedWorker) => void) { super(); this.script = script; }
  postMessage(message: EngineHistoryJob) { setImmediate(() => this.script(message, this)); }
  terminate() { setImmediate(() => this.emit("exit", 0)); return Promise.resolve(0); }
}
/** Runs every job in this thread (so the stubbed helper applies) and counts the plans: one plan is one attempt. `planned` lists the
 * homes (`engine\0home`) each plan was asked for. `override` gives a failed home another reason than the plan found (Murage's own turn
 * on it, another program holding it). */
function counting(override?: (key: string) => string | undefined): { plans: () => number; planned: string[][] } {
  let plans = 0;
  const planned: string[][] = [];
  engineHistoryTestHooks.createWorker = () => new ScriptedWorker((message, worker) => {
    if (message.kind === "plan") {
      plans++;
      planned.push(message.homes.map((home) => homeKey(home.engine, home.home)).filter((key) => !message.only || message.only.includes(key)));
    }
    const result = runEngineHistoryJob(message);
    if (override && message.kind === "plan") for (const key of result.failedHomes ?? []) { const reason = override(key); if (reason) result.homeReasons![key] = reason; }
    worker.emit("message", { type: "result", result });
  }) as unknown as Worker;
  return { plans: () => plans, planned };
}
const dataOf = (fx: Fixture) => join(fx.root, "data");
function service(fx: Fixture, options: Partial<ConstructorParameters<typeof ConversationDeletions>[0]> = {}): ConversationDeletions {
  const data = dataOf(fx);
  mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(join(data, "messages.db"));
  openDatabases.push(db);
  const made = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [15, 15], slowRetryMs: 40, openRetryMs: 40, ...options });
  services.push(made);
  return made;
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const WORDS = "Murage removed this conversation, but could not clear it from Claude Code's own history on this system. Murage tries again after its next update.";

describe("a helper that cannot load on this system", () => {
  it("is named at once, in words that promise no finish, and arms no retry timer", async () => {
    const fx = buildFixture("claude", scratch);
    const told: OwnerNotice[][] = [];
    // the default grace (2 minutes) is left in place: this line does not wait for it
    const deletions = service(fx, { appVersion: () => "1.0.7", onOwed: (notices) => told.push(notices) });
    const count = counting();
    const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    expect(report.failed).toContain(fx.homes[0]!.home);
    const notices = deletions.notices();
    expect(notices.map((item) => item.text)).toEqual([WORDS]);
    expect(notices[0]).toMatchObject({ waitsForUpdate: true, tryAgain: true, label: "Claude Code" });
    expect(notices[0]!.byItself).toBeUndefined();
    expect(told.at(-1)?.map((item) => item.text)).toEqual([WORDS]); // the window is told right away, not after a grace period
    expect(deletions.pending()[0]!.owed?.items.map((item) => [item.code, item.named, item.version])).toEqual([["helper-unloadable", true, "1.0.7"]]);
    // the schedule would have tried again at 15 ms, 30 ms, then every 40 ms: nothing runs
    await delay(400);
    expect(count.plans()).toBe(1);
  });

  it("a start of another version plans the home again", async () => {
    const fx = buildFixture("claude", scratch);
    const waiting = homeKey(fx.homes[0]!.engine, fx.homes[0]!.home);
    const count = counting();
    const first = service(fx, { appVersion: () => "1.0.7" });
    await runConversationDeletion(first, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    expect(count.plans()).toBe(1);
    first.dispose();

    const updated = service(fx, { appVersion: () => "1.0.8" });
    await updated.reconcile(() => false, () => {});
    expect(count.plans()).toBe(2);
    expect(count.planned[1]).toEqual([waiting]);
    // still unloadable under the new version: recorded under it, named at once, and again no timer
    expect(updated.pending()[0]!.owed?.items.map((item) => [item.code, item.version])).toEqual([["helper-unloadable", "1.0.8"]]);
    expect(updated.notices().map((item) => item.text)).toEqual([WORDS]);
    await delay(300);
    expect(count.plans()).toBe(2);
  });

  it("\"Try again now\" still tries, and says what Murage does next", async () => {
    const fx = buildFixture("claude", scratch);
    const count = counting();
    const deletions = service(fx, { appVersion: () => "1.0.7" });
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    const result = await deletions.retryNow();
    expect(count.plans()).toBe(2);
    expect(result.still).toEqual([{ engine: "claude", code: "helper-unloadable" }]);
    expect(result.line).toBe("Nothing changed. Murage tries again after its next update.");
    await delay(300);
    expect(count.plans()).toBe(2);
  });

  it("a helper that loaded but could not make its writes durable keeps today's schedule: not named before it runs out, and tried again", async () => {
    exclOps.available = realAvailable; // the real helper, loaded
    expect(exclOps.available()).toBe(true);
    // the durability barrier reports no barrier at all (engine-exec.ts durableBarrier): a HelperError of a helper that is there
    Object.assign(mutOps, { fsyncFile: () => undefined, fsyncDir: () => undefined });
    const fx = buildFixture("claude", scratch);
    const count = counting();
    const deletions = service(fx, { appVersion: () => "1.0.7", owedGraceMs: 0 });
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    expect(deletions.pending()[0]!.owed?.items.map((item) => [item.code, item.named ?? false, item.version])).toEqual([["helper", false, undefined]]);
    expect(deletions.notices()).toEqual([]);
    await delay(400);
    expect(count.plans()).toBeGreaterThan(2); // the schedule (15 ms, 15 ms, then every 40 ms) keeps trying
    const owed = deletions.pending()[0]!.owed?.items ?? [];
    expect(owed.length).toBeGreaterThan(0);
    expect(owed.some((item) => item.code === "helper-unloadable")).toBe(false);
    expect(deletions.notices().some((item) => item.waitsForUpdate)).toBe(false);
  });

  it("a same-version start finishes the deletion's other work and never plans the home that waits for the update", async () => {
    const fx = buildFixture("claude", scratch);
    const waiting = homeKey(fx.homes[0]!.engine, fx.homes[0]!.home);
    const count = counting();
    const name = "0a1b2c3d-1111-4222-8333-444455556666.png";
    const file = join(dataOf(fx), "attachments", name);
    let failing = true;
    let calls = 0;
    const deleteAttachment = (path: string) => { calls++; if (failing) throw new Error("EBUSY"); rmSync(path, { force: true }); };
    const first = service(fx, { appVersion: () => "1.0.7", deleteAttachment });
    const db = openDatabases.at(-1)!;
    db.exec("CREATE TABLE messages (id TEXT, thread_id TEXT, json TEXT)");
    db.prepare("INSERT INTO messages VALUES (?, ?, ?)").run("m1", THREAD, JSON.stringify({ file: name }));
    mkdirSync(join(dataOf(fx), "attachments"), { recursive: true });
    writeFileSync(file, "x");
    const { report } = await runConversationDeletion(first, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    expect(report.failed).toContain(file);
    expect(count.planned).toEqual([[waiting]]);
    first.dispose();

    failing = false;
    const before = calls;
    const rows: string[] = [];
    const forgotten: string[][] = [];
    const same = service(fx, { appVersion: () => "1.0.7", deleteAttachment, forgetThreads: (ids) => { forgotten.push(ids); } });
    await same.reconcile(() => false, (threadId) => rows.push(threadId));
    expect(rows).toEqual([THREAD]);
    expect(forgotten).toEqual([[THREAD]]);
    expect(calls).toBeGreaterThan(before);
    expect(existsSync(file)).toBe(false);
    expect(count.planned).toEqual([[waiting]]); // the home whose helper would not load under 1.0.7 is not planned again
    expect(same.pending()[0]!.owed?.items.map((item) => [item.code, item.version])).toEqual([["helper-unloadable", "1.0.7"]]);
    // only that home is owed now: no timer, and a later start of the same version still leaves it out
    await delay(200);
    expect(count.planned).toEqual([[waiting]]);
    same.dispose();

    const again = service(fx, { appVersion: () => "1.0.7", deleteAttachment });
    await again.reconcile(() => false, () => {});
    await delay(100);
    expect(count.planned).toEqual([[waiting]]);
    expect(again.pending()).toHaveLength(1);
  });

  it("a record redaction that failed is tried again on a same-version start, and completes", async () => {
    const fx = buildFixture("claude", scratch);
    const waiting = homeKey(fx.homes[0]!.engine, fx.homes[0]!.home);
    const count = counting();
    let failures = 1;
    const forgotten: string[][] = [];
    const forgetThreads = (ids: string[]) => { if (failures > 0) { failures--; throw new Error("SQLITE_BUSY"); } forgotten.push(ids); };
    const first = service(fx, { appVersion: () => "1.0.7", forgetThreads });
    await runConversationDeletion(first, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    expect(failures).toBe(0); // the redaction was asked for and failed
    expect(forgotten).toEqual([]);
    expect(first.pending()[0]!.owed?.items.map((item) => item.code)).toEqual(["helper-unloadable"]);
    first.dispose();

    const same = service(fx, { appVersion: () => "1.0.7", forgetThreads });
    await same.reconcile(() => false, () => {});
    expect(forgotten).toEqual([[THREAD]]);
    expect(count.planned).toEqual([[waiting]]);
    expect(same.pending()).toHaveLength(1);
  });

  it("keeps trying until the notice is in the journal: a save that failed is not a record", async () => {
    const fx = buildFixture("claude", scratch);
    const count = counting();
    const deletions = service(fx, { appVersion: () => "1.0.7" });
    const hooks = deletions as unknown as { save: (entries: Array<{ owed?: unknown }>) => void };
    const realSave = hooks.save.bind(deletions);
    let failures = 1;
    hooks.save = (entries) => { if (failures > 0 && entries.some((entry) => entry.owed)) { failures--; throw new Error("EIO"); } realSave(entries); };
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    expect(deletions.pending()[0]!.owed).toBeUndefined();
    expect(deletions.notices()).toEqual([]);
    await delay(300);
    expect(count.plans()).toBe(2); // tried once more, and that attempt's notice was saved
    expect(deletions.pending()[0]!.owed?.items.map((item) => [item.code, item.version])).toEqual([["helper-unloadable", "1.0.7"]]);
    expect(deletions.notices().map((item) => item.text)).toEqual([WORDS]);
    await delay(300);
    expect(count.plans()).toBe(2);
  });

  it("with another home held by Murage's own turn, the retries work on that home and leave the one waiting for the update", async () => {
    const fx = buildFixture("claude", scratch);
    const other = buildFixture("claude", scratch);
    const waiting = homeKey(fx.homes[0]!.engine, fx.homes[0]!.home);
    const busy = homeKey(other.homes[0]!.engine, other.homes[0]!.home);
    const count = counting((key) => key === busy ? "engine-running" : undefined);
    const deletions = service(fx, { appVersion: () => "1.0.7" });
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [fx.homes[0]!, other.homes[0]!] }, () => true);
    expect(count.planned[0]).toEqual(expect.arrayContaining([waiting, busy]));
    await delay(400);
    const later = count.planned.slice(1);
    expect(later.length).toBeGreaterThan(1); // the busy home keeps its schedule
    expect(later.every((keys) => keys.includes(busy) && !keys.includes(waiting))).toBe(true);
    expect(deletions.pending()[0]!.owed?.items.map((item) => [item.home, item.code]).sort()).toEqual([[busy, "using"], [waiting, "helper-unloadable"]].sort());
    // one engine, two reasons: the line says the one that is true for all of it
    expect(deletions.notices().map((item) => item.text)).toEqual([WORDS]);
    // "Try again now" plans every home, the waiting one too
    const plansBefore = count.planned.length;
    const result = await deletions.retryNow();
    expect(count.planned.slice(plansBefore).some((keys) => keys.includes(waiting))).toBe(true);
    expect(result.still).toEqual([{ engine: "claude", code: "helper-unloadable" }]);
  });

  it("an engine with a home another program holds and a home whose helper cannot load is named for the update", async () => {
    const fx = buildFixture("claude", scratch);
    const other = buildFixture("claude", scratch);
    const held = homeKey(other.homes[0]!.engine, other.homes[0]!.home);
    counting((key) => key === held ? "held" : undefined);
    const deletions = service(fx, { appVersion: () => "1.0.7" });
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [fx.homes[0]!, other.homes[0]!] }, () => true);
    const notices = deletions.notices();
    expect(notices.map((item) => item.text)).toEqual([WORDS]);
    expect(notices[0]!.waitsForUpdate).toBe(true);
    const result = await deletions.retryNow();
    expect(result.still).toEqual([{ engine: "claude", code: "helper-unloadable" }]);
    expect(result.line).toBe("Nothing changed. Murage tries again after its next update.");
  });
});

describe("the answer to \"Try again now\"", () => {
  const line = (still: Array<{ engine: string; code: string }>) => {
    const fx = buildFixture("claude", scratch);
    const deletions = service(fx);
    return (deletions as unknown as { retryLine: (started: number, finished: string[], still: unknown[], unchanged: boolean) => string }).retryLine(1, [], still, true);
  };
  it("promises no try before the next update to an engine whose helper cannot load", () => {
    expect(line([{ engine: "codex", code: "using" }])).toBe("Nothing changed yet. Murage keeps trying by itself.");
    expect(line([{ engine: "claude", code: "helper-unloadable" }])).toBe("Nothing changed. Murage tries again after its next update.");
    expect(line([{ engine: "codex", code: "using" }, { engine: "claude", code: "helper-unloadable" }]))
      .toBe("Nothing changed yet. Murage keeps trying Codex by itself, and tries Claude Code again after its next update.");
  });
});

describe("the words for it", () => {
  it("say what Murage did and does next, for one or many conversations, with the authored rules", () => {
    expect(owedCodeOf("helper-unloadable")).toBe("helper-unloadable");
    expect(ownerNoticeText("Codex", "helper-unloadable", undefined, 3)).toBe("Murage removed these 3 conversations, but could not clear them from Codex's own history on this system. Murage tries again after its next update.");
    for (const count of [1, 2]) {
      const text = ownerNoticeText("Grok", "helper-unloadable", undefined, count);
      expect(text).not.toMatch(/—|–|[\\/]|\bsafe(ly|ty)?\b|\bunsafe\b|\berror\b|by itself|finishes|composio|\$/i);
    }
  });
});
