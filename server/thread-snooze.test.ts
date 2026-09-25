// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import {
  initializeThreadSnooze, listThreadSnoozes, snoozeThread, threadSnoozeRequest, unsnoozeThread, wakeThreadSnoozes,
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
