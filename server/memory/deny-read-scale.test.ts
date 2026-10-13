// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Write-time privacy, S4: the turn check costs the same at any history size (DESIGN-WRITETIME 8, "Turn"). One turn's lookups (3 transcript
// pages of 200 lines, 20 quoted lines from 20 other threads, 32 recall candidates, 1 retained session with 2,000 receipts, the send fence)
// run on a 1k-message file and on a 3M-message-shaped file (one 3M-line thread, 500k receipts, 300k records, history-sized marks). The
// statements run, the rows they return and every verdict are identical, and every statement's query plan is an index search (no table
// scan other than the bounded existence probes). build host only (hz-test.sh): the large fixture is built in SQL in about a minute.
import { afterAll, expect, it } from "vitest";
import { denyLookup, denyReadMeter, fenceVerdict, memoryLookup, refsLookup, resetDenyReadMeter, sessionLookup } from "./deny-read.ts";
import { buildPrompt, promptPart } from "./prompt-parts.ts";
import type { LineageRef, LineageVerdict, MemoryRef, PageLine } from "./lineage-types.ts";
import { MEMBER, testThreadNo, WritetimeFixture } from "./testing/writetime-fixture.ts";

const BIG = Number(process.env.MURAGE_S4_SCALE_LINES ?? 3_000_000);
const fixtures: WritetimeFixture[] = [];
afterAll(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

/** Every property of the newest 600 lines depends only on their distance from the end (j), so both files hold the same tail. History-sized
 * rows sit only in lines older than the tail (i <= n - 1000), which exist only in the large file. */
function build(n: number): WritetimeFixture {
  const f = new WritetimeFixture(); fixtures.push(f);
  const db = f.db;
  db.exec("BEGIN");
  const series = "WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<?1)";
  db.prepare(`${series} INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT 'BIG','m'||i,i,CASE WHEN i%2=1 THEN 'user' ELSE 'bot' END,'text','',json_object('id','m'||i) FROM c`).run(n);
  // tail (j = n - i < 1000) properties by j; history lines plain
  const big = testThreadNo(db, "BIG");
  db.prepare(`${series} INSERT INTO memory_line_lineage(thread_no,lsn,message_id,turn_lsn,mem_lsn,footprint)
    SELECT ${big},i,'m'||i,CASE WHEN i%2=1 THEN NULL ELSE i-1 END,
      CASE WHEN (?1-i)%7=0 THEN i-3 ELSE NULL END,CASE WHEN (?1-i)%11=0 THEN 1 WHEN (?1-i)%13=0 THEN 2 ELSE NULL END FROM c`).run(n);
  db.prepare("UPDATE memory_lsn SET next=? WHERE id=1").run(n + 1000);
  f.footprint(1, ["s-room"]).footprint(2, ["s-room", "s-secret"]);
  // tail marks
  db.prepare(`${series} INSERT INTO memory_deny_line(thread_id,lsn,revoke_id,mark_lsn,reason) SELECT 'BIG',i,1,i,'t' FROM c WHERE ?1-i<600 AND (?1-i)%50=0 AND i%2=0`).run(n);
  db.prepare(`${series} INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) SELECT 'tt'||i,'source','message:BIG:m'||i,NULL,NULL,0,'owner-forget',0 FROM c WHERE ?1-i<600 AND (?1-i)%41=0 AND i%2=1`).run(n);
  f.denyRange("BIG", n - 300, n - 250, 2).pending("BIG", n - 100, 3).meta("policy_bump_lsn", n - 400);
  // history-sized marks (the large file only): marks every 97th old line, forgotten sources every 101st, ranges early in the thread
  db.prepare(`${series} INSERT INTO memory_deny_line(thread_id,lsn,revoke_id,mark_lsn,reason) SELECT 'BIG',i,4,i,'t' FROM c WHERE i<=?1-1000 AND i%97=0`).run(n);
  db.prepare(`${series} INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) SELECT 'th'||i,'source','message:BIG:m'||i,NULL,NULL,0,'owner-forget',0 FROM c WHERE i<=?1-1000 AND i%101=0`).run(n);
  // 40 ranges in both files (their from below the tail, their until below the tail's turns), spread over whatever history there is
  for (let at = 0; at < 40; at++) { const from = 1 + Math.floor((n - 1000) * at / 40); f.denyRange("BIG", from, from + 1, 10 + at); }
  // 20 other threads with 30 lines each (the quotes), same in both
  db.prepare(`WITH RECURSIVE t(k) AS (SELECT 0 UNION ALL SELECT k+1 FROM t WHERE k<19), l(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM l WHERE i<30)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT 'Q'||k,'q'||i,i,'bot','text','','{}' FROM t,l`).run();
  db.prepare(`WITH RECURSIVE t(k) AS (SELECT 0 UNION ALL SELECT k+1 FROM t WHERE k<19), l(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM l WHERE i<30)
    INSERT INTO memory_thread_no(thread_id,no) SELECT 'Q'||k,1000+k FROM t`).run();
  db.prepare(`WITH RECURSIVE t(k) AS (SELECT 0 UNION ALL SELECT k+1 FROM t WHERE k<19), l(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM l WHERE i<30)
    INSERT INTO memory_line_lineage(thread_no,lsn,message_id,turn_lsn,mem_lsn,footprint) SELECT 1000+k,?1+k*100+i,'q'||i,?1+k*100+i-1,NULL,NULL FROM t,l`).run(n);
  f.denyLine("Q3", n + 300 + 30, 5);
  // the session: 2,000 receipts in both; 500k-shaped receipts elsewhere in the large file
  db.prepare("WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<2000) INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) SELECT 'sb'||i,'BIG','d','n','[]','[]','[]',0,0,0,'delivered',i FROM c").run();
  db.prepare(`${series} INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) SELECT 'hb'||i,'BIG','d','old'||(i%500),'[]','[]','[]',0,0,0,CASE WHEN i%9=0 THEN 'revoked' ELSE 'delivered' END,i FROM c WHERE i<=(?1-1000)/6`).run(n);
  f.sessionLineage("BIG", "d", "n", 1, n - 700);
  // recall candidates (same 32 in both) and 300k-shaped history records with marks
  db.prepare("WITH RECURSIVE c(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM c WHERE i<31) INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,valid_to,supersedes_id,created_at) SELECT 'r'||i,1,'s-room','fact','x','owner-statement','active',0,0,NULL,NULL,0 FROM c").run();
  db.prepare(`${series} INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,valid_to,supersedes_id,created_at) SELECT 'h'||i,1,'s-room','fact','x','owner-statement','active',0,0,NULL,NULL,0 FROM c WHERE i<=(?1-1000)/10`).run(n);
  db.prepare(`${series} INSERT INTO memory_deny_memory(kind,id,version,revoke_id) SELECT 'record','h'||i,0,6 FROM c WHERE i<=(?1-1000)/10 AND i%13=0`).run(n);
  f.denyMemory("record", "r5", 0, 7).tombstone("record", "r9", null);
  db.exec("COMMIT");
  db.exec("ANALYZE");
  return f;
}

interface Turn { verdicts: string[]; statements: number; rows: number; sql: readonly string[] }
function turn(f: WritetimeFixture, n: number): Turn {
  const db = f.db;
  const tail = (from: number, to: number): PageLine[] => {
    const lines: PageLine[] = [];
    for (let j = to - 1; j >= from; j--) { const i = n - j; lines.push({ messageId: `m${i}`, author: i % 2 === 1 ? "owner" : "generated" }); }
    return lines;
  };
  const quotes: LineageRef[] = Array.from({ length: 20 }, (_, k) => ({ kind: "line", threadId: `Q${k}`, messageId: `q30` }));
  const recall: MemoryRef[] = Array.from({ length: 32 }, (_, k) => ({ kind: "record", id: `r${k}`, version: 1, scopeId: "s-room" }));
  const out: LineageVerdict[] = [];
  db.prepare("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'").run();
  const built = buildPrompt(undefined, quotes.map(ref => promptPart("quote", [ref])));
  resetDenyReadMeter();
  for (const [from, to] of [[400, 600], [200, 400], [0, 200]] as const) out.push(...denyLookup(db, { threadId: "BIG", lines: tail(from, to) }, MEMBER).values());
  out.push(refsLookup(db, quotes, MEMBER));
  out.push(...memoryLookup(db, recall, MEMBER).values());
  out.push(sessionLookup(db, { threadId: "BIG", driverInstance: "d", nativeSession: "n" }, MEMBER));
  out.push(fenceVerdict(db, built, MEMBER));
  const meter = denyReadMeter();
  return { verdicts: out.map(v => JSON.stringify(v)), statements: meter.statements, rows: meter.rows, sql: meter.sql };
}

/** Plans that read a table whole: none, except a bounded existence probe (LIMIT 1, or memory_deny's whole-table EXISTS) and json_each. */
function scans(f: WritetimeFixture, sql: readonly string[]): string[] {
  const bad: string[] = [];
  for (const text of sql) {
    for (const row of f.db.prepare(`EXPLAIN QUERY PLAN ${text}`).all() as Array<{ detail: string }>) {
      const detail = String(row.detail);
      if (!detail.startsWith("SCAN ")) continue;
      if (/VIRTUAL TABLE|CONSTANT ROW/.test(detail)) continue;
      if (/^SCAN (memory_deny|memory_deny_pending|memory_deny_pending_scope)\b/.test(detail) && (/LIMIT 1/.test(text) || /EXISTS \(SELECT 1 FROM memory_deny\)/.test(text))) continue;
      bad.push(`${detail} :: ${text.slice(0, 120)}`);
    }
  }
  return bad;
}

it("one turn's lookups are flat: identical statements, rows and verdicts at 1k and 3M-message-shaped history, index searches only", () => {
  const small = build(1000), large = build(BIG);
  const a = turn(small, 1000), b = turn(large, BIG);
  // the same answers (by position from the end) at both sizes, and some of every kind, so the comparison means something
  expect(b.verdicts).toEqual(a.verdicts);
  for (const kind of ["shown", "withheld", "checking"]) expect(a.verdicts.some(v => v.includes(`"${kind}"`)), kind).toBe(true);
  expect(b.statements).toBe(a.statements);
  expect(b.rows).toBe(a.rows);
  // the design's budget: about 120-200 seeks, about 1,000 rows
  expect(a.statements).toBeLessThanOrEqual(200);
  expect(a.rows).toBeLessThanOrEqual(1500);
  expect(scans(large, b.sql)).toEqual([]);
  // a warm second turn costs the same again (no cache that grows with history decides it)
  const c = turn(large, BIG);
  expect(c.statements).toBeLessThanOrEqual(b.statements);
  expect(c.rows).toBeLessThanOrEqual(b.rows);
}, 900_000);
