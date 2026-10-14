// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A room member turn reads the same rows of a room of 1,000 messages as of
// 200,000 (the newest thirty text lines, the pin and the lines they quote), a
// tool-heavy stretch hides none of them, and its recall exclusions are exactly as
// strict as when it read the whole room (an older row this route holds back is
// still held back).
import { expect, it } from "vitest";
import { promptRows } from "./external-context-delivery.ts";
import { GROUP_CONTEXT_MESSAGES, roomContextMessageIds, roomContextMessages } from "./room-context.ts";
import { readRoomTurnRows, roomHeldLookup, type RoomRowsStore } from "./room-turn-rows.ts";
import type { Message } from "./store.ts";

/** A room of `count` rows: row 50 is a tool-needing inbound action, row 51 quotes it; the newest text row quotes row 7;
 * every row after `activityFrom` (when given) is a tool activity row, not a line. */
function room(count: number, activityFrom = Number.POSITIVE_INFINITY) {
  const rows = (id: number): Message => id >= activityFrom
    ? ({ id: `r${id}`, at: id, role: "bot", kind: "activity", tool: { name: "Bash" } } as Message)
    : ({ id: `r${id}`, at: id, role: id % 2 ? "user" : "bot", kind: "text", text: `line ${id}`,
      ...(id === 50 ? { inboundKind: "action" as const } : {}), ...(id === 51 ? { replyToId: "r50" } : {}), ...(id === Math.min(count, activityFrom - 1) ? { replyToId: "r7" } : {}) } as Message);
  const reads = { rowsRead: 0, calls: 0 };
  const store: RoomRowsStore = {
    newestTextLines(_thread, limit) {
      reads.calls++;
      const out: Message[] = [];
      for (let id = count; id >= 1 && out.length < limit; id--) { const row = rows(id); if (row.kind === "text" && row.text) out.unshift(row); }
      reads.rowsRead += out.length; // the line index reads only lines, whatever lies between them
      return out;
    },
    messageById(_thread, id) { reads.calls++; reads.rowsRead++; const n = Number(id.slice(1)); return n >= 1 && n <= count ? rows(n) : undefined; },
  };
  return { store, reads, all: Array.from({ length: count }, (_, i) => rows(i + 1)) };
}

it("a room turn reads the same rows at 1,000 (and a hundred) and at 200,000 messages, with the pin and the quoted line", () => {
  const small = room(1_100), large = room(200_000);
  const a = readRoomTurnRows(small.store, "t", "r3"), b = readRoomTurnRows(large.store, "t", "r3");
  expect(large.reads).toEqual(small.reads);
  expect(large.reads.rowsRead).toBeLessThanOrEqual(GROUP_CONTEXT_MESSAGES + 4);
  expect(b.rows.length).toBe(GROUP_CONTEXT_MESSAGES + 2);
  // the pin and the line the newest row quotes are there, older than the rest
  expect(b.rows.slice(0, 2).map((row) => row.id).sort()).toEqual(["r3", "r7"]);
  expect(b.extras).toBe(2);
  expect(b.more).toBe(true);
  expect(a.more).toBe(true);
  // what the prompt shows is what the whole room would have shown
  expect(roomContextMessageIds(b.rows, GROUP_CONTEXT_MESSAGES, "r3")).toEqual(roomContextMessageIds(large.all, GROUP_CONTEXT_MESSAGES, "r3"));
});

it("8,999 tool rows after the last conversation hide none of its thirty lines, and a pin keeps the line it quotes", () => {
  const large = room(200_000, 191_001);
  const read = readRoomTurnRows(large.store, "t", "r9");
  const whole = roomContextMessages(large.all, GROUP_CONTEXT_MESSAGES, "r9").map((m) => m.id);
  expect(roomContextMessages(read.rows, GROUP_CONTEXT_MESSAGES, "r9").map((m) => m.id)).toEqual(whole);
  expect(whole.filter((id) => id !== "r9")).toHaveLength(GROUP_CONTEXT_MESSAGES);
  // an old pin that quotes an older line: both are there
  const quoting: Message = { id: "r9", at: 9, role: "bot", kind: "text", text: "line 9", replyToId: "r2" } as Message;
  const base = large.store;
  const store: RoomRowsStore = { ...base, messageById: (t, id) => id === "r9" ? quoting : base.messageById(t, id) };
  const pinned = readRoomTurnRows(store, "t", "r9");
  expect(new Set(pinned.rows.map((m) => m.id)).has("r2")).toBe(true);
  expect(new Set(pinned.rows.map((m) => m.id)).has("r9")).toBe(true);
});

it("widening asks for the same rows with a wider window of lines", () => {
  const large = room(200_000);
  const read = readRoomTurnRows(large.store, "t", undefined);
  expect(read.widen(120).rows.filter((m) => m.kind === "text").length).toBeGreaterThanOrEqual(120);
});

it("a room row older than the rows read that this route holds back is still held back from recall, by lookup", () => {
  const large = room(200_000);
  const read = readRoomTurnRows(large.store, "t", undefined);
  const route = (hasTools: boolean) => roomHeldLookup(large.store, "t", read, hasTools);
  // a route without tools holds the tool-needing row 50 back, wherever it is
  expect(route(false).held("r50")).toBe(true);
  expect(route(false).held("r49")).toBe(false);
  expect(route(true).held("r50")).toBe(false);
  // inside the rows read it is the same verdict the whole room gives
  const whole = new Set(promptRows(large.all, false).map((row) => row.id));
  const wholeHeld = large.all.filter((row) => !whole.has(row.id)).map((row) => row.id);
  expect(wholeHeld).toEqual(["r50"]);
  const nearStore: RoomRowsStore = { ...large.store, newestTextLines: (t, limit) => large.store.newestTextLines(t, limit).map((m) => m.id === "r199991" ? { ...m, inboundKind: "action" as const } : m) };
  expect(roomHeldLookup(nearStore, "t", readRoomTurnRows(nearStore, "t", undefined), false).heldIds.has("r199991")).toBe(true);
  // one lookup per older row asked about, remembered
  const before = large.reads.calls;
  const lookup = route(false);
  lookup.held("r50"); lookup.held("r50");
  expect(large.reads.calls - before).toBe(1);
});

it("random rooms: the window, the pin and the quotes equal what the whole room gives", () => {
  let seed = 7;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let round = 0; round < 60; round++) {
    const count = 20 + Math.floor(random() * 400);
    const all: Message[] = Array.from({ length: count }, (_, i) => {
      const id = i + 1;
      const kind = random() < 0.45 ? "activity" : "text";
      const text = kind === "text" ? (random() < 0.1 ? "" : `line ${id}`) : undefined;
      return { id: `m${id}`, at: id, role: random() < 0.5 ? "user" : "bot", kind, ...(text !== undefined ? { text } : {}), ...(id > 3 && random() < 0.2 ? { replyToId: `m${1 + Math.floor(random() * (id - 1))}` } : {}) } as Message;
    });
    const store: RoomRowsStore = {
      newestTextLines: (_t, limit) => all.filter((m) => m.kind === "text" && m.text).slice(-limit),
      messageById: (_t, id) => all.find((m) => m.id === id),
    };
    const pin = random() < 0.5 ? `m${1 + Math.floor(random() * count)}` : undefined;
    const read = readRoomTurnRows(store, "t", pin);
    const expected = roomContextMessageIds(all, GROUP_CONTEXT_MESSAGES, pin);
    expect(roomContextMessageIds(read.rows, GROUP_CONTEXT_MESSAGES, pin)).toEqual(expected);
    // every line the window (and the pin) quotes is among the rows read
    const have = new Set(read.rows.map((m) => m.id));
    for (const m of roomContextMessages(all, GROUP_CONTEXT_MESSAGES, pin)) if (m.replyToId) expect(have.has(m.replyToId)).toBe(true);
  }
});
