// G0-W: a refused turn's note goes through R.write: one row, the latch sets only at the commit, a rolled-back write is retried.
import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FencedRefusal, latchAfterCommit, writeHandbackRefusalNote, writeRefusalNote } from "./drivers/engine-input.ts";
import { persistLedgerRefusal } from "./ledger-persistence.ts";
import { afterCommit, scopedTx } from "./tx-scope.ts";

const refusal = () => new FencedRefusal({ engine: "fixture", threadId: "thread-w" }, "lease.ledger", "turn");
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const store = () => { const rows: string[] = []; return { rows, work: () => { afterCommit(() => { rows.push("refusal-note"); }); } }; };

it("REC-RETRY: a rolled-back note write does not latch R.written; the retry lands the row once", async () => {
  const R = refusal(); const { rows, work } = store();
  expect(() => scopedTx(() => { writeRefusalNote(R, work); throw new Error("busy"); })).toThrow("busy");
  await tick();
  expect(rows).toEqual([]); expect(R.written).toBe(false);
  scopedTx(() => writeRefusalNote(R, work)); await tick();
  expect(rows).toEqual(["refusal-note"]); expect(R.written).toBe(true);
});

it("REC-HANDBACK: two sites telling the same refusal land one row (the second sees the latch, or the write in flight)", async () => {
  const R = refusal(); const { rows, work } = store();
  scopedTx(() => { writeRefusalNote(R, work); writeRefusalNote(R, work); }); await tick();
  writeRefusalNote(R, work); await tick();
  expect(rows).toEqual(["refusal-note"]);
});

it("latchAfterCommit: a flag set inside a transaction is set at the commit, never by a rollback", () => {
  let flag = false;
  expect(() => scopedTx(() => { latchAfterCommit(() => { flag = true; }); expect(flag).toBe(false); throw new Error("rollback"); })).toThrow();
  expect(flag).toBe(false);
  scopedTx(() => { latchAfterCommit(() => { flag = true; }); expect(flag).toBe(false); });
  expect(flag).toBe(true);
});

it("no refusal for the turn: the plain call runs the work", () => {
  const { rows, work } = store();
  writeRefusalNote(undefined, work);
  expect(rows).toEqual(["refusal-note"]);
});

// W2 (late handback) under a busy database. Schedule, gate-forced: a second connection holds the write lock (BEGIN IMMEDIATE) from before the
// handback note's first attempt until the test releases it; the generic fallback (the R.teardown row) fires while the note is still waiting.
it("REC-HANDBACK-BUSY: a busy database at the handback note delays the owner's row and never loses it (one row, cause kept until the commit)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "g0w-busy-"));
  const server = new DatabaseSync(join(dir, "notes.db")), holder = new DatabaseSync(join(dir, "notes.db"));
  try {
    server.exec("PRAGMA journal_mode=WAL; CREATE TABLE notes(text TEXT)");
    const rows = () => (holder.prepare("SELECT text FROM notes").all() as { text: string }[]).map(r => r.text);
    const insert = (text: string) => () => { server.exec("BEGIN IMMEDIATE"); try { server.prepare("INSERT INTO notes(text) VALUES (?)").run(text); server.exec("COMMIT"); } catch (error) { server.exec("ROLLBACK"); throw error; } };
    const R = refusal(); const settled: boolean[] = [];
    holder.exec("BEGIN IMMEDIATE");
    const told = writeHandbackRefusalNote(R, work => persistLedgerRefusal(server, work), insert("handback-note"), written => { settled.push(written); });
    // the fallback of a refusal whose handback is still writing joins that write: it never adds the generic row
    writeRefusalNote(R, insert("generic-row"));
    await new Promise(resolve => setTimeout(resolve, 250));
    // still busy: nothing written, nothing latched, and the cause is NOT released (settled has not run)
    expect(R.written).toBe(false); expect(settled).toEqual([]);
    holder.exec("ROLLBACK");
    await told;
    expect(rows()).toEqual(["handback-note"]);
    expect(settled).toEqual([true]); expect(R.written).toBe(true);
    await R.writeDone;
    writeRefusalNote(R, insert("generic-row")); await tick();
    expect(rows()).toEqual(["handback-note"]);
  } finally { try { holder.close(); } catch { /* closed */ } try { server.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); }
});

it("REC-HANDBACK-BUSY: a handback note that fails for good reports it and keeps the cause (no silent loss); no refusal record still retries busy", async () => {
  const settled: boolean[] = [];
  await writeHandbackRefusalNote(refusal(), () => Promise.reject(new Error("LEDGER_PERSISTENCE_DATABASE_CLOSED")), () => {}, written => { settled.push(written); });
  expect(settled).toEqual([false]);
  let attempts = 0; const rows: string[] = [];
  const busyOnce = (work: () => void) => new Promise<void>(resolve => { attempts++; setTimeout(() => { attempts++; work(); resolve(); }, 5); });
  await writeHandbackRefusalNote(undefined, busyOnce, () => { rows.push("refusal-note"); }, written => { settled.push(written); });
  expect(rows).toEqual(["refusal-note"]); expect(attempts).toBe(2); expect(settled).toEqual([false, true]);
});

it("W2 wiring: the handback site tells its note through writeHandbackRefusalNote with the persisted sink, and clears the cause only in its commit callback", () => {
  const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
  const at = source.indexOf("if (ledgerRefusalAwaitingHandback.has(dispatchClaimId)) {");
  expect(at).toBeGreaterThan(0);
  const whole = source.slice(at, source.indexOf("noteRefusedLeaseTerminal(ledgerLease);", at));
  // MA-REBUILD Q2: a released attempt's note is deferred to the engine's teardown (tellDeferredRefusal); every other note is the W2 write
  expect(whole).toContain("deferredRefusalNotes.set(accepted.turnId, refusalNote);");
  const site = whole.slice(whole.indexOf("} else {"));
  expect(site).toContain("writeHandbackRefusalNote(fencedRefusalRegistry.byTurn(noteTurnId), work => persistLedgerRefusal(noteDb, work");
  expect(site).not.toMatch(/\bwriteRefusalNote\(/);
  expect(site).not.toContain("finally { refusalNote.clearCause()");
  expect(site.indexOf("refusalNote.clearCause()")).toBeGreaterThan(site.indexOf("if (!written) return;"));
});
