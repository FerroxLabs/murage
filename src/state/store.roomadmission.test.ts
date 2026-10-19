// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ROOM-ORDER-DESIGN (r1-r3), client half: one server number orders every room statement, removal and roster row; the reducer is the only
// judge (`admitRoom`, `admitRoomRemoval`). Each regression is named by the round and finding Astra raised it in. The randomized order
// test is src/state/store.order.test.ts.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allHeldTasks } from "@/lib/task-window";
import { hiddenPatchFrom } from "@/lib/record-numbers";
import { ANSWER_TTL_MS, answerClock, asAnswer, fromAnswer, tagAnswer, sentAtOf } from "./answer-tag";
import { admitRoom, admitRoomRemoval, initialState, reducer, type Action, type AppState, type Group, type GroupTask } from "./store";
import { httpNow } from "./test-origins";
import { nextPage, transcriptState } from "./transcript-seq";

const E1 = "e1";
const E2 = "e2";
const ID = "ops-room";

const room = (seq: number | undefined, extra: Record<string, unknown> = {}, epoch = E1): Group => ({
  id: ID, threadId: `${ID}-thread`, name: "Operations", memberIds: ["x"], defaultResponder: { kind: "everyone" }, bulletin: "",
  unread: false, createdAt: 1, section: "Operations", ...(seq === undefined ? {} : { recordSeq: seq, recordEpoch: epoch }), ...extra,
}) as unknown as Group;
const roster = (rooms: Group[], extra: Record<string, unknown> = {}): Action =>
  ({ type: "hydrate", ...httpNow, bots: [], groups: rooms, computerControl: {}, tasksEpoch: E1, removed: [], ...extra }) as Action;
const answer = (group: object, extra: Record<string, unknown> = {}): Action => ({ type: "groupPatched", origin: httpNow, group, ...extra }) as Action;
const frame = (group: object): Action => ({ type: "groupPatched", origin: { source: "stream" }, group }) as Action;
const gone = (seq: number | undefined, epoch: string | undefined = E1, extra: Record<string, unknown> = {}, origin: unknown = { source: "stream" }, id = ID): Action =>
  ({ type: "groupDeleted", origin, groupId: id, ...(seq === undefined ? {} : { recordSeq: seq }), ...(epoch === undefined ? {} : { recordEpoch: epoch }), ...extra }) as Action;
const held = (state: AppState, id = ID) => state.groups.find((g) => g.id === id);
/** A client holding the room at e1/seq, its roster built at the room clock `seq`. */
const withRoom = (seq = 4, extra: Record<string, unknown> = {}) => reducer(initialState, roster([room(seq, extra)], { sentTick: 0, roomClock: seq }));
const task = (i: number, extra: Record<string, unknown> = {}): GroupTask => ({ threadId: `t${i}`, title: `T${i}`, createdAt: 100 - i, ...extra }) as GroupTask;
const cursorOf = (t: GroupTask) => `${t.createdAt}:${t.threadId}`;

const realNow = answerClock.now;
afterEach(() => { answerClock.now = realNow; vi.restoreAllMocks(); });

describe("the named regressions (Astra r2, r3, r4)", () => {
  it("Astra r2 H2: a rename answer delayed past another window's delete+archive never brings the team back through its channel", () => {
    let state = withRoom();
    expect(held(state)).toMatchObject({ section: "Operations", recordSeq: 4 });
    // the other window's delete+archive: the channel's frame at 6 (the store omits the cleared team; hidden is set)
    state = reducer(state, frame({ ...room(6, { hidden: true }), section: undefined }));
    expect(held(state)).toMatchObject({ hidden: true, recordSeq: 6 });
    expect(held(state)?.section).toBeUndefined();
    // the delayed rename answer: the team route's row at 5
    state = reducer(state, answer({ id: ID, name: "Ops Crew", section: "Ops Crew", hidden: undefined, recordSeq: 5, recordEpoch: E1 }));
    expect(held(state)).toMatchObject({ hidden: true, name: "Operations", recordSeq: 6 });
    expect(held(state)?.section).toBeUndefined();
    // the same row past the held number applies, as every frame does
    state = reducer(state, answer({ id: ID, name: "Ops Crew", section: "Ops Crew", hidden: undefined, recordSeq: 7, recordEpoch: E1 }));
    expect(held(state)).toMatchObject({ name: "Ops Crew", section: "Ops Crew", recordSeq: 7 });
    expect(held(state)?.hidden).toBeUndefined();
  });

  it("Astra r3 H1: a restore callback keeps its numbers (hiddenPatchFrom), so a delayed restore at 5 cannot undo the archive at 6", () => {
    let state = withRoom();
    state = reducer(state, frame(room(6, { hidden: true })));
    state = reducer(state, answer(hiddenPatchFrom(ID, { id: ID, hidden: false, recordSeq: 5, recordEpoch: E1 })));
    expect(held(state)).toMatchObject({ hidden: true, recordSeq: 6 });
    state = reducer(state, answer(hiddenPatchFrom(ID, { id: ID, hidden: false, recordSeq: 7, recordEpoch: E1 })));
    expect(held(state)?.hidden).toBeUndefined();
  });

  it("Astra r3 H2: a deleted room does not reappear from a whole answer built before the deletion (the deletion takes a number)", () => {
    let state = withRoom();
    state = reducer(state, frame(room(6)));
    state = reducer(state, gone(7));
    expect(held(state)).toBeUndefined();
    expect(state.roomTombstones?.[ID]).toMatchObject({ epoch: E1, seq: 7, kind: "deleted", streamAcked: true });
    state = reducer(state, answer({ ...room(5), name: "from before the delete" }));
    expect(held(state)).toBeUndefined();
    state = reducer(state, answer(room(7)));
    expect(held(state)).toBeUndefined();
  });

  it("Astra r3 H3: a numbered answer from a run this client already left is stale whatever is held", () => {
    let state = withRoom();
    state = reducer(state, roster([room(0, {}, E2)], { tasksEpoch: E2, roomClock: 0, sentTick: state.admitTick }));
    expect(held(state)).toMatchObject({ recordEpoch: E2, recordSeq: 0 });
    state = reducer(state, answer({ id: ID, name: "late from e1", recordSeq: 9, recordEpoch: E1 }));
    expect(held(state)).toMatchObject({ name: "Operations", recordEpoch: E2 });
  });

  it("Astra r4 H1: a delayed DELETE answer of the old run removes nothing from the restored room; an unnumbered one removes nothing and asks for the roster", () => {
    let state = withRoom(5);
    state = reducer(state, gone(6));
    // the same id is back through a fresh e2/0 roster (a restart); the tombstone of the earlier run does not fence it
    state = reducer(state, roster([room(0, {}, E2)], { tasksEpoch: E2, roomClock: 0, sentTick: state.admitTick }));
    expect(held(state)).toBeDefined();
    const delayed = reducer(state, gone(7, E1, {}, httpNow));
    expect(held(delayed)).toBeDefined();
    expect(delayed.reconcileRequested).toBe(state.reconcileRequested);
    // an older server's answer carries no number: against a numbered run nothing is removed and the roster is read again
    const unnumbered = reducer(state, gone(undefined, undefined, {}, httpNow));
    expect(held(unnumbered)).toBeDefined();
    expect(unnumbered.reconcileRequested).toBe((state.reconcileRequested ?? 0) + 1);
    // the hydrate at e2 applies
    expect(held(reducer(state, roster([room(0, { name: "After" }, E2)], { tasksEpoch: E2, roomClock: 0, sentTick: state.admitTick })))?.name).toBe("After");
  });

  it("Astra r4 H2a: an e1 answer outlives e1's retirement by one minute at most, and by then it is expired and dropped", () => {
    answerClock.now = () => 500;
    const body = asAnswer({ group: { id: ID, name: "late e1 rename", recordSeq: 9, recordEpoch: E1 } });
    answerClock.now = () => 1_000;
    let state = withRoom();
    state = reducer(state, roster([room(0, {}, E2)], { tasksEpoch: E2, roomClock: 0, sentTick: state.admitTick }));
    expect(state.pastEpochs?.map((entry) => entry.epoch)).toEqual([E1]);
    answerClock.now = () => 1_000 + ANSWER_TTL_MS + 1;
    state = reducer(state, { type: "tombstonesSweep", now: answerClock.now() });
    expect(state.pastEpochs).toEqual([]);
    state = reducer(state, { type: "groupPatched", origin: fromAnswer(body.group), group: body.group });
    expect(held(state)?.name).toBe("Operations");
    expect(state.reconcileRequested).toBe(1);
  });

  it("Astra r4 H2b: a whole answer sent before the deletion is expired by the time the tombstone retires", () => {
    answerClock.now = () => 900;
    const body = asAnswer({ group: { ...room(5), name: "from before the delete" } });
    answerClock.now = () => 1_000;
    let state = withRoom(4);
    state = reducer(state, gone(6));
    const later = 1_000 + ANSWER_TTL_MS + 1;
    answerClock.now = () => later;
    state = reducer(state, { type: "tombstonesSweep", now: later });
    expect(state.roomTombstones?.[ID]).toBeUndefined();
    state = reducer(state, { type: "groupPatched", origin: fromAnswer(body.group), group: body.group });
    expect(held(state)).toBeUndefined();
  });

  it("Astra r4 M1: 300 deletions evict nothing; a delayed same-run record of the first is still dropped", () => {
    const rooms = Array.from({ length: 300 }, (_, i) => room(i + 1, { id: `r${i}`, threadId: `r${i}-t` }));
    let state = reducer(initialState, roster(rooms, { sentTick: 0, roomClock: 300 }));
    for (let i = 0; i < 300; i += 1) state = reducer(state, gone(301 + i, E1, {}, { source: "stream" }, `r${i}`));
    expect(state.groups).toHaveLength(0);
    expect(Object.keys(state.roomTombstones ?? {})).toHaveLength(300);
    state = reducer(state, answer({ ...rooms[0]!, name: "late" }));
    expect(state.groups).toHaveLength(0);
  });
});

describe("the judge, step by step (ROOM-ORDER-DESIGN §2.2, §2.3)", () => {
  const base = () => withRoom(4);
  const verdict = (state: AppState, input: object, origin: unknown = httpNow) => admitRoom(state, input as never, origin as never);

  it("step 0: an expired answer is dropped and asks for the roster; a stream frame has no life", () => {
    const out = verdict(base(), room(9), { ...httpNow, expired: true });
    expect(out.verdict).toBe("drop");
    expect(out.state.reconcileRequested).toBe(1);
    expect(verdict(base(), room(9), { source: "stream" }).verdict).toBe("newer");
  });

  it("step 1: no run known (an older server) is today's merge, no tombstones", () => {
    expect(admitRoom(initialState, room(undefined), httpNow).verdict).toBe("legacy");
    const state = reducer({ ...initialState, groups: [room(undefined)] }, gone(undefined, undefined, {}, httpNow));
    expect(held(state)).toBeUndefined();
    expect(state.roomTombstones).toBeUndefined();
  });

  it("step 2 (r2 M2): an unnumbered statement in a numbered run is dropped and the roster re-read, held or not", () => {
    const heldOut = verdict(base(), { id: ID, name: "x" });
    expect(heldOut.verdict).toBe("drop");
    expect(heldOut.state.reconcileRequested).toBe(1);
    const unheld = verdict(base(), { ...room(undefined), id: "other" });
    expect(unheld.verdict).toBe("drop");
    expect(unheld.state.reconcileRequested).toBe(1);
  });

  it("step 3: a tombstone drops a number at or below it, a later one clears it; an earlier run's is cleared by the current run; a past or unknown run drops", () => {
    let state = reducer(base(), gone(7));
    expect(verdict(state, room(7)).verdict).toBe("drop");
    expect(verdict(state, room(6)).verdict).toBe("drop");
    const back = verdict(state, room(8));
    expect(back.verdict).toBe("insert");
    expect(back.state.roomTombstones?.[ID]).toBeUndefined();
    // unknown run: dropped and the roster read again
    const unknown = verdict(state, room(1, {}, "e9"));
    expect(unknown.verdict).toBe("drop");
    expect(unknown.state.reconcileRequested).toBe(1);
    // the run moves on: e1 is past, e2 current; the e1 tombstone is the roster's to decide, so e2's whole record clears it
    state = reducer(state, roster([], { tasksEpoch: E2, roomClock: 0, sentTick: state.admitTick }));
    expect(verdict(state, room(3, {}, E1)).verdict).toBe("drop");
    const next = verdict(state, room(1, {}, E2));
    expect(next.verdict).toBe("insert");
    expect(next.state.roomTombstones?.[ID]).toBeUndefined();
  });

  it("step 4: a past run is stale, an unknown one dropped with a reconcile, the current one continues", () => {
    let state = reducer(base(), roster([room(0, {}, E2)], { tasksEpoch: E2, roomClock: 0, sentTick: 0 }));
    expect(verdict(state, room(9, {}, E1)).verdict).toBe("stale");
    const unknown = verdict(state, room(1, {}, "e9"));
    expect(unknown.verdict).toBe("drop");
    expect(unknown.state.reconcileRequested).toBe(1);
    expect(verdict(state, room(1, {}, E2)).verdict).toBe("newer");
    state = base();
    expect(verdict(state, room(5)).verdict).toBe("newer");
  });

  it("step 5: newer, same, stale against the held copy; a whole unheld record inserts; a partial unheld row is dropped and the roster re-read", () => {
    const state = base();
    expect(verdict(state, room(5)).verdict).toBe("newer");
    expect(verdict(state, room(4)).verdict).toBe("same");
    expect(verdict(state, room(3)).verdict).toBe("stale");
    expect(verdict(state, { ...room(9), id: "fresh" }).verdict).toBe("insert");
    const partial = verdict(state, { id: "fresh", name: "x", recordSeq: 9, recordEpoch: E1 });
    expect(partial.verdict).toBe("drop");
    expect(partial.state.reconcileRequested).toBe(1);
    // a held copy from an earlier run is replaced by the current run's statement
    const moved = { ...state, groups: [room(40, {}, "e0")] };
    expect(verdict(moved, room(1)).verdict).toBe("newer");
  });

  it("step 6: a scoped client removes a hidden room and fences the id at its number; the desktop keeps archived rooms as hidden records", () => {
    const phone = { ...base(), scopedClient: true };
    const hidden = reducer(phone, frame(room(6, { hidden: true })));
    expect(held(hidden)).toBeUndefined();
    expect(hidden.roomTombstones?.[ID]).toMatchObject({ seq: 6, kind: "hidden", streamAcked: true });
    expect(held(reducer(base(), frame(room(6, { hidden: true }))))).toMatchObject({ hidden: true });
    // a partial restore for a room the phone dropped: dropped, and the roster read again so the room shows without a reload
    const restore = reducer(hidden, answer({ id: ID, hidden: undefined, recordSeq: 8, recordEpoch: E1 }));
    expect(held(restore)).toBeUndefined();
    expect(restore.reconcileRequested).toBe(1);
    // the whole record past the tombstone brings it back
    expect(held(reducer(hidden, answer(room(8))))).toBeDefined();
  });

  const removal = (state: AppState, input: Record<string, unknown>, origin: unknown = { source: "stream" }) => admitRoomRemoval(state, { groupId: ID, ...input }, origin as never);

  it("removal steps 0-4: expired, legacy, unnumbered, past and unknown run, current run (tombstone acked only by the stream)", () => {
    const state = withRoom(4);
    expect(removal(state, { recordSeq: 5, recordEpoch: E1 }, { ...httpNow, expired: true }).reconcileRequested).toBe(1);
    expect(held(removal(state, { recordSeq: 5, recordEpoch: E1 }, { ...httpNow, expired: true }))).toBeDefined();
    expect(held(admitRoomRemoval({ ...initialState, groups: [room(undefined)] }, { groupId: ID }, httpNow))).toBeUndefined();
    const unnumbered = removal(state, {}, httpNow);
    expect(held(unnumbered)).toBeDefined();
    expect(unnumbered.reconcileRequested).toBe(1);
    const moved = reducer(state, roster([room(0, {}, E2)], { tasksEpoch: E2, roomClock: 0, sentTick: 0 }));
    expect(held(removal(moved, { recordSeq: 9, recordEpoch: E1 }))).toBeDefined();
    expect(removal(moved, { recordSeq: 9, recordEpoch: "e9" }).reconcileRequested).toBe(1);
    const viaAnswer = removal(state, { recordSeq: 5, recordEpoch: E1 }, httpNow);
    expect(held(viaAnswer)).toBeUndefined();
    expect(viaAnswer.roomTombstones?.[ID]).toMatchObject({ seq: 5, kind: "deleted", streamAcked: false });
    // the frame for the same deletion acks it; a hide never outranks a deletion
    const acked = removal(viaAnswer, { recordSeq: 5, recordEpoch: E1 });
    expect(acked.roomTombstones?.[ID]).toMatchObject({ seq: 5, kind: "deleted", streamAcked: true });
    expect(removal(acked, { recordSeq: 6, recordEpoch: E1, hidden: true }).roomTombstones?.[ID]).toMatchObject({ seq: 6, kind: "deleted" });
  });

  it("r2 M1: a scoped removal below the held copy's number (a restore that already landed) changes nothing, selection included", () => {
    let state: AppState = { ...withRoom(4), scopedClient: true };
    state = reducer(state, frame(room(9)));
    state = { ...state, selectedId: ID };
    const out = removal(state, { recordSeq: 6, recordEpoch: E1, hidden: true });
    expect(out).toBe(state);
  });
});

describe("F3: history outlives every answer it orders (independent clocks)", () => {
  it("property: with the answer clock the only clock, no answer that passes step 0 finds its tombstone retired (2,000 schedules)", () => {
    let seed = 0x2f6e2b1;
    const rnd = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    for (let run = 0; run < 2_000; run += 1) {
      const td = 1 + rnd(2 * ANSWER_TTL_MS);
      const ts = rnd(td + 1);
      const ta = td + rnd(2 * ANSWER_TTL_MS);
      const sweeps = [0, 1, 2].map(() => td + rnd(ta - td + ANSWER_TTL_MS + 1));
      // the wall clock jumps wherever it likes: nothing admission-related may read it
      vi.spyOn(Date, "now").mockImplementation(() => rnd(2 ** 40));
      answerClock.now = () => 0;
      let state = withRoom(4);
      answerClock.now = () => ts;
      const body = asAnswer({ group: { ...room(6), name: "built before the delete" } }, ts);
      const events: Array<{ at: number; kind: "delete" | "sweep" | "arrive" }> = [{ at: td, kind: "delete" }, { at: ta, kind: "arrive" }, ...sweeps.map((at) => ({ at, kind: "sweep" as const }))];
      events.sort((a, b) => a.at - b.at || (a.kind === "arrive" ? 1 : b.kind === "arrive" ? -1 : a.kind === "delete" ? -1 : 1));
      for (const event of events) {
        answerClock.now = () => event.at;
        if (event.kind === "delete") state = reducer(state, gone(7));
        else if (event.kind === "sweep") state = reducer(state, { type: "tombstonesSweep", now: event.at });
        else state = reducer(state, { type: "groupPatched", origin: fromAnswer(body.group), group: body.group });
      }
      expect(held(state), `run ${run}: td=${td} ts=${ts} ta=${ta}`).toBeUndefined();
      vi.restoreAllMocks();
    }
  });
});

describe("hydrate (ROOM-ORDER-DESIGN §2.4, r3 R5)", () => {
  it("removedGroups become tombstones written before the rows, acked once the buffered frames drained; the held copy of that room goes", () => {
    let state = withRoom(3);
    state = reducer(state, roster([], { removedGroups: [{ id: ID, recordSeq: 5, recordEpoch: E1, kind: "deleted" }], roomClock: 5, sentTick: state.admitTick }));
    expect(held(state)).toBeUndefined();
    expect(state.roomTombstones?.[ID]).toMatchObject({ seq: 5, kind: "deleted", streamAcked: false, ackOnDrain: true });
    state = reducer(state, { type: "streamDrained" });
    expect(state.roomTombstones?.[ID]?.streamAcked).toBe(true);
    // retired only once acked and older than the TTL
    answerClock.now = () => ANSWER_TTL_MS * 3;
    expect(reducer(state, { type: "tombstonesSweep", now: answerClock.now() }).roomTombstones?.[ID]).toBeUndefined();
  });

  it("r2 M3: an unacked tombstone of the current run survives the sweep; the hydrate acks only what was written before it was asked for", () => {
    answerClock.now = () => 1_000;
    let state = withRoom(3);
    state = reducer(state, gone(5, E1, {}, httpNow));
    expect(state.roomTombstones?.[ID]).toMatchObject({ streamAcked: false });
    const later = 1_000 + ANSWER_TTL_MS + 1;
    expect(reducer(state, { type: "tombstonesSweep", now: later }).roomTombstones?.[ID]).toBeDefined();
    const rosterAsked = reducer(state, roster([], { roomClock: 5, sentTick: state.admitTick }));
    expect(rosterAsked.roomTombstones?.[ID]).toMatchObject({ ackOnDrain: true });
    const written = (rosterAsked.roomTombstones?.[ID]?.tick ?? 0);
    // a tombstone written after the request (tick above sentTick) is not acked by it
    const newer = reducer(state, roster([], { roomClock: 5, sentTick: written - 1 }));
    expect(newer.roomTombstones?.[ID]?.ackOnDrain).toBeUndefined();
  });

  it("a stale row keeps the held copy", () => {
    let state = withRoom(4);
    state = reducer(state, frame(room(9, { name: "Newer" })));
    state = reducer(state, roster([room(6, { name: "Older" })], { roomClock: 6, sentTick: state.admitTick }));
    expect(held(state)).toMatchObject({ name: "Newer", recordSeq: 9 });
  });

  it("an unlisted held room admitted before the roster was asked for is gone, with a horizon tombstone at the roster's clock", () => {
    let state = withRoom(4);
    state = reducer(state, roster([], { roomClock: 12, sentTick: state.admitTick }));
    expect(state.groups).toHaveLength(0);
    expect(state.roomTombstones?.[ID]).toMatchObject({ epoch: E1, seq: 12, kind: "deleted", streamAcked: false, ackOnDrain: true });
    // anything at or below the roster's clock is dropped; a later statement (a restore frame) clears it
    expect(held(reducer(state, answer(room(11))))).toBeUndefined();
    expect(held(reducer(state, frame(room(13))))).toBeDefined();
    // a scoped client's tombstone is a hide
    const phone = reducer({ ...withRoom(4), scopedClient: true }, roster([], { roomClock: 12, sentTick: 99 }));
    expect(phone.roomTombstones?.[ID]?.kind).toBe("hidden");
  });

  it("a room admitted after the roster was asked for (a create during the hydrate) is kept; its own buffered frames settle it", () => {
    let state = withRoom(4);
    const asked = state.admitTick ?? 0;
    state = reducer(state, frame({ ...room(11), id: "fresh", threadId: "fresh-t", name: "Fresh" }));
    state = reducer(state, roster([room(4)], { roomClock: 10, sentTick: asked }));
    expect(held(state, "fresh")).toMatchObject({ name: "Fresh" });
    expect(held(state)).toBeDefined();
    expect(state.roomTombstones?.fresh).toBeUndefined();
  });

  it("a roster of a run this client already left is ignored whole", () => {
    let state = withRoom(4);
    state = reducer(state, roster([room(0, {}, E2)], { tasksEpoch: E2, roomClock: 0, sentTick: 0 }));
    const after = reducer(state, roster([], { tasksEpoch: E1, roomClock: 99, sentTick: 99 }));
    expect(after).toBe(state);
  });

  it("r3 R5: the horizon is the roster's clock, never lowered by a roster delivered out of order, reset by a run change", () => {
    let state = withRoom(4);
    expect(state.roomHorizon).toEqual({ epoch: E1, seq: 4 });
    state = reducer(state, roster([room(4)], { roomClock: 20, sentTick: 0 }));
    expect(state.roomHorizon).toEqual({ epoch: E1, seq: 20 });
    state = reducer(state, roster([room(4)], { roomClock: 9, sentTick: 0 }));
    expect(state.roomHorizon).toEqual({ epoch: E1, seq: 20 });
    state = reducer(state, roster([room(0, {}, E2)], { tasksEpoch: E2, roomClock: 3, sentTick: 0 }));
    expect(state.roomHorizon).toEqual({ epoch: E2, seq: 3 });
  });

  it("r3 R5: a whole record for a room this client does not hold is dropped at or below the horizon, inserted above it; the roster's own rows skip the check", () => {
    let state = withRoom(4);
    state = reducer(state, roster([room(4)], { roomClock: 20, sentTick: state.admitTick }));
    const fresh = (seq: number) => ({ ...room(seq), id: "fresh", threadId: "fresh-t" });
    expect(held(reducer(state, answer(fresh(20))), "fresh")).toBeUndefined();
    expect(held(reducer(state, frame(fresh(20))), "fresh")).toBeUndefined();
    expect(held(reducer(state, answer(fresh(21))), "fresh")).toBeDefined();
    // the roster's own row for a room created after the previous roster is inserted (at most the horizon it carries)
    const next = reducer(state, roster([room(4), fresh(25)], { roomClock: 25, sentTick: state.admitTick }));
    expect(held(next, "fresh")).toBeDefined();
  });

  it("r3 new H1: a roster row at 6 delivered after the DELETE answer at 7 inserts no room, and the tombstone at 7 stays", () => {
    let state = withRoom(4);
    const asked = state.admitTick;
    // the roster is requested; the DELETE answer (e1/7) lands first; then the roster built before the deletion, with the row at 6, lands
    state = reducer(state, gone(7, E1, {}, httpNow));
    expect(held(state)).toBeUndefined();
    state = reducer(state, roster([room(6)], { roomClock: 6, sentTick: asked }));
    expect(held(state)).toBeUndefined();
    expect(state.roomTombstones?.[ID]).toMatchObject({ seq: 7, kind: "deleted" });
  });

  it("r3 new H2: a delayed create answer for a room this client never held is dropped on the horizon alone (clocks driven independently, no server ledger)", () => {
    // the server's ledger window has pruned the deletion: the roster carries no removedGroups, only the clock
    answerClock.now = () => 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => 1_700_000_000_000);
    const create = asAnswer({ group: { ...room(5), id: "made", threadId: "made-t" } }, 9_000);
    let state = reducer(initialState, roster([], { roomClock: 8, sentTick: 0 }));
    // the wall clock jumps two hours, the answer clock advances seconds
    vi.spyOn(Date, "now").mockImplementation(() => 1_700_000_000_000 + 2 * 3_600_000);
    answerClock.now = () => 10_000 + 5_000;
    state = reducer(state, { type: "groupPatched", origin: fromAnswer(create.group), group: create.group });
    expect(held(state, "made")).toBeUndefined();
    expect(state.reconcileRequested ?? 0).toBe(0);
    // a statement made after the roster is not refused
    state = reducer(state, frame({ ...room(9), id: "made", threadId: "made-t" }));
    expect(held(state, "made")).toBeDefined();
  });

  it("r3 R5: POSITIVE_INFINITY is not written by the room admission section, and nothing in it reads the wall clock (static)", () => {
    const text = readFileSync(join(process.cwd(), "src/state/store.tsx"), "utf8");
    const rooms = text.slice(text.indexOf("// ── Room admission"), text.indexOf("// ── end of admission"));
    expect(rooms.length).toBeGreaterThan(1_000);
    expect(rooms).not.toMatch(/POSITIVE_INFINITY|Infinity/);
    const whole = text.slice(text.indexOf("// ── Bot admission"), text.indexOf("// ── end of admission"));
    expect(whole).not.toMatch(/Date\.now/);
    expect(text).toMatch(/type: "tombstonesSweep", now: answerClock\.now\(\)/);
  });
});

describe("a restart, and the statement model (r2 R2, ROOM_SERVER_KEYS)", () => {
  it("r2 R2: after a restart the rooms arrive at (e2, 0); a later rename at 1 applies; a delayed e1 answer is dropped", () => {
    const rooms = ["a", "b", "c", "restored"].map((id) => room(0, { id, threadId: `${id}-t` }, E2));
    let state = withRoom(4);
    state = reducer(state, roster(rooms, { tasksEpoch: E2, roomClock: 0, sentTick: state.admitTick }));
    expect(state.groups.map((g) => g.id)).toEqual(["a", "b", "c", "restored"]);
    expect(state.groups.every((g) => g.recordSeq === 0 && g.recordEpoch === E2)).toBe(true);
    state = reducer(state, answer({ id: "a", name: "Renamed", recordSeq: 1, recordEpoch: E2 }));
    expect(held(state, "a")?.name).toBe("Renamed");
    state = reducer(state, answer({ id: "b", name: "from e1", recordSeq: 99, recordEpoch: E1 }));
    expect(held(state, "b")?.name).toBe("Operations");
  });

  it("r2: a whole statement clears an omitted server key; a partial one sets only the keys it carries; local keys are kept", () => {
    let state = withRoom(4, { bulletin: "Be kind", cwd: "/work", busyBotId: "x", turnStartedAt: 5, channelProject: { goal: "g", status: "active", startedAt: 1, updatedAt: 1 } });
    state = reducer(state, { type: "groupEdited", group: { id: ID, unread: true, setupPending: false } });
    // a partial row sets what it carries
    state = reducer(state, answer({ id: ID, section: "Other", recordSeq: 5, recordEpoch: E1 }));
    expect(held(state)).toMatchObject({ section: "Other", bulletin: "Be kind", cwd: "/work", busyBotId: "x" });
    // a whole statement sets every server key, absent meaning cleared
    const { unread: _unread, ...statement } = room(6);
    state = reducer(state, frame({ ...statement, section: undefined, bulletin: "" }));
    const next = held(state)!;
    expect(next.section).toBeUndefined();
    expect(next.cwd).toBeUndefined();
    expect(next.busyBotId).toBeUndefined();
    expect(next.turnStartedAt).toBeUndefined();
    expect(next.channelProject).toBeUndefined();
    expect(next.bulletin).toBe("");
    // local keys survive both
    expect(next.setupPending).toBe(false);
    expect(next.unread).toBe(true);
  });

  it("r2: transient keys are absent after a restart roster", () => {
    let state = withRoom(4, { busyBotId: "x", turnStartedAt: 5 });
    expect(held(state)?.busyBotId).toBe("x");
    state = reducer(state, roster([room(0, {}, E2)], { tasksEpoch: E2, roomClock: 0, sentTick: state.admitTick }));
    expect(held(state)?.busyBotId).toBeUndefined();
    expect(held(state)?.turnStartedAt).toBeUndefined();
  });

  it("r2 (#2641): an older frame cannot flip a thread's working back; a newer one can", () => {
    let state = withRoom(4, { tasks: [task(0, { working: false })], tasksTotal: 1, tasksOlder: null });
    state = reducer(state, frame(room(6, { tasks: [task(0, { working: true })], tasksTotal: 1, tasksOlder: null })));
    state = reducer(state, frame(room(5, { tasks: [task(0, { working: false })], tasksTotal: 1, tasksOlder: null })));
    expect((held(state)?.tasks?.[0] as unknown as { working: boolean }).working).toBe(true);
    state = reducer(state, frame(room(7, { tasks: [task(0, { working: false })], tasksTotal: 1, tasksOlder: null })));
    expect((held(state)?.tasks?.[0] as unknown as { working: boolean }).working).toBe(false);
  });

  it("r2 (#2662): a bulk-delete answer removes the threads, and the older frame still carrying one is stale", () => {
    let state = withRoom(4, { tasks: [task(0), task(1), task(2)], tasksTotal: 3, tasksOlder: null });
    state = reducer(state, answer(room(8, { tasks: [task(0)], tasksTotal: 1, tasksOlder: null }), { removedTaskIds: ["t1", "t2"] }));
    expect(held(state)?.tasks?.map((t) => t.threadId)).toEqual(["t0"]);
    state = reducer(state, frame(room(7, { tasks: [task(0), task(1), task(2)], tasksTotal: 3, tasksOlder: null })));
    expect(held(state)?.tasks?.map((t) => t.threadId)).toEqual(["t0"]);
  });

  it("r2 M2: groupEdited writes local keys of a held room only; it never inserts, numbers or touches a tombstone", () => {
    let state = withRoom(4, { tasks: [task(0), task(1)], tasksTotal: 2, tasksOlder: null });
    state = reducer(state, { type: "groupEdited", group: { id: ID, tasks: [{ threadId: "t1", unreadCount: 3, unread: true, sending: true }] } });
    expect(held(state)?.tasks?.[1]).toMatchObject({ unreadCount: 3, unread: true, sending: true });
    expect(held(state)).toMatchObject({ recordSeq: 4, recordEpoch: E1 });
    expect(reducer(state, { type: "groupEdited", group: { id: "nobody", unread: true } })).toBe(state);
    const deleted = reducer(state, gone(9));
    expect(reducer(deleted, { type: "groupEdited", group: { id: ID, unread: true } })).toBe(deleted);
    expect(deleted.roomTombstones?.[ID]).toMatchObject({ seq: 9 });
  });
});

describe("a statement's task window is a window, not the list (r3 R6)", () => {
  const rows = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => task(from + i));

  it("a 10-row roster after a 50-row frame removes no task", () => {
    let state = withRoom(4, { tasks: rows(0, 50), tasksTotal: 50, tasksOlder: null });
    state = reducer(state, roster([room(6, { tasks: rows(0, 10), tasksTotal: 50, tasksOlder: cursorOf(task(9)) })], { roomClock: 6, sentTick: state.admitTick }));
    expect(allHeldTasks(held(state)).map((t) => t.threadId).sort()).toEqual(rows(0, 50).map((t) => t.threadId).sort());
    expect(held(state)?.tasks).toHaveLength(10);
  });

  it("a frame whose window covers a held thread and lacks it removes it; an older paged-in row stays", () => {
    const start = reducer(withRoom(4, { tasks: [...rows(0, 5)], tasksTotal: 6, tasksOlder: cursorOf(task(4)), extraTasks: [task(9)] }), { type: "groupEdited", group: { id: ID } });
    const frameRows = [task(0), task(1), task(3), task(4)];
    const state = reducer(start, frame(room(7, { tasks: frameRows, tasksTotal: 6, tasksOlder: cursorOf(task(4)) })));
    expect(allHeldTasks(held(state)).map((t) => t.threadId).sort()).toEqual(["t0", "t1", "t3", "t4", "t9"]);
    // a statement that holds every task (tasksOlder null) leaves no extras
    const whole = reducer(start, frame(room(7, { tasks: frameRows, tasksTotal: 4, tasksOlder: null })));
    expect(allHeldTasks(held(whole)).map((t) => t.threadId).sort()).toEqual(["t0", "t1", "t3", "t4"]);
  });

  it("a bulk-delete answer removes an extraTasks row by removedTaskIds whatever the window", () => {
    let state = withRoom(4, { tasks: rows(0, 3), tasksTotal: 6, tasksOlder: cursorOf(task(2)), extraTasks: [task(9)] });
    state = reducer(state, answer(room(8, { tasks: rows(0, 3), tasksTotal: 5, tasksOlder: cursorOf(task(2)) }), { removedTaskIds: ["t9"] }));
    expect(allHeldTasks(held(state)).map((t) => t.threadId)).not.toContain("t9");
    expect(held(state)?.tasks).toHaveLength(3);
  });

  it("setupPending survives a whole statement (the only writer is a groupEdited)", () => {
    let state = withRoom(4);
    state = reducer(state, { type: "groupEdited", group: { id: ID, setupPending: false } });
    state = reducer(state, frame({ ...room(6), setupPending: true }));
    expect(held(state)).toMatchObject({ setupPending: false, recordSeq: 6 });
    state = reducer(state, roster([room(8)], { roomClock: 8, sentTick: state.admitTick }));
    expect(held(state)?.setupPending).toBe(false);
  });

  it("per-task local keys survive a statement that carries the row (unreadMessageIds, sending)", () => {
    let state = withRoom(4, { tasks: [task(0), task(1)], tasksTotal: 2, tasksOlder: null });
    state = reducer(state, { type: "groupEdited", group: { id: ID, tasks: [{ threadId: "t1", unreadMessageIds: ["m1"], sending: true }] } });
    state = reducer(state, frame(room(6, { tasks: [task(0), task(1, { title: "Renamed" })], tasksTotal: 2, tasksOlder: null })));
    expect(held(state)?.tasks?.[1]).toMatchObject({ title: "Renamed", unreadMessageIds: ["m1"], sending: true });
  });
});

describe("answers are tagged and every dispatch names its origin (static)", () => {
  it("tagAnswer tags group, groups[], changed.groups[] and removedGroups", () => {
    const body = { group: { id: "g" }, groups: [{ id: "a" }], changed: { groups: [{ id: "c" }] }, removedGroups: [{ id: "r" }] };
    tagAnswer(body, 42);
    for (const target of [body.group, body.groups[0], body.changed.groups[0], body.removedGroups[0]]) expect(sentAtOf(target)).toBe(42);
  });

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(process.cwd(), dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(process.cwd(), rel)).isDirectory()) { if (name !== "e2e") walk(rel); continue; }
      if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.spec\.ts$/.test(name)) files.push(rel);
    }
  };
  walk("src");
  const text = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

  it("no groupPatched or groupDeleted dispatch in src/ lacks origin", () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const file of files) {
      const source = text(file);
      for (const match of source.matchAll(/type:\s*"(groupPatched|groupDeleted)"([\s\S]{0,40})/g)) {
        seen += 1;
        if (!/^\s*[,;]\s*origin:/.test(match[2]!)) offenders.push(`${file}: ${match[0].slice(0, 80)}`);
      }
    }
    expect(seen).toBeGreaterThan(15);
    expect(offenders).toEqual([]);
  });

  it("the fence machinery of the earlier rounds is gone, and a groupEdited never carries a number", () => {
    const joined = files.map(text).join("\n");
    for (const symbol of ["writeGroupFence", "groupFences", "GROUP_FENCES_MAX", "staleGroupInput", "clearGroupFence"]) expect(joined).not.toContain(symbol);
    for (const file of files) for (const match of text(file).matchAll(/[dD]ispatch\(\{\s*type:\s*"groupEdited"([\s\S]*?)\}\)/g)) expect(match[1]).not.toMatch(/recordSeq|recordEpoch/);
  });
});

describe("a page against rows held (Astra r7 H3)", () => {
  const row = (id: string) => ({ id, role: "bot", kind: "text", text: id });
  const ids = (state: AppState) => held(state)!.messages.map((m) => m.id);

  it("a same-number page never replaces rows this client holds: the switch's answer lands after its frame and a row written since", () => {
    let state = withRoom(4);
    expect(held(state)?.messagesUnloaded).toBe(true);
    // the switch's frame at 5 carries the page the statement was built with
    state = reducer(state, frame({ ...room(5), messages: [row("m1")], hasMore: false, messagesTotal: 1 }));
    expect(ids(state)).toEqual(["m1"]);
    expect(held(state)?.messagesUnloaded).toBeUndefined();
    // a row written after the statement reaches this client live, ordered behind the frame by the stream
    state = reducer(state, { type: "messageAdded", threadId: `${ID}-thread`, message: row("m2") } as unknown as Action);
    expect(ids(state)).toEqual(["m1", "m2"]);
    expect(held(state)?.messagesTotal).toBe(2);
    // the same switch's answer, delayed: the same statement in its other shape, with the page of its time
    state = reducer(state, answer({ ...room(5), name: "Operations", messages: [row("m1")], hasMore: false, messagesTotal: 1 }));
    expect(ids(state), "a delayed same-number page took a live row off the screen").toEqual(["m1", "m2"]);
    expect(held(state)).toMatchObject({ recordSeq: 5, messagesTotal: 2, name: "Operations" });
    // a newer statement's page is the room's transcript from then on
    state = reducer(state, frame({ ...room(6), messages: [row("m1"), row("m2"), row("m3")], hasMore: false, messagesTotal: 3 }));
    expect(ids(state)).toEqual(["m1", "m2", "m3"]);
  });

  it("a same-number page for a room that holds no rows loads it", () => {
    let state = withRoom(4);
    state = reducer(state, answer({ ...room(4), messages: [row("m1")], hasMore: false, messagesTotal: 1 }));
    expect(held(state)?.messagesUnloaded).toBeUndefined();
    expect(ids(state)).toEqual(["m1"]);
  });
});

describe("r4: the transcript is an id-keyed union and loaded state is explicit (Astra build r2)", () => {
  const row = (id: string) => ({ id, role: "bot", kind: "text", text: id, at: 0 });
  const ids = (state: AppState) => held(state)!.messages.map((m) => m.id);
  const thread = `${ID}-thread`;
  const sent = (sentAt: number) => ({ source: "http", sentAt, expired: false });
  const generation = (state: AppState) => state.transcriptGeneration[thread] ?? 0;

  it("Astra new High: a room inserted from a metadata-only answer is unloaded, and its first page shows its rows", () => {
    let state = reducer(initialState, roster([], { sentTick: 0, roomClock: 4 }));
    // the restore's answer: a whole record without a page, numbered above the horizon
    state = reducer(state, answer(room(7)));
    expect(held(state)).toMatchObject({ recordSeq: 7, messagesUnloaded: true, messages: [] });
    expect(transcriptState(held(state)!)).toBe("unloaded");
    // the statement's own frame, the same number and no page: still unloaded; a live row moves the sidebar line only
    state = reducer(state, frame(room(7)));
    state = reducer(state, { type: "messageAdded", threadId: thread, message: row("m2") } as unknown as Action);
    expect(held(state)).toMatchObject({ messagesUnloaded: true, messages: [] });
    // the first page (scrollback loadFirstPage) shows the rows
    state = reducer(state, { type: "firstPageStarted", threadId: thread } as Action);
    state = reducer(state, { type: "firstPage", threadId: thread, generation: generation(state), page: { messages: [row("m1"), row("m2")], hasMore: false } } as Action);
    expect(ids(state)).toEqual(["m1", "m2"]);
    // r6 Q6: rows without numbers are a legacy transcript, never complete
    expect(transcriptState(held(state)!)).toBe("partial");
    expect(held(state)?.firstPageEvents).toBeUndefined();
  });

  it("Astra new High, equal version: the statement's frame carrying the page loads the room its answer inserted", () => {
    let state = reducer(initialState, roster([], { sentTick: 0, roomClock: 4 }));
    state = reducer(state, answer(room(7)));
    state = reducer(state, frame({ ...room(7), messages: [row("m1")], hasMore: false, messagesTotal: 1 }));
    expect(ids(state)).toEqual(["m1"]);
    expect(held(state)).toMatchObject({ recordSeq: 7, messagesTotal: 1 });
    expect(held(state)?.messagesUnloaded).toBeUndefined();
  });

  it("Astra H3: a delayed newer-version page cannot erase a row received over HTTP", () => {
    let state = withRoom(4);
    state = reducer(state, frame({ ...room(5), messages: [row("m1")], hasMore: false, messagesTotal: 1 }));
    // this client's own send, answered over HTTP
    state = reducer(state, { type: "messageAdded", threadId: thread, message: row("m2") } as unknown as Action);
    expect(ids(state)).toEqual(["m1", "m2"]);
    // a newer statement's page, built before m2 and delivered after it
    state = reducer(state, answer({ ...room(6), name: "Renamed", messages: [row("m1")], hasMore: false, messagesTotal: 1 }));
    expect(ids(state), "a delayed newer page took an HTTP-received row off the screen").toEqual(["m1", "m2"]);
    expect(held(state)).toMatchObject({ recordSeq: 6, name: "Renamed", messagesTotal: 2 });
    // the next page carries every row: the union is the page
    state = reducer(state, frame({ ...room(7), messages: [row("m1"), row("m2"), row("m3")], hasMore: false, messagesTotal: 3 }));
    expect(ids(state)).toEqual(["m1", "m2", "m3"]);
    expect(held(state)?.messagesTotal).toBe(3);
  });

  it("r4 T4: a delayed answer's page never loads an unloaded room; a frame's page or an answer sent after the roster does", () => {
    const booted = () => reducer(initialState, roster([room(4)], { sentTick: 0, roomClock: 4, sentAt: 100 }));
    let state = booted();
    expect(held(state)).toMatchObject({ messagesUnloaded: true });
    expect(state.transcriptFloor).toBe(100);
    // a newer statement's page in an answer whose request was sent before the roster was asked for: rows written since may be lost with the old connection
    const late = { ...room(5), messages: [row("m1")], hasMore: false, messagesTotal: 1 };
    state = reducer(state, { type: "groupPatched", origin: sent(50), group: late } as Action);
    expect(held(state)).toMatchObject({ recordSeq: 5, messagesUnloaded: true, messages: [], messagesTotal: 1 });
    expect(held(state)?.firstPageEvents).toBeUndefined();
    // the same page from the stream closes the gap
    state = reducer(state, frame(late));
    expect(ids(state)).toEqual(["m1"]);
    expect(transcriptState(held(state)!)).toBe("partial");
    // an answer sent at or after the roster closes it too
    const fresh = reducer(booted(), { type: "groupPatched", origin: sent(100), group: late } as Action);
    expect(held(fresh)?.messages.map((m) => m.id)).toEqual(["m1"]);
    // a late roster never lowers the floor
    const lowered = reducer(fresh, roster([room(5)], { sentTick: 0, roomClock: 5, sentAt: 60 }));
    expect(lowered.transcriptFloor).toBe(100);
  });

  it("r4 T4: a delayed answer's page unions into a live transcript", () => {
    let state = reducer(initialState, roster([room(4)], { sentTick: 0, roomClock: 4, sentAt: 100 }));
    state = reducer(state, frame({ ...room(5), messages: [row("m1")], hasMore: false, messagesTotal: 1 }));
    state = reducer(state, { type: "groupPatched", origin: sent(50), group: { ...room(6), messages: [row("m1"), row("m2")], hasMore: false, messagesTotal: 2 } } as Action);
    expect(ids(state)).toEqual(["m1", "m2"]);
    expect(held(state)).toMatchObject({ recordSeq: 6 });
  });

  it("r4 T5: a stale statement's page unions rows into a live transcript; its record, number and flags stay", () => {
    let state = withRoom(4);
    state = reducer(state, frame({ ...room(6), name: "Six", messages: [row("m5"), row("m6")], hasMore: true, olderFrom: "m4", messagesTotal: 6 }));
    state = reducer(state, answer({ ...room(5), name: "Five", messages: [row("m3"), row("m4"), row("m5")], hasMore: true, olderFrom: "m2", messagesTotal: 5 }));
    expect(ids(state)).toEqual(["m3", "m4", "m5", "m6"]);
    expect(held(state)).toMatchObject({ recordSeq: 6, name: "Six", hasMore: true, olderFrom: "m2", messagesTotal: 6 });
    // a stale page never loads an unloaded room
    let fresh = withRoom(6);
    fresh = reducer(fresh, answer({ ...room(5), messages: [row("m1")], hasMore: false, messagesTotal: 1 }));
    expect(held(fresh)).toMatchObject({ recordSeq: 6, messagesUnloaded: true, messages: [] });
  });

  it("r4 T1: a page of another thread replaces the transcript; a moved thread without a page starts unloaded", () => {
    let state = withRoom(4);
    state = reducer(state, frame({ ...room(5), messages: [row("a1")], hasMore: false, messagesTotal: 1 }));
    state = reducer(state, frame({ ...room(6), threadId: "task-2", messages: [row("b1")], hasMore: false, messagesTotal: 1 }));
    expect(held(state)).toMatchObject({ threadId: "task-2", messagesTotal: 1 });
    expect(ids(state)).toEqual(["b1"]);
    state = reducer(state, frame({ ...room(7), threadId: "task-3" }));
    expect(held(state)).toMatchObject({ threadId: "task-3", messagesUnloaded: true, messages: [] });
  });

  it("r4 T2 (static): no room path infers loaded state from messages.length, and the equal-version strip is gone", () => {
    const src = readFileSync(join(process.cwd(), "src/state/store.tsx"), "utf8");
    const merge = readFileSync(join(process.cwd(), "src/state/transcript-seq.ts"), "utf8");
    const groupPatched = /case "groupPatched": \{([\s\S]*?)case "groupEdited":/.exec(src)?.[1];
    const firstPage = /case "firstPage": \{([\s\S]*?)case "firstPageFailed":/.exec(src)?.[1];
    const helpers = /function roomPageOf([\s\S]*?)function unionStaleRoomPage[\s\S]*?\n\}\n/.exec(src)?.[0];
    for (const block of [groupPatched, firstPage, helpers, merge]) {
      expect(block).toBeDefined();
      expect(block).not.toMatch(/messages\.length\s*[=!<>?]/);
    }
    expect(src).not.toContain("samePage");
    expect(src).not.toMatch(/mergeTranscript|applyOlderPage|addLiveRow|staleGaps|olderAnchor|TranscriptGap|pageStale: true as const/);
    expect(helpers).toContain("applyRoomTranscript");
    expect(src).toContain("roomTranscriptInput(group, { kind: \"live\"");
    expect(groupPatched).toContain("UNLOADED_TRANSCRIPT");
  });
});

// ROOM-ORDER-DESIGN r6-r8, through the reducer: rows carry `seq`, envelopes `newestSeq` (the wire contract the server half implements).
const seqRow = (n: number, extra: Record<string, unknown> = {}) => ({ id: `m${n}`, role: "bot", kind: "text", text: `m${n}`, at: 0, seq: n, ...extra });
const seqRows = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => seqRow(from + i));
const thread = `${ID}-thread`;
const generation = (state: AppState) => state.transcriptGeneration[thread] ?? 0;
const ids = (state: AppState) => held(state)!.messages.map((m) => m.id);
const firstPage = (state: AppState, messages: unknown[], newestSeq: number | undefined, hasMore = false): AppState => {
  state = reducer(state, { type: "firstPageStarted", threadId: thread } as Action);
  return reducer(state, { type: "firstPage", threadId: thread, generation: generation(state), page: { messages, hasMore, ...(newestSeq === undefined ? {} : { newestSeq }) } } as Action);
};
const older = (state: AppState, before: string, messages: unknown[], newestSeq: number | undefined, hasMore: boolean): AppState => {
  state = reducer(state, { type: "loadOlderMessages", threadId: thread });
  return reducer(state, { type: "olderMessages", threadId: thread, generation: generation(state), messages, hasMore, before, ...(newestSeq === undefined ? {} : { newestSeq }) } as Action);
};
const added = (message: unknown, newestSeq?: number, origin?: unknown): Action =>
  ({ type: "messageAdded", threadId: thread, message, ...(newestSeq === undefined ? {} : { newestSeq }), ...(origin ? { origin } : {}) }) as unknown as Action;
const patched = (message: unknown, newestSeq?: number): Action =>
  ({ type: "messagePatched", threadId: thread, message, ...(newestSeq === undefined ? {} : { newestSeq }) }) as unknown as Action;
/** The client holding the room's thread complete at 1..n, then the roster of a same-run reconnect (no rows). */
const heldThenHydrated = (n: number): AppState => {
  let state = firstPage(withRoom(4), seqRows(1, n), n);
  expect(transcriptState(held(state)!)).toBe("complete");
  state = reducer(state, roster([room(4)], { sentTick: state.admitTick, roomClock: 4, sentAt: 100 }));
  return state;
};

describe("r6: one ordering key (Astra build r4 BLOCK)", () => {
  it("Q10.1 split gap: a frame inside a gap splits it; the walk ends complete at exactly 201 and never complete at 150", () => {
    let state = firstPage(withRoom(4), [seqRow(1)], 1);
    state = firstPage(state, seqRows(102, 201), 201, true);
    state = reducer(state, added(seqRow(50), 201));
    expect(transcriptState(held(state)!)).toBe("partial");
    state = older(state, "m102", seqRows(52, 101), 201, true);
    expect(held(state)!.messages).toHaveLength(152);
    expect(transcriptState(held(state)!)).toBe("partial");
    state = older(state, "m52", seqRows(2, 51), 201, true);
    expect(ids(state)).toEqual(seqRows(1, 201).map((m) => m.id));
    expect(transcriptState(held(state)!)).toBe("complete");
    expect(held(state)?.messagesTotal).toBe(201);
  });

  it("Q10.2 stall: a frame past the newest held row is never the anchor; two pages complete 202", () => {
    let state = firstPage(withRoom(4), seqRows(102, 201), 201, true);
    state = reducer(state, added(seqRow(202), 202));
    expect(ids(state).at(-1)).toBe("m202");
    state = older(state, "m102", seqRows(2, 101), 202, true);
    state = older(state, "m2", [seqRow(1)], 202, false);
    expect(transcriptState(held(state)!)).toBe("complete");
    expect(held(state)!.messages).toHaveLength(202);
  });

  it("Q10.3 ties: a delayed frame with a tied `at` is shown first; a splice holds at its number; hydrate re-vouches by the walk", () => {
    let state = firstPage(withRoom(4), seqRows(3, 102).map((m) => (m.seq === 3 ? { ...m, at: 5 } : m)), 102, true);
    state = reducer(state, added(seqRow(1, { at: 5 }), 102));
    expect(ids(state)[0]).toBe("m1");
    state = reducer(state, added(seqRow(103, { insertedBefore: "m60", at: 99_999 }), 103));
    expect(ids(state).at(-1)).toBe("m103");
    state = reducer(state, added(seqRow(104, { at: -1 }), 104));
    expect(ids(state).slice(-2)).toEqual(["m103", "m104"]);
    state = older(state, "m3", seqRows(1, 2), 104, false);
    expect(transcriptState(held(state)!)).toBe("complete");
  });

  it("Q10.3 hydrate: the tail is forgotten and held rows unvouched; the newest page over 1..100 leaves (100,150) paged and the copies replaced", () => {
    let state = heldThenHydrated(100);
    expect(held(state)?.tail).toBeUndefined();
    expect(held(state)!.messages.every((m) => m.unvouched)).toBe(true);
    expect(ids(state)).toHaveLength(100);
    state = firstPage(state, seqRows(150, 201), 201, true);
    expect(transcriptState(held(state)!)).toBe("partial");
    state = older(state, "m150", seqRows(50, 149), 201, true);
    state = older(state, "m50", seqRows(1, 49), 201, false);
    expect(transcriptState(held(state)!)).toBe("complete");
    expect(held(state)!.messages.some((m) => m.unvouched)).toBe(false);
  });

  it("Q10.3 an empty numbered thread is complete with none; a new run drops every held row", () => {
    let state = firstPage(withRoom(4), [], 0);
    expect(transcriptState(held(state)!)).toBe("complete");
    state = firstPage(withRoom(4), seqRows(1, 3), 3);
    state = reducer(state, roster([room(1, {}, E2)], { tasksEpoch: E2, sentTick: state.admitTick, roomClock: 1 }));
    expect(held(state)).toMatchObject({ messages: [], messagesUnloaded: true });
    expect(held(state)?.numbered).toBeUndefined();
  });

  it("Q10.3 a row without `seq` in a numbered run is dropped and the newest page asked once (Q6)", () => {
    let state = firstPage(withRoom(4), seqRows(1, 3), 3);
    state = reducer(state, added({ id: "m4", role: "bot", kind: "text", text: "m4", at: 0 }, 4));
    expect(ids(state)).toEqual(["m1", "m2", "m3"]);
    expect(transcriptState(held(state)!)).toBe("partial");
    state = firstPage(state, seqRows(1, 4), 4);
    expect(transcriptState(held(state)!)).toBe("complete");
  });

  it("Q10.3 a legacy server never makes a room complete", () => {
    let state = firstPage(withRoom(4), [{ id: "l1", role: "bot", kind: "text", text: "", at: 0 }], undefined);
    expect(transcriptState(held(state)!)).toBe("partial");
    state = reducer(state, added({ id: "l2", role: "bot", kind: "text", text: "", at: 0 }));
    expect(ids(state)).toEqual(["l1", "l2"]);
    expect(transcriptState(held(state)!)).toBe("partial");
  });
});

describe("r7: the tail is the server's number (Astra r6 REVISE)", () => {
  it("(5) an old server's empty page: legacy, hasMore false, never complete", () => {
    const state = firstPage(withRoom(4), [], undefined);
    expect(held(state)?.messagesUnloaded).toBeUndefined();
    expect(held(state)?.numbered).toBeUndefined();
    expect(held(state)?.hasMore).toBe(false);
    expect(transcriptState(held(state)!)).toBe("partial");
  });

  it("(6) missed patch: row 40 edited during the outage is re-fetched by the walk and the held copy replaced", () => {
    let state = heldThenHydrated(50);
    const edited = seqRows(11, 60).map((m) => (m.seq === 40 ? { ...m, text: "edited during the outage" } : m));
    state = firstPage(state, edited, 60, true);
    state = older(state, "m11", seqRows(1, 10), 60, false);
    expect(transcriptState(held(state)!)).toBe("complete");
    expect(held(state)!.messages[39]!.text).toBe("edited during the outage");
  });

  it("(7) the false-tail schedule: a fresh POST answer carrying row 50 sets the tail to 201; a pre-floor one sets nothing", () => {
    let state = heldThenHydrated(100);
    state = reducer(state, added(seqRow(50), 999, { source: "http", sentAt: 50, expired: false }));
    expect(held(state)?.tail).toBeUndefined();
    state = reducer(state, added(seqRow(50), 201, { source: "http", sentAt: 100, expired: false }));
    expect(held(state)?.tail).toBe(201);
    expect(transcriptState(held(state)!)).toBe("partial");
    expect(held(state)!.messages.find((m) => m.id === "m50")?.unvouched).toBeUndefined();
  });
});

describe("r8: suffix recovery and promotion (Astra r7 REVISE H3, H4)", () => {
  it("(9) case 1: hold 1..100, hydrate, vouched row 50 with newestSeq 201: newest, two gaps, two unvouched runs, complete at 201", () => {
    let state = heldThenHydrated(100);
    state = reducer(state, added(seqRow(50), 201));
    state = firstPage(state, seqRows(152, 201), 201, true);
    state = older(state, "m152", seqRows(102, 151), 201, true);
    state = older(state, "m102", seqRows(52, 101), 201, true);
    state = older(state, "m52", seqRows(2, 51), 201, true);
    expect(transcriptState(held(state)!)).toBe("partial");
    state = older(state, "m2", [seqRow(1)], 201, false);
    expect(transcriptState(held(state)!)).toBe("complete");
    expect(held(state)?.messagesTotal).toBe(201);
  });

  it("(10) case 2: hold 1..201 complete, hydrate, no later input: the newest page re-vouches the top run, the walk refreshes down to 1", () => {
    let state = heldThenHydrated(201);
    state = firstPage(state, seqRows(152, 201), 201, true);
    for (const [before, from, to] of [["m152", 102, 151], ["m102", 52, 101], ["m52", 2, 51]] as const) {
      expect(transcriptState(held(state)!)).toBe("partial");
      state = older(state, before, seqRows(from, to), 201, true);
    }
    state = older(state, "m2", [seqRow(1)], 201, false);
    expect(transcriptState(held(state)!)).toBe("complete");
  });

  it("(11) client half: a legacy room promotes on the first numbered patch, drops its legacy rows and pages back to complete", () => {
    const legacy = (n: number, text = `m${n}`) => ({ id: `m${n}`, role: "bot", kind: "text", text, at: 0 });
    let state = firstPage(withRoom(4), [1, 2, 3, 4].map((n) => legacy(n)), undefined);
    state = reducer(state, patched(legacy(2, "edit 1")));
    expect(held(state)?.numbered).toBeUndefined();
    expect(held(state)!.messages[1]!.text).toBe("edit 1");
    state = reducer(state, patched(seqRow(2, { text: "edit 2" }), 4));
    expect(held(state)).toMatchObject({ numbered: true, tail: 4 });
    expect(ids(state)).toEqual(["m2"]);
    state = firstPage(state, seqRows(1, 4).map((m) => (m.seq === 2 ? { ...m, text: "edit 2" } : m)), 4);
    expect(ids(state)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(transcriptState(held(state)!)).toBe("complete");
    // a replayed pre-flip frame is dropped and the newest page asked once
    state = reducer(state, added(legacy(5)));
    expect(ids(state)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(transcriptState(held(state)!)).toBe("partial");
  });

  it("a room statement's page carries `newestSeq` on the record; it promotes and sets the tail, and never lands on the room record", () => {
    let state = withRoom(4);
    state = reducer(state, frame({ ...room(5), messages: seqRows(1, 2), hasMore: false, messagesTotal: 2, newestSeq: 2 }));
    expect(held(state)).toMatchObject({ numbered: true, tail: 2 });
    expect((held(state) as unknown as { newestSeq?: number }).newestSeq).toBeUndefined();
    expect(transcriptState(held(state)!)).toBe("complete");
  });
});

describe("Astra build r5: the two client Highs, through the reducer", () => {
  it("H1: restore 1..100, an old POST answer X/101, then the current frame Y/101: Y is shown and the room completes", () => {
    let state = firstPage(withRoom(4), seqRows(1, 120), 120);
    state = reducer(state, roster([room(4)], { sentTick: state.admitTick, roomClock: 4, sentAt: 100, tasksEpoch: E2 }));
    expect(held(state)?.messagesUnloaded).toBe(true);
    state = firstPage(state, seqRows(1, 100), 100);
    expect(transcriptState(held(state)!)).toBe("complete");
    state = reducer(state, added(seqRow(101, { id: "x101" }), 101, { source: "http", sentAt: 50, expired: false }));
    state = reducer(state, added(seqRow(101, { id: "y101" }), 101));
    expect(ids(state).slice(-2)).toEqual(["m100", "y101"]);
    expect(transcriptState(held(state)!)).toBe("complete");
  });

  it("H1: after a same-run hydrate an old answer X/101 yields to the newest page's Y/101", () => {
    let state = heldThenHydrated(100);
    state = reducer(state, added(seqRow(101, { id: "x101" }), 101, { source: "http", sentAt: 50, expired: false }));
    state = firstPage(state, [...seqRows(52, 100), seqRow(101, { id: "y101" })], 101, true);
    expect(ids(state)).toContain("y101");
    expect(ids(state)).not.toContain("x101");
  });

  it("H2: a legacy room holding m1 takes a disjoint newest page m102..201; the gap is paged through olderMessages until it closes", () => {
    const legacy = (n: number) => ({ id: `m${n}`, role: "bot", kind: "text", text: `m${n}`, at: 0 });
    const rows = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => legacy(from + i));
    let state = firstPage(withRoom(4), [legacy(1)], undefined, false);
    state = reducer(state, frame({ ...room(5), messages: rows(102, 201), hasMore: true, messagesTotal: 201 }));
    expect(nextPage(held(state)!)).toEqual({ before: "m102" });
    state = older(state, "m102", rows(52, 101), undefined, true);
    expect(nextPage(held(state)!)).toEqual({ before: "m52" });
    state = older(state, "m52", rows(2, 51), undefined, true);
    state = older(state, "m2", [legacy(1)], undefined, false);
    expect(ids(state)).toEqual(rows(1, 201).map((m) => m.id));
    expect(nextPage(held(state)!)).toBeUndefined();
  });
});
