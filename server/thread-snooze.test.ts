// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { THREAD_SNOOZE_MAX_MS } from "../shared/thread-snooze.ts";
import {
  initializeThreadSnooze, isSnoozeActivity, isSnoozeReport, wakesActivitySnooze, listThreadSnoozes, snoozeThread, threadSnoozeRequest, unsnoozeThread, wakeThreadOnActivity, wakeThreadSnoozes,
  type ThreadSnoozeDeps,
} from "./thread-snooze.ts";

const roots: string[] = [], databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) { try { db.close(); } catch {} }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-thread-snooze-")); roots.push(root);
  const file = join(root, "messages.db"), db = new DatabaseSync(file); databases.push(db);
  initializeThreadSnooze(db);
  return { db, file };
}
const HOUR = 60 * 60 * 1000, NOW = 1_800_000_000_000;

it("persists a snooze across a restart and lists only the ones still in effect", () => {
  const f = fixture();
  snoozeThread(f.db, "thread-a", NOW + HOUR, { now: NOW, owed: false });
  snoozeThread(f.db, "thread-b", NOW + 2 * HOUR, { now: NOW, owed: false });
  f.db.close();
  const reopened = new DatabaseSync(f.file); databases.push(reopened); initializeThreadSnooze(reopened);
  expect(listThreadSnoozes(reopened, NOW)).toEqual([
    { threadId: "thread-a", until: NOW + HOUR },
    { threadId: "thread-b", until: NOW + 2 * HOUR },
  ]);
  // Past its time it is no longer in effect even before anything sweeps it.
  expect(listThreadSnoozes(reopened, NOW + HOUR)).toEqual([{ threadId: "thread-b", until: NOW + 2 * HOUR }]);
});

it("snoozing again moves the time, and unsnooze removes it", () => {
  const { db } = fixture();
  snoozeThread(db, "thread", NOW + HOUR, { now: NOW, owed: false });
  snoozeThread(db, "thread", NOW + 3 * HOUR, { now: NOW, owed: false });
  expect(listThreadSnoozes(db, NOW)).toEqual([{ threadId: "thread", until: NOW + 3 * HOUR }]);
  expect(unsnoozeThread(db, "thread")).toBe(true);
  expect(unsnoozeThread(db, "thread")).toBe(false);
  expect(listThreadSnoozes(db, NOW)).toEqual([]);
});

it("refuses times in the past, too far ahead, or not a whole number", () => {
  const { db } = fixture();
  for (const until of [NOW, NOW - 1, NOW + 31 * 24 * HOUR, NOW + 0.5, Number.NaN]) {
    expect(() => snoozeThread(db, "thread", until, { now: NOW, owed: false })).toThrow(/time/);
  }
  expect(listThreadSnoozes(db, NOW)).toEqual([]);
});

it("never snoozes a conversation that is waiting on the owner", () => {
  const { db } = fixture();
  expect(() => snoozeThread(db, "thread", NOW + HOUR, { now: NOW, owed: true })).toThrow(/waiting on your answer/);
  expect(listThreadSnoozes(db, NOW)).toEqual([]);
});

it("wakes a snooze when its time comes, and early when something owed arrives", () => {
  const { db } = fixture();
  snoozeThread(db, "due", NOW + HOUR, { now: NOW, owed: false });
  snoozeThread(db, "owed", NOW + 5 * HOUR, { now: NOW, owed: false });
  snoozeThread(db, "quiet", NOW + 5 * HOUR, { now: NOW, owed: false });
  snoozeThread(db, "deleted", NOW + 5 * HOUR, { now: NOW, owed: false });
  const known = new Set(["due", "owed", "quiet"]);
  const woken = wakeThreadSnoozes(db, { now: NOW + HOUR, owed: new Set(["owed"]), known });
  expect(woken).toEqual(expect.arrayContaining([
    { threadId: "due", reason: "time" },
    { threadId: "owed", reason: "owed" },
    { threadId: "deleted", reason: "gone" },
  ]));
  expect(woken).toHaveLength(3);
  expect(listThreadSnoozes(db, NOW + HOUR)).toEqual([{ threadId: "quiet", until: NOW + 5 * HOUR }]);
  // A second sweep has nothing left to wake: waking happens once.
  expect(wakeThreadSnoozes(db, { now: NOW + HOUR, owed: new Set(["owed"]), known })).toEqual([]);
});

function deps(overrides: Partial<ThreadSnoozeDeps> = {}) {
  const woken: Array<{ threadId: string; reason: string }> = [];
  const value: ThreadSnoozeDeps = {
    now: () => NOW,
    threads: () => new Set(["thread", "other"]),
    owed: () => new Set<string>(),
    wake: (threadId, reason) => { woken.push({ threadId, reason }); },
    ...overrides,
  };
  return { deps: value, woken };
}

it("routes: changes and reads are desktop only and answer 404 elsewhere", () => {
  const { db } = fixture(); const { deps: d } = deps();
  for (const request of [
    { method: "GET", path: "/api/thread-snoozes" },
    { method: "PUT", path: "/api/thread-snoozes/thread", body: { until: NOW + HOUR } },
    { method: "DELETE", path: "/api/thread-snoozes/thread" },
  ]) {
    expect(threadSnoozeRequest(db, { ...request, desktop: false }, d)).toMatchObject({ status: 404 });
  }
  expect(listThreadSnoozes(db, NOW)).toEqual([]);
  expect(threadSnoozeRequest(db, { method: "GET", path: "/api/threads", desktop: true }, d)).toBeNull();
});

it("routes: snooze, list and unsnooze a known conversation", () => {
  const { db } = fixture(); const { deps: d } = deps();
  expect(threadSnoozeRequest(db, { method: "PUT", path: "/api/thread-snoozes/thread", body: { until: NOW + HOUR }, desktop: true }, d))
    .toEqual({ status: 200, body: { snoozes: [{ threadId: "thread", until: NOW + HOUR }] } });
  expect(threadSnoozeRequest(db, { method: "GET", path: "/api/thread-snoozes", desktop: true }, d))
    .toEqual({ status: 200, body: { snoozes: [{ threadId: "thread", until: NOW + HOUR }] } });
  expect(threadSnoozeRequest(db, { method: "DELETE", path: "/api/thread-snoozes/thread", desktop: true }, d))
    .toEqual({ status: 200, body: { snoozes: [] } });
});

it("routes: refuse an unknown conversation, a bad body and an owed conversation", () => {
  const { db } = fixture();
  const { deps: d } = deps({ owed: () => new Set(["thread"]) });
  expect(threadSnoozeRequest(db, { method: "PUT", path: "/api/thread-snoozes/missing", body: { until: NOW + HOUR }, desktop: true }, d)).toMatchObject({ status: 404 });
  expect(threadSnoozeRequest(db, { method: "PUT", path: "/api/thread-snoozes/other", body: { until: NOW + HOUR, extra: 1 }, desktop: true }, d)).toMatchObject({ status: 400 });
  expect(threadSnoozeRequest(db, { method: "PUT", path: "/api/thread-snoozes/other", body: "soon", desktop: true }, d)).toMatchObject({ status: 400 });
  expect(threadSnoozeRequest(db, { method: "PUT", path: "/api/thread-snoozes/thread", body: { until: NOW + HOUR }, desktop: true }, d))
    .toMatchObject({ status: 409, body: { error: expect.stringMatching(/waiting on your answer/) } });
  expect(listThreadSnoozes(db, NOW)).toEqual([]);
});

it("routes: a read wakes what is due or owed and tells the caller, so it can mark them unread", () => {
  const { db } = fixture();
  snoozeThread(db, "thread", NOW + HOUR, { now: NOW, owed: false });
  snoozeThread(db, "other", NOW + 5 * HOUR, { now: NOW, owed: false });
  const { deps: d, woken } = deps({ now: () => NOW + HOUR });
  expect(threadSnoozeRequest(db, { method: "GET", path: "/api/thread-snoozes", desktop: true }, d))
    .toEqual({ status: 200, body: { snoozes: [{ threadId: "other", until: NOW + 5 * HOUR }] } });
  expect(woken).toEqual([{ threadId: "thread", reason: "time" }]);
  const owedNow = deps({ now: () => NOW + HOUR, owed: () => new Set(["other"]) });
  expect(threadSnoozeRequest(db, { method: "GET", path: "/api/thread-snoozes", desktop: true }, owedNow.deps))
    .toEqual({ status: 200, body: { snoozes: [] } });
  expect(owedNow.woken).toEqual([{ threadId: "other", reason: "owed" }]);
});

it("initializing twice is harmless", () => {
  const { db } = fixture();
  initializeThreadSnooze(db);
  snoozeThread(db, "thread", NOW + HOUR, { now: NOW, owed: false });
  initializeThreadSnooze(db);
  expect(listThreadSnoozes(db, NOW)).toHaveLength(1);
});

// "Until new activity" (adapted from OpenMausBot #1205): quiet until the
// conversation has something new that the owner did not write, with the
// usual 30 days as the latest it can sleep.
it("snoozes until new activity, with the 30-day limit as its latest wake", () => {
  const f = fixture();
  expect(snoozeThread(f.db, "thread", "activity", { now: NOW, owed: false })).toEqual({ threadId: "thread", until: NOW + THREAD_SNOOZE_MAX_MS, untilActivity: true });
  snoozeThread(f.db, "timed", NOW + HOUR, { now: NOW, owed: false });
  f.db.close();
  const reopened = new DatabaseSync(f.file); databases.push(reopened); initializeThreadSnooze(reopened);
  expect(listThreadSnoozes(reopened, NOW)).toEqual([
    { threadId: "timed", until: NOW + HOUR },
    { threadId: "thread", until: NOW + THREAD_SNOOZE_MAX_MS, untilActivity: true },
  ]);
  // A timed snooze over it replaces it, and the other way round.
  snoozeThread(reopened, "thread", NOW + 2 * HOUR, { now: NOW, owed: false });
  expect(listThreadSnoozes(reopened, NOW).find((entry) => entry.threadId === "thread")).toEqual({ threadId: "thread", until: NOW + 2 * HOUR });
  snoozeThread(reopened, "timed", "activity", { now: NOW, owed: false });
  expect(listThreadSnoozes(reopened, NOW).find((entry) => entry.threadId === "timed")).toMatchObject({ untilActivity: true });
  expect(() => snoozeThread(reopened, "other", "activity", { now: NOW, owed: true })).toThrow(/waiting on your answer/);
});

it("new activity wakes only a snooze waiting for it", () => {
  const { db } = fixture();
  snoozeThread(db, "waits", "activity", { now: NOW, owed: false });
  snoozeThread(db, "timed", NOW + HOUR, { now: NOW, owed: false });
  expect(wakeThreadOnActivity(db, "timed")).toBe(false);
  expect(wakeThreadOnActivity(db, "missing")).toBe(false);
  expect(wakeThreadOnActivity(db, "waits")).toBe(true);
  expect(wakeThreadOnActivity(db, "waits")).toBe(false);
  expect(listThreadSnoozes(db, NOW)).toEqual([{ threadId: "timed", until: NOW + HOUR }]);
});

it("counts as activity what the owner did not write, and not a working step", () => {
  expect(isSnoozeActivity({ role: "bot", kind: "text" })).toBe(true);
  expect(isSnoozeActivity({ role: "bot", kind: "options" })).toBe(true);
  expect(isSnoozeActivity({ role: "bot", kind: "routine.run" })).toBe(true);
  expect(isSnoozeActivity({ role: "user", kind: "text", origin: "unproven" })).toBe(true);
  // no proven sender: the owner's own words drained after a restart look like this
  expect(isSnoozeActivity({ role: "user", kind: "text" })).toBe(false);
  expect(isSnoozeActivity({ role: "user", kind: "text", origin: "desktop" })).toBe(false);
  expect(isSnoozeActivity({ role: "user", kind: "text", origin: "companion" })).toBe(false);
  expect(isSnoozeActivity({ role: "bot", kind: "activity" })).toBe(false);
  expect(isSnoozeActivity({ role: "bot", kind: "screen" })).toBe(false);
});

it("a run report that finishes while snoozed is news; a replayed or working one is not", () => {
  const routine = (status: string) => ({ role: "bot" as const, kind: "routine.run", routineRun: { status } });
  const goal = (status: string) => ({ role: "bot" as const, kind: "goal.run", goalRun: { status } });
  expect(isSnoozeReport(routine("running"), routine("completed"))).toBe(true);
  expect(isSnoozeReport(routine("queued"), routine("failed"))).toBe(true);
  expect(isSnoozeReport(routine("waiting"), routine("missed"))).toBe(true);
  expect(isSnoozeReport(goal("working"), goal("completed"))).toBe(true);
  // progress, a replay of a finished card, or no earlier copy to compare with
  expect(isSnoozeReport(routine("queued"), routine("running"))).toBe(false);
  expect(isSnoozeReport(routine("completed"), routine("completed"))).toBe(false);
  expect(isSnoozeReport(goal("completed"), goal("completed"))).toBe(false);
  expect(isSnoozeReport(undefined, routine("completed"))).toBe(false);
  expect(isSnoozeReport({ role: "bot", kind: "text" }, { role: "bot", kind: "text" })).toBe(false);
});

it("the store listener's rule: which changes end an until-activity snooze", () => {
  const owner = () => false, person = () => true;
  const words = { role: "user" as const, kind: "text" };
  // a channel person's words, in their own conversation, as the webhook writes them (no origin)
  expect(wakesActivitySnooze({ type: "message", threadId: "t", message: words }, person)).toBe(true);
  expect(wakesActivitySnooze({ type: "message", threadId: "t", message: words }, owner)).toBe(false);
  expect(wakesActivitySnooze({ type: "message", threadId: "t", message: { role: "bot", kind: "text" } }, owner)).toBe(true);
  expect(wakesActivitySnooze({ type: "message", threadId: "t", message: { role: "bot", kind: "activity" } }, person)).toBe(false);
  const card = (status: string) => ({ role: "bot" as const, kind: "routine.run", routineRun: { status } });
  expect(wakesActivitySnooze({ type: "message.patch", threadId: "t", message: card("completed"), before: card("running") }, owner)).toBe(true);
  expect(wakesActivitySnooze({ type: "message.patch", threadId: "t", message: card("completed") }, owner)).toBe(false);
  expect(wakesActivitySnooze({ type: "message.patch", threadId: "t", message: { role: "bot", kind: "text" }, before: { role: "bot", kind: "text" } }, owner)).toBe(false);
  expect(wakesActivitySnooze({ type: "thread.deleted", threadId: "t" }, person)).toBe(false);
});

it("routes: snooze until new activity, and refuse a body that mixes it with a time", () => {
  const { db } = fixture(); const { deps: d } = deps();
  expect(threadSnoozeRequest(db, { method: "PUT", path: "/api/thread-snoozes/thread", body: { untilActivity: true }, desktop: true }, d))
    .toEqual({ status: 200, body: { snoozes: [{ threadId: "thread", until: NOW + THREAD_SNOOZE_MAX_MS, untilActivity: true }] } });
  for (const body of [{ untilActivity: true, until: NOW + HOUR }, { untilActivity: false }, { untilActivity: "yes" }]) {
    expect(threadSnoozeRequest(db, { method: "PUT", path: "/api/thread-snoozes/other", body, desktop: true }, d)).toMatchObject({ status: 400 });
  }
  expect(listThreadSnoozes(db, NOW).map((entry) => entry.threadId)).toEqual(["thread"]);
});

it("a database from 0.1.60 gains the column and keeps its snoozes", () => {
  const root = mkdtempSync(join(tmpdir(), "murage-thread-snooze-old-")); roots.push(root);
  const db = new DatabaseSync(join(root, "messages.db")); databases.push(db);
  db.exec(`CREATE TABLE IF NOT EXISTS thread_snooze (
    thread_id TEXT PRIMARY KEY, snoozed_until INTEGER NOT NULL, snoozed_at INTEGER NOT NULL)`);
  db.prepare("INSERT INTO thread_snooze VALUES('old',?,?)").run(NOW + HOUR, NOW);
  initializeThreadSnooze(db); initializeThreadSnooze(db);
  expect((db.prepare("PRAGMA table_info(thread_snooze)").all() as Array<{ name: string }>).map((c) => c.name))
    .toEqual(["thread_id", "snoozed_until", "snoozed_at", "until_activity"]);
  expect(listThreadSnoozes(db, NOW)).toEqual([{ threadId: "old", until: NOW + HOUR }]);
});
