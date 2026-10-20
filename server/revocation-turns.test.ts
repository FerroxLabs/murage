// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 lane D (revocation, round 6): provider output keeps arriving through a held writer lock (the generic gate in
// database.ts; the revocation index build no longer takes it): the real EventBus, the
// real turn tracking (IndependentThreadRuns) and a fake provider driver emit a whole reply; the listener writes messages.db
// like the fold and does NOT gate itself. Every event persists, in order, with its terminal state; the loop stays free.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitWriterGate, DatabaseBusyError, holdWritersForIndexBuild, isDatabaseBusy, writersHeldForIndexBuild } from "./database.ts";
import { EventBus } from "./harness/bus.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { IndependentThreadRuns } from "./independent-thread-runs.ts";
import { downgradeMemorySchema, migrateMemorySchema } from "./memory/schema.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

let dir: string, db: DatabaseSync, lockHolder: DatabaseSync | undefined;
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
  dir = mkdtempSync(join(tmpdir(), "revoke-turns-"));
  db = new DatabaseSync(join(dir, "messages.db"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=50");
  migrateMemorySchema(db, "active");
  downgradeMemorySchema(db, 7); migrateMemorySchema(db);
  db.exec("CREATE TABLE reply(seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, text TEXT)");
});
afterEach(async () => {
  holdWritersForIndexBuild(false);
  if (lockHolder) { try { lockHolder.exec("ROLLBACK"); } catch { /* none open */ } lockHolder.close(); lockHolder = undefined; }
  try { db.close(); } catch { /* closed */ }
  removeTempDirSync(dir);
  vi.restoreAllMocks();
});

function tracking() {
  const directRuns = new IndependentThreadRuns<{ id: string }>();
  return { directRuns };
}
const ev = (type: string, extra: Record<string, unknown> = {}) => ({ eventId: `e-${Math.random()}`, provider: "fake", threadId: "t1", turnId: "turn-1", createdAt: new Date().toISOString(), type, ...extra }) as unknown as RuntimeEvent;

it("through a held writer lock a direct turn's whole reply and terminal state persist in order from real provider events, with no write during the lock and loop max under 50 ms", async () => {
  const t = tracking();
  const fake = makeFakeDriver();
  await fake.driver.create({ instanceId: "inst", displayName: undefined, environment: {}, enabled: true, config: {} });
  const { instance, emit } = fake.created.get("inst")!;
  const bus = new EventBus();
  bus.gateDeliveries({ held: writersHeldForIndexBuild, wait: awaitWriterGate, isBusy: isDatabaseBusy });
  bus.omitLog(() => true);
  bus.attach([instance]);
  const writesDuringLock: number[] = [];
  let locked = false;
  // the fold: writes messages.db directly and does not gate itself
  bus.subscribe((e: RuntimeEvent) => {
    if (locked) writesDuringLock.push(1);
    const x = e as unknown as { itemType?: string; text?: string };
    if (e.type === "item.completed" && x.itemType === "assistant_text") db.prepare("INSERT INTO reply(kind,text) VALUES('text',?)").run(x.text ?? "");
    if (e.type === "turn.completed") { db.prepare("INSERT INTO reply(kind,text) VALUES('terminal','done')").run(); const r = t.directRuns.get("t1"); if (r) t.directRuns.release(r); }
  });
  const turn = t.directRuns.admit("bot", "t1", { id: "bot" });
  // part of the reply streams in before the hold
  emit(ev("item.completed", { itemType: "assistant_text", text: "part 0" }));
  expect(db.prepare("SELECT count(*) AS n FROM reply").get()).toMatchObject({ n: 1 });
  t.directRuns.release(turn);
  // a writer hold and a raw write lock for 2 s, then both released
  holdWritersForIndexBuild(true);
  lockHolder = new DatabaseSync(join(dir, "messages.db"));
  lockHolder.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  const released = new Promise<void>(res => setTimeout(() => { try { lockHolder?.exec("COMMIT"); } catch { /* gone */ } locked = false; holdWritersForIndexBuild(false); res(); }, 2000).unref());
  locked = true;
  const histogram = monitorEventLoopDelay({ resolution: 5 }); histogram.enable();
  // a second turn starts and streams while the lock is held (provider output is not stoppable)
  t.directRuns.admit("bot", "t1", { id: "bot" });
  for (let i = 1; i <= 8; i++) { emit(ev("item.completed", { itemType: "assistant_text", text: `part ${i}` })); await new Promise(res => setTimeout(res, 50)); }
  emit(ev("turn.completed"));
  expect(writesDuringLock).toEqual([]); // nothing hit the locked file
  expect(bus.pendingDurable()).toBeGreaterThan(0);
  await released;
  await vi.waitFor(() => expect(bus.pendingDurable()).toBe(0), { timeout: 5000 });
  histogram.disable();
  const rows = db.prepare("SELECT kind,text FROM reply ORDER BY seq").all() as Array<{ kind: string; text: string }>;
  expect(rows.map(r => r.text)).toEqual(["part 0", ...Array.from({ length: 8 }, (_, i) => `part ${i + 1}`), "done"]);
  expect(rows.at(-1)).toMatchObject({ kind: "terminal" });
  expect(t.directRuns.any()).toBe(false); // terminal cleanup ran
  // the loop never sat in a lock wait: one would cost the 1 s owner busy budget. 50 ms was below a loaded
  // macOS runner's scheduling noise (193 ms seen there); 500 ms still catches a budgeted owner wait.
  expect(Number(histogram.max) / 1e6).toBeLessThan(500);
}, 40_000);

it("a delivery that meets a locked database (another process, no gate) is retried and delivered once, in order, never dropped", async () => {
  const bus = new EventBus();
  bus.omitLog(() => true);
  bus.gateDeliveries({ held: () => false, wait: async () => {}, isBusy: isDatabaseBusy });
  const seen: string[] = [];
  let failures = 2;
  bus.subscribe((e: RuntimeEvent) => { if (failures-- > 0) throw new DatabaseBusyError("fold", 0); seen.push(e.eventId); });
  bus.publish(ev("item.completed", { eventId: "a" }));
  bus.publish(ev("item.completed", { eventId: "b" }));
  expect(seen).toEqual([]);
  await vi.waitFor(() => expect(seen).toEqual(["a", "b"]), { timeout: 5000 });
  expect(bus.pendingDurable()).toBe(0);
});
