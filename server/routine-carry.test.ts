// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SL-M: the memory-side check before a routine's last report is carried (routine-carry.ts). Each case is a way the owner would be
// surprised to see a report come back: one they forgot, one from a deleted conversation, or one that cannot be proved.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  denied: false, forgotten: false, captured: true, throwOn: "" as string,
  rows: [] as Array<{ id: string; at: number; role: string; kind: string }>,
  prepared: [] as string[],
}));

vi.mock("./database.ts", () => ({
  database: () => ({
    prepare: (sql: string) => {
      state.prepared.push(sql);
      return { get: (id: string) => { if (state.throwOn === "db") throw new Error("busy"); return state.captured ? { id } : undefined; } };
    },
  }),
}));
vi.mock("./memory/deny.ts", () => ({ threadDenied: () => state.denied }));
vi.mock("./memory/replay-lineage.ts", () => ({ messageSourceForgotten: () => state.forgotten }));
vi.mock("./message-db.ts", () => ({
  scanTextLinesNewest: (_thread: string, visit: (message: unknown) => boolean) => {
    for (const row of [...state.rows].sort((a, b) => b.at - a.at)) if (visit(row)) return true;
    return false;
  },
}));

import { priorReplyCarryable } from "./routine-carry.ts";

beforeEach(() => {
  state.denied = false; state.forgotten = false; state.captured = true; state.throwOn = ""; state.prepared = [];
  state.rows = [
    { id: "u1", at: 100, role: "user", kind: "text" },
    { id: "b1", at: 150, role: "bot", kind: "text" },
    { id: "later", at: 900, role: "bot", kind: "text" },
  ];
});

describe("priorReplyCarryable", () => {
  it("is true when the newest bot reply inside the run's window is present, captured and not forgotten", () => {
    expect(priorReplyCarryable("t", 100, 200)).toBe(true);
    expect(state.prepared.join(" ")).toContain("memory_sources");
  });
  it("is false when the conversation was deleted", () => { state.denied = true; expect(priorReplyCarryable("t", 100, 200)).toBe(false); });
  it("is false when the owner forgot that reply", () => { state.forgotten = true; expect(priorReplyCarryable("t", 100, 200)).toBe(false); });
  it("is false when the reply was never captured", () => { state.captured = false; expect(priorReplyCarryable("t", 100, 200)).toBe(false); });
  it("is false when no bot reply was written inside the run's window", () => {
    expect(priorReplyCarryable("t", 300, 400)).toBe(false);
    state.rows = state.rows.filter((row) => row.role !== "bot");
    expect(priorReplyCarryable("t", 100, 200)).toBe(false);
  });
  it("is false, not an error, when the database cannot be read", () => { state.throwOn = "db"; expect(priorReplyCarryable("t", 100, 200)).toBe(false); });
});
