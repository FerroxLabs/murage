// SPDX-License-Identifier: AGPL-3.0-or-later
// The prepared downgrade and channel delivery stores (fprod4): PREFLIGHT inspects a staged copy and never the source; PRESERVE writes 1.0.18's v1 files.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as atomic from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { putState, rowOf, stored } from "./channels/delivery-ledger-test-support.ts";
import { buildSchema, readLedger } from "./channels/delivery-ledger-v1.ts";
import { channelLedgerStores, LEDGER_INVALID, LedgerStore } from "./channels/delivery-ledger-store.ts";
import { DurableDelivery } from "./channels/durable-delivery.ts";
import { downgradeInstallationMemorySchema } from "./installation-memory-downgrade.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database(); closeDatabase(); });
afterEach(() => { vi.restoreAllMocks(); closeDatabase(); });

const NOW = 1_700_000_000_000;
const state = (count = 150) => ({ version: 1 as const, bindingKey: "binding", recipient: "owner",
  records: Array.from({ length: count }, (_, i) => ({ deliveryId: `r${i}`, prompt: "p", response: "x".repeat(20_000), occurredAt: NOW + i, attempts: 1, state: "uncertain" })),
  tombstones: [{ deliveryId: "t0", occurredAt: NOW }] });
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const fingerprint = (file: string) => { const s = lstatSync(file); return `${sha(file)}:${s.size}:${s.mtimeMs}`; };

it("W-PREFLIGHT-UNTOUCHED: a corrupt row refuses the downgrade and the source store, -wal and -shm stay byte-identical (mutant: PREFLIGHT opens the source)", async () => {
  const dir = join(DATA_DIR, "channels", "discord"), file = join(dir, "chat.json"), db = join(dir, "delivery-ledger.db");
  mkdirSync(dir, { recursive: true }); putState(file, state(2));
  // A second connection commits without checkpointing and stays open, as a running app would.
  const hold = new DatabaseSync(db); hold.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  hold.prepare("INSERT INTO delivery_entry (ledger_key,kind,seq,body) VALUES ('chat.json','record',99,'{not json')").run();
  try {
    const before = [db, `${db}-wal`, `${db}-shm`].map(fingerprint);
    await expect(downgradeInstallationMemorySchema(DATA_DIR, 10)).rejects.toThrow("CHANNEL_RECEIPTS_UNREADABLE");
    expect([db, `${db}-wal`, `${db}-shm`].map(fingerprint)).toEqual(before);
    expect(existsSync(`${db}-wal`)).toBe(true); expect(existsSync(file)).toBe(false);
  } finally { hold.close(); }
});

it("W-DOWNGRADE: the export is readable by 1.0.18 and equal to the store; a root-write fault leaves the row unexported and a retry converges (mutant: marked before written)", async () => {
  const dir = join(DATA_DIR, "channels", "discord"), file = join(dir, "chat.json");
  mkdirSync(dir, { recursive: true }); putState(file, state());
  const write = atomic.writeFileAtomic; let armed = true;
  vi.spyOn(atomic, "writeFileAtomic").mockImplementation((target, text, options) => { if (armed && target === file) { armed = false; throw new Error("disk"); } return write(target, text, options); });
  await expect(downgradeInstallationMemorySchema(DATA_DIR, 10)).rejects.toMatchObject({ code: "DOWNGRADE_PRESERVATION_FAILED" });
  expect(rowOf(file)?.legacy).not.toBe("exported"); expect(existsSync(file)).toBe(false);
  await downgradeInstallationMemorySchema(DATA_DIR, 10);
  const v1 = readLedger(file, buildSchema(20_000, false)).state;
  expect(v1).toEqual(stored(file));
  const root = JSON.parse(readFileSync(file, "utf8")) as { overflow?: string[] };
  for (const page of root.overflow ?? []) expect(existsSync(`${file}.${page}`)).toBe(true);
  expect(rowOf(file)?.legacy).toBe("exported");
});

// W-AGG-EXPORT: the aggregate that is big (210 records, 10000 tombstones, the worst escaped content) exports as v1 pages 1.0.18's reader accepts, in order, and imports back to the same state.
const record = (i: number, response: string) => ({ deliveryId: `r${String(i).padStart(4, "0")}`, prompt: "p", response, occurredAt: NOW + i, attempts: 1, state: "uncertain" });
const aggregates: Array<[string, () => ReturnType<typeof state>]> = [
  ["210 records", () => ({ ...state(0), records: Array.from({ length: 210 }, (_, i) => record(i, "answer")), tombstones: [] })],
  ["10000 tombstones", () => ({ ...state(0), records: [], tombstones: Array.from({ length: 10_000 }, (_, i) => ({ deliveryId: `t${i}`, occurredAt: NOW + i })) })],
  ["200 records of 20000 control characters", () => ({ ...state(0), records: Array.from({ length: 200 }, (_, i) => record(i, "\u0001".repeat(20_000))), tombstones: [] })],
];
it.each(aggregates)("W-AGG-EXPORT: %s export to v1 in order, read by 1.0.18's reader, and import back to the same state (mutant: export without paging)", async (_name, build) => {
  const dir = join(DATA_DIR, "channels", "discord"), file = join(dir, "chat.json");
  mkdirSync(dir, { recursive: true }); putState(file, build());
  const expected = stored(file);
  await downgradeInstallationMemorySchema(DATA_DIR, 10);
  const v1 = readLedger(file, buildSchema(20_000, true)).state;
  expect(v1).toEqual(expected);
  expect(v1.records.map((r) => r.deliveryId)).toEqual(expected.records.map((r: { deliveryId: string }) => r.deliveryId));
  // import back: the exported v1 files alone, in a fresh folder, become the same store state
  const back = join(DATA_DIR, "channels", "slack"), target = join(back, "chat.json");
  mkdirSync(back, { recursive: true });
  for (const name of readdirSync(dir).filter((n) => n === "chat.json" || n.startsWith("chat.json."))) copyFileSync(join(dir, name), join(back, name));
  const ledger = new DurableDelivery({ file: target, bindingKey: "binding", recipient: "owner", maxResponse: 20_000, isCurrent: () => true, now: () => NOW + 20_000,
    runs: { enqueue: () => ({ id: "run" }), result: () => ({ status: "completed", output: "answer" }) }, send: async () => ({ recipient: "owner", messageId: "m1" }) });
  ledger.stop();
  expect(stored(target)).toEqual(expected);
});

// r3 4.2(3): after a prepared downgrade the older build owns the v1 files. Its replace writes pages first and the root last, so a root missing
// beside a page is its crash shape; the store's older snapshot may only answer when no page of the ledger remains.
it("W-EXPORT-ORPHAN: an exported ledger whose root is gone beside a page is refused and its row is left alone; with no page left the store answers (mutant: fall back before the page check)", async () => {
  const dir = join(DATA_DIR, "channels", "discord"), file = join(dir, "chat.json");
  mkdirSync(dir, { recursive: true }); putState(file, state());
  await downgradeInstallationMemorySchema(DATA_DIR, 10);
  const before = rowOf(file), expected = stored(file);
  expect(before?.legacy).toBe("exported");
  const pages = readdirSync(dir).filter(name => name.startsWith("chat.json."));
  expect(pages.length).toBeGreaterThan(0);
  rmSync(file);
  const crashed = new LedgerStore(file);
  try {
    expect(() => crashed.load(20_000, { migrate: true })).toThrow(LEDGER_INVALID);
    expect(() => crashed.load(20_000, { migrate: false })).toThrow(LEDGER_INVALID);
  } finally { await crashed.release(); }
  expect(rowOf(file)).toEqual(before);
  expect(readdirSync(dir).filter(name => name.startsWith("chat.json."))).toEqual(pages);
  // control: the older build removed the whole ledger (no root, no page): the fallback r3 permits
  for (const page of pages) rmSync(join(dir, page));
  const removed = new LedgerStore(file);
  try { expect(removed.load(20_000, { migrate: true })?.state).toEqual(expected); } finally { await removed.release(); }
  expect(rowOf(file)?.legacy).toBeNull();
});

it("W-DISCOVERY-REFUSES: a receipts folder that cannot be listed refuses the downgrade before anything is preserved; an absent one is simply empty (mutant: swallow the listing error)", async () => {
  expect(channelLedgerStores(DATA_DIR)).toEqual([]);
  // a listing error that is not "absent": the name exists and is not a folder
  writeFileSync(join(DATA_DIR, "channels"), "");
  expect(() => channelLedgerStores(DATA_DIR)).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
  const before = readdirSync(DATA_DIR).sort();
  await expect(downgradeInstallationMemorySchema(DATA_DIR, 10)).rejects.toMatchObject({ code: "CHANNEL_RECEIPTS_UNREADABLE" });
  // The read-only preflight opens the two databases (their SQLite side files appear, as in every refused preflight); nothing else may: no preserved copy, no stamp.
  expect(readdirSync(DATA_DIR).filter(name => !/^(?:messages|search)\.db(?:-shm|-wal)?$/.test(name)).sort()).toEqual(before.filter(name => name !== "messages.db"));
  expect(readFileSync(join(DATA_DIR, "channels"), "utf8")).toBe("");
});
