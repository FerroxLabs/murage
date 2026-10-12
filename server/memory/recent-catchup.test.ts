// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The catch-up that used to sit inside searchMemory is its own lock-tolerant step run before recall: a message
// written a moment ago is still found while the worker is behind, and a held write lock means "the worker will get to it".
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { catchUpRecentMemory } from "./recent.ts";
import { searchMemory } from "./search.ts";
import { accessFor, changes, emptyBridge, freshDataDir } from "./testing/recall-fixture.ts";

let other: DatabaseSync | null = null;
beforeEach(() => { freshDataDir("active"); });
afterEach(() => { try { other?.close(); } catch { /* closed */ } other = null; });

it("captures at most two chunks of what is waiting, so a message written a moment ago is recalled, and search itself does not", async () => {
  const { access } = accessFor();
  appendMessage("thread", { id: "fresh", at: 5, role: "user", kind: "text", text: "My report colour is charcoal." });
  const before = changes();
  const unsearched = await searchMemory("report colour", access, emptyBridge);
  expect(changes()).toBe(before);                   // search wrote nothing
  expect(unsearched.hits.some(hit => hit.text.includes("charcoal"))).toBe(false);
  expect(catchUpRecentMemory(access)).toBe(1);
  const found = await searchMemory("report colour", access, emptyBridge);
  expect(found.hits.some(hit => hit.text.includes("charcoal"))).toBe(true);
});

it("a held write lock returns nothing within a fraction of a second: no error, no wait", () => {
  const { access } = accessFor();
  appendMessage("thread", { id: "fresh", at: 5, role: "user", kind: "text", text: "My report colour is charcoal." });
  database();
  other = new DatabaseSync(join(DATA_DIR, "messages.db"));
  other.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  const started = performance.now();
  expect(catchUpRecentMemory(access)).toBe(0);
  expect(performance.now() - started).toBeLessThan(400);
  other.exec("ROLLBACK");
  expect(catchUpRecentMemory(access)).toBe(1);
});

it("leaves out the messages the turn already holds: its own prompt is not caught up", () => {
  const { access } = accessFor();
  appendMessage("thread", { id: "older", at: 4, role: "user", kind: "text", text: "An earlier message the worker has not got to." });
  appendMessage("thread", { id: "prompt", parentId: "older", at: 5, role: "user", kind: "text", text: "This turn's own prompt." });
  expect(catchUpRecentMemory(access, undefined, undefined, { messageIds: ["prompt"] })).toBe(1);
  const captured = database().prepare("SELECT s.message_id FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE j.status='complete'").all().map(row => String(row.message_id));
  expect(captured).toEqual(["older"]);
  expect(catchUpRecentMemory(access, undefined, undefined, { messageIds: ["prompt"] })).toBe(0);
  expect(database().prepare("SELECT count(*) n FROM memory_jobs WHERE status='pending'").get()!.n).toBe(1);
});

it("leaves a standing backlog to the worker: only what was written in the last quarter hour is caught up", () => {
  const { access } = accessFor();
  appendMessage("thread", { id: "old", at: 1, role: "user", kind: "text", text: "A message from long ago that the worker never got to." });
  database().prepare("UPDATE memory_source_versions SET created_at=? WHERE source_id LIKE '%old'").run(Date.now() - 3_600_000);
  expect(catchUpRecentMemory(access)).toBe(0);
  appendMessage("thread", { id: "new", parentId: "old", at: 2, role: "user", kind: "text", text: "A message from a moment ago." });
  expect(catchUpRecentMemory(access)).toBe(1);
});
