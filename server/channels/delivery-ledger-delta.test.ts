// q1022-channels item 1: a ledger mutation writes only the rows that changed. Real DurableDelivery (the WhatsApp/Signal receipt ledger) on a
// real delivery-ledger.db; the row writes are counted by triggers on delivery_entry, which fire on the store's own connection.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
const folds = vi.hoisted(() => ({ n: 0 }));
vi.mock("../sqlite-file-checkpoint.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("../sqlite-file-checkpoint.ts")>();
  return { ...actual, checkpointFile: (...args: Parameters<typeof actual.checkpointFile>) => { folds.n++; return actual.checkpointFile(...args); } };
});
import { DurableDelivery } from "./durable-delivery.ts";
import { LEDGER_DB } from "./delivery-ledger-store.ts";
import { putState, stored } from "./delivery-ledger-test-support.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const roots: string[] = [], ledgers: DurableDelivery[] = [];
afterEach(async () => { for (const l of ledgers.splice(0)) await l.stop(); vi.restoreAllMocks(); for (const r of roots.splice(0)) removeTempDirSync(r); });

function world(tombstones: number) {
  const root = mkdtempSync(join(tmpdir(), "murage-ledger-delta-")); roots.push(root);
  let now = 1_800_000_000_000;
  const file = join(root, "receipts.json");
  putState(file, { version: 1, bindingKey: "binding", recipient: "owner",
    records: Array.from({ length: 20 }, (_, i) => ({ deliveryId: `held-${i}`, prompt: `held prompt ${i}`, occurredAt: now - 1000, attempts: 1, state: "uncertain", response: "answer" })),
    tombstones: Array.from({ length: tombstones }, (_, i) => ({ deliveryId: `old-${i}`, occurredAt: now - 3600_000 + i })) });
  const send = vi.fn(async () => ({ recipient: "owner", messageId: `m-${send.mock.calls.length}` }));
  const options = { file, bindingKey: "binding", recipient: "owner", isCurrent: () => true, now: () => now,
    runs: { enqueue: ({ deliveryId }: { deliveryId: string }) => ({ id: `run-${deliveryId}` }), result: () => ({ status: "completed", output: "reply" }) }, send };
  const open = () => { const l = new DurableDelivery(options); ledgers.push(l); return l; };
  const counter = new DatabaseSync(join(root, LEDGER_DB));
  counter.exec(`CREATE TABLE IF NOT EXISTS w(n INTEGER); INSERT INTO w VALUES (0);
    CREATE TRIGGER wi AFTER INSERT ON delivery_entry BEGIN UPDATE w SET n=n+1; END;
    CREATE TRIGGER wu AFTER UPDATE ON delivery_entry BEGIN UPDATE w SET n=n+1; END;
    CREATE TRIGGER wd AFTER DELETE ON delivery_entry BEGIN UPDATE w SET n=n+1; END;`);
  const writes = () => (counter.prepare("SELECT n FROM w").get() as { n: number }).n;
  const close = () => counter.close();
  return { file, open, writes, close, advance: (ms: number) => { now += ms; }, now: () => now };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const live = (l: DurableDelivery) => JSON.parse(JSON.stringify((l as any).state));

it.each([10, 1000])("one delivered message writes a bounded number of rows with %i tombstones, and the rows always read back as the live state", async (tombstones) => {
  const w = world(tombstones), ledger = w.open();
  const steps: Array<[string, () => unknown]> = [
    ["accept", () => ledger.accept({ deliveryId: "new-1", prompt: "hello", occurredAt: w.now() })],
    ["drain", () => ledger.drain()],
    ["accept-reclaims", () => { w.advance(1000); return ledger.accept({ deliveryId: "new-2", prompt: "again", occurredAt: w.now() }); }],
    ["drain", () => ledger.drain()],
    ["resend", () => ledger.resend("held-3")],
    ["redact", () => ledger.redact("held-5")],
    ["settle", () => ledger.settle("held-7")],
    ["accept-reclaims", () => { w.advance(1000); return ledger.accept({ deliveryId: "new-3", prompt: "third", occurredAt: w.now() }); }],
  ];
  const perStep: Record<string, number> = {};
  for (const [name, step] of steps) {
    const before = w.writes();
    await step();
    perStep[name] = Math.max(perStep[name] ?? 0, w.writes() - before);
    // WhatsApp/Signal delivery states unchanged end to end: the committed rows are exactly the live ledger, in order.
    expect(stored(w.file)).toEqual(live(ledger));
  }
  // accept 1 insert (+1 delete and 1 insert per reclaimed record), each state step 1 update, a resend 2 inserts and 1 update.
  expect(Math.max(...Object.values(perStep))).toBeLessThanOrEqual(8);
  // both delivered messages went out once and were reclaimed into tombstones; the held receipts kept their review states
  expect((ledger as unknown as { options: { send: { mock: { calls: unknown[] } } } }).options.send.mock.calls).toHaveLength(2);
  const tombstoneIds = live(ledger).tombstones.map((t: { deliveryId: string }) => t.deliveryId);
  expect(tombstoneIds).toHaveLength(tombstones + 5);
  expect(tombstoneIds.slice(-5).sort()).toEqual(["held-3", "held-5", "held-7", "new-1", "new-2"]);
  expect(ledger.snapshotRecords().find(r => r.deliveryId === "held-0")).toMatchObject({ state: "uncertain", prompt: "held prompt 0" });
  const reopened = new DurableDelivery((ledger as unknown as { options: ConstructorParameters<typeof DurableDelivery>[0] }).options);
  ledgers.push(reopened);
  expect(live(reopened)).toEqual(live(ledger));
  w.close();
});

it("item 2: a repeated redact of an already redacted receipt (the transport write fence asks before every send) copies nothing and starts no fold", async () => {
  const w = world(1000), ledger = w.open();
  expect(ledger.redact("held-5")).toEqual({});
  await ledger.sweepPages();
  await vi.waitFor(() => expect(ledger.maintenancePending).toBe(false));
  const clone = vi.spyOn(globalThis, "structuredClone"), before = w.writes();
  folds.n = 0;
  for (let i = 0; i < 20; i++) { expect(ledger.redact("held-5")).toEqual({}); expect(ledger.redact("never-held")).toBeNull(); }
  await vi.waitFor(() => expect(ledger.maintenancePending).toBe(false));
  expect({ clones: clone.mock.calls.length, folds: folds.n, writes: w.writes() - before }).toEqual({ clones: 0, folds: 0, writes: 0 });
  expect(ledger.isRedacted("held-5")).toBe(true);
  expect(stored(w.file)).toEqual(live(ledger));
  w.close();
});
