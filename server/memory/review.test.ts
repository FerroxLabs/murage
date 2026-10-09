// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Reviewing what bots would like to remember (PROPOSAL-v2 Phase 0, items 0.2 to
// 0.7): the waiting counts and what they exclude, the live counter and its
// frames, Keep / Keep all / Later / Edit-and-keep / Undo, and the durable
// action ids that make a retried press return the first result, restart or not.
import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { ensureScope, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { memoryOwnerRoute } from "./settings.ts";
import { recordLearningEvent } from "./learning-ledger.ts";
import { WAITING_SCOPE_SQL, LATER_ROW, waitingSummary, waitingCounts } from "./review.ts";
import { WaitingMonitor, WaitingPushGate, type WaitingFrame } from "./waiting-monitor.ts";
import { waitingEpoch } from "./waiting-epoch.ts";
import { memoryEligibility, sensitiveReasons, type EligibilityRow } from "./review-eligibility.ts";
import { memoryWaitingRows, withMemoryWaiting } from "../inbox-memory-waiting.ts";
import { KNOWN_FRAME_KINDS, frameSubject } from "../sse-visibility.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { vi.restoreAllMocks(); });

const TEXT_ONE = "The deploy window is Tuesday and reports go out Monday";
const TEXT_TWO = "A second message about the launch review date";

function world() {
  const roster = {
    bots: [{ id: "bot", name: "Sable", threadId: "thread" }, { id: "other", name: "Ember", threadId: "other-thread" }],
    groups: [{ id: "room", name: "Ops room", threadId: "room-thread", memberIds: ["bot", "other"] }],
  } as unknown as MemoryRoster;
  reconcileMemoryRoster(roster); setMemoryMode("capture");
  const sources: string[] = [];
  // Two sources in two threads: a second message in one thread would retire the first from the visible branch.
  [["thread", TEXT_ONE], ["other-thread", TEXT_TWO]].forEach(([thread, text], index) => {
    appendMessage(thread, { id: `m${index}`, at: index + 1, role: "user", kind: "text", text });
    const work = claimMemoryJob("fixture")!; publishMemoryWork(work, "fixture", captureWork(work)); sources.push(work.sourceId);
  });
  setMemoryMode("active");
  const db = database(), owner = ownerMemoryTicket();
  let tick = Date.now();
  const scopes = { bot: ensureScope("bot", "bot"), other: ensureScope("bot", "other"), room: ensureScope("room", "room"), conversation: ensureScope("conversation", "other-thread") };
  function candidate(text: string, options: { scope?: keyof typeof scopes; kind?: string; supersedes?: string; source?: number; assertion?: string } = {}) {
    const id = randomUUID();
    db.prepare("INSERT INTO memory_records VALUES(?,1,?,?,?,?,'candidate',0,?,NULL,?,?)")
      .run(id, scopes[options.scope ?? "bot"], options.kind ?? "fact", text, options.assertion ?? "assistant-inference", ++tick, options.supersedes ?? null, tick);
    db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,0,5)").run(id, sources[options.source ?? 0]);
    return id;
  }
  const act = (body: Record<string, unknown>) => memoryOwnerRoute("/api/memory/action", body, owner, roster) as Promise<any>;
  const row = (id: string, version = 1) => db.prepare("SELECT state,text,owner_pinned FROM memory_records WHERE id=? AND version=?").get(id, version) as { state: string; text: string; owner_pinned: number } | undefined;
  return { roster, db, owner, scopes, sources, candidate, act, row };
}
const uid = () => randomUUID();

describe("waiting counts (0.2)", () => {
  it("counts per item, per bot, with a room counted once under the room, and leaves out Later and identity rows", async () => {
    const w = world();
    for (let n = 0; n < 3; n++) w.candidate(`Reports go out on Mondays, note ${n}`);
    for (let n = 0; n < 2; n++) w.candidate(`The launch review is on a Friday, note ${n}`, { scope: "conversation" });
    for (let n = 0; n < 2; n++) w.candidate(`The standup moves to nine, note ${n}`, { scope: "room" });
    w.candidate("Sable keeps the calm tone", { kind: "commitment" });
    const summary = waitingSummary(w.roster);
    const by = Object.fromEntries(summary.subjects.map(item => [`${item.kind}:${item.id}`, item.waiting]));
    expect(by).toEqual({ "bot:bot": 3, "bot:other": 2, "room:room": 2 });
    expect(summary.total).toBe(7);
    // a room item is not repeated under each member bot
    expect(waitingCounts(w.db, w.roster).get("bot:other")?.waiting).toBe(2);
    const first = (await w.act({ action: "waiting-list", subjectType: "bot", subjectId: "bot" })).items[0];
    await w.act({ action: "review-later", actionId: uid(), id: first.id, version: first.version });
    const after = waitingSummary(w.roster);
    expect(after.subjects.find(item => item.id === "bot")).toMatchObject({ waiting: 2, later: 1 });
    expect(after.total).toBe(6);
  });

  it("reads each scope with one indexed seek on memory_records_scope", () => {
    const w = world();
    const plan = w.db.prepare(`EXPLAIN QUERY PLAN ${WAITING_SCOPE_SQL}`).all(w.scopes.bot).map(item => String(item.detail)).join(" | ");
    expect(plan).toContain("memory_records_scope");
    expect(plan).not.toMatch(/SCAN/);
  });

  it("answers the fixture-scale count fast: 11 waiting among 2,000 audiences", () => {
    const w = world();
    const insert = w.db.prepare("INSERT INTO memory_scopes VALUES(?,'conversation',?,'[]',0)");
    w.db.exec("BEGIN");
    for (let n = 0; n < 2000; n++) insert.run(randomUUID(), `thread-${n}`);
    w.db.exec("COMMIT");
    for (let n = 0; n < 11; n++) w.candidate(`Reports go out on Mondays, note ${n}`);
    const times: number[] = [];
    for (let run = 0; run < 12; run++) { const at = performance.now(); waitingCounts(w.db, w.roster); times.push(performance.now() - at); }
    times.sort((a, b) => a - b);
    console.info(`[test] waiting count over 2,000 audiences: p50=${times[6].toFixed(1)}ms p95=${times[11].toFixed(1)}ms`);
    expect(times[11]).toBeLessThan(150);
    expect(waitingCounts(w.db, w.roster).get("bot:bot")?.waiting).toBe(11);
  });
});

describe("the live counter and its frames (0.3)", () => {
  it("moves when a waiting item appears, is kept or leaves, and is not moved by other writes", async () => {
    const w = world();
    expect(waitingEpoch(w.db)).toBe(0);
    const id = w.candidate("Reports go out on Mondays");
    expect(waitingEpoch(w.db)).toBe(1);
    w.db.prepare("UPDATE memory_records SET text='x' WHERE id=?").run(id);
    expect(waitingEpoch(w.db)).toBe(1);
    await w.act({ action: "review-keep", actionId: uid(), id, version: 1 });
    expect(waitingEpoch(w.db)).toBe(2);
  });

  it("announces counts only, for the subjects that changed, and stays quiet when nothing moved", async () => {
    const w = world();
    const frames: WaitingFrame[] = []; let changed = 0;
    const monitor = new WaitingMonitor({ roster: () => w.roster, emit: frame => frames.push(frame), changed: () => { changed++; }, database: () => w.db });
    expect(monitor.tick()).toEqual([]);
    const a = w.candidate("Reports go out on Mondays");
    w.candidate("The launch review is on a Friday", { scope: "conversation" });
    const sent = monitor.tick();
    expect(sent.map(frame => [frame.botId, frame.waiting, frame.total])).toEqual(expect.arrayContaining([["bot", 1, 2], ["other", 1, 2]]));
    expect(changed).toBe(1);
    expect(JSON.stringify(sent)).not.toContain("Mondays");
    expect(monitor.tick()).toEqual([]);
    await w.act({ action: "review-keep", actionId: uid(), id: a, version: 1 });
    const next = monitor.tick();
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ kind: "memory.waiting", botId: "bot", waiting: 0, total: 1 });
  });

  it("is registered desktop-only in sse-visibility", () => {
    expect(KNOWN_FRAME_KINDS).toContain("memory.waiting");
    expect(frameSubject({ kind: "memory.waiting", botId: "bot", waiting: 3, total: 3 })).toEqual({ scope: "desktop" });
  });

  it("pushes on 0 to N and each +10, at most once per bot per 4 hours", () => {
    const gate = new WaitingPushGate(), hour = 3_600_000;
    expect(gate.decide("bot:a", 0, 3, 0)).toBe(true);
    expect(gate.decide("bot:a", 3, 5, hour)).toBe(false);
    expect(gate.decide("bot:a", 5, 13, 2 * hour)).toBe(false);
    expect(gate.decide("bot:a", 13, 13, 5 * hour)).toBe(true);
    expect(gate.decide("bot:a", 13, 14, 10 * hour)).toBe(false);
    expect(gate.decide("bot:b", 0, 1, hour)).toBe(true);
    expect(gate.decide("bot:b", 1, 0, 10 * hour)).toBe(false);
  });

  it("counts the Inbox per item, not per card", () => {
    const rows = memoryWaitingRows({ subjects: [{ kind: "bot", id: "a", name: "Sable", waiting: 11, later: 0, everyday: 8 }, { kind: "bot", id: "b", name: "Ember", waiting: 3, later: 2, everyday: 0 }], total: 14, later: 2, boot: "x", revision: 1 });
    const body = withMemoryWaiting({ decisions: 2 }, rows);
    expect(body.decisions).toBe(16);
    expect(body.memoryWaiting).toHaveLength(2);
    expect(JSON.stringify(body)).not.toMatch(/Reports|note/);
    expect(withMemoryWaiting({ decisions: 2 }, [])).toEqual({ decisions: 2 });
  });
});

describe("Keep, with durable action ids (0.5, 0.7)", () => {
  it("keeps one memory and returns the same result for a retry, after a restart too", async () => {
    const w = world();
    const id = w.candidate("Reports go out on Mondays");
    const actionId = uid();
    const first = await w.act({ action: "review-keep", actionId, id, version: 1 });
    expect(first.result).toEqual({ status: "kept", id, version: 1 });
    expect(w.row(id)?.state).toBe("active");
    expect(first.summary.total).toBe(0);
    closeDatabase();
    const again = await memoryOwnerRoute("/api/memory/action", { action: "review-keep", actionId, id, version: 1 }, ownerMemoryTicket(), w.roster) as any;
    expect(again.result).toEqual(first.result);
    const events = database().prepare("SELECT detail FROM memory_learning_events WHERE record_id=? AND kind='owner-keep'").all(id);
    expect(events).toHaveLength(1);
    expect(JSON.parse(String(events[0].detail))).toMatchObject({ actionId, batchId: actionId, reviewedVersion: 1, ruleVersion: 1 });
  });

  it("refuses a reused action id with a different payload and a stale version", async () => {
    const w = world();
    const id = w.candidate("Reports go out on Mondays"), other = w.candidate("The launch review is on a Friday");
    const actionId = uid();
    await w.act({ action: "review-keep", actionId, id, version: 1 });
    await expect(w.act({ action: "review-keep", actionId, id, version: 2 })).rejects.toThrow("MEMORY_ACTION_REUSED");
    await expect(w.act({ action: "review-keep", actionId: uid(), id, version: 1 })).rejects.toThrow("MEMORY_VERSION_CONFLICT");
    expect(w.row(other)?.state).toBe("candidate");
  });

  it("only the owner can review", async () => {
    const w = world();
    const id = w.candidate("Reports go out on Mondays");
    await expect(memoryOwnerRoute("/api/memory/action", { action: "review-keep", actionId: uid(), id, version: 1 }, {}, w.roster)).rejects.toThrow("MEMORY_OWNER_REQUIRED");
  });

  it("asks for the pin choice when a correction would replace a pinned memory, then keeps with it", async () => {
    const w = world();
    const target = w.candidate("Invoices go out on the 1st");
    w.db.prepare("UPDATE memory_records SET state='active',owner_pinned=1 WHERE id=?").run(target);
    const fix = w.candidate("Invoices go out on the 5th", { supersedes: target });
    w.db.prepare("INSERT INTO memory_derivations VALUES(?,1,?,1)").run(target, fix);
    const list = (await w.act({ action: "waiting-list", subjectType: "bot", subjectId: "bot" })).items;
    const entry = list.find((item: any) => item.id === fix);
    expect(entry).toMatchObject({ group: "one-by-one", rank: 0, correction: { targetText: "Invoices go out on the 1st", targetPinned: true } });
    expect(entry.reasons).toEqual(expect.arrayContaining(["correction"]));
    await expect(w.act({ action: "review-keep", actionId: uid(), id: fix, version: 1 })).rejects.toThrow("MEMORY_CORRECTION_PIN_CHOICE_REQUIRED");
    const done = await w.act({ action: "review-keep", actionId: uid(), id: fix, version: 1, correctionPin: "transfer" });
    expect(done.result.status).toBe("kept");
    expect(w.row(fix)).toMatchObject({ state: "active", owner_pinned: 1 });
    expect(w.row(target)?.state).toBe("superseded");
  });
});

describe("Keep all (0.6)", () => {
  it("keeps the everyday items on the list the owner saw, refuses the rest per item, and says which", async () => {
    const w = world();
    const everyday = Array.from({ length: 8 }, (_, n) => w.candidate(`Reports go out on Mondays, note ${n}`));
    const money = w.candidate("The salary review is in March");
    const secret = w.candidate("The wifi password is on the fridge");
    const person = w.candidate("Lunch with Dana is on the 3rd");
    const list = (await w.act({ action: "waiting-list", subjectType: "bot", subjectId: "bot" })).items as any[];
    expect(list).toHaveLength(11);
    expect(list.filter(item => item.group === "everyday")).toHaveLength(8);
    const summary = await w.act({ action: "waiting-summary" });
    expect(summary.subjects.find((item: any) => item.id === "bot")).toMatchObject({ waiting: 11, everyday: 8 });
    const items = list.map(item => ({ id: item.id, version: item.version }));
    const actionId = uid();
    const answer = await w.act({ action: "review-keep-all", actionId, items });
    expect(answer.kept).toBe(8);
    expect(answer.results.filter((item: any) => item.status === "needs-you").map((item: any) => item.id).sort()).toEqual([money, secret, person].sort());
    expect(answer.results.find((item: any) => item.id === money).reasons).toContain("sensitive-money");
    expect(answer.results.find((item: any) => item.id === secret).reasons).toContain("sensitive-secret");
    expect(answer.results.find((item: any) => item.id === person).reasons).toContain("sensitive-person");
    for (const id of everyday) expect(w.row(id)?.state).toBe("active");
    for (const id of [money, secret, person]) expect(w.row(id)?.state).toBe("candidate");
    expect(answer.summary.total).toBe(3);
    // a retry, after a restart, returns the same per-item results and keeps nothing twice
    closeDatabase();
    const retry = await memoryOwnerRoute("/api/memory/action", { action: "review-keep-all", actionId, items }, ownerMemoryTicket(), w.roster) as any;
    expect(retry.results).toEqual(answer.results);
    expect(database().prepare("SELECT count(*) AS n FROM memory_learning_events WHERE kind='owner-keep'").get()!.n).toBe(8);
  });

  it("re-checks each item when it commits: a changed item and a lost source are reported, not kept", async () => {
    const w = world();
    const changed = w.candidate("Reports go out on Mondays, note a");
    const lost = w.candidate("Reports go out on Mondays, note b", { source: 1 });
    const fine = w.candidate("Reports go out on Mondays, note c");
    const items = [changed, lost, fine].map(id => ({ id, version: 1 }));
    w.db.prepare("UPDATE memory_records SET state='archived' WHERE id=?").run(changed);
    w.db.prepare("UPDATE memory_sources SET state='retired' WHERE id=?").run(w.sources[1]);
    const answer = await w.act({ action: "review-keep-all", actionId: uid(), items });
    expect(Object.fromEntries(answer.results.map((item: any) => [item.id, item.status]))).toEqual({ [changed]: "changed", [lost]: "gone", [fine]: "kept" });
  });

  it("works in slices of 25 with one revocation each, and none at all for plain waiting items", async () => {
    const w = world();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const revoked = () => warn.mock.calls.filter(call => String(call[0]).startsWith("memory receipts revoked")).length;
    const ids = Array.from({ length: 60 }, (_, n) => w.candidate(`Reports go out on Mondays, note ${n}`));
    const first = await w.act({ action: "review-keep-all", actionId: uid(), items: ids.map(id => ({ id, version: 1 })) });
    expect(first.kept).toBe(60);
    expect(revoked()).toBe(0);
    // items something was derived from could be in a receipt: one call per slice, never one per item
    const parents = Array.from({ length: 60 }, (_, n) => w.candidate(`The launch review is on a Friday, note ${n}`));
    const child = w.candidate("A child of the first");
    for (const id of parents) w.db.prepare("INSERT INTO memory_derivations VALUES(?,1,?,1)").run(id, child);
    const second = await w.act({ action: "review-keep-all", actionId: uid(), items: parents.map(id => ({ id, version: 1 })) });
    expect(second.kept).toBe(60);
    expect(revoked()).toBe(3);
  });

  it("keeps 100 in well under a second of server time", async () => {
    const w = world();
    const ids = Array.from({ length: 100 }, (_, n) => w.candidate(`Reports go out on Mondays, note ${n}`));
    const at = performance.now();
    const answer = await w.act({ action: "review-keep-all", actionId: uid(), items: ids.map(id => ({ id, version: 1 })) });
    const took = performance.now() - at;
    console.info(`[test] keep all 100: ${took.toFixed(0)}ms`);
    expect(answer.kept).toBe(100);
    expect(took).toBeLessThan(1000);
  });
});

describe("Not now stays in the Later row (0.5)", () => {
  it("parks an item with its action id, takes it out of the count, and puts it back", async () => {
    const w = world();
    const id = w.candidate("Reports go out on Mondays");
    const actionId = uid();
    const parked = await w.act({ action: "review-later", actionId, id, version: 1 });
    expect(parked.result).toEqual({ status: "later", id, version: 1 });
    const stored = JSON.parse(String(w.db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(LATER_ROW)!.intent));
    expect(stored.items[id]).toMatchObject({ version: 1, actionId });
    expect(parked.summary).toMatchObject({ total: 0, later: 1 });
    expect((await w.act({ action: "review-later", actionId, id, version: 1 })).result).toEqual(parked.result);
    const later = await w.act({ action: "waiting-list", subjectType: "bot", subjectId: "bot", tab: "later" });
    expect(later.items.map((item: any) => item.id)).toEqual([id]);
    const back = await w.act({ action: "review-back", id });
    expect(back.summary.total).toBe(1);
    await w.act({ action: "review-later", actionId: uid(), id, version: 1 });
    await w.act({ action: "review-keep", actionId: uid(), id, version: 1 });
    expect(JSON.parse(String(w.db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(LATER_ROW)!.intent)).items[id]).toBeUndefined();
  });
});

describe("Edit, then keep as two steps under one action id (0.7)", () => {
  it("saves the new words as a new waiting version and keeps that version, once", async () => {
    const w = world();
    const id = w.candidate("Reports go out on Mondays");
    const actionId = uid();
    const body = { action: "review-edit", actionId, id, version: 1, text: "Reports go out on Mondays, short", keep: true };
    const done = await w.act(body);
    expect(done.result).toEqual({ status: "kept", id, version: 2 });
    expect(w.row(id, 1)?.state).toBe("superseded");
    expect(w.row(id, 2)).toMatchObject({ state: "active", text: "Reports go out on Mondays, short" });
    expect(((await w.act(body)) as any).result).toEqual(done.result);
    await expect(w.act({ ...body, text: "Something else" })).rejects.toThrow("MEMORY_ACTION_REUSED");
    expect(database().prepare("SELECT count(*) AS n FROM memory_learning_events WHERE record_id=? AND kind='owner-keep'").get(id)!.n).toBe(1);
  });

  it("editing alone never keeps", async () => {
    const w = world();
    const id = w.candidate("Reports go out on Mondays");
    const body = { action: "review-edit", actionId: uid(), id, version: 1, text: "Reports go out on Mondays, short" };
    const saved = await w.act(body);
    expect(saved.result).toEqual({ status: "edited", id, version: 2 });
    expect(w.row(id, 2)?.state).toBe("candidate");
    expect((await w.act(body)).result).toEqual(saved.result);
    expect(waitingSummary(w.roster).total).toBe(1);
    const entry = (await w.act({ action: "waiting-list", subjectType: "bot", subjectId: "bot" })).items[0];
    expect(entry).toMatchObject({ version: 2, group: "one-by-one", reasons: expect.arrayContaining(["edited"]) });
  });
});

describe("Undo from the toast (9.2)", () => {
  it("returns a fresh keep to waiting, and a retry returns the same answer", async () => {
    const w = world();
    const id = w.candidate("Reports go out on Mondays");
    const keepActionId = uid();
    await w.act({ action: "review-keep", actionId: keepActionId, id, version: 1 });
    const undoId = uid();
    const undone = await w.act({ action: "review-undo", actionId: undoId, keepActionId, id, version: 1 });
    expect(undone.result).toEqual({ status: "waiting", id, version: 1 });
    expect(w.row(id)?.state).toBe("candidate");
    expect(undone.summary.total).toBe(1);
    expect((await w.act({ action: "review-undo", actionId: undoId, keepActionId, id, version: 1 })).result).toEqual(undone.result);
    await expect(w.act({ action: "review-undo", actionId: uid(), keepActionId: uid(), id, version: 1 })).rejects.toThrow("MEMORY_UNDO_UNAVAILABLE");
  });

  it("archives instead when the keep is no longer the last thing that happened", async () => {
    const w = world();
    const id = w.candidate("Reports go out on Mondays");
    const keepActionId = uid();
    await w.act({ action: "review-keep", actionId: keepActionId, id, version: 1 });
    recordLearningEvent(w.db, { kind: "owner-keep", scopeId: w.scopes.bot, recordId: id, recordVersion: 1, detail: { actionId: uid() } });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const undone = await w.act({ action: "review-undo", actionId: uid(), keepActionId, id, version: 1 });
    expect(undone.result.status).toBe("archived");
    expect(w.row(id)?.state).toBe("archived");
  });

  it("archives when a receipt has cited the kept memory", async () => {
    const w = world();
    const id = w.candidate("Reports go out on Mondays");
    const keepActionId = uid();
    await w.act({ action: "review-keep", actionId: keepActionId, id, version: 1 });
    w.db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,NULL,?,'[]','[]',0,0,1,'delivered',?)")
      .run(randomUUID(), "thread", "driver", JSON.stringify([{ id, version: 1 }]), Date.now() + 5);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const undone = await w.act({ action: "review-undo", actionId: uid(), keepActionId, id, version: 1 });
    expect(undone.result.status).toBe("archived");
  });
});

describe("what the list says (0.15)", () => {
  it("gives plain typed reasons and sources, with no ids, hashes or byte ranges", async () => {
    const w = world();
    const id = w.candidate("Reports go out on Mondays");
    const sources = await w.act({ action: "waiting-sources", id, version: 1 });
    expect(sources.sources).toHaveLength(1);
    expect(Object.keys(sources.sources[0]).sort()).toEqual(["at", "excerpt", "where", "who"]);
    expect(sources.sources[0].where).toEqual({ kind: "chat", name: "Sable" });
    expect(JSON.stringify(sources)).not.toMatch(/sourceId|hash|startByte|[0-9a-f]{8}-[0-9a-f]{4}/);
    const item = (await w.act({ action: "waiting-list", subjectType: "bot", subjectId: "bot" })).items[0];
    expect(Object.keys(item).sort()).toEqual(["at", "group", "id", "later", "origin", "rank", "reasons", "scopeLabel", "text", "version"]);
  });
});

describe("the eligibility rules", () => {
  it.each([
    ["Her salary is paid on the 25th", "sensitive-money"],
    ["The invoice total is $4,200", "sensitive-money"],
    ["Mi sueldo sube en marzo", "sensitive-money"],
    ["Das Gehalt kommt am Ersten", "sensitive-money"],
    ["The allergy list is on the fridge", "sensitive-health"],
    ["Ravi has a doctor visit", "sensitive-health"],
    ["The passport number is in the drawer", "sensitive-secret"],
    ["Use key sk-abcdefghijklmnop1234 for the test", "sensitive-secret"],
    ["My wife prefers the window seat", "sensitive-person"],
    ["Ask Dana about the contract", "sensitive-person"],
  ])("marks %s as %s", (text, reason) => { expect(sensitiveReasons(text)).toContain(reason); });
  it.each([
    "Reports go out on Mondays", "Use the Brightline template for client proposals", "Check the syntax before shipping", "The Q4 launch review is on 14 November",
  ])("leaves %s as everyday", text => { expect(sensitiveReasons(text)).toEqual([]); });
  it("asks for identity rows and shared audiences, and refuses lost evidence", () => {
    const w = world();
    const everyday = w.candidate("Reports go out on Mondays");
    const get = (id: string) => w.db.prepare("SELECT * FROM memory_records WHERE id=?").get(id) as unknown as EligibilityRow;
    expect(memoryEligibility(w.db, get(everyday))).toMatchObject({ decision: "keep", reasons: [] });
    expect(memoryEligibility(w.db, get(w.candidate("Sable keeps the calm tone", { kind: "commitment" }))).reasons).toContain("identity");
    expect(memoryEligibility(w.db, get(w.candidate("The standup moves to nine", { scope: "room" }))).reasons).toContain("shared-space");
    w.db.prepare("UPDATE memory_sources SET state='retired' WHERE id=?").run(w.sources[0]);
    expect(memoryEligibility(w.db, get(everyday))).toMatchObject({ decision: "refuse", reasons: ["source-gone"] });
  });
});
