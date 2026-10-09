// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The first check of a resumed session (nothing remembered yet: a restart, or the epoch moved) on a session of 80 receipts of
// about 30 entries each. It used to hydrate every cited record twice (once for the receipts, once more inside the lineage
// check), re-read the memory settings for each assertion, prepare the same statements tens of thousands of times and ask SQLite
// for total_changes() at every memo lookup: 3.5 s on the 60,000-source store. The wall-clock figure is gated in memory-perf.test.ts
// (MEMORY_PERF=1); this file pins the work done, which does not depend on the machine.
import { afterEach, beforeEach, expect, it } from "vitest";
import { database } from "../database.ts";
import { ioBudget } from "../io-budget.ts";
import { continuationMemoryRevoked, resetSessionHolds } from "./disclosures.ts";
import { closeMemoryIndexReader } from "./index-reader.ts";
import { buildPerfFixture } from "./testing/perf-fixture.ts";
import { accessFor, freshDataDir } from "./testing/recall-fixture.ts";

const SESSION = "session-0";
const RECORDS = 500;
beforeEach(() => {
  freshDataDir("active"); resetSessionHolds();
  buildPerfFixture({ sources: RECORDS + 40, indexedRecords: RECORDS, active: 300, waiting: 0, extraWaiting: 0, deferredJobs: 0, pendingJobs: 0, disclosures: 80, disclosureEntries: 30 });
});
afterEach(() => { closeMemoryIndexReader(); resetSessionHolds(); });

const statements = () => (ioBudget as unknown as { statements: Map<string, { sql: string; calls: number }> }).statements;
const calls = (prefix: string) => [...statements().values()].filter(row => row.sql.startsWith(prefix)).reduce((sum, row) => sum + row.calls, 0);

it("80 receipts citing 500 records: each record is hydrated once, the settings are read a handful of times, and nothing is prepared twice", () => {
  const { access } = accessFor();
  expect(Number(database().prepare("SELECT count(*) AS n FROM memory_disclosures WHERE native_session=?").get(SESSION)!.n)).toBe(80);
  statements().clear();
  const why: { reason?: string } = {};
  expect(continuationMemoryRevoked(access.threadId, "claude", SESSION, access, why)).toBe(false);
  expect(why.reason).toBeUndefined();
  const distinct = Number(database().prepare("SELECT count(*) AS n FROM (SELECT DISTINCT json_extract(j.value,'$.id') AS id, json_extract(j.value,'$.version') AS v FROM memory_disclosures d, json_each(d.record_versions) j WHERE d.native_session=?)").get(SESSION)!.n);
  expect(distinct).toBe(RECORDS);
  expect(calls("SELECT * FROM memory_records WHERE id=? AND version=? AND state='active'")).toBe(distinct);
  expect(calls("SELECT * FROM memory_meta WHERE id=1")).toBeLessThan(10);
  expect(calls("SELECT total_changes()")).toBe(0);
  const total = [...statements().values()].reduce((sum, row) => sum + row.calls, 0);
  expect(total).toBeLessThan(distinct * 30);
});

it("the same pass still refuses the session when a cited record was archived since, and when it was tombstoned", () => {
  const { access } = accessFor();
  const [first, second] = database().prepare("SELECT DISTINCT json_extract(j.value,'$.id') AS id, json_extract(j.value,'$.version') AS version FROM memory_disclosures d, json_each(d.record_versions) j WHERE d.native_session=? LIMIT 2").all(SESSION) as Array<{ id: string; version: number }>;
  expect(continuationMemoryRevoked(access.threadId, "claude", SESSION, access)).toBe(false);
  database().prepare("UPDATE memory_records SET state='archived' WHERE id=? AND version=?").run(first.id, first.version);
  const why: { reason?: string } = {};
  expect(continuationMemoryRevoked(access.threadId, "claude", SESSION, access, why)).toBe(true);
  expect(why.reason).toMatch(/memory-changed/);
  resetSessionHolds();
  database().prepare("UPDATE memory_records SET state='active' WHERE id=? AND version=?").run(first.id, first.version);
  database().prepare("UPDATE memory_disclosures SET state='delivered' WHERE native_session=?").run(SESSION);
  expect(continuationMemoryRevoked(access.threadId, "claude", SESSION, access)).toBe(false);
  database().prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,epoch,reason,created_at) VALUES('tomb-test','record',?,NULL,0,'test',?)").run(second.id, Date.now());
  expect(continuationMemoryRevoked(access.threadId, "claude", SESSION, access)).toBe(true);
});
