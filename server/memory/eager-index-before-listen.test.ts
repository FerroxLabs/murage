// SPDX-License-Identifier: AGPL-3.0-or-later
// rc13 round 2 (c): the eager optional indexes of an upgrade launch are made before the server listens, under the start-up note, so no CREATE INDEX
// holds the write lock after listen (rc13 real-data run: 137, 179 and 302 ms builds right after listen).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { buildEagerIndexesBeforeListen, OPTIONAL_INDEXES, optionalIndexReady } from "./optional-index.ts";
import { IDENTITY_CANON_INDEX, IDENTITY_PARTITION_INDEX, WAITING_REVIEW_INDEX } from "./schema.ts";
import { buildSyntheticV6 } from "./testing/upgrade-fast-fixture.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
const EAGER = [IDENTITY_CANON_INDEX, IDENTITY_PARTITION_INDEX, WAITING_REVIEW_INDEX];

it("an upgrade launch opens with every eager index made, and only those", () => {
  buildSyntheticV6(join(DATA_DIR, "messages.db"), { threads: 4, perThread: 6, payloadBytes: 50, receiptsPerThread: 1 });
  const db = database();
  for (const name of EAGER) expect(optionalIndexReady(db, name)).toBe(true);
  // the idle-gated ones (not eager) still wait for the owner to be away
  for (const index of OPTIONAL_INDEXES.filter(item => !item.eager)) expect(optionalIndexReady(db, index.name)).toBe(false);
});

it("a fresh installation is not an upgrade launch: nothing is built at open (the after-listen build has nothing to read)", () => {
  const db = database();
  for (const name of EAGER) expect(optionalIndexReady(db, name)).toBe(false);
});

it("buildEagerIndexesBeforeListen builds each eager index once and skips the ones present", () => {
  const db = database();
  expect(buildEagerIndexesBeforeListen(db, { log: false }).sort()).toEqual([...EAGER].sort());
  expect(buildEagerIndexesBeforeListen(db, { log: false })).toEqual([]);
  for (const name of EAGER) expect(optionalIndexReady(db, name)).toBe(true);
});
