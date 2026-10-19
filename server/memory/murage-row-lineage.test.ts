// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 lifecycle card (Sean's 1.0.2 logs, Claude engine): a routine's card patched to Completed in a thread with an open owner turn was
// attached to that turn (message-db.ts: every generated row while a turn runs), so a pending window on the owner turn's parents opened an
// inherit revoke with the owner's turn as its child at the card's old position: the owner's prompt read "checking", the dispatch was refused
// with MEMORY_CONTEXT_REVOKED, the re-dispatch too, and the owner's session was reset. A row Murage writes is never a turn's engine output:
// it gets only the refs of what it quotes, and no write makes another actor's open turn its inherit child. The real writers (message-db.ts
// appendMessage / updateMessage on the app's database) with the real lineage and revoke code.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage, closeMessageDb, updateMessage } from "../message-db.ts";
import type { Message } from "../store.ts";
import { denyLookup, refsLookup } from "./deny-read.ts";
import { addTurnParents, bindProviderTurn, closeTurnLineage, memberTurnId, openTurnLineage, writeSessionLineage } from "./lineage-write.ts";
import { turnChildRef, type TurnLineage } from "./lineage-types.ts";
import { drainRevokeMarker } from "./memory-revocation.ts";
import { lineOf } from "./revoke-marker.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";
import { murageLine } from "../murage-line.ts";
import { TURN_STOPPED_NOTE } from "../turn-outcome.ts";

const P = "parent-conversation", E = "routine-run-thread";
const owner = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: "user", kind: "text", text: id, at: Date.now(), ...extra });
const card = (status: "running" | "completed", extra: Partial<Message> = {}, summary?: string): Message => ({
  id: "card", role: "bot", kind: "routine.run", at: Date.now(), text: status === "running" ? "Running" : "Completed",
  routineRun: { runId: "run-1", routineId: "routine-1", routineName: "Daily check", status, executionThreadId: E, ...(summary ? { summary } : {}) }, ...extra,
});

let opened: TurnLineage[] = [];
function reset(): void { closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); }
// The app's database is built once per file, not once per test: its schema and every table the writers create on first use (messages and
// their search index, the write revision, hand-offs, project settings, ...) cost a fully synced commit each, and on a loaded machine the
// first test spent seconds there. Each test starts from a copy of that built, certified file.
const TEMPLATE = `${DATA_DIR}.murage-row-lineage.db`;
beforeAll(() => {
  reset();
  new WritetimeFixture(database()).cert(true);
  appendMessage("warm-up", owner("w1"));
  appendMessage("warm-up", { ...card("running"), parentId: "w1" });
  updateMessage("warm-up", { ...card("completed", {}, "done"), parentId: "w1" });
  appendMessage("warm-up", { id: "w2", role: "bot", kind: "activity", at: Date.now(), parentId: "card", tool: { name: "Read", ok: true } });
  // (the fixture's room scopes carry audience '{}'; the app writes an array, and reopening a file checks that shape)
  database().exec("UPDATE memory_scopes SET audience='[]' WHERE json_type(audience)<>'array'");
  rmSync(TEMPLATE, { force: true });
  database().prepare("VACUUM INTO ?").run(TEMPLATE);
  reset();
});
afterAll(() => { reset(); rmSync(TEMPLATE, { force: true }); });
beforeEach(() => { reset(); opened = []; copyFileSync(TEMPLATE, join(DATA_DIR, "messages.db")); });
afterEach(() => { for (const turn of opened) closeTurnLineage(turn); opened = []; });

const lsnOf = (thread: string, id: string) => lineOf(database(), thread, id)!.lsn;
const tx = (work: () => void) => { database().exec("BEGIN IMMEDIATE"); try { work(); database().exec("COMMIT"); } catch (error) { database().exec("ROLLBACK"); throw error; } };
/** The owner turn's parent is a line of another conversation whose revoke is in flight (the window the lineage backfill's walk holds). */
function pendingParent(): number {
  appendMessage(P, owner("p1"));
  return pendingWindow();
}
/** The revoke of p1 (already written) starts walking now. */
function pendingWindow(): number {
  const R = 50;
  database().prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'line',?,?,?,'mark','','active')").run(R, JSON.stringify({ kind: "line", cause: "forget" }), lsnOf(P, "p1"), lsnOf(P, "p1"));
  database().prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES(?,?,?)").run(P, lsnOf(P, "p1"), R);
  return R;
}
/** The owner turn, opened when its prompt is built, running in session claude/s-own and handed p1. */
function ownerTurn(T: string, shape: "direct" | "room" | "late handback"): TurnLineage {
  const turn = openTurnLineage(database(), { threadId: T, turnId: shape === "late handback" ? "t-1" : memberTurnId("bot-a") });
  opened.push(turn);
  if (shape === "room") opened.push(openTurnLineage(database(), { threadId: T, turnId: memberTurnId("bot-b") }));
  // late handback: the turn id came back first and the prompt was written later; a line landed in between
  if (shape === "late handback") appendMessage(T, owner("u2", { parentId: "card" }));
  // the session the turn resumes, then what the turn is handed (a frame, a lookup: addTurnParents)
  tx(() => writeSessionLineage(database(), { threadId: T, driverInstance: "claude", nativeSession: "s-own" }, turn));
  addTurnParents(turn, [{ kind: "line", threadId: P, messageId: "p1" }]);
  return turn;
}
const sessionRow = (T: string) => database().prepare("SELECT first_lsn AS f,last_lsn AS l FROM memory_session_lineage WHERE thread_id=? AND native_session='s-own'").get(T) as { f: number; l: number };
const count = (sql: string, ...args: string[]) => Number((database().prepare(sql).get(...args) as { n: number }).n);
/** What a refusal reads: the owner's prompt (its thread read up to its head) and the reset of its session. */
function expectOwnerTurnUntouched(T: string, turn: TurnLineage, session: { f: number; l: number }): void {
  expect(refsLookup(database(), [{ kind: "prefix", threadId: T, headLsn: turn.turnLsn }], CONTENT), "the owner's prompt still reads shown: no refusal").toEqual({ state: "shown" });
  expect(count("SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id=? AND since_lsn<=?", T, String(turn.turnLsn)), "no hold on the owner's prompt").toBe(0);
  expect(count("SELECT count(*) AS n FROM memory_deny_session WHERE thread_id=?", T), "no deny_session").toBe(0);
  expect(sessionRow(T), "the card did not advance the owner's session").toEqual(session);
}

describe("a row Murage writes is never attached to an open turn", () => {
  for (const shape of ["direct", "room", "late handback"] as const) it(`${shape}: a routine completing while the owner's turn waits on a pending window is no refusal and no deny_session`, () => {
    const T = `lifecycle-${shape.replace(" ", "-")}`;
    pendingParent();
    appendMessage(E, owner("e1"));
    appendMessage(T, owner("u1"));
    const from = shape === "room" ? { from: { botId: "bot-a", name: "A", color: "#000" } } : {};
    appendMessage(T, { ...card("running", from), parentId: "u1" }); // the card the routine's creation posted
    const turn = ownerTurn(T, shape);
    const session = sessionRow(T);
    updateMessage(T, { ...card("completed", from, "All good"), parentId: "u1" }); // syncRoutineRunToSource: the card turned Completed
    // Murage's own status line, posted while the turn runs (no member named in a room: before, every open turn of the thread merged)
    appendMessage(T, { id: "status", role: "bot", kind: "text", text: "Queued", at: Date.now(), actorKind: "murage", murage: { kind: "status" }, parentId: shape === "late handback" ? "u2" : "card" });
    expectOwnerTurnUntouched(T, turn, session);
    expect(count("SELECT count(*) AS n FROM memory_revoke_jobs WHERE kind='inherit'"), "no inherit revoke opened").toBe(0);
    expect(count("SELECT count(*) AS n FROM memory_revoke_jobs WHERE revoke_id<>50"), "no revoke of any kind").toBe(0);
  });

  it("a lifecycle card that quotes revoked content is withheld itself; the owner's turn is untouched", () => {
    const T = "lifecycle-quotes-revoked";
    appendMessage(E, owner("e1"));
    appendMessage(E, { id: "e2", role: "bot", kind: "text", text: "secret", at: Date.now(), parentId: "e1", turnId: "run-turn" });
    new WritetimeFixture(database()).denyLine(E, lsnOf(E, "e2"), 77); // the run's reply was forgotten (its job is gone)
    appendMessage(T, owner("u1"));
    appendMessage(T, { ...card("running"), parentId: "u1" });
    const turn = ownerTurn(T, "direct");
    const session = sessionRow(T);
    updateMessage(T, { ...card("completed", {}, "secret"), parentId: "u1" });
    expectOwnerTurnUntouched(T, turn, session);
    expect(drainRevokeMarker(database()).pending).toBe(false);
    expect(denyLookup(database(), { threadId: T, lines: [{ messageId: "card", author: "generated" }] }, CONTENT).get("card")?.state, "the card quoting the forgotten reply is withheld").toBe("withheld");
    expectOwnerTurnUntouched(T, turn, session);
    expect(denyLookup(database(), { threadId: T, lines: [{ messageId: "u1", author: "owner" }] }, CONTENT).get("u1")?.state).toBe("shown");
  });

  it("an engine's own generated line still carries its turn and inherits its pending parent", () => {
    const T = "engine-line";
    const R = pendingParent();
    appendMessage(T, owner("u1"));
    const turn = ownerTurn(T, "direct");
    const reply: Message = { id: "r1", role: "bot", kind: "text", text: "hel", at: Date.now(), parentId: "u1", turnId: "provider-turn" };
    appendMessage(T, reply);
    updateMessage(T, { ...reply, text: "hello" }); // streamed growth inside its turn
    const at = lsnOf(T, "r1");
    expect(sessionRow(T).l, "the reply advanced its own session").toBe(at);
    expect(database().prepare("SELECT since_lsn AS s FROM memory_deny_pending WHERE thread_id=? AND revoke_id=?").get(T, R), "the turn is held from the reply that carried it, above its prompt's head (1.0.2 Keep all P0)").toEqual({ s: at });
    expect(at).toBeGreaterThan(turn.turnLsn);
    expect(denyLookup(database(), { threadId: T, lines: [{ messageId: "r1", author: "generated" }] }, CONTENT).get("r1")?.state).toBe("checking");
  });

  // The same bot's earlier turn (never closed: a dispatch supersedes it) and the newer one its next dispatch opened, both open while the
  // newer prompt is built. A late line of the earlier turn used to merge the two (runningTurnFor over every open turn of the member) and so
  // made the newer turn an inherit child at the older turn's position: its prompt read "checking" and the dispatch was refused.
  /** bot-a's earlier turn (provider turn prov-1, handed p1, its reply r0 written) and its newer turn (prov-2, session s-own); then the
   * forget of p1 starts walking. */
  function twoTurns(T: string): { older: TurnLineage; newer: TurnLineage } {
    appendMessage(P, owner("p1"));
    appendMessage(T, owner("u1"));
    const older = openTurnLineage(database(), { threadId: T, turnId: memberTurnId("bot-a") });
    opened.push(older);
    addTurnParents(older, [{ kind: "line", threadId: P, messageId: "p1" }]);
    bindProviderTurn(older, "prov-1");
    appendMessage(T, { id: "r0", role: "bot", kind: "text", text: "earlier reply", at: Date.now(), parentId: "u1", turnId: "prov-1" });
    appendMessage(T, owner("u2", { parentId: "r0" }));
    const newer = openTurnLineage(database(), { threadId: T, turnId: memberTurnId("bot-a") });
    opened.push(newer);
    tx(() => writeSessionLineage(database(), { threadId: T, driverInstance: "claude", nativeSession: "s-own" }, newer));
    bindProviderTurn(newer, "prov-2");
    pendingWindow(); // the forget of p1 starts walking while both turns are open
    return { older, newer };
  }
  const turnCarries = (T: string) => [...new Set(database().prepare("SELECT c.child_ref AS ref FROM memory_lineage_carry c JOIN memory_thread_no k ON k.no=c.child_thread_no WHERE k.thread_id=? AND c.child_kind=1").all(T).map(row => String((row as { ref: string }).ref)))].sort();
  const promptShown = (T: string, turn: TurnLineage) => refsLookup(database(), [{ kind: "prefix", threadId: T, headLsn: turn.turnLsn }], CONTENT);

  for (const kind of ["stop", "error"] as const) it(`a ${kind} line written while the same bot has two open turns makes neither turn a child and causes no refusal`, () => {
    const T = `two-turns-${kind}`;
    const { older, newer } = twoTurns(T);
    const before = turnCarries(T);
    const session = sessionRow(T);
    // the line the event fold writes for the earlier provider turn's end (index.ts pushMessage stamps every such chip)
    const tool = kind === "stop" ? { name: TURN_STOPPED_NOTE, ok: true } : { name: "error: the engine stopped answering", ok: false };
    appendMessage(T, murageLine({ id: `late-${kind}`, role: "bot" as const, kind: "activity" as const, at: Date.now(), parentId: "u2", turnId: "prov-1", tool }));
    expect(turnCarries(T), "no turn was made a child").toEqual(before);
    expect(promptShown(T, newer), "the newer prompt still reads shown: no refusal").toEqual({ state: "shown" });
    expect(promptShown(T, older)).toEqual({ state: "shown" });
    expect(count("SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id=? AND since_lsn<=?", T, String(newer.turnLsn)), "no hold on either prompt").toBe(0);
    expect(count("SELECT count(*) AS n FROM memory_deny_session WHERE thread_id=?", T), "no deny_session").toBe(0);
    expect(sessionRow(T), "the line advanced no session").toEqual(session);
    // it still rests on what the turn it reports on was shown, as its own refs: held itself while that revoke walks
    expect(denyLookup(database(), { threadId: T, lines: [{ messageId: `late-${kind}`, author: "generated" }] }, CONTENT).get(`late-${kind}`)?.state).toBe("checking");
  });

  it("a line no turn id names, written while the same bot has two open turns, is attached to neither (no merge of the bot's open turns)", () => {
    const T = "two-turns-unnamed";
    const { newer } = twoTurns(T);
    const before = turnCarries(T);
    const session = sessionRow(T);
    appendMessage(T, { id: "unnamed", role: "bot", kind: "activity", at: Date.now(), parentId: "u2", tool: { name: "error: provider stop is unconfirmed", ok: false } });
    expect(turnCarries(T)).toEqual(before);
    expect(promptShown(T, newer)).toEqual({ state: "shown" });
    expect(count("SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id=? AND since_lsn<=?", T, String(newer.turnLsn))).toBe(0);
    expect(sessionRow(T)).toEqual(session);
  });

  it("with two open turns an engine line inherits through the exact turn its provider turn names, never the earlier one", () => {
    const T = "two-turns-engine";
    const R = pendingParent();
    appendMessage(P, owner("p2", { parentId: "p1" }));
    appendMessage(T, owner("u1"));
    const older = openTurnLineage(database(), { threadId: T, turnId: memberTurnId("bot-a") });
    opened.push(older);
    addTurnParents(older, [{ kind: "line", threadId: P, messageId: "p2" }]);
    bindProviderTurn(older, "prov-1");
    appendMessage(T, owner("u2", { parentId: "u1" }));
    const newer = openTurnLineage(database(), { threadId: T, turnId: memberTurnId("bot-a") });
    opened.push(newer);
    tx(() => writeSessionLineage(database(), { threadId: T, driverInstance: "claude", nativeSession: "s-own" }, newer));
    addTurnParents(newer, [{ kind: "line", threadId: P, messageId: "p1" }]);
    bindProviderTurn(newer, "prov-2");
    expect(older.turnLsn).toBeLessThan(newer.turnLsn);
    const reply: Message = { id: "r2", role: "bot", kind: "text", text: "new", at: Date.now(), parentId: "u2", turnId: "prov-2" };
    appendMessage(T, reply);
    updateMessage(T, { ...reply, text: "newer reply" });
    expect(turnCarries(T), "the newer turn is the reply's turn child, the earlier is not").toEqual([turnChildRef(newer.turnLsn)]);
    expect(sessionRow(T).l, "the reply advanced its own session").toBe(lsnOf(T, "r2"));
    expect(database().prepare("SELECT since_lsn AS s FROM memory_deny_pending WHERE thread_id=? AND revoke_id=?").get(T, R), "held from the newer turn's reply, above its prompt's head (1.0.2 Keep all P0)").toEqual({ s: lsnOf(T, "r2") });
    expect(promptShown(T, older), "the earlier prompt is not held").toEqual({ state: "shown" });
    expect(denyLookup(database(), { threadId: T, lines: [{ messageId: "r2", author: "generated" }] }, CONTENT).get("r2")?.state).toBe("checking");
  });
});
