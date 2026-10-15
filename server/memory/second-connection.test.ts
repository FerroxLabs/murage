// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The authority epoch and the lineage cache count writes with TEMP triggers, which exist on the main connection only. Every other
// connection that writes messages.db (a restore, the conversation deletion, the downgrade, another process) is seen through
// data_version, which both the authority stamp and the hard stamp include: a write through a second connection to any covered
// table must move both, so a hold never treats a record that changed behind its back as sound.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { database } from "../database.ts";
import { authorityParts, authorityStamp, pinStamp } from "./authority-epoch.ts";
import { resetSessionHolds } from "./disclosures.ts";
import { resetMemoryCounters } from "./health.ts";
import { accessFor, captureAndPublish, emptyBridge, freshDataDir } from "./testing/recall-fixture.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { MemoryDispatchReceipt } from "./dispatch.ts";
import { LineageAllowance } from "./lineage-allowance.ts";

beforeEach(() => { freshDataDir("active"); resetMemoryCounters(); resetSessionHolds(); });
afterEach(() => resetMemoryCounters());

const COVERED = [
  "memory_records", "memory_sources", "memory_source_versions", "memory_evidence", "memory_derivations", "memory_tombstones",
  "memory_record_details", "memory_scopes", "memory_scope_bindings", "memory_disclosures", "memory_disclosure_outputs",
  "memory_output_roots", "memory_root_set_members", "memory_root_sets", "memory_lineage_meta", "memory_meta", "messages",
];

it("a write through a second connection to each covered table moves the stamp, the hard stamp and the pin stamp", async () => {
  const { access } = accessFor();
  captureAndPublish("The launch review is on Friday.");
  const bundle = await buildMemoryBundle("launch", access, emptyBridge, {allowance: LineageAllowance.tool()});
  const receipt = new MemoryDispatchReceipt(bundle, access, "engine");
  receipt.sessionStarted("session-1"); receipt.accepted(); receipt.output("m-out");
  database().prepare("INSERT OR IGNORE INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t','m1',1,'user','text','x','{}')").run();
  const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
  other.exec("PRAGMA busy_timeout=5000");
  try {
    let covered = 0;
    for (const table of COVERED) {
      const rows = Number(database().prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0);
      if (!rows) continue;
      covered++;
      const first = authorityParts()!, stamp = authorityStamp(), pins = pinStamp();
      // a write that changes nothing in the data still commits a page, which is all data_version needs
      other.exec(`UPDATE ${table} SET rowid=rowid WHERE rowid=(SELECT min(rowid) FROM ${table})`);
      const now = authorityParts()!;
      expect(now.hard, table).not.toBe(first.hard);
      expect(now.stamp, table).not.toBe(first.stamp);
      expect(authorityStamp(), table).not.toBe(stamp);
      expect(pinStamp(), table).not.toBe(pins);
    }
    expect(covered).toBeGreaterThan(8);
  } finally { other.close(); }
});

it("a message replaced by INSERT OR REPLACE into a copy moves the hard counter (replace fires no update or delete trigger)", () => {
  const db = database();
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t','m1',1,'bot','text','x','{\"a\":1}')").run();
  const hard = authorityParts()!.hard;
  db.prepare("INSERT OR REPLACE INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t','m1',1,'bot','text','x','{\"a\":1}')").run();
  expect(authorityParts()!.hard).toBe(hard);
  db.prepare("INSERT OR REPLACE INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t','m1',1,'bot','text','x','{\"copyOf\":\"m0\"}')").run();
  expect(authorityParts()!.hard).not.toBe(hard);
});
