// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import * as messages from "../message-db.ts";
import { setMemoryMode } from "./repository.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); });
const message = (id: string, text: string) => ({ id, text, parentId: null, at: 1, role: "user" as const, kind: "text" as const });
const payloads = (threadId: string) => (database().prepare("SELECT v.payload FROM memory_source_versions v JOIN memory_sources s ON s.id=v.source_id WHERE s.thread_id=?").all(threadId) as Array<{ payload: string }>).map(row => String(row.payload));

it("forgets a deleted conversation's memory even after memory was turned off", () => {
  messages.appendMessage("gone", message("m1", "my bank PIN is 4455"));
  messages.appendMessage("kept", message("m2", "a different conversation"));
  setMemoryMode("off");
  messages.deleteThread("gone");
  expect(database().prepare("SELECT state FROM memory_sources WHERE thread_id='gone'").get()?.state).toBe("deleted");
  expect(database().prepare("SELECT count(*) AS n FROM memory_tombstones WHERE reason='thread-deleted'").get()?.n).toBe(1);
  expect(payloads("gone").join("")).not.toContain("4455");
  expect(payloads("kept").join("")).toContain("a different conversation");
});

it("clears the deleted conversation's words from memory, not only its state", () => {
  messages.appendMessage("gone", message("m1", "the launch code is 7788"));
  messages.deleteThread("gone");
  expect(payloads("gone")).toHaveLength(1);
  expect(payloads("gone").join("")).not.toContain("7788");
  // a deleted source is never captured again
  messages.appendMessage("gone", message("m1", "the launch code is 7788"));
  expect(payloads("gone").join("")).not.toContain("7788");
});
