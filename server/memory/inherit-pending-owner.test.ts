// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it } from "vitest";
import { denyLookup } from "./deny-read.ts";
import { inheritMarks } from "./revoke-commit.ts";
import { stopMemoryRevocation } from "./memory-revocation.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";

const fixtures: WritetimeFixture[] = [];
afterEach(() => { stopMemoryRevocation(); for (const f of fixtures.splice(0)) f.close(); });
function world(state: "active" | "seeding" = "active") {
  const f = new WritetimeFixture(); fixtures.push(f);
  f.cert(true).job(1, 50, state).pending("*", 1).ready("fresh", true);
  f.db.prepare("UPDATE memory_revoke_jobs SET root=? WHERE revoke_id=1").run(JSON.stringify({ kind: "line", threadId: "unrelated", cause: "branch-switch" }));
  f.reply("fresh", "result", 80, { turnLsn: 70 });
  return f;
}
function carry(f: WritetimeFixture, from: number, to = from, threadId = "fresh") {
  f.db.exec("BEGIN");
  try {
    inheritMarks(f.db, { kind: "line", threadId: "fresh", lsn: 80 }, [], [{ threadId, from, to }]);
    f.db.exec("COMMIT");
  } catch (error) { f.db.exec("ROLLBACK"); throw error; }
  return denyLookup(f.db, { threadId: "fresh", lines: [{ messageId: "result", author: "generated" }] }, CONTENT).get("result");
}
it("a new owner prompt does not inherit an unrelated pre-prompt revoke", () => {
  const f = world(); f.owner("fresh", "prompt", 70);
  expect(denyLookup(f.db, { threadId: "fresh", lines: [{ messageId: "prompt", author: "owner" }] }, CONTENT).get("prompt")).toEqual({ state: "shown" });
  expect(carry(f, 70)).toEqual({ state: "shown" });
  expect(f.db.prepare("SELECT 1 FROM memory_deny_pending WHERE thread_id='fresh'").get()).toBeUndefined();
});
it("generated text from a turn before the revoke still holds its new child", () => {
  const f = world(); f.reply("fresh", "parent", 70, { turnLsn: 40 });
  expect(carry(f, 70)).toMatchObject({ state: "checking", reason: "pending" });
});
it("an owner line already shown before the revoke does not become generated ancestry", () => {
  const f = world(); f.owner("fresh", "prompt", 40);
  expect(carry(f, 40)).toEqual({ state: "shown" });
});
it("generated text from a turn after the revoke stays outside its window", () => {
  const f = world(); f.reply("fresh", "parent", 70, { turnLsn: 60 });
  expect(carry(f, 70)).toEqual({ state: "shown" });
});
it("a seeding revoke still holds a child until its root set is known", () => {
  const f = world("seeding"); f.owner("fresh", "prompt", 70);
  expect(carry(f, 70)).toMatchObject({ state: "checking", reason: "pending" });
});
it("a carried range with missing lineage still fails closed", () => {
  const f = world();
  expect(carry(f, 70, 70, "unknown-parent")).toMatchObject({ state: "checking", reason: "pending" });
});
it("an older affected generated line in a mixed prefix still holds its child", () => {
  const f = world(); f.reply("fresh", "old", 40, { turnLsn: 30 }).owner("fresh", "prompt", 70);
  expect(carry(f, 40, 70)).toMatchObject({ state: "checking", reason: "pending" });
});
it("a directly denied owner line still denies its child", () => {
  const f = world(); f.owner("fresh", "prompt", 70).denyLine("fresh", 70);
  expect(carry(f, 70)).toMatchObject({ state: "withheld", reason: "deny-line" });
});
it("an orphaned pending row still fails closed", () => {
  const f = world(); f.owner("fresh", "prompt", 70);
  f.db.prepare("DELETE FROM memory_revoke_jobs WHERE revoke_id=1").run();
  expect(carry(f, 70)).toMatchObject({ state: "checking", reason: "pending" });
});
it("a targeted pending row still holds an owner-line child", () => {
  const f = world(); f.owner("fresh", "prompt", 70).pending("fresh", 1);
  expect(carry(f, 70)).toMatchObject({ state: "checking", reason: "pending" });
});
it("an unproven global root still holds an owner-line child", () => {
  const f = world(); f.owner("fresh", "prompt", 70);
  f.db.prepare("UPDATE memory_revoke_jobs SET root='{}' WHERE revoke_id=1").run();
  expect(carry(f, 70)).toMatchObject({ state: "checking", reason: "pending" });
});
