// SPDX-License-Identifier: AGPL-3.0-or-later
// sweep-1021 B2: a "not now" refusal of the one-time admission-epoch install (BG_DEFERRED, lock wait) was kept for the connection for good,
// so every reflection read compared as moved until restart. It is retried; any other error keeps the fail-closed answer.
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { BgDeferred } from "../bg-admission.ts";
import { ioBudget } from "../io-budget.ts";
import { closeDatabase, database } from "../database.ts";
import { freshDataDir } from "./testing/recall-fixture.ts";
import { ADMISSION_EPOCH_RETRY_FLOOR_MS, ensureAdmissionEpochs } from "./pip-admission.ts";

afterEach(() => { vi.restoreAllMocks(); closeDatabase(); });
/** The real memory schema on a fresh data dir: the shared connection starts with no epoch install (the first look makes it). */
const fixtureDb = () => { freshDataDir("active"); return database(); };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function failFirst(error: (() => Error) | null): { attempts: () => number; sources: Array<string | undefined> } {
  const exec = DatabaseSync.prototype.exec;
  let attempts = 0;
  const sources: Array<string | undefined> = [];
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
    if (sql.includes("CREATE TEMP TABLE IF NOT EXISTS memory_admission_epoch")) { attempts++; sources.push(ioBudget.currentSource()); if (attempts === 1 && error) throw error(); }
    return exec.call(this, sql);
  });
  return { attempts: () => attempts, sources };
}

it("a deferred install is refused now, not remembered: a later look installs the epochs", async () => {
  const gate = failFirst(() => new BgDeferred(1));
  const db = fixtureDb();
  expect(ensureAdmissionEpochs(db)).toBe(false);
  // inside the retry floor the refused install is not hammered
  expect(ensureAdmissionEpochs(db)).toBe(false);
  expect(gate.attempts()).toBe(1);
  await pause(ADMISSION_EPOCH_RETRY_FLOOR_MS + 50);
  expect(ensureAdmissionEpochs(db)).toBe(true);
  expect(db.prepare("SELECT 1 FROM temp.sqlite_master WHERE name='memory_admission_epoch'").get()).toBeTruthy();
  expect(ensureAdmissionEpochs(db)).toBe(true);
  expect(gate.attempts()).toBe(2);
});

it("the install runs outside every memory source, even when the first read is inside one", () => {
  const gate = failFirst(null);
  const db = fixtureDb();
  expect(ioBudget.withSource("memory-capture", () => ensureAdmissionEpochs(db))).toBe(true);
  expect(gate.sources.length).toBeGreaterThan(0);
  expect(gate.sources.filter(source => source?.startsWith("memory-"))).toEqual([]);
});

it("an error that is not a deferral keeps the fail-closed answer with no retry", async () => {
  const gate = failFirst(() => new Error("fixture broken schema"));
  const db = fixtureDb();
  expect(ensureAdmissionEpochs(db)).toBe(false);
  await pause(ADMISSION_EPOCH_RETRY_FLOOR_MS + 50);
  expect(ensureAdmissionEpochs(db)).toBe(false);
  expect(gate.attempts()).toBe(1);
});
