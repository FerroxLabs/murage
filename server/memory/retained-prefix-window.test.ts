// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it } from "vitest";
import { denyReadMeter, refsLookup, resetDenyReadMeter } from "./deny-read.ts";
import type { LineageRef } from "./lineage-types.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";
const fixtures: WritetimeFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
function world() {
  const f = new WritetimeFixture(); fixtures.push(f);
  return f.cert(true).ready("T", true).job(1, 50).pending("*", 1).reply("T", "safe", 85, { turnLsn: 70 });
}
const prefix = (heldFrom?: number): LineageRef => ({ kind: "prefix", threadId: "T", headLsn: 90,
  held: 80, shown: ["safe"], ...(heldFrom === undefined ? {} : { heldFrom }) });
const verdict = (f: WritetimeFixture, from?: number) => refsLookup(f.db, [prefix(from)], CONTENT);
it("a retained prefix built after an old revoke passes the same cap as its session", () => {
  expect(verdict(world(), 70)).toEqual({ state: "shown" });
});
it("a retained prefix starting exactly at the cap is fenced against that revoke", () => {
  expect(verdict(world(), 50)).toEqual({ state: "shown" });
});
it("a retained prefix from before the cap remains checking", () => {
  expect(verdict(world(), 40)).toMatchObject({ state: "checking", reason: "pending" });
});
it("a prefix with no proven session start keeps legacy wholesale checking", () => {
  expect(verdict(world())).toMatchObject({ state: "checking", reason: "pending" });
});
it("a seeding root still holds the retained prefix", () => {
  const f = world(); f.db.prepare("UPDATE memory_revoke_jobs SET state='seeding'").run();
  expect(verdict(f, 70)).toMatchObject({ state: "checking", reason: "pending" });
});
it("a missing job still holds the retained prefix", () => {
  const f = world(); f.db.prepare("DELETE FROM memory_revoke_jobs").run();
  expect(verdict(f, 70)).toMatchObject({ state: "checking", reason: "pending" });
});
it("an inherited post-commit window still holds the retained prefix", () => {
  const f = world(); f.pending("T", 75);
  expect(verdict(f, 70)).toMatchObject({ state: "checking", reason: "pending" });
});
it("a listed line denied after build still refuses the prefix", () => {
  const f = world(); f.denyLine("T", 85);
  expect(verdict(f, 70)).toMatchObject({ state: "withheld", reason: "deny-line" });
});
it("a listed affected generated line still refuses a post-cap retained span", () => {
  const f = world(); f.reply("T", "affected", 75, { turnLsn: 40 });
  expect(refsLookup(f.db, [{ ...prefix(70), shown: ["affected"] } as LineageRef], CONTENT))
    .toMatchObject({ state: "checking", reason: "pending" });
});
it("a start beyond the retained bound is not accepted as proof", () => {
  expect(verdict(world(), 81)).toMatchObject({ state: "checking" });
});
it.each([false, true])("duplicate prefixes retain the earliest start, reversed=%s", reversed => {
  const refs = [prefix(40), prefix(70)];
  expect(refsLookup(world().db, reversed ? refs.reverse() : refs, CONTENT)).toMatchObject({ state: "checking", reason: "pending" });
});
it("a proven duplicate cannot replace a legacy prefix's unknown start", () => {
  expect(refsLookup(world().db, [prefix(), prefix(70)], CONTENT)).toMatchObject({ state: "checking", reason: "pending" });
});
it("a wider duplicate cannot legitimize a malformed retained span", () => {
  expect(refsLookup(world().db, [prefix(81), { ...prefix(70), held: 100 } as LineageRef], CONTENT)).toMatchObject({ state: "checking", reason: "no-lineage" });
});
it("raw pending work stays bounded when the unrelated backlog grows tenfold", () => {
  const work: Array<{ statements: number; rows: number }> = [];
  for (const n of [1000, 10000]) {
    const f = world(); f.db.exec("BEGIN");
    const put = f.db.prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('*',1,?)");
    for (let id = 2; id <= n; id++) put.run(id);
    f.db.exec("COMMIT"); resetDenyReadMeter();
    expect(verdict(f, 70)).toMatchObject({ state: "checking", reason: "pending" });
    const { statements, rows } = denyReadMeter();
    expect(rows).toBeLessThan(1000); work.push({ statements, rows });
  }
  expect(work[1]).toEqual(work[0]);
});
