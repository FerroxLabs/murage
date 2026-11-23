// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: memory V2 lane C (revoke engine). Privacy invariant P4 (MEMORY-V2-DESIGN section 2): a window is closed only when its walk is
// proven. V2 adds no site that deletes a pending row and never changes started_lsn of a job that has left 'seeding'.
// (a) + (b) are structural: every site is pinned by file and enclosing top-level declaration, so a new one fails here and has to be argued.
// (c) is the same rule at run time, on a real file with the real schema: TEMP triggers (no persisted object) record every pending-row
// delete with its job's state at that moment, and every started_lsn change, while real revokes drain to the end.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { closeWaitedPending, INLINE_REVOCATION, resetWaitedPendingAllowance, stopMemoryRevocation } from "./memory-revocation.ts";
import { revokeRecordDisclosures } from "./revocation.ts";
import { resetRevokeWriteBudget } from "./revoke-budget.ts";
import { activateBulkRevoke, commitRevoke, openBulkRevoke } from "./revoke-commit.ts";
import * as marker from "./revoke-marker.ts";
import { flipAll, SHARED, storm, THREADS } from "./testing/revoke-storm-fixture.ts";
import type { WritetimeFixture } from "./testing/writetime-fixture.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}
const FILES = sourceFiles(join(ROOT, "server")).map(path => ({ rel: relative(ROOT, path).split("\\").join("/"), lines: readFileSync(path, "utf8").split("\n") }));
const DECL = /^(?:export\s+)?(?:async\s+)?(?:function|class)\s+(\w+)|^(?:export\s+)?const\s+(\w+)/;
/** Every match of `pattern`, as "file#enclosing top-level declaration", one entry per match, sorted. */
function sites(pattern: RegExp, only?: (rel: string) => boolean): string[] {
  const out: string[] = [];
  for (const file of FILES) {
    if (only && !only(file.rel)) continue;
    let decl = "(top)";
    for (const line of file.lines) {
      const m = DECL.exec(line);
      if (m) decl = m[1] ?? m[2]!;
      const hits = line.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`));
      for (let i = 0; i < (hits?.length ?? 0); i++) out.push(`${file.rel}#${decl}`);
    }
  }
  return out.sort();
}
const M = "server/memory/", LEGACY = `${M}testing/legacy-lineage/revoke-marker-103.ts`;
const times = (site: string, n: number) => Array.from({ length: n }, () => site);

// ---- (a) the pending tables' delete sites. Base f6ae52c670 has exactly these; V2 adds none.
it("P4-a: DELETE FROM memory_deny_pending* is written only at the certified end of flow (and its 1.0.3 testing copy)", () => {
  expect(sites(/DELETE\s+FROM\s+["'`[]?memory_deny_pending/i)).toEqual([
    ...times(`${M}revoke-marker.ts#advance`, 2), // the '*' rows, behind the lineage certificate (wildcard narrowing)
    ...times(`${LEGACY}#advance`, 2), // the 1.0.3 marker kept for the upgrade tests: never loaded by the app
  ].sort());
});
// A templated delete names the table through a string literal, so every literal naming a pending table is pinned in every file that can
// delete at all (deny-read.ts names them too, and holds no DELETE: asserted below, so the readers' owner can move those freely).
const NAMES = /["'`]memory_deny_pending(?:_scope)?["'`]/;
const namingFiles = FILES.filter(f => f.lines.some(l => NAMES.test(l)));
const deleting = (rel: string) => FILES.find(f => f.rel === rel)!.lines.some(l => /\bDELETE\b/.test(l));
/** Memory V2 modules that name a pending table only to hang connection-local TEMP triggers on it (the wake bus, lane C's memo shim, the
 * V5 window summary). Their rule is stricter than a pinned list and is asserted on its own below: every DELETE they hold is on a TEMP
 * `mem_*` table, none is templated, and none names a `memory_*` table. */
const TEMP_ONLY = [`${M}revoke-wake.ts`, `${M}wake.ts`, `${M}window-summary.ts`];
const persistent = (rel: string) => deleting(rel) && !TEMP_ONLY.includes(rel);
it("P4-a: the TEMP-trigger modules delete only from their own TEMP tables, never from a memory_* table and never by a templated name", () => {
  for (const rel of TEMP_ONLY) {
    const text = FILES.find(f => f.rel === rel)!.lines.join("\n");
    const targets = [...text.matchAll(/DELETE\s+FROM\s+([^\s;`"']+)/gi)].map(m => m[1]!);
    expect(targets.filter(target => !/^(?:temp\.)?mem_[a-z_]+$/.test(target)), rel).toEqual([]);
    expect(/DELETE\s+FROM\s+["'`[]?(?:main\.)?memory_/i.test(text), rel).toBe(false);
  }
  // each of them does hold such a delete or a DELETE trigger event, which is why `deleting` lists it
  expect(TEMP_ONLY.filter(rel => !deleting(rel))).toEqual([]);
});
it("P4-a: the files that name a pending table and can delete are the marker, the fold, the waited close and the schema lists", () => {
  expect(namingFiles.map(f => f.rel).filter(deleting).sort()).toEqual([
    `${M}memory-revocation.ts`, `${M}revoke-fold.ts`, `${M}revoke-marker.ts`, `${M}schema.ts`, LEGACY, `${M}testing/schema-1.0.2.ts`,
    ...TEMP_ONLY,
  ].sort());
  expect(namingFiles.map(f => f.rel).filter(rel => !deleting(rel))).toEqual([`${M}deny-read.ts`]);
});
it("P4-a: a pending table is named only by tidy, undo's list, the fold's member list, closeWaitedPending and the writers' own insert", () => {
  expect(sites(NAMES, persistent)).toEqual([
    ...times(`${M}memory-revocation.ts#closeWaitedPending`, 6), // job in tidy with an empty frontier (READY_REVOKE), re-read in the writer
    ...times(`${M}revoke-fold.ts#MEMBER_TABLES`, 2), // a folded member's rows, after the fold bulk holds its window
    ...times(`${M}revoke-marker.ts#BY_REVOKE`, 2), // undo
    ...times(`${M}revoke-marker.ts#markPending`, 2), // INSERT only
    ...times(`${M}revoke-marker.ts#tidyStep`, 2), // tidy: every mark is written
    ...times(`${M}schema.ts#WRITETIME_TABLES`, 2), // the table list (a downgrade drops the tables, it deletes no row of a kept one)
    ...times(`${LEGACY}#BY_REVOKE`, 2), ...times(`${LEGACY}#markPending`, 2), ...times(`${LEGACY}#tidyStep`, 2),
    ...times(`${M}testing/schema-1.0.2.ts#WRITETIME_TABLES`, 2),
  ].sort());
});
it("P4-a: the templated deletes of those files, and the callers of the paged delete, are the base ones", () => {
  expect(sites(/DELETE\s+FROM\s+\$\{/i, rel => namingFiles.some(f => f.rel === rel) && deleting(rel))).toEqual([
    `${M}memory-revocation.ts#closeWaitedPending`,
    `${M}revoke-fold.ts#deleteMemberPage`, `${M}revoke-fold.ts#moveMember`,
    `${M}revoke-marker.ts#deleteOwn`, `${M}revoke-marker.ts#deletePage`,
    ...times(`${M}schema.ts#OWNER_TAIL_SCHEMA`, 2), ...times(`${M}schema.ts#RECORD_KEYS_SCHEMA`, 2), // triggers on other tables
    `${LEGACY}#deleteOwn`, `${LEGACY}#deletePage`,
    ...times(`${M}testing/schema-1.0.2.ts#OWNER_TAIL_SCHEMA`, 2),
  ].sort());
  expect(sites(/\bdeletePage\(/, rel => rel === `${M}revoke-marker.ts`)).toEqual([`${M}revoke-marker.ts#deletePage`, ...times(`${M}revoke-marker.ts#tidyStep`, 2), `${M}revoke-marker.ts#undoStep`].sort());
  expect(sites(/\bdeleteMemberPage\(/, rel => rel === `${M}revoke-fold.ts`)).toEqual([`${M}revoke-fold.ts#deleteMemberPage`, ...times(`${M}revoke-fold.ts#runFold`, 2)].sort());
  expect(sites(/\bMEMBER_TABLES\b/, rel => rel === `${M}revoke-fold.ts`)).toEqual([`${M}revoke-fold.ts#MEMBER_TABLES`, `${M}revoke-fold.ts#moveMember`, ...times(`${M}revoke-fold.ts#runFold`, 2)].sort());
  expect(sites(/\bBY_REVOKE\b/, rel => rel === `${M}revoke-marker.ts`)).toEqual([`${M}revoke-marker.ts#BY_REVOKE`, `${M}revoke-marker.ts#undoStep`].sort());
});

// ---- (b) a job's cap. Base f6ae52c670 has exactly these three writers of started_lsn on an existing job row.
const body = (rel: string, name: string): string => {
  const lines = FILES.find(f => f.rel === rel)!.lines;
  const from = lines.findIndex(l => new RegExp(`^(?:export\\s+)?function\\s+${name}\\(`).test(l));
  const to = lines.findIndex((l, i) => i > from && l === "}");
  return from < 0 ? "" : lines.slice(from, to + 1).join("\n");
};
it("P4-b: started_lsn of an existing job is written only by activateBulkRevoke (seeding), the fold's own opening and the upgrade", () => {
  expect(sites(/UPDATE\s+memory_revoke_jobs\s+SET[^"`;]*\bstarted_lsn\s*=/i)).toEqual([
    `${M}revoke-commit.ts#activateBulkRevoke`, // 'seeding' -> 'active', once, in the transaction that ends the seeding
    `${M}revoke-fold.ts#openFold`, // the fold bulk it has just opened ('seeding'), same transaction
    `${M}schema.ts#activateRevokesAtUpgrade`, // a file back from an older build: every active cap moves UP to a fresh slot (withholds more)
  ].sort());
  // a row replaced wholesale would change the cap too: only the test fixture does that
  expect(sites(/REPLACE\s+INTO\s+memory_revoke_jobs|INSERT\s+INTO\s+memory_revoke_jobs[^"`]*ON\s+CONFLICT/i)).toEqual([`${M}testing/writetime-fixture.ts#WritetimeFixture`]);
  // activateBulkRevoke changes the cap only behind its own read of state='seeding'
  const activate = body(`${M}revoke-commit.ts`, "activateBulkRevoke");
  const guard = activate.indexOf("AND state='seeding'\").get(revokeId))"), update = activate.indexOf("UPDATE memory_revoke_jobs SET state='active',started_lsn=?");
  expect(guard).toBeGreaterThan(0);
  expect(update).toBeGreaterThan(guard);
  expect(activate.slice(guard, update)).not.toContain(";"); // the UPDATE is the guarded statement itself
  // openFold writes the cap of the bulk it opened in this call, before anything else can run
  const fold = body(`${M}revoke-fold.ts`, "openFold");
  expect(fold.indexOf("const B = openBulkRevoke(")).toBeGreaterThan(0);
  expect(fold.indexOf("started_lsn=?")).toBeGreaterThan(fold.indexOf("const B = openBulkRevoke("));
});

// ---- (c) at run time
type Gone = { table: string; revoke: number; key: string; phase: string | null; state: string | null; frontier: number; cert: number };
type Cap = { revoke: number; was: string; now: string; old: number; new: number };
const inline = { ...INLINE_REVOCATION };
let f: WritetimeFixture | null = null;
afterEach(() => { vi.restoreAllMocks(); stopMemoryRevocation(); marker.setScopeFlowEdgesRecorded(false); f?.close(); f = null; Object.assign(INLINE_REVOCATION, inline); resetRevokeWriteBudget(); resetWaitedPendingAllowance(); });

function watch(fx: WritetimeFixture): void {
  fx.db.exec(`CREATE TEMP TABLE p4_gone(tbl TEXT, revoke INTEGER, key TEXT, phase TEXT, state TEXT, frontier INTEGER, cert INTEGER);
    CREATE TEMP TABLE p4_cap(revoke INTEGER, was TEXT, now TEXT, old INTEGER, new INTEGER);`);
  for (const [table, column] of [["memory_deny_pending", "thread_id"], ["memory_deny_pending_scope", "scope_id"]] as const) fx.db.exec(`
    CREATE TEMP TRIGGER p4_gone_${table} BEFORE DELETE ON main.${table} BEGIN
      INSERT INTO p4_gone VALUES('${table}', OLD.revoke_id, OLD.${column},
        (SELECT phase FROM memory_revoke_jobs WHERE revoke_id=OLD.revoke_id), (SELECT state FROM memory_revoke_jobs WHERE revoke_id=OLD.revoke_id),
        (SELECT count(*) FROM memory_revoke_frontier WHERE revoke_id=OLD.revoke_id), (SELECT ready FROM memory_lineage_cert WHERE id=1));
    END;`);
  fx.db.exec(`CREATE TEMP TRIGGER p4_cap_move BEFORE UPDATE ON main.memory_revoke_jobs WHEN NEW.started_lsn IS NOT OLD.started_lsn OR NEW.revoke_id IS NOT OLD.revoke_id BEGIN
      INSERT INTO p4_cap VALUES(OLD.revoke_id, OLD.state, NEW.state, OLD.started_lsn, NEW.started_lsn);
    END;`);
}
const pendingRows = (fx: WritetimeFixture) => Number(fx.db.prepare("SELECT (SELECT count(*) FROM memory_deny_pending)+(SELECT count(*) FROM memory_deny_pending_scope) AS n").get()!.n);
/** The proof a delete went through: tidy (every mark written: nothing left on the frontier), or the '*' row at the end of a certified flow.
 * `after`: the job row when the transaction ended (absent: finished and pruned). */
function proof(row: Gone, after: { phase: string; state: string } | undefined): "tidy" | "flow-wildcard" | null {
  // tidy: the marker enters tidy in memory and saves the phase at the end of its slice, so the row still reads 'mark' at the delete; the
  // transaction must leave the job in tidy, done or pruned, and nothing may be left on its frontier at the delete
  if (row.state === "active" && (row.phase === "tidy" || row.phase === "mark") && row.frontier === 0 && (!after || after.state === "done" || (after.state === "active" && after.phase === "tidy"))) return "tidy";
  if (row.state === "active" && row.phase === "flow" && row.key === "*" && row.cert === 1) return "flow-wildcard";
  return null;
}
/** Real revokes of every write-time shape, then a full drain in small slices, each in its own transaction as the runner commits them.
 * Returns what the triggers saw. Every transaction is checked on its own: a drop of the pending count equals the proven deletes in it. */
function drainWatched(cert: boolean): { gone: Array<Gone & { proof: string | null }>; caps: Cap[]; left: number; jobsSeen: number; waited: number } {
  const fx = f = storm(8);
  fx.cert(cert);
  watch(fx);
  marker.setScopeFlowEdgesRecorded(true); // as the app sets it once the flow triggers are in place (the '*' rows may then go at the end of a certified flow)
  INLINE_REVOCATION.ms = 0; // nothing walks inside the commits: the drain below does all of it, slice by slice
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const tx = <T>(run: () => T): T => { fx.db.exec("BEGIN IMMEDIATE"); try { const out = run(); fx.db.exec("COMMIT"); return out; } catch (error) { fx.db.exec("ROLLBACK"); throw error; } };
  const gone: Array<Gone & { proof: string | null }> = [], caps: Cap[] = [];
  const left = new Map<number, number>(); // the cap of every job seen out of 'seeding', as first seen
  let waited = 0;
  const check = (label: string, before: number) => {
    const rows = fx.db.prepare("SELECT tbl AS \"table\",revoke,key,phase,state,frontier,cert FROM p4_gone").all() as unknown as Gone[];
    fx.db.exec("DELETE FROM p4_gone");
    // (c2) the pending count drops only by deletes the triggers saw, and each of those carries its proof
    expect(before - pendingRows(fx), `${label}: pending rows dropped without a recorded delete`).toBeLessThanOrEqual(rows.length);
    for (const row of rows) { const p = proof(row, fx.db.prepare("SELECT phase,state FROM memory_revoke_jobs WHERE revoke_id=?").get(row.revoke) as { phase: string; state: string } | undefined); gone.push({ ...row, proof: p }); expect(p, `${label}: unproven delete ${JSON.stringify(row)}`).not.toBeNull(); }
    // (c1) a cap moves only as the job leaves 'seeding', and never again
    const moved = fx.db.prepare("SELECT revoke,was,now,old,new FROM p4_cap").all() as unknown as Cap[];
    fx.db.exec("DELETE FROM p4_cap");
    for (const row of moved) { caps.push(row); expect(row.was, `${label}: started_lsn moved on a job that left seeding ${JSON.stringify(row)}`).toBe("seeding"); }
    for (const job of fx.db.prepare("SELECT revoke_id AS r,started_lsn AS s FROM memory_revoke_jobs WHERE state!='seeding'").all() as Array<{ r: number; s: number }>) {
      if (!left.has(job.r)) left.set(job.r, job.s);
      expect(job.s, `${label}: job ${job.r} cap changed after it left seeding`).toBe(left.get(job.r));
    }
  };
  const step = (label: string, run: () => unknown) => { const before = pendingRows(fx); run(); check(label, before); };
  // the roots: an owner forget of a line, a soft revise of a record through the real writer, every receipt flipped (the marker drains the
  // flips into a bulk it opens, fills and activates in one transaction), and a bulk left 'seeding' over several commits
  step("line", () => tx(() => commitRevoke(fx.db, { kind: "line", threadId: THREADS[0]!, messageIds: ["r0"], cause: "forget" })));
  step("revise", () => tx(() => revokeRecordDisclosures(fx.db, "revise", { recordIds: [SHARED.id] })));
  step("flip", () => tx(() => flipAll(fx)));
  let bulk = 0;
  step("bulk-open", () => tx(() => { bulk = openBulkRevoke(fx.db, "seed", false); commitRevoke(fx.db, { kind: "line", threadId: THREADS[1]!, messageIds: ["r1"], cause: "hide" }, { into: bulk }); }));
  expect(bulk).toBeGreaterThan(0);
  for (let i = 0; i < 6; i++) step(`slice-seeding-${i}`, () => tx(() => marker.markerSlice(fx.db, 8)));
  step("bulk-fill", () => tx(() => commitRevoke(fx.db, { kind: "line", threadId: THREADS[2]!, messageIds: ["r2"], cause: "hide" }, { into: bulk })));
  step("bulk-activate", () => tx(() => activateBulkRevoke(fx.db, bulk)));
  step("activate-again", () => tx(() => activateBulkRevoke(fx.db, bulk))); // a second activation never moves the cap again
  for (let i = 0; i < 20_000 && marker.markerWorkPending(fx.db); i++) {
    step(`slice-${i}`, () => tx(() => marker.markerSlice(fx.db, 8)));
    // the waiter's close between two runner commits (fence-pending.ts): its own transaction, the third proof site
    step(`waited-${i}`, () => { if (closeWaitedPending(fx.db, THREADS, ["s-room", "s-bot", "s-other", "s-project"])) waited++; });
  }
  expect(marker.markerWorkPending(fx.db)).toBe(false);
  return { gone, caps, left: pendingRows(fx), jobsSeen: left.size, waited };
}

for (const cert of [true, false]) it(`P4-c: a full drain (lineage certificate ${cert ? "ready" : "not ready"}) deletes a pending row only with its proof and never moves a cap after seeding`, () => {
  const seen = drainWatched(cert);
  const by = (p: string) => seen.gone.filter(g => g.proof === p).length;
  console.log(`MEMV2C P4-c cert=${cert}: pending deletes=${seen.gone.length} (tidy=${by("tidy")} flow-wildcard=${by("flow-wildcard")}) cap moves=${seen.caps.length} jobs seen out of seeding=${seen.jobsSeen} waited closes=${seen.waited} pending left=${seen.left}`);
  // the run really exercised the sites (not vacuous)
  expect(seen.left).toBe(0);
  expect(by("tidy")).toBeGreaterThan(0);
  if (cert) expect(by("flow-wildcard")).toBeGreaterThan(0);
  else expect(by("flow-wildcard")).toBe(0); // no certificate: the '*' rows stay to tidy
  expect(seen.jobsSeen).toBeGreaterThanOrEqual(4);
  expect(seen.caps.length).toBeGreaterThanOrEqual(2); // the flip drain's bulk and the seeded bulk, each once
  expect(new Set(seen.caps.map(c => c.revoke)).size).toBe(seen.caps.length);
  for (const cap of seen.caps) expect(cap.new).toBeGreaterThan(cap.old); // a cap only moves up
});
