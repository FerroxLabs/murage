// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The upgrade strip moves INSIDE one huge message (a reply whose root-set chain takes hundreds of slices) and inside one frontier node of the
// marker, never backwards and never past its total (RC4-SPEED-DIAG item 6).
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";

const { DATA_DIR } = await import("../config.ts");
const { closeDatabase, database } = await import("../database.ts");
const { chainStore } = await import("./schema.ts");
const { lineageBackfillSlice, lineageCertProgress, resetLineageBackfillForTest, setLineageSeedCommitForTest, upgradeMarkerFanout, MARKER_FANOUT_UNIT } = await import("./lineage-backfill.ts");
const { buildLegacyHistory, markUpgraded } = await import("./testing/legacy-history-fixture.ts");
setLineageSeedCommitForTest(() => 1);

beforeEach(() => { closeDatabase(); resetLineageBackfillForTest(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
const ticking = (step = 1) => { let t = 0; return () => (t += step); };

it("one message with thousands of root-set members moves done/total within the message, monotone and below total", () => {
  const db = database();
  buildLegacyHistory(db, { seed: 3, threads: 1, lines: 3, rootSets: 0, copies: 0 });
  const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  const keys: string[] = [];
  for (let i = 0; i < 4000; i++) { insert.run("src", `r${i}`, i, "user", "text", "x", "{}"); keys.push(`src\u0000r${i}`); }
  const set = chainStore(db)(null, 0, keys);
  insert.run("big", "huge", 1, "assistant", "text", "x", "{}");
  db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)").run("big", "huge", set);
  markUpgraded(db);
  const clock = ticking(5);
  const seen: Array<{ done: number; total: number; cut: boolean }> = [];
  for (let slices = 0; ; slices++) {
    const { more } = lineageBackfillSlice(db, { budgetMs: 3, now: clock });
    const cert = lineageCertProgress(db);
    const cursor = String(db.prepare("SELECT cursor FROM memory_lineage_cert WHERE id=1").get()!.cursor);
    seen.push({ done: cert.done, total: cert.total, cut: cursor.includes("\"line\"") });
    if (!more) break;
    if (slices > 100_000) throw new Error("no end");
  }
  for (let i = 1; i < seen.length; i++) expect(seen[i]!.done).toBeGreaterThanOrEqual(seen[i - 1]!.done);
  for (const step of seen.slice(0, -1)) expect(step.done).toBeLessThan(step.total);
  expect(seen.at(-1)!.done).toBe(seen.at(-1)!.total);
  // while the one huge message was cut across slices, the bar kept moving: many distinct values with the same finished rows
  const inside = new Set(seen.filter(step => step.cut).map(step => step.done));
  expect(inside.size).toBeGreaterThanOrEqual(5);
});

it("a frontier node's fan-out rows move the marker fraction: monotone in the rows, below one node", () => {
  const db = database();
  db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(1,'bulk','{\"upgrade-seed\":true}',0,0,'mark','','active')").run();
  expect(upgradeMarkerFanout(db)).toBe(0);
  let last = 0;
  for (const w of [1, MARKER_FANOUT_UNIT, MARKER_FANOUT_UNIT * 10, MARKER_FANOUT_UNIT * 1000]) {
    db.prepare("UPDATE memory_revoke_jobs SET cursor=? WHERE revoke_id=1").run(JSON.stringify({ seq: 1, n: {}, w }));
    const now = upgradeMarkerFanout(db);
    expect(now).toBeGreaterThan(last);
    expect(now).toBeLessThan(1);
    last = now;
  }
});
