import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { MemoryIndex, type IndexedMemory } from "./index.ts";
import { openIndexWal, IndexWalWriter, MEMW_W_STEP_BYTES } from "./index-wal.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0).reverse()) f(); });
function path(): string {
  const root = mkdtempSync(join(tmpdir(), "memw-bounds-"));
  cleanup.push(() => removeTempDirSync(root));
  return join(root, "memory-index.db");
}
function open(file: string) {
  const result = openIndexWal(file, { charge: async () => true });
  cleanup.push(() => (result.wal as IndexWalWriter).closeForQuarantine());
  return result;
}

it.each(["PRAGMA page_size=1024", "PRAGMA auto_vacuum=INCREMENTAL"])("rejects geometry outside the WAL proof: %s", pragma => {
  const file = path(), db = new DatabaseSync(file);
  db.exec(`${pragma}; PRAGMA journal_mode=WAL; CREATE TABLE index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID`);
  db.close();
  const result = open(file);
  expect(result.rebuilt, "geometry outside the bounded-write proof accepted").toBe(true);
});

it.each(["x".repeat(901), "é".repeat(500)])("rejects oversized index metadata without committing", async value => {
  const result = open(path());
  await result.wal.openCheck();
  result.wal.write("fill", MEMW_W_STEP_BYTES, put => put("entries_live", "0"));
  await result.wal.check();
  expect(() => result.wal.write("fill", MEMW_W_STEP_BYTES, put => put("entries_live", value)), "oversize metadata write accepted").toThrow(/MEMW_META_VALUE/);
  expect(result.writable.prepare("SELECT value FROM index_meta WHERE key='entries_live'").get()?.value).toBe("0");
});

it("defers an oversize posting set instead of writing every term in the foreground unit", async () => {
  const file = path();
  // This adapter exercises the public writer on both the pre-port and checked-writer trees.
  type CompatibleIndex = MemoryIndex & { upsert?: (rows: IndexedMemory[]) => void; applyBatch?: (rows: IndexedMemory[]) => Promise<{status:string}> };
  const ctor = MemoryIndex as unknown as { new(path:string): CompatibleIndex; create?: (path:string, opts:{charge:()=>Promise<boolean>})=>Promise<CompatibleIndex> };
  const index = ctor.create ? await ctor.create(file, { charge: async () => true }) : new ctor(file);
  cleanup.push(() => index.close());
  const rows = [{ id:"large", version:1, scopeId:"s", text:Array.from({length:300},(_,i)=>`word${i}`).join(" "), deleted:false }];
  if (index.applyBatch) expect((await index.applyBatch(rows)).status).toBe("done");
  else index.upsert!(rows);
  const db = new DatabaseSync(file, { readOnly:true });
  try {
    expect(Number(db.prepare("SELECT count(*) AS n FROM postings").get()?.n), "oversize posting write accepted inline").toBe(0);
    expect(Number(db.prepare("SELECT count(*) AS n FROM posting_todo").get()?.n)).toBe(1);
  } finally { db.close(); }
});

it("rejects an unknown metadata key through a writer consumer, not only the WAL envelope", async () => {
  const index=await MemoryIndex.create(path(),{charge:async()=>true});
  cleanup.push(()=>index.close());
  const consumer=index as unknown as {writer:IndexWalWriter;bumpMeta(key:string,delta:number):void};
  expect(()=>consumer.writer.write("fill",MEMW_W_STEP_BYTES,()=>consumer.bumpMeta("unregistered_metadata",1)),"unregistered metadata write accepted by consumer").toThrow(/MEMW_META_KEY/);
});

// A slow-call budget must shrink reads as well as writes. Eagerly collecting the
// remaining text before StepSizer.take makes each small step depend on history.
for (const phase of ["fill", "validate"] as const) {
  it.each([20_000, 200_000])(`${phase} reads only its selected prefix and one crossing row at %s records`, async n => {
    const { dirname } = await import("node:path");
    const { vi } = await import("vitest");
    const { buildFixture } = await import("./testing/age-staged-harness.ts");
    const { ageStep, LEXICAL_AGE_SCHEMA, AGE_STAGE_SCHEMA } = await import("./age-index.ts");
    const { StepSizer } = await import("./memw-steps.ts");
    const file = path(), fx = buildFixture(dirname(file), n, { mix: "one-word", completePostings: false });
    const setup = new DatabaseSync(file);
    setup.exec(LEXICAL_AGE_SCHEMA + AGE_STAGE_SCHEMA);
    const meta = setup.prepare("INSERT OR REPLACE INTO index_meta VALUES(?,?)");
    for (const [key, value] of Object.entries({ age_phase: phase, age_sum_done: "1", age_text_left: String(n * 5), age_rows_left: String(n), age_id_left: String(n * 15), age_vb_cursor: "0", age_vb_pass: "1", age_unkeyed: "0" })) meta.run(key, value);
    setup.exec("PRAGMA wal_checkpoint(TRUNCATE)"); setup.close();
    const opened = open(file), db = opened.writable, writer = opened.wal;
    expect((await writer.openCheck()).state).toBe("writable");
    const authority = new DatabaseSync(fx.authPath, { readOnly: true });
    cleanup.push(() => authority.close());
    const sizer = new StepSizer(writer.pageSize);
    vi.spyOn(sizer, "budget").mockReturnValue(256); // a valid adaptive small-step budget
    const seen = { text: 0, keys: 0 };
    const observe = (connection: DatabaseSync, key: keyof typeof seen, matches: (sql: string) => boolean) => {
      const prepare = connection.prepare.bind(connection);
      vi.spyOn(connection, "prepare").mockImplementation(sql => {
        const statement = prepare(sql);
        if (!matches(sql)) return statement;
        const get = statement.get.bind(statement), all = statement.all.bind(statement), iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, "get").mockImplementation((...args) => { const row = get(...args); if (row) seen[key]++; return row; });
        vi.spyOn(statement, "all").mockImplementation((...args) => { const rows = all(...args); seen[key] += rows.length; return rows; });
        vi.spyOn(statement, "iterate").mockImplementation(function* (...args): ReturnType<typeof statement.iterate> { for (const row of iterate(...args)) { seen[key]++; yield row; } return undefined; });
        return statement;
      });
    };
    observe(db, "text", sql => sql.startsWith("SELECT rowid AS r,scope_id AS s,text FROM entries") || sql.startsWith("SELECT e.rowid AS r,e.id,e.version,e.scope_id AS s,e.text FROM entries"));
    observe(authority, "keys", sql => sql.startsWith("SELECT record_id AS id,record_version AS version,age_key AS k FROM memory_record_keys"));
    try {
      for (let turn = 0; turn < 2; turn++) {
        seen.text = 0; seen.keys = 0;
        const result = ageStep({ db, writer, authority, sizer });
        await writer.check();
        expect(result.walked).toBeGreaterThan(0);
        expect(result.walked).toBeLessThanOrEqual(4);
        expect(seen.text, "age step loaded history outside its bounded prefix").toBeLessThanOrEqual(result.walked + 1);
        expect(seen.keys, "age step materialized history outside its bounded prefix").toBeLessThanOrEqual(result.walked + 1);
        expect(result.copied).toBe(result.walked);
      }
    } finally { vi.restoreAllMocks(); }
  }, 120_000);
}
