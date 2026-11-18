import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryIndex, MEMW_OPEN_RESERVE } from "./index.ts";
import { openTestIndex, closeSealed } from "./testing/open-index.ts";

async function fixture(run: (index: MemoryIndex) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "wp2a-accessors-"));
  const index = await openTestIndex(join(dir, "index.db"));
  try { await run(index); }
  finally { vi.restoreAllMocks(); try { await closeSealed(index); } catch (error) { index.close(); throw error; } finally { rmSync(dir, { recursive: true, force: true }); } }
}
it("writerStopped reflects both writer states and stopped maintenance does no work", async () => fixture(async index => {
  const internals = index as unknown as { writer: { stopped: boolean }; db: DatabaseSync };
  const writer = internals.writer;
  expect(index.writerStopped()).toBe(false);
  // Replace only the writer seam: the accessor and maintenance implementation stay real.
  internals.writer = { stopped: true };
  const sql = vi.spyOn(internals.db, "prepare");
  try {
    expect(index.writerStopped()).toBe(true);
    expect(await index.maintenanceStep()).toEqual({ ran: null });
    expect(sql).not.toHaveBeenCalled();
  } finally { internals.writer = writer; sql.mockRestore(); }
}));
it("writerCheckOwed reflects the writer and maintenance checks before any write", async () => fixture(async index => {
  const internals = index as unknown as { writer: { stopped: boolean; checkOwed(): boolean; check(): Promise<void> } };
  const writer = internals.writer;
  let owed = true;
  const check = vi.fn(async () => { owed = false; });
  expect(index.writerCheckOwed()).toBe(false);
  internals.writer = { stopped: false, checkOwed: () => owed, check };
  try {
    expect(index.writerCheckOwed()).toBe(true);
    expect(await index.maintenanceStep()).toEqual({ ran: null });
    expect(check).toHaveBeenCalledTimes(1); expect(index.writerCheckOwed()).toBe(false);
  } finally { internals.writer = writer; }
}));
it("resetDone reads durable reset completion and rejects malformed metadata", async () => fixture(async index => {
  expect(index.resetDone()).toBeNull();
  // A checked write of the open kind stands in for the open txn of a start that carries R (r3.2.8 3.2).
  const writer = (index as unknown as { writer: { admit(k: string, b: number): boolean; write(k: string, b: number, f: (m: (k: string, v: string) => void) => void): unknown } }).writer;
  expect(writer.admit("open", MEMW_OPEN_RESERVE)).toBe(true);
  writer.write("open", MEMW_OPEN_RESERVE, meta => meta("reset_done", "37"));
  await index.maintenanceStep();
  expect(index.resetDone()).toBe(37);
  const db = (index as unknown as { db: DatabaseSync }).db;
  // A read seam exercises damaged metadata without making an unchecked write.
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
    if (sql === "SELECT value FROM index_meta WHERE key=?") return { get: () => ({ value: "37bad" }) } as unknown as ReturnType<DatabaseSync["prepare"]>;
    return prepare(sql);
  });
  expect(index.resetDone()).toBeNull();
}));
it("stopInfo carries the core file identity sequence kind and reason", async () => fixture(async index => {
  const internals = index as unknown as { core: unknown };
  const core = internals.core;
  expect(index.stopInfo()).toBeNull();
  internals.core = { fileId: 123n, stopInfo: () => ({ seq: 7, kind: "merge", reason: "segment_limit:lexical" }) };
  try { expect(index.stopInfo()).toEqual({ fileId: "123", seq: 7, kind: "merge", reason: "segment_limit:lexical" }); }
  finally { internals.core = core; }
}));
