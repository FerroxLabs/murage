// SPDX-License-Identifier: AGPL-3.0-or-later
// rc13 round 2 (c): the eager optional indexes of an upgrade launch are made before the server listens, under the start-up note, so no CREATE INDEX
// holds the write lock after listen (rc13 real-data run: 137, 179 and 302 ms builds right after listen).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { buildEagerIndexesBeforeListen, buildPreListenIndexes, OPTIONAL_INDEXES, optionalIndexReady } from "./optional-index.ts";
import { IDENTITY_CANON_INDEX, IDENTITY_PARTITION_INDEX, OWNER_PIN_INDEX, ownerPinIndexPresent, WAITING_REVIEW_INDEX } from "./schema.ts";
import { buildSyntheticV6 } from "./testing/upgrade-fast-fixture.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
const EAGER = [IDENTITY_CANON_INDEX, IDENTITY_PARTITION_INDEX, WAITING_REVIEW_INDEX];

it("an upgrade launch opens with every eager index made, and only those", () => {
  buildSyntheticV6(join(DATA_DIR, "messages.db"), { threads: 4, perThread: 6, payloadBytes: 50, receiptsPerThread: 1 });
  const db = database();
  for (const name of EAGER) expect(optionalIndexReady(db, name)).toBe(true);
  // the idle-gated ones (not eager) still wait for the owner to be away; the preListen owner-pin index is made at every open
  for (const index of OPTIONAL_INDEXES.filter(item => !item.eager && !item.preListen)) expect(optionalIndexReady(db, index.name)).toBe(false);
  expect(optionalIndexReady(db, OWNER_PIN_INDEX)).toBe(true);
});

it("a fresh installation is not an upgrade launch: nothing is built at open (the after-listen build has nothing to read)", () => {
  const db = database();
  for (const name of EAGER) expect(optionalIndexReady(db, name)).toBe(false);
});

it("MEM-PIN-INDEX-BOOT: an ordinary launch of a file without the owner-pin index makes it before listen, and the first pin read seeks it", () => {
  let db = database();
  // a fresh installation makes it at open too (an empty table: nothing to read)
  expect(optionalIndexReady(db, OWNER_PIN_INDEX)).toBe(true);
  // a file an earlier build left without it (the idle-gated build never ran)
  db.exec(`DROP INDEX ${OWNER_PIN_INDEX}`);
  closeDatabase();
  db = database(); // not an upgrade launch: the schema is current
  expect(optionalIndexReady(db, OWNER_PIN_INDEX)).toBe(true);
  expect(ownerPinIndexPresent(db)).toBe(true);
  const read = `SELECT id,version FROM memory_records r INDEXED BY ${OWNER_PIN_INDEX} WHERE state='active' AND owner_pinned=1 AND scope_id IN (SELECT value FROM json_each(?)) ORDER BY id,version`;
  expect(db.prepare(`EXPLAIN QUERY PLAN ${read}`).all(JSON.stringify(["s-0", "s-3"])).map(row => String(row.detail)).join(" | ")).toMatch(/USING (COVERING )?INDEX memory_records_pinned/);
  // the next launch finds it: nothing is built again
  expect(buildPreListenIndexes(db, { log: false })).toEqual([]);
});

it("buildEagerIndexesBeforeListen builds each eager index once and skips the ones present", () => {
  const db = database();
  expect(buildEagerIndexesBeforeListen(db, { log: false }).sort()).toEqual([...EAGER].sort());
  expect(buildEagerIndexesBeforeListen(db, { log: false })).toEqual([]);
  for (const name of EAGER) expect(optionalIndexReady(db, name)).toBe(true);
});
