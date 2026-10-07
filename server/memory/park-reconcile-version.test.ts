// The park reconciliation repairs a downgrade, and a downgrade followed by an upgrade changes the running
// version: a launch whose version equals the one recorded at the end of the last finished pass runs no pass,
// a changed version runs one, and a pass that was interrupted resumes from its recorded cursor.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import * as park from "./park.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";

const fix = park as unknown as Record<string, any>;
const saved = process.env.MURAGE_APP_VERSION;
beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster({ bots: [], groups: [] }); setMemoryMode("capture"); park.resetParkSweep(); fix.resetParkReconcile(); process.env.MURAGE_APP_VERSION = "1.0.0";
});
afterEach(() => { if (saved === undefined) delete process.env.MURAGE_APP_VERSION; else process.env.MURAGE_APP_VERSION = saved; closeDatabase(); });

function cancelled(n: number) {
  const db = database();
  db.exec("BEGIN");
  db.prepare("INSERT INTO memory_scopes VALUES('s','conversation','o','[]',0)").run();
  db.prepare("INSERT INTO memory_sources VALUES('big','s','t','m',NULL,1,'h','text','owner','recorded',NULL,'active')").run();
  db.prepare("INSERT INTO memory_source_versions VALUES('big',1,'h',?,1)").run(JSON.stringify({ text: "x" }));
  const insert = db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,policy_revision,deletion_epoch) VALUES(?,'big',1,'capture',?,'cancelled',0,0,0)");
  for (let i = 0; i < n; i++) insert.run(`c-${i}`, `v${i}`);
  db.exec("COMMIT");
  return db;
}
const runPass = (db: ReturnType<typeof database>) => { let steps = 0; while (!fix.parkReconcileFinished() && steps < 50) { fix.parkReconcileStep(db); steps++; } return steps; };
/** Statements that walk the cancelled index. */
function walks(db: ReturnType<typeof database>, run: () => void) {
  const real = db.prepare.bind(db); let count = 0;
  (db as any).prepare = (sql: string) => { if (sql.includes("INDEXED BY memory_jobs_pending")) count++; return real(sql); };
  try { run(); } finally { (db as any).prepare = real; }
  return count;
}

it("the same version after a finished pass runs no pass; a changed version runs one", () => {
  const db = cancelled(700);
  expect(walks(db, () => runPass(db))).toBeGreaterThan(0);
  fix.resetParkReconcile();  // the next launch, same version
  expect(walks(db, () => { runPass(db); })).toBe(0);
  expect(fix.parkReconcileFinished()).toBe(true);
  process.env.MURAGE_APP_VERSION = "1.0.1";
  fix.resetParkReconcile();
  expect(walks(db, () => { runPass(db); })).toBeGreaterThan(0);
  fix.resetParkReconcile();
  expect(walks(db, () => { runPass(db); })).toBe(0);
});

it("an interrupted pass resumes from its recorded cursor instead of starting over", () => {
  const db = cancelled(1300);
  fix.parkReconcileStep(db);  // one window of 500, then the launch ends
  expect(fix.parkReconcileFinished()).toBe(false);
  fix.resetParkReconcile();
  const rowsAfter = () => JSON.parse(String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id='memory-parked-reconcile'").get()!.intent));
  expect(rowsAfter().done).toBe(false);
  const marker = rowsAfter();
  fix.parkReconcileStep(db);
  // the second launch's first step continued past the first window
  expect(BigInt(rowsAfter().r)).toBeGreaterThan(BigInt(marker.r));
  runPass(db);
  expect(rowsAfter().done).toBe(true);
});
