// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// rc4: a revocation job an earlier RC persisted (phase "supersede", removed since) completes instead of throwing forever, and a job with a phase no
// build here knows is parked as failed (needs attention) so it never blocks the jobs behind it.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { setMemoryMode } from "./repository.ts";
import { ensureScope } from "./policy.ts";
import { createRevocationJob, revocationWorkPending, runRevocationJobsNow, type RevocationJob } from "./memory-revocation.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); ensureScope("workspace", "rc4-test"); });
const queue = (id: string, phases: string[], extra: object = {}) => createRevocationJob(database(), { v: 2, id, phases, c: null, ...extra } as unknown as RevocationJob);

it("a persisted supersede phase completes by marking the notebook links for a fresh look, and the job leaves the queue", () => {
  const db = database();
  const scope = String(db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id);
  db.prepare("INSERT INTO memory_scope_bindings VALUES('link-1',?,'system','notebook-link',0,'granted',?)").run(scope, JSON.stringify({ selection: { kind: "section" }, hash: "abc", status: "current", checkedAt: 123 }));
  queue("old-rc", ["supersede", "done"], { cause: "import-supersede" });
  expect(() => runRevocationJobsNow(db)).not.toThrow();
  expect(Number(db.prepare("SELECT COUNT(*) AS n FROM memory_scope_bindings WHERE subject_id='memory-revocation'").get()!.n)).toBe(0);
  expect(JSON.parse(String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id='link-1'").get()!.intent))).toMatchObject({ hash: "", checkedAt: 0, status: "current" });
});

it("a job with an unknown phase is parked as failed once, and the jobs behind it still run", () => {
  const db = database();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  queue("wedge", ["from-the-future", "done"]);
  queue("behind", ["done"]);
  expect(() => runRevocationJobsNow(db)).not.toThrow();
  const rows = db.prepare("SELECT id,state,intent FROM memory_scope_bindings WHERE subject_id='memory-revocation'").all();
  expect(rows).toHaveLength(1); // "behind" completed and left; "wedge" is parked
  expect(rows[0]).toMatchObject({ state: "revoked" });
  expect(JSON.parse(String(rows[0]!.intent)).failed).toBe("unknown-phase:from-the-future");
  expect(warn.mock.calls.filter(call => String(call[0]).includes("unknown phase"))).toHaveLength(1);
  expect(revocationWorkPending(db)).toBe(false); // a parked job no longer holds the queue
  runRevocationJobsNow(db); // nothing re-runs it
  expect(warn.mock.calls.filter(call => String(call[0]).includes("unknown phase"))).toHaveLength(1);
  warn.mockRestore();
});
