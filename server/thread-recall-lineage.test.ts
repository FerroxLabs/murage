// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Thread recall building blocks (THREAD-RECALL-DESIGN r6 rules 11(a), 12, 13): recordTurnReads, isTurnOpen and sourcesRoom.
// (revokeInternalGeneration dropping its own turnOutputRoots entry lives in index.ts and is covered by its two-line guard only.)
import { mkdirSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const { DATA_DIR } = await import("./config.ts");
const { closeDatabase, database, transaction } = await import("./database.ts");
const { appendMessage, closeMessageDb } = await import("./message-db.ts");
const { sessionChildRef } = await import("./memory/lineage-types.ts");
const {
  closeTurnLineage, currentTurnLineage, isTurnOpen, memberTurnId, openTurnLineage, recordTurnReads, supersedeMemberTurns, writeSessionLineage,
} = await import("./memory/lineage-write.ts");
const { addSourcesToRunningTurn, sourcesRoom } = await import("./steer-lineage.ts");
import type { Message } from "./store.ts";
import type { LineageRef } from "./memory/lineage-types.ts";
import type { RunningTurnLineage, ShownLine } from "./steer-lineage.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
afterAll(() => closeMessageDb());

type Row = Record<string, unknown>;
const db = () => database();
const msg = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text: id, at: Date.now(), ...extra });
const line = (threadId: string, messageId: string): LineageRef => ({ kind: "line", threadId, messageId });
const S1 = { threadId: "chat", driverInstance: "claude", nativeSession: "S1" };
const S2 = { threadId: "chat", driverInstance: "codex", nativeSession: "S2" };
/** Carry rows onto a session child, with their parent thread by name. */
const sessionCarries = (s: { driverInstance: string; nativeSession: string }) =>
  db().prepare("SELECT p.thread_id AS parent_thread,c.from_lsn,c.to_lsn FROM memory_lineage_carry c JOIN memory_thread_no p ON p.no=c.parent_thread_no WHERE c.child_kind=2 AND c.child_ref=? ORDER BY 1,2,3").all(sessionChildRef(s.driverInstance, s.nativeSession)) as Row[];
const carryCount = () => Number((db().prepare("SELECT COUNT(*) AS n FROM memory_lineage_carry").get() as Row).n);
const sessionRows = () => db().prepare("SELECT driver_instance,native_session,first_lsn,last_lsn FROM memory_session_lineage ORDER BY 1,2").all() as Row[];

beforeEach(() => {
  closeMessageDb(); closeDatabase();
  removeTempDirSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
  for (const thread of ["chat", "other"]) { let turn; while ((turn = currentTurnLineage(thread))) closeTurnLineage(turn); }
});

describe("recordTurnReads (rule 11a)", () => {
  function setup() {
    appendMessage("other", msg("x1"));
    appendMessage("other", msg("x2"));
    appendMessage("chat", msg("o1", { role: "user" }));
    const turn = openTurnLineage(db(), { threadId: "chat", turnId: memberTurnId("bot") });
    return turn;
  }

  it("carries every ref onto every session of the turn (resumed and session.started), additive and idempotent", () => {
    const turn = setup();
    transaction(tx => { writeSessionLineage(tx, S1, turn); writeSessionLineage(tx, S2, turn); }); // a resumed session, and one registered at session.started
    expect(sessionCarries(S1)).toEqual([]);
    expect(transaction(tx => recordTurnReads(tx, turn, [line("other", "x1")]))).toBe(true);
    const one = sessionCarries(S1);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ parent_thread: "other" });
    expect(sessionCarries(S2)).toEqual(one);
    expect(turn.parents).toEqual([]); // never adds the refs to the turn
    // a second call: more refs add rows, the same refs add nothing
    const before = carryCount();
    expect(transaction(tx => recordTurnReads(tx, turn, [line("other", "x1")]))).toBe(true);
    expect(carryCount()).toBe(before);
    expect(transaction(tx => recordTurnReads(tx, turn, [line("other", "x2"), line("other", "x1")]))).toBe(true);
    for (const s of [S1, S2]) {
      const rows = sessionCarries(s);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.every(row => row.parent_thread === "other")).toBe(true);
      expect(Math.max(...rows.map(row => Number(row.to_lsn)))).toBeGreaterThan(Number(one[0]!.from_lsn) - 1);
    }
    expect(sessionCarries(S1)).toEqual(sessionCarries(S2));
    const rows = sessionRows();
    expect(rows).toHaveLength(2);
    expect(rows.every(row => Number(row.first_lsn) === turn.turnLsn)).toBe(true);
  });

  it("a carry statement that throws returns false and leaves the carry and session tables unchanged", () => {
    const turn = setup();
    transaction(tx => { writeSessionLineage(tx, S1, turn); });
    const carriesBefore = carryCount(), sessionsBefore = sessionRows();
    let inside: { ok: boolean; carries: number; sessions: Row[] } | undefined;
    expect(() => transaction(tx => {
      const failing = new Proxy(tx, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop === "prepare") return (sql: string) => { if (/INTO memory_lineage_carry/.test(sql)) throw new Error("carry failed"); return target.prepare(sql); };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      appendMessage("other", msg("x3"));
      const ok = recordTurnReads(failing, turn, [line("other", "x1"), line("other", "x3")]);
      inside = { ok, carries: carryCount(), sessions: sessionRows() };
      throw new Error("handler throws on false");
    })).toThrow("handler throws on false");
    expect(inside?.ok).toBe(false);
    expect(inside?.carries).toBe(carriesBefore);
    expect(inside?.sessions).toEqual(sessionsBefore);
    expect(carryCount()).toBe(carriesBefore);
  });

  it("a turn with no established session returns true and writes nothing", () => {
    const turn = setup();
    const before = carryCount();
    expect(transaction(tx => recordTurnReads(tx, turn, [line("other", "x1")]))).toBe(true);
    expect(carryCount()).toBe(before);
    expect(sessionRows()).toEqual([]);
  });
});

describe("isTurnOpen (rule 12)", () => {
  it("is true for the open turn object only", () => {
    const turn = openTurnLineage(db(), { threadId: "chat", turnId: memberTurnId("bot") });
    expect(isTurnOpen(turn)).toBe(true);
    expect(isTurnOpen({ ...turn })).toBe(false); // same ids, another object
    closeTurnLineage(turn);
    expect(isTurnOpen(turn)).toBe(false);
  });
  it("is false for a superseded turn and true for the one that superseded it", () => {
    const older = openTurnLineage(db(), { threadId: "chat", turnId: memberTurnId("bot") });
    const newer = openTurnLineage(db(), { threadId: "chat", turnId: memberTurnId("bot") });
    expect(isTurnOpen(older)).toBe(true);
    supersedeMemberTurns(newer);
    expect(isTurnOpen(older)).toBe(false);
    expect(isTurnOpen(newer)).toBe(true);
  });
});

describe("sourcesRoom (rule 13)", () => {
  const shown = (threadId: string, id: string, role = "bot"): ShownLine => ({ threadId, id, role });
  const lineageOf = (extra: Partial<RunningTurnLineage> = {}): RunningTurnLineage => ({
    roots: { roots: new Set(), over: false }, instanceId: "claude", botId: "bot", generation: "g", turn: { threadId: "chat", turnId: "t", turnLsn: 0, parents: [], denyGeneration: 0 },
    sources: [shown("other", "k1")], ...extra,
  });

  it("counts what addSourcesToRunningTurn then names, and changes nothing", () => {
    const lineage = lineageOf();
    const lines = [shown("other", "k1"), shown("other", "a"), shown("other", "a"), shown("other", "b"), shown("other", "u", "user")];
    const snapshot = JSON.stringify(lineage);
    expect(sourcesRoom(lineage, lines)).toBe(2);
    expect(JSON.stringify(lineage)).toBe(snapshot);
    addSourcesToRunningTurn(lineage, lines);
    expect((lineage.sources as ShownLine[]).length).toBe(3);
  });

  it("does not count a line a held range places", () => {
    appendMessage("chat", msg("m1"));
    appendMessage("chat", msg("m2"));
    const position = Number((db().prepare("SELECT rowid AS p FROM messages WHERE thread_id='chat' AND id='m2'").get() as Row).p);
    const lineage = lineageOf({ ranges: [{ threadId: "chat", upTo: "m2", since: "m1", position } as never] });
    const lines = [shown("chat", "m1"), shown("chat", "m2"), shown("chat", "gone"), shown("other", "z")];
    const room = sourcesRoom(lineage, lines);
    expect(room).toBe(2); // "gone" has no stored position, so it is named; m1 and m2 are inside the range
    const before = (lineage.sources as ShownLine[]).length;
    addSourcesToRunningTurn(lineage, lines);
    expect((lineage.sources as ShownLine[]).length - before).toBe(room);
  });

  it("is 0 when sources are not established", () => {
    expect(sourcesRoom(lineageOf({ sources: "over" }), [shown("other", "a")])).toBe(0);
    expect(sourcesRoom(lineageOf({ sources: undefined }), [shown("other", "a")])).toBe(0);
    expect(sourcesRoom(undefined, [shown("other", "a")])).toBe(0);
  });
});
