// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: sc-safety (fixture schema producer and isolated-copy consumers).
// fixrev-sc-safety owns independent review; actual product initializers stay unchanged.
import { afterAll } from "vitest";
import { mkdtempSync,copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { WritetimeFixture } from "../memory/testing/writetime-fixture.ts";
import { safeWipeSync } from "./safe-wipe.mjs";
import { initializeOwnWriteHolds } from "../own-write-holds.ts";
import { initializeArtifacts } from "../artifacts.ts";
import { initializeTeamIdentityTables } from "../team-identities.ts";
import { initializeMessageTables } from "../message-tables.ts";
import { initializeInbox } from "../inbox.ts";
import { initializeProjectTables } from "../project-tables.ts";
import { initializePendingDelegations } from "../pending-delegations-schema.ts";

const prepared=new WeakMap<DatabaseSync,number>();
const schemaCookie=(db:DatabaseSync):number=>Number(db.prepare("PRAGMA schema_version").get()!.schema_version);
/** Full real Store using the isolated Vitest installation's DATA_DIR. */
export function initializeInternalFixtureDatabase(db: Parameters<typeof initializeMessageTables>[0]):void {
  const cookie=schemaCookie(db);
  if(prepared.get(db)===cookie)return;
  // Match the real application storage mode and full commit durability.
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  initializeMessageTables(db);
  // Message backfill owns its own BEGIN above. Batch the remaining actual
  // schema initializers into one durable fixture commit instead of one fsync
  // per DDL statement; every production initializer and trigger still runs.
  db.exec("SAVEPOINT internal_fixture_schema");
  try {
    initializeInbox(db);
    initializeProjectTables(db);
    initializeTeamIdentityTables(db);
    initializePendingDelegations(db);
    initializeArtifacts(db);
    initializeOwnWriteHolds(db);
    db.exec("RELEASE internal_fixture_schema");
    prepared.set(db,schemaCookie(db));
  } catch(error) {
    db.exec("ROLLBACK TO internal_fixture_schema; RELEASE internal_fixture_schema");
    throw error;
  }
}

let template:{directory:string;file:string}|undefined;
/** Copy actual initialized schema and the same two constant fixture lines.
 * No turn, approval, capability or dispatch owner exists in this template.
 * Every caller opens its own real file and subsequently registers fresh state.
 */
export function preparedInternalWritetimeFixture():WritetimeFixture {
  if(!template) {
    const directory=mkdtempSync(join(tmpdir(),"sc-internal-schema-")),file=join(directory,"schema.db");
    const seed=new WritetimeFixture().reply("T","X",1).reply("T","Y",2);
    try {
      initializeInternalFixtureDatabase(seed.db);
      seed.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const source=String(seed.db.prepare("PRAGMA database_list").get()!.file);
      seed.db.close();copyFileSync(source,file);template={directory,file};
    } catch(error) {safeWipeSync(directory);throw error;}
    finally {seed.close();}
  }
  const fixture=new WritetimeFixture(undefined,{template:template.file});
  // Installation identity is fresh fixture DATA, never retained in a copy.
  fixture.db.prepare("UPDATE memory_meta SET installation_id=? WHERE id=1").run(randomUUID());
  prepared.set(fixture.db,schemaCookie(fixture.db));
  return fixture;
}
afterAll(()=>{if(template){safeWipeSync(template.directory);template=undefined;}});
