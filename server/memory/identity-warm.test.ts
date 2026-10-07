// The identity set is warmed in rowid slices after the port opens, so the
// first skills request finds it built. The set it keeps must be exactly the
// one the one-shot query gives, and never one a write has outdated.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { captureSource } from "./capture.ts";
import { setMemoryMode } from "./repository.ts";
import { IDENTITY_CHUNK_HI_SQL, IDENTITY_CHUNK_SQL, identityScanCount, identitySourceSet, warmIdentitySourceSet } from "./provenance-stamp.ts";

const ONE_SHOT = "SELECT e.source_id,e.source_revision FROM memory_records r LEFT JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version CROSS JOIN memory_evidence e ON e.record_id=r.id AND e.record_version=r.version WHERE r.kind='character-canon' OR d.partition='identity'";
const SOURCES = 40, TOTAL = 20_500;
let scopeId = "";
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); seed(); });
function seed() {
  for (let i = 0; i < SOURCES; i++) transaction(db => captureSource(db, { id: `source:s${i}`, threadId: `t${i}`, kind: "tool-outcome", speaker: "tool", outcome: "completed", text: `o${i}`, action: { label: "fixture-check", reportedOutcome: "completed", verification: "tool-reported" } }));
  scopeId = String(database().prepare("SELECT scope_id FROM memory_sources WHERE id='source:s0'").get()!.scope_id);
  transaction(db => {
    const rec = db.prepare("INSERT INTO memory_records VALUES(?,1,?,?,?,'owner-statement','active',0,1,NULL,NULL,1)");
    const det = db.prepare("INSERT INTO memory_record_details(record_id,record_version,partition,attention,claim_status) VALUES(?,1,?,'current','current') ON CONFLICT(record_id,record_version) DO UPDATE SET partition=excluded.partition");
    const ev = db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,0,1)");
    for (let i = 0; i < TOTAL; i++) {
      const id = `r${i}`, canon = i % 1013 === 7, ident = i % 389 === 3;
      rec.run(id, scopeId, canon ? "character-canon" : "fact", `t${i}`);
      det.run(id, ident ? "identity" : "semantic");
      ev.run(id, `source:s${i % SOURCES}`);
    }
  });
}
const oneShot = (db = database()) => new Set(db.prepare(ONE_SHOT).all().map(r => `${r.source_id}:${r.source_revision}`));
const sorted = (s: ReadonlySet<string>) => [...s].sort();
function addIdentityEvidence(db = database(), id = "r3", source = "source:s39") { db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,5,6)").run(id, source); }

it("each chunk is a rowid range seek, never a scan of the records", () => {
  const db = database();
  const hi = db.prepare(`EXPLAIN QUERY PLAN ${IDENTITY_CHUNK_HI_SQL}`).all(0, 2000).map(r => String(r.detail)).join("\n");
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${IDENTITY_CHUNK_SQL}`).all(0, 2000).map(r => String(r.detail)).join("\n");
  expect(hi).toMatch(/SEARCH .*memory_records.*rowid>\?/);
  expect(rows).toMatch(/SEARCH r USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)|SEARCH r USING INTEGER PRIMARY KEY \(rowid>/);
  expect(rows).not.toMatch(/SCAN r\b/);
});

it("builds the same set as the one-shot query across chunk boundaries and keeps it", async () => {
  const db = database(), expected = oneShot(db);
  expect(expected.size).toBeGreaterThan(5);
  const before = identityScanCount();
  expect(await warmIdentitySourceSet(db, { chunk: 1500 })).toBe(true);
  const afterWarm = identityScanCount();
  expect(afterWarm).toBe(before + 1);
  expect(sorted(identitySourceSet(db))).toEqual(sorted(expected));
  expect(identityScanCount()).toBe(afterWarm); // the next request does not scan
});

it("yields the event loop between chunks", async () => {
  let ticks = 0; const tick = () => { ticks++; if (!done) setImmediate(tick); }; let done = false;
  setImmediate(tick);
  await warmIdentitySourceSet(database(), { chunk: 2000 }); done = true;
  expect(ticks).toBeGreaterThanOrEqual(Math.floor(TOTAL / 2000));
});

it("a write on this connection between chunks restarts the warm-up and never stores a stale set", async () => {
  const db = database();
  let n = 0, wrote = false;
  const writer = () => { if (++n === 3 && !wrote) { wrote = true; addIdentityEvidence(db); } else if (!wrote) setImmediate(writer); };
  setImmediate(writer);
  const before = identityScanCount();
  expect(await warmIdentitySourceSet(db, { chunk: 1500, retries: 0 })).toBe(false);
  expect(identityScanCount()).toBe(before); // nothing stored
  expect(identitySourceSet(db).has("source:s39:1")).toBe(true); // the next request scans the current state
  expect(identityScanCount()).toBe(before + 1);
});

it("restarts after a write and then stores the current set", async () => {
  const db = database();
  let n = 0, wrote = false;
  const writer = () => { if (++n === 3) { wrote = true; addIdentityEvidence(db); } else setImmediate(writer); };
  setImmediate(writer);
  expect(await warmIdentitySourceSet(db, { chunk: 1500, retries: 3 })).toBe(true);
  expect(wrote).toBe(true);
  const scans = identityScanCount();
  expect(sorted(identitySourceSet(db))).toEqual(sorted(oneShot(db)));
  expect(identitySourceSet(db).has("source:s39:1")).toBe(true);
  expect(identityScanCount()).toBe(scans);
});

it("a write from another connection (even an ordinary one) discards the partial result", async () => {
  const db = database();
  const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
  try {
    let n = 0, wrote = false;
    const writer = () => { if (++n === 3 && !wrote) { wrote = true; other.prepare("UPDATE memory_records SET text='x' WHERE id='r5'").run(); } else if (!wrote) setImmediate(writer); };
    setImmediate(writer);
    const before = identityScanCount();
    expect(await warmIdentitySourceSet(db, { chunk: 1500, retries: 0 })).toBe(false);
    expect(identityScanCount()).toBe(before);
    expect(wrote).toBe(true);
  } finally { other.close(); }
});

it("a request during the warm-up gets the correct set, and the warm-up leaves a valid memo", async () => {
  const db = database(), expected = oneShot(db);
  let during: string[] | undefined;
  setImmediate(() => { during = sorted(identitySourceSet(db)); });
  const warm = warmIdentitySourceSet(db, { chunk: 1500 });
  await warm;
  expect(during).toEqual(sorted(expected));
  expect(sorted(identitySourceSet(db))).toEqual(sorted(expected));
});
