// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1020 CTXSTOP-ROSTER B: after one roster change every recall view rebuilds, and each rebuild walked EVERY memory_scope_bindings row
// in 64-row pages (recall-membership.ts rows()), system, pip and checkpoint rows included. Live: 158k-285k page reads a minute,
// cpu 142%, and the admission ledger lock held past its deadline (AdmissionLockTimeout). A workspace-owner view reads only the
// bindings of the threads it names and the grants to its own bot or room, so its statement count does not grow with the table.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { resetDataRootsForTest } from "../data-roots.ts";
import { threadHumanPrincipal } from "../human-principals.ts";
import { ensureScope, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { recallMembershipSteps } from "./recall-membership.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); resetDataRootsForTest(); });
afterEach(() => { vi.restoreAllMocks(); });

const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: "lead", threadId: "lead-thread", section: "agency", tasks: [{ threadId: "lead-thread" }, { threadId: "lead-task" }] }, { id: "other", threadId: "other-thread", section: "agency" }], groups: [{ id: "room", threadId: "room-thread", memberIds: ["lead", "other"] }] };
const binding = { botId: "lead", threadId: "lead-thread", humanPrincipal: threadHumanPrincipal("lead-thread"), notOwnerAudience: false };
function construct() {
  const steps = recallMembershipSteps(database(), binding, roster);
  for (;;) { const next = steps.next(); if (next.done) return next.value; }
}
/** One construction and how many binding statements it ran. */
function measure() { let n = 0; const db = database(), prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => { const s = prepare(sql); if (sql.includes("FROM memory_scope_bindings")) { const all = s.all.bind(s); s.all = ((...a: never[]) => { n++; return all(...a); }) as typeof s.all; } return s; });
  try { const result = construct(); return { reads: n, result }; } finally { spy.mockRestore(); } }

const insert = (id: string, scope: string, type: string, subject: string, state = "granted", intent = "{}") =>
  database().prepare("INSERT INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) VALUES(?,?,?,?,1,?,?)").run(id, scope, type, subject, state, intent);

it("W-B1: an owner view's binding reads stay bounded when memory_scope_bindings grows by 5000 unrelated rows", () => {
  reconcileMemoryRoster(roster); setMemoryMode("active");
  const small = measure();
  const scope = ensureScope("workspace", "noise");
  const db = database();
  db.exec("BEGIN");
  for (let n = 0; n < 5000; n++) insert(`pip-reflect:${n}`, scope, "system", `noise-${n}`);
  db.exec("COMMIT");
  const large = measure();
  expect(large.result).toEqual(small.result);
  expect(large.reads).toBe(small.reads);
  expect(large.reads).toBeLessThanOrEqual(8);
});

it("W-B2: the bounded read keeps the walk's answers: a grant to this bot is read, a grant to another bot, a revoked grant and another person's room thread are not", () => {
  reconcileMemoryRoster(roster); setMemoryMode("active");
  const before = measure().result;
  const mine = ensureScope("team", "granted-to-lead"), theirs = ensureScope("team", "granted-to-other"), revoked = ensureScope("team", "revoked-for-lead");
  insert("g-mine", mine, "bot", "lead");
  insert("g-theirs", theirs, "bot", "other");
  insert("g-revoked", revoked, "bot", "lead", "revoked");
  const after = measure().result;
  expect(after.scopes).toContain(mine);
  expect(after.scopes).not.toContain(theirs);
  expect(after.scopes).not.toContain(revoked);
  const roomScope = ensureScope("conversation", "room-thread");
  expect(before.scopes).toContain(roomScope);
  expect(after.scopes).toContain(roomScope);
  // the room thread now belongs to another person: an owner view no longer reaches it (persons map, reach())
  insert("h-room", ensureScope("workspace", "people"), "human-thread", "room-thread", "granted", JSON.stringify({ personId: "guest-1" }));
  expect(measure().result.scopes).not.toContain(roomScope);
});
