// SPDX-License-Identifier: AGPL-3.0-or-later
// A fill slice is sized from the rows' record headers alone: working out how
// many rows the budget admits must not read the rows. Sizing that read every
// candidate row (256 consecutive 32 KiB tool outputs = 8 MiB at the first 64
// KiB budget, 512 MiB at the ceiling) held the loop before the adaptive
// controller had seen anything.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { inboxProjectionSlice, initializeInbox } from "./inbox.ts";
import { initializeMessageTables } from "./message-tables.ts";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) { try { db.close(); } catch { /* closed */ } } });
const open = () => { const db = new DatabaseSync(":memory:"); databases.push(db); return db; };
const median = (values: number[]) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

/** `count` consecutive rows whose json is `bytes` long (tool output, with a provider refusal so the fill really projects them). */
function bigRows(db: DatabaseSync, count: number, bytes: number, prefix = "big") {
  const shell = (id: string, output: string) => JSON.stringify({ id, at: 1_800_000_000_000, role: "bot", kind: "activity", tool: { name: "run", ok: false, providerError: { httpStatus: 500, provider: "x" }, output } });
  const pad = bytes - shell(`${prefix}000`, "").length;
  const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < count; i++) {
    const id = `${prefix}${String(i).padStart(3, "0")}`;
    insert.run(`t${i % 8}`, id, 1_800_000_000_000, "bot", "activity", null, shell(id, "x".repeat(pad)));
  }
  db.exec("COMMIT");
}

describe("the size of a row is read from its record header, not its content", () => {
  it("octet_length(json) costs the same for 32 KiB rows as for 2 MiB rows, while length(json) follows the content", () => {
    const version = (open().prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
    const [major, minor] = version.split(".").map(Number) as [number, number];
    expect(major * 1000 + minor, `bundled SQLite ${version} must have octet_length (3.43+)`).toBeGreaterThanOrEqual(3043);

    const candidates = { "length(json)": "length(json)", "length(CAST(json AS BLOB))": "length(CAST(json AS BLOB))", "octet_length(json)": "octet_length(json)" } as const;
    const measure = (rowBytes: number) => {
      const db = open();
      db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
      const body = "x".repeat(rowBytes);
      const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t',?,?,'bot','activity',NULL,?)");
      db.exec("BEGIN");
      for (let i = 0; i < 256; i++) insert.run(`m${i}`, i, body);
      db.exec("COMMIT");
      const out: Record<string, number> = {};
      for (const [name, expression] of Object.entries(candidates)) {
        const statement = db.prepare(`SELECT sum(l) AS s FROM (SELECT ${expression} AS l FROM messages WHERE rowid>? ORDER BY rowid LIMIT 256)`);
        const times: number[] = [];
        for (let run = 0; run < 7; run++) {
          const started = performance.now();
          const total = (statement.get(0) as { s: number }).s;
          times.push(performance.now() - started);
          expect(total).toBe(256 * rowBytes);
        }
        out[name] = median(times);
      }
      db.close();
      return out;
    };
    const small = measure(32 * 1024), large = measure(2 * 1024 * 1024);
    for (const name of Object.keys(candidates)) console.log(`[sizing-proof] ${name}: 256 rows x 32 KiB = ${small[name]!.toFixed(3)} ms, 256 rows x 2 MiB = ${large[name]!.toFixed(3)} ms`);
    // the measurement can tell a reading function from a header one: the content-reading forms follow the bytes
    expect(large["length(json)"]!).toBeGreaterThan(small["length(json)"]! * 5);
    // the header-only form does not: 64x the bytes, the same time, and far under 50 ms
    expect(large["octet_length(json)"]!).toBeLessThan(small["octet_length(json)"]! * 3 + 1);
    expect(large["octet_length(json)"]!).toBeLessThan(5);
    expect(large["octet_length(json)"]!).toBeLessThan(large["length(json)"]! / 5);
  }, 120_000);
});

/**
 * A disk that takes `msPerMiB` per MiB of message JSON that a statement reads.
 * What a statement reads is decided by its text: the fill's insert reads the
 * json of its rowid range; a sizing statement reads the json of the rows it
 * evaluates unless it asks only for octet_length(json), which the test above
 * measures as header-only.
 */
function slowDisk(db: DatabaseSync, msPerMiB: number) {
  const charged = { fillBytes: 0, sizingBytes: 0, sizingCalls: 0 };
  const burn = (ms: number) => { const until = performance.now() + ms; while (performance.now() < until) { /* a slow read */ } };
  // the fill reads only the rows its budget admits; the heavier ones are deferred and never read here
  const bytesOf = (from: number, to: number, budget: number) => (db.prepare("SELECT COALESCE(SUM(octet_length(json)),0) AS bytes FROM messages WHERE rowid>? AND rowid<=? AND octet_length(json)+256<=?").get(from, to, budget) as { bytes: number }).bytes;
  const firstRowsBytes = (from: number, rows: number) => (db.prepare("SELECT COALESCE(SUM(octet_length(json)),0) AS bytes FROM (SELECT json FROM messages WHERE rowid>? ORDER BY rowid LIMIT ?)").get(from, rows) as { bytes: number }).bytes;
  const proxy = new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property !== "prepare") return typeof value === "function" ? value.bind(target) : value;
      return (sql: string) => {
        const statement = target.prepare(sql);
        const fill = sql.startsWith("INSERT OR IGNORE INTO inbox_raw");
        const sizing = /FROM messages WHERE rowid>\?/.test(sql) && /length\(/.test(sql);
        if (!fill && !sizing) return statement;
        const readsContent = sizing && /(?<!octet_)length\(/.test(sql);
        return new Proxy(statement, {
          get(inner, name) {
            if (name === "run" || name === "get" || name === "all") {
              return (...args: number[]) => {
                if (fill) { const bytes = bytesOf(args[0]!, args[1]!, args[2]!); charged.fillBytes += bytes; burn(bytes / 1048576 * msPerMiB); }
                else {
                  charged.sizingCalls++;
                  if (readsContent) { const bytes = firstRowsBytes(args[0]!, args[1]!); charged.sizingBytes += bytes; burn(bytes / 1048576 * msPerMiB); }
                }
                return (inner[name] as (...a: unknown[]) => unknown).apply(inner, args);
              };
            }
            const member = Reflect.get(inner, name) as unknown;
            return typeof member === "function" ? member.bind(inner) : member;
          },
        });
      };
    },
  });
  return { proxy, charged };
}

describe("sizing a slice reads no row content", () => {
  for (const [label, budget] of [["64 KiB (the first budget)", 64 * 1024], ["512 KiB (the ceiling)", 512 * 1024]] as const) {
    it(`256 consecutive 32 KiB tool outputs at the ${label} budget make a slice under 50 ms on a slow disk, before the controller has seen anything`, () => {
      const db = open();
      initializeMessageTables(db);
      bigRows(db, 256, 32 * 1024);
      initializeInbox(db);
      const { proxy, charged } = slowDisk(db, 60);
      const started = performance.now();
      const slice = inboxProjectionSlice(proxy, { rows: 10_000, weight: budget });
      const ms = performance.now() - started;
      console.log(`[slice-sizing] ${label}: ${ms.toFixed(1)} ms, rows=${slice.rows}, fill read ${(charged.fillBytes / 1024).toFixed(0)} KiB, sizing read ${(charged.sizingBytes / 1024).toFixed(0)} KiB in ${charged.sizingCalls} step(s)`);
      expect(ms).toBeLessThan(50);
      expect(charged.sizingBytes, "sizing reads no content").toBe(0);
      // the fill reads only what it admitted: the budget plus at most the one row that crossed it
      expect(slice.rows).toBeGreaterThan(0);
      expect(charged.fillBytes).toBeLessThanOrEqual(budget + 33 * 1024);
      expect((db.prepare("SELECT COUNT(*) AS n FROM inbox_raw").get() as { n: number }).n).toBe(slice.rows);
    });
  }

  it("a run of huge rows is deferred whole: sizing reads headers only, and the fill reads none of them", () => {
    const db = open();
    initializeMessageTables(db);
    bigRows(db, 64, 2 * 1024 * 1024);
    initializeInbox(db);
    const { proxy, charged } = slowDisk(db, 60);
    const started = performance.now();
    const slice = inboxProjectionSlice(proxy, { rows: 10_000, weight: 64 * 1024 });
    const sizingMs = performance.now() - started;
    expect(slice.rows).toBe(64);
    expect(slice.weight, "nothing admitted").toBe(0);
    expect(charged.sizingCalls, "four steps of 16 rows and the empty one at the end").toBe(5);
    expect(charged.sizingBytes).toBe(0);
    expect(charged.fillBytes).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM inbox_fill_deferred").get() as { n: number }).n).toBe(64);
    expect(sizingMs).toBeLessThan(50);
    console.log(`[slice-sizing] 64 x 2 MiB rows: slice ${sizingMs.toFixed(1)} ms, sizing steps=${charged.sizingCalls}`);
  });

  it("the budget counts each row's bytes plus 256: a row heavier than the budget is deferred, the rest are admitted while they fit", () => {
    const db = open();
    initializeMessageTables(db);
    bigRows(db, 100, 1_000);
    initializeInbox(db);
    expect(inboxProjectionSlice(db, { rows: 10_000, weight: 1 })).toMatchObject({ finished: false, rows: 1 });
    // rows of 1000 bytes weigh 1256: a 10 KiB budget admits a row only while the total stays within it (8 x 1256 = 10048 <= 10240 < 9 x 1256)
    const slice = inboxProjectionSlice(db, { rows: 10_000, weight: 10 * 1024 });
    expect(slice.rows).toBe(8);
    expect(slice.weight).toBe(8 * 1256);
    // a row cap still applies
    expect(inboxProjectionSlice(db, { rows: 3, weight: 1_000_000 }).rows).toBe(3);
  });
});
