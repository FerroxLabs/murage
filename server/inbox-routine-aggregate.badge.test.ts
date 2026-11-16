// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { inboxBadgeRequest, initializeInbox, type InboxAccess } from "./inbox.ts";
import { IncrementalRoutineRollup, ROUTINE_DAY_MS as DAY, routineNumberKey, type OrderedRoutineFact } from "./inbox-routine-aggregate.ts";
import { bumpMessagesVersion } from "./inbox-version.ts";

const NOW = 1_800_000_000_000, handles: DatabaseSync[] = [];
afterEach(() => { for (const db of handles.splice(0)) db.close(); });
function fixture(size: number) {
  const db = new DatabaseSync(":memory:"); handles.push(db);
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  initializeInbox(db);
  const aggregate = new IncrementalRoutineRollup();
  const entries: OrderedRoutineFact[] = Array.from({ length: size }, (_, i) => ({ id: `run-${i}`, position: routineNumberKey(i), fact: {
    routineKey: `routine:${i}`, routineName: `Routine ${i % 20}`, botLabel: "Bot",
    at: NOW - i % 14 * DAY, failed: true, detail: "401 unauthorized",
  } }));
  aggregate.rebuild(entries, NOW, true);
  const access: InboxAccess = { owner: true, threads: [{ threadId: "thread", label: "Bot" }], routineRollup: {
    read: (): never => { throw new Error("badge materialised historical routine rows"); },
    needsConnection: now => aggregate.needsConnection(now),
  },
    // Any accidental snapshot read fails, even if the resulting count is right.
    get routineRuns(): never { throw new Error("badge enumerated routine history"); },
  };
  const badge = (now = NOW) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try { return inboxBadgeRequest(db, { method: "GET", path: "/api/inbox", query: { view: "decisions", page: 0, pageSize: 1 } }, access, { cache: true }); }
    finally { clock.mockRestore(); }
  };
  return { aggregate, entries, db, badge };
}

it("badge requests use maintained counters at 100 and 2,000 runs, including cache misses", () => {
  const counts = [100, 2_000].map(size => {
    const { aggregate, db, badge } = fixture(size);
    expect(badge()).toMatchObject({ status: 200, body: { decisions: 1, connections: 1 } });
    bumpMessagesVersion();
    const sql = vi.spyOn(db, "prepare");
    const original = Map.prototype[Symbol.iterator], get = Map.prototype.get;
    let visited = 0, lookups = 0;
    const iteratorSpy = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (this: Map<unknown, unknown>) {
      const iterator = original.call(this), next = iterator.next;
      iterator.next = () => { const result = next.call(iterator); if (!result.done) visited++; return result; };
      return iterator;
    });
    const getSpy = vi.spyOn(Map.prototype, "get").mockImplementation(function (this: Map<unknown, unknown>, key: unknown) { lookups++; return get.call(this, key); });
    const nodes = aggregate.work.nodes;
    let response: ReturnType<typeof badge>;
    try { response = badge(NOW + 1); } finally { iteratorSpy.mockRestore(); getSpy.mockRestore(); }
    expect(response!).toMatchObject({ status: 200, body: { decisions: 1 } });
    expect(sql.mock.calls.some(([statement]) => statement.includes("SELECT thread_id, message_id, title, summary"))).toBe(false);
    const result = { nodes: aggregate.work.nodes - nodes, visited, lookups, statements: sql.mock.calls.length };
    sql.mockRestore();
    return result;
  });
  console.info("badge-work", JSON.stringify({ sizes: [100, 2_000], counts }));
  expect(counts[0]).toEqual(counts[1]);
  expect(counts[1]!.nodes).toBe(1);
  expect(counts[1]!.visited).toBe(0);
});

it("badge recovery and expiry follow aggregate deltas", () => {
  const { aggregate, entries, badge } = fixture(100);
  expect(badge()).toMatchObject({ status: 200, body: { decisions: 1 } });
  for (const entry of entries) aggregate.upsert({ ...entry, fact: { ...entry.fact, failed: false } });
  expect(badge()).toMatchObject({ status: 200, body: { decisions: 0 } });
  aggregate.upsert(entries[0]!);
  expect(badge()).toMatchObject({ status: 200, body: { decisions: 1 } });
  expect(badge(NOW + 14 * DAY + 1)).toMatchObject({ status: 200, body: { decisions: 0 } });
});
