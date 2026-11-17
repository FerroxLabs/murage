// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it } from "vitest";
import { sessionLookup } from "./deny-read.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";

const fixtures: WritetimeFixture[] = [];
const key = { threadId: "fresh", driverInstance: "fixture", nativeSession: "new-session" };
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
function world(first = 70, last = 80) {
  const f = new WritetimeFixture(); fixtures.push(f);
  return f.cert(true).ready(key.threadId, true).job(1, 50).pending("*", 1)
    .sessionLineage(key.threadId, key.driverInstance, key.nativeSession, first, last);
}
const verdict = (f: WritetimeFixture) => sessionLookup(f.db, key, CONTENT);
it("a session started after an old revoke does not reset on that capped window", () => {
  expect(verdict(world())).toEqual({ state: "shown" });
});
it("a session started exactly at the revoke cap is fenced against it", () => {
  expect(verdict(world(50))).toEqual({ state: "shown" });
});
it("a retained session started before the revoke remains checking", () => {
  expect(verdict(world(40))).toMatchObject({ state: "checking", reason: "pending" });
});
it("a session ending before the pending window remains outside it", () => {
  const f = world(10, 20); f.db.prepare("UPDATE memory_deny_pending SET since_lsn=30").run();
  expect(verdict(f)).toEqual({ state: "shown" });
});
it("a seeding revoke keeps a fresh session checking", () => {
  const f = world(); f.db.prepare("UPDATE memory_revoke_jobs SET state='seeding'").run();
  expect(verdict(f)).toMatchObject({ state: "checking", reason: "pending" });
});
it("an orphaned pending row keeps a fresh session checking", () => {
  const f = world(); f.db.prepare("DELETE FROM memory_revoke_jobs").run();
  expect(verdict(f)).toMatchObject({ state: "checking", reason: "pending" });
});
it("a post-commit inherited hold still resets the session that consumed it", () => {
  const f = world(); f.pending(key.threadId, 75);
  expect(verdict(f)).toMatchObject({ state: "checking", reason: "pending" });
});
it("a direct session deny still wins over a post-cap session start", () => {
  const f = world(); f.denySession(key.threadId, key.driverInstance, key.nativeSession);
  expect(verdict(f)).toMatchObject({ state: "withheld", reason: "deny-session" });
});
it("missing session lineage still fails closed", () => {
  const f = world(); f.db.prepare("DELETE FROM memory_session_lineage").run();
  expect(verdict(f)).toMatchObject({ state: "checking", reason: "no-lineage" });
});
