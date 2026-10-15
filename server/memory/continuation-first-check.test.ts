// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The first check of a resumed session (nothing remembered yet: a restart, or the epoch moved) on a session of 80 receipts of
// about 30 entries each. It used to hydrate every cited record twice (once for the receipts, once more inside the lineage
// check), re-read the memory settings for each assertion, prepare the same statements tens of thousands of times and ask SQLite
// for total_changes() at every memo lookup: 3.5 s on the 60,000-source store. The wall-clock figure is gated in memory-perf.test.ts
// (MEMORY_PERF=1); this file pins the work done, which does not depend on the machine.
import { afterEach, beforeEach, expect, it } from "vitest";
import { afterEach as thawAfterEach, beforeEach as thawBeforeEach } from "vitest";
import { thawRootSetWritesForTest } from "./replay-lineage.ts";
import { database } from "../database.ts";
import { ioBudget } from "../io-budget.ts";
import { continuationMemoryRevoked, resetSessionHolds } from "./disclosures.ts";
import { closeMemoryIndexReader } from "./index-reader.ts";
import { outputRootsFor, recordSessionRoots, setTurnLineageNodesForTest } from "./replay-lineage.ts";
import { buildPerfFixture } from "./testing/perf-fixture.ts";
import { accessFor, freshDataDir } from "./testing/recall-fixture.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
// 1.0.2: this test models a 1.0.1 file (legacy root-set rows) for the read-time judge, which still decides legacy data until S6.
thawBeforeEach(() => thawRootSetWritesForTest(true));
thawAfterEach(() => thawRootSetWritesForTest(false));

const SESSION = "session-0";
const RECORDS = 500;
beforeEach(() => {
  // These pin what a check hydrates and prepares on a session of 80 receipts citing 500 records, which costs more than the allowance of one turn
  // (a cold first turn resets such a session for warming: lineage-cold-turn.test.ts, and the two tests at the end of this file), so the check is given room to finish.
  setTurnLineageNodesForTest(1_000_000_000);
  freshDataDir("active"); resetSessionHolds();
  buildPerfFixture({ sources: RECORDS + 40, indexedRecords: RECORDS, active: 300, waiting: 0, extraWaiting: 0, deferredJobs: 0, pendingJobs: 0, disclosures: 80, disclosureEntries: 30 });
  // sessions this build wrote carry a lineage row
  for (const r of database().prepare("SELECT DISTINCT thread_id,driver_instance,native_session FROM memory_disclosures WHERE native_session IS NOT NULL").all()) recordSessionRoots(String(r.thread_id), String(r.driver_instance), String(r.native_session), outputRootsFor(LineageAllowance.tool(1_000_000_000), []));
});
afterEach(() => { closeMemoryIndexReader(); resetSessionHolds(); setTurnLineageNodesForTest(null); });

const statements = () => (ioBudget as unknown as { statements: Map<string, { sql: string; calls: number }> }).statements;
const calls = (prefix: string) => [...statements().values()].filter(row => row.sql.startsWith(prefix)).reduce((sum, row) => sum + row.calls, 0);

it("80 receipts citing 500 records: each record is hydrated once, the settings are read a handful of times, and nothing is prepared twice", () => {
  const { access } = accessFor();
  expect(Number(database().prepare("SELECT count(*) AS n FROM memory_disclosures WHERE native_session=?").get(SESSION)!.n)).toBe(80);
  statements().clear();
  const why: { reason?: string } = {};
  expect(continuationMemoryRevoked(LineageAllowance.tool(), access.threadId, "claude", SESSION, access, why)).toBe(false);
  expect(why.reason).toBeUndefined();
  const distinct = Number(database().prepare("SELECT count(*) AS n FROM (SELECT DISTINCT json_extract(j.value,'$.id') AS id, json_extract(j.value,'$.version') AS v FROM memory_disclosures d, json_each(d.record_versions) j WHERE d.native_session=?)").get(SESSION)!.n);
  expect(distinct).toBe(RECORDS);
  expect(calls("SELECT * FROM memory_records WHERE id=? AND version=? AND state='active'")).toBe(distinct);
  expect(calls("SELECT * FROM memory_meta WHERE id=1")).toBeLessThan(10);
  expect(calls("SELECT total_changes()")).toBe(0);
  const total = [...statements().values()].reduce((sum, row) => sum + row.calls, 0);
  // 1.0.2: the write-time deny lookups add a few statements per record (still linear in the records cited, never in receipts or turns).
  // (S6 adds the retire gate's two seeks and the session predicate's per call, a constant: 22,773 at 500 records measured)
  expect(total).toBeLessThan(distinct * 48);
});

it("the same pass still refuses the session when a cited record was archived since, and when it was tombstoned", () => {
  const { access } = accessFor();
  const [first, second] = database().prepare("SELECT DISTINCT json_extract(j.value,'$.id') AS id, json_extract(j.value,'$.version') AS version FROM memory_disclosures d, json_each(d.record_versions) j WHERE d.native_session=? LIMIT 2").all(SESSION) as Array<{ id: string; version: number }>;
  expect(continuationMemoryRevoked(LineageAllowance.tool(), access.threadId, "claude", SESSION, access)).toBe(false);
  database().prepare("UPDATE memory_records SET state='archived' WHERE id=? AND version=?").run(first.id, first.version);
  const why: { reason?: string } = {};
  expect(continuationMemoryRevoked(LineageAllowance.tool(), access.threadId, "claude", SESSION, access, why)).toBe(true);
  expect(why.reason).toMatch(/memory-changed/);
  resetSessionHolds();
  database().prepare("UPDATE memory_records SET state='active' WHERE id=? AND version=?").run(first.id, first.version);
  database().prepare("UPDATE memory_disclosures SET state='delivered' WHERE native_session=?").run(SESSION);
  expect(continuationMemoryRevoked(LineageAllowance.tool(), access.threadId, "claude", SESSION, access)).toBe(false);
  database().prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,epoch,reason,created_at) VALUES('tomb-test','record',?,NULL,0,'test',?)").run(second.id, Date.now());
  expect(continuationMemoryRevoked(LineageAllowance.tool(), access.threadId, "claude", SESSION, access)).toBe(true);
});

// 1.0.2 lineage-cold: the receipts of the session are read within the turn's allowance (never every receipt of a session outside it)
it("with no allowance left the first check reads no receipt: the session is unproven and resets for warming", () => {
  const { access } = accessFor();
  statements().clear();
  const why: { reason?: string } = {};
  expect(continuationMemoryRevoked(LineageAllowance.turn(0), access.threadId, "claude", SESSION, access, why)).toBe(true);
  expect(why.reason).toBe("lineage-warming");
  expect(calls("SELECT rowid AS rid,bundle_id")).toBe(0);
});

it("an allowance that pays for fewer receipts than the session holds stops the read at what it pays for and resets for warming; one that pays for them all does not", () => {
  const { access } = accessFor();
  statements().clear();
  const short: { reason?: string } = {};
  // one node pays for 16 rows: the 80 receipts do not fit
  expect(continuationMemoryRevoked(LineageAllowance.turn(1), access.threadId, "claude", SESSION, access, short)).toBe(true);
  expect(short.reason).toBe("lineage-warming");
  resetSessionHolds();
  const enough: { reason?: string } = {};
  expect(continuationMemoryRevoked(LineageAllowance.turn(1_000_000), access.threadId, "claude", SESSION, access, enough)).toBe(false);
  expect(enough.reason).toBeUndefined();
});
