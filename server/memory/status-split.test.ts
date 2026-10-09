// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PROPOSAL-v2 13, item 0.9: opening Memory runs no health or retention scan on a large store. The figures are
// measured by the worker a slice at a time and read back as the last finished value, stamped "as of".
import { afterEach, beforeEach, expect, it } from "vitest";
import { database } from "../database.ts";
import { memoryHealth, resetHealthScan, stepHealthScan, STATUS_SCAN_INTERVAL_MS } from "./health.ts";
import { memoryRetentionStatus, resetRetentionScan, stepRetentionScan } from "./retention.ts";
import { PagedScan, SMALL_STORE_ROWS } from "./status-scan.ts";
import { accessFor, captureAndPublish, freshDataDir } from "./testing/recall-fixture.ts";

beforeEach(() => { freshDataDir("capture"); resetHealthScan(); resetRetentionScan(); });
afterEach(() => { resetHealthScan(); resetRetentionScan(); });

function bigStore(sources: number) {
  const db = database();
  const scope = String(db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()?.id ?? (accessFor(), db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id));
  db.exec("BEGIN");
  const s = db.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,revision,content_hash,kind,speaker,outcome,state) VALUES(?,?,?,?,1,?,'text','owner','recorded','active')");
  const v = db.prepare("INSERT INTO memory_source_versions(source_id,revision,content_hash,payload,created_at) VALUES(?,1,?,?,?)");
  for (let n = 0; n < sources; n++) { s.run(`bulk-${n}`, scope, "thread", `m${n}`, `h${n}`); v.run(`bulk-${n}`, `h${n}`, JSON.stringify({ text: `Conversation text number ${n}. `.repeat(20) }), 1000 + n); }
  db.exec("COMMIT");
}
function spy(match: (text: string) => boolean) {
  const db = database(), real = db.prepare.bind(db);
  let n = 0;
  (db as unknown as { prepare: unknown }).prepare = (text: string) => { if (match(text)) n++; return real(text); };
  return { get n() { return n; }, restore: () => { (db as unknown as { prepare: unknown }).prepare = real; } };
}

it("a small store is measured on the spot, as before, and says when", () => {
  captureAndPublish("One durable fact.");
  const health = memoryHealth("x");
  expect(health.captured.sources).toBe(1);
  expect(health.processed.sources).toBe(1);
  expect(health.asOf).toBeGreaterThan(0);
  expect(memoryRetentionStatus().records).toEqual([{ state: "active", count: 1, bytes: expect.any(Number) }]);
  expect(memoryRetentionStatus().asOf).toBeGreaterThan(0);
});

it("on a large store opening Memory reads a stored value: no payload is parsed or measured", () => {
  bigStore(SMALL_STORE_ROWS + 200);
  const scans = spy(text => text.includes("json_extract(v.payload") || text.includes("length(CAST(payload") || text.includes("length(CAST(text AS BLOB))"));
  try {
    const health = memoryHealth("x"), retention = memoryRetentionStatus();
    expect(scans.n).toBe(0);
    expect(health.asOf).toBeNull();
    expect(health.captured.sources).toBe(0);
    expect(retention.asOf).toBeNull();
  } finally { scans.restore(); }
});

it("the worker's slices reach the same figures a full scan gives, then Details shows them with their time", () => {
  bigStore(SMALL_STORE_ROWS + 200);
  database().prepare("UPDATE memory_sources SET state='deleted' WHERE id IN ('bulk-1','bulk-2')").run();
  database().prepare("UPDATE memory_source_versions SET payload='{\"text\":\"x\",\"excluded\":true}' WHERE source_id='bulk-3'").run();
  let slices = 0;
  while (stepHealthScan(1)) slices++;
  while (stepRetentionScan(1)) slices++;
  expect(slices).toBeGreaterThan(5);   // sliced, not one block
  const exact = database().prepare(`SELECT count(*) n FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
    WHERE s.state!='deleted' AND json_extract(v.payload,'$.excluded') IS NULL AND length(json_extract(v.payload,'$.text'))>0`).get()!;
  const scans = spy(text => text.includes("json_extract(v.payload"));
  try {
    const health = memoryHealth("x");
    expect(scans.n).toBe(0);
    expect(health.captured.sources).toBe(Number(exact.n));
    expect(health.captured.sources).toBe(SMALL_STORE_ROWS + 200 - 3);
    expect(health.asOf).toBeGreaterThan(0);
  } finally { scans.restore(); }
  const bytes = Number(database().prepare("SELECT sum(length(CAST(payload AS BLOB))) b FROM memory_source_versions").get()!.b);
  expect(memoryRetentionStatus().sourceBytes).toBe(bytes);
  expect(memoryRetentionStatus().asOf).toBeGreaterThan(0);
});

it("a finished pass waits its interval before starting another, and a new pass can be asked for", () => {
  const db = database();
  let pages = 0;
  const scan = new PagedScan<{ n: number }, number>({ init: () => ({ n: 0 }), page: (_db, cursor, acc) => { pages++; if (cursor >= 3) return null; acc.n++; return cursor + 1; }, finish: acc => acc.n }, 1000);
  while (scan.step(db, 5, 0)) { /* run to the end */ }
  expect(scan.result).toBe(3);
  const done = pages;
  expect(scan.step(db, 5, 500)).toBe(false);
  expect(pages).toBe(done);
  scan.invalidate();
  while (scan.step(db, 5, 600)) { /* again */ }
  expect(pages).toBeGreaterThan(done);
  expect(STATUS_SCAN_INTERVAL_MS).toBe(600_000);
});
