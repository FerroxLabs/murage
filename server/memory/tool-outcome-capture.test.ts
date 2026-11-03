// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MEMORY-TOOL-NAME-JUNK (1.0.15): what a tool returned is evidence, never a memory row the owner reads. A tool row that is only the tool's
// name keeps an empty payload (its action label stays); the capture stage writes no `source` record for a tool outcome, on every engine;
// and the owner's list leaves the earlier ones out unless the owner pinned them, at a capped cost per page.
import { mkdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { captureMessage, captureSource } from "./capture.ts";
import { captureWork } from "./chunks.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { ownerMemoryList, type OwnerListInput } from "./owner-list.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const roster = { bots: [{ id: "bot", threadId: "thread" }], groups: [] };
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); });

const list = (input: OwnerListInput = {}) => ownerMemoryList(input, roster);
const ids = (result: { rows: Array<Record<string, unknown>> }) => result.rows.map(row => String(row.id)).sort();
/** A record as the writers before 1.0.15 left it (memory_records' twelve columns), with its projection receipt. */
function record(db: DatabaseSync, id: string, scope: string, at: number, o: { kind?: string; assertion?: string; state?: string; pinned?: number; text?: string } = {}) {
  db.prepare("INSERT INTO memory_records VALUES(?,1,?,?,?,?,?,?,?,NULL,NULL,?)").run(id, scope, o.kind ?? "source", o.text ?? id, o.assertion ?? "tool-observation", o.state ?? "active", o.pinned ?? 0, at, at);
  db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,1,'indexed','indexed',NULL)").run(id);
}
const drain = () => { for (let work = claimMemoryJob("fixture"); work; work = claimMemoryJob("fixture")) publishMemoryWork(work, "fixture", captureWork(work)); };

it("a completed tool row that is only the tool's name keeps an empty payload, its action label and a job born complete; one with text is captured as before", () => {
  const db = database(); db.exec("UPDATE memory_meta SET mode='active'");
  captureMessage(db, "thread", { id: "bare", at: 1, role: "bot", kind: "activity", tool: { name: "read_file", ok: true } } as never);
  captureMessage(db, "thread", { id: "said", at: 2, role: "bot", kind: "activity", text: "notes.md: 3 lines", tool: { name: "read_file", ok: true } } as never);
  captureMessage(db, "thread", { id: "fail", at: 3, role: "bot", kind: "activity", tool: { name: "read_file", ok: false } } as never);
  const source = (id: string) => db.prepare("SELECT s.state,s.outcome,v.payload,j.status FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision JOIN memory_jobs j ON j.source_id=s.id WHERE s.id=?").get(`message:thread:${id}`)!;
  const bare = source("bare"), payload = JSON.parse(String(bare.payload));
  expect({ state: bare.state, status: bare.status, text: payload.text, excluded: payload.excluded }).toEqual({ state: "active", status: "complete", text: "", excluded: undefined });
  expect(payload.action).toEqual({ label: "read_file", reportedOutcome: "completed", verification: "tool-reported" });
  const said = source("said");
  expect({ state: said.state, status: said.status, text: JSON.parse(String(said.payload)).text }).toEqual({ state: "active", status: "pending", text: "read_file\nnotes.md: 3 lines" });
  // a failed one stays procedure evidence, as before: its own text, its job born complete
  const fail = source("fail");
  expect({ state: fail.state, outcome: fail.outcome, status: fail.status, text: JSON.parse(String(fail.payload)).text }).toEqual({ state: "active", outcome: "failed", status: "complete", text: "read_file" });
  drain();
  expect(db.prepare("SELECT count(*) AS n FROM memory_records").get()!.n).toBe(0);
});

it("the capture stage writes no source record for a tool outcome or a legacy activity, but still covers and completes it; what people said is a record as before", () => {
  const db = database(); db.exec("UPDATE memory_meta SET mode='active'");
  captureSource(db, { id: "tool", threadId: "thread", kind: "tool-outcome", speaker: "tool", outcome: "completed", text: "read_file\nThe rent is due on the 1st." });
  captureSource(db, { id: "legacy", threadId: "thread", kind: "activity", speaker: "assistant", outcome: "completed", text: "delegate_bot\nFailed to parse arguments" });
  captureSource(db, { id: "owner", threadId: "thread", origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text: "I take my tea with milk." });
  captureSource(db, { id: "reply", threadId: "thread", kind: "text", speaker: "assistant", outcome: "recorded", text: "Noted, milk it is." });
  const revision = Number(db.prepare("SELECT data_revision AS r FROM memory_meta").get()!.r);
  drain();
  const jobs = db.prepare("SELECT source_id AS id,status FROM memory_jobs ORDER BY source_id").all().map(row => ({ id: row.id, status: row.status }));
  expect(jobs).toEqual([{ id: "legacy", status: "complete" }, { id: "owner", status: "complete" }, { id: "reply", status: "complete" }, { id: "tool", status: "complete" }]);
  const records = db.prepare("SELECT r.kind,r.assertion,e.source_id AS source FROM memory_records r JOIN memory_evidence e ON e.record_id=r.id AND e.record_version=r.version WHERE r.kind='source' ORDER BY e.source_id").all();
  expect(records).toEqual([{ kind: "source", assertion: "owner-statement", source: "owner" }, { kind: "source", assertion: "assistant-inference", source: "reply" }]);
  expect(db.prepare("SELECT count(*) AS n FROM memory_projection_receipts").get()!.n).toBe(2);
  expect(Number(db.prepare("SELECT data_revision AS r FROM memory_meta").get()!.r)).toBe(revision + 2);
  // the sources themselves stay, for checkpoints, nightly learning and Forget
  expect(db.prepare("SELECT count(*) AS n FROM memory_sources WHERE id IN ('tool','legacy') AND state='active'").get()!.n).toBe(2);
});

it("the owner's list leaves tool excerpts out of browse in every state; a pinned one and every other memory stay; a typed search still finds one", async () => {
  const db = database(), scope = ensureScope("bot", "bot");
  record(db, "owner-line", scope, 1_000, { assertion: "owner-statement", text: "read_file is what I call the reader" });
  record(db, "fact-observed", scope, 1_001, { kind: "fact", text: "read_file found the lease" });
  record(db, "pinned-tool", scope, 1_002, { pinned: 1, text: "read_file pinned" });
  for (let n = 0; n < 300; n++) record(db, `tool-${n}`, scope, 2_000 + n, { text: "read_file", state: n % 3 === 0 ? "archived" : "active" });
  record(db, "tool-lease", scope, 1_500, { text: "read_file\nlease ends in March" });
  expect(ids(await list())).toEqual(["fact-observed", "owner-line", "pinned-tool"]);
  expect(ids(await list({ scopeId: scope }))).toEqual(["fact-observed", "owner-line", "pinned-tool"]);
  expect(ids(await list({ view: "recent" }))).toEqual(["fact-observed", "owner-line", "pinned-tool"]);
  expect(ids(await list({ state: "archived" }))).toEqual([]);
  expect(ids(await list({ view: "important" }))).toEqual(["pinned-tool"]);
  // what a bot may still read from before 1.0.15, the owner can still find, read, pin or Forget
  expect(ids(await list({ query: "lease ends" }))).toEqual(["tool-lease"]);
  expect(ids(await list({ scopeId: scope, query: "lease ends" }))).toEqual(["tool-lease"]);
});

it("one browse page examines at most its window of keys over all its scans, not a window per scan, and the pages still reach the older rows", async () => {
  const db = database(), scope = ensureScope("bot", "bot");
  record(db, "old-owner", scope, 1_000, { assertion: "owner-statement" });
  db.exec("BEGIN");
  for (let n = 0; n < 12_000; n++) record(db, `tool-${n}`, scope, 2_000 + n, { state: n % 2 ? "archived" : "active" });
  db.exec("COMMIT");
  // no view: four states, four scans, 6,000 active and 6,000 archived excerpts in the way of the one owner line
  const pages: Array<{ rows: string[]; complete: boolean | undefined }> = [];
  let cursor: string | undefined;
  for (let n = 0; n < 6; n++) {
    const page = await list(cursor ? { cursor } : {});
    pages.push({ rows: ids(page), complete: page.coverageComplete });
    if (pages.at(-1)!.rows.length || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  expect(pages[0]).toEqual({ rows: [], complete: false });
  expect(pages.at(-1)!.rows).toEqual(["old-owner"]);
  expect(pages.length).toBeGreaterThan(1);
});

it("a browse page walks at most its window of keys past the excerpts, says so, and the next page carries on to the older rows", async () => {
  const db = database(), scope = ensureScope("bot", "bot");
  record(db, "old-owner", scope, 1_000, { assertion: "owner-statement" });
  db.exec("BEGIN");
  for (let n = 0; n < 20_600; n++) record(db, `tool-${n}`, scope, 2_000 + n);
  db.exec("COMMIT");
  const first = await list({ view: "recent" });
  expect(first.rows).toEqual([]);
  expect(first.coverageComplete).toBe(false);
  expect(first.nextCursor).toBeDefined();
  const second = await list({ view: "recent", cursor: first.nextCursor! });
  expect(ids(second)).toEqual(["old-owner"]);
});
