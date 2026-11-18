import { afterEach, expect, it } from "vitest";
import { denyGeneration, preparedWindowIdentity, refsLookup } from "./deny-read.ts";
import { memoryRefKey, type LineageRef, type PreparedWindow } from "./lineage-types.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";

// 7C deny-pending ruling (handoffs/designs/7C-DENY-PENDING-RULING.md): preparedWindowIdentity threw above 512 pending rows anywhere in the
// file, so every send in every chat was refused at prepare (lookup-error) and went out on the last-resort route. Above the bound the
// identity is null: no prepared exception, refs judged strictly. The fix still fails closed.
const fixtures: WritetimeFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
function seeded(extraRows: number) {
  const f = new WritetimeFixture(); fixtures.push(f);
  f.source("src", "s-bot").record("rec", 1, "s-bot", ["src"]);
  // the window's own scope is pending from lsn 0 (before the record), so a strict judgment of its ref says "pending"
  f.db.prepare("INSERT INTO memory_deny_pending_scope(scope_id,since_lsn,revoke_id) VALUES('s-bot',0,1)").run();
  f.db.exec("BEGIN");
  const insert = f.db.prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES(?,5,?)");
  for (let i = 0; i < extraRows; i++) insert.run(`unrelated-${i}`, 100 + i);
  f.db.exec("COMMIT");
  const ref = { kind: "record" as const, id: "rec", version: 1 };
  const refs: LineageRef[] = [{ kind: "memory", ref }];
  const window = (identity: string | null): PreparedWindow =>
    ({ reader: CONTENT, generation: denyGeneration(f.db), identity, memoryKeys: new Set([memoryRefKey(ref)]), open: true });
  return { f, refs, window };
}

it("the window identity is a string up to 512 pending rows and null above, never a throw", () => {
  const small = seeded(0), big = seeded(513);
  expect(typeof preparedWindowIdentity(small.f.db)).toBe("string");
  expect(preparedWindowIdentity(big.f.db)).toBeNull();
});

it("control: up to 512 rows, a prepared window whose identity still matches keeps its exception for the ref", () => {
  const { f, refs, window } = seeded(0);
  expect(refsLookup(f.db, refs, CONTENT, true, window(preparedWindowIdentity(f.db)))).toMatchObject({ state: "shown" });
});

it("above 512 rows a ref whose scope is pending is still refused: no identity, no prepared exception (fails closed)", () => {
  const { f, refs, window } = seeded(513);
  const identity = preparedWindowIdentity(f.db);
  expect(identity).toBeNull();
  // Even a window that carries the ref's key cannot take the exception on a null identity (null === null must not count as a match).
  expect(refsLookup(f.db, refs, CONTENT, true, window(identity))).toMatchObject({ state: "checking", reason: "pending" });
});
