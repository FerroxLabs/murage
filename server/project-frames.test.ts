// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane R tests for the project SSE frames (SPEC-P 12.3): ids and revisions
// only, 250 ms coalescing per group for project.board with the merge rules,
// 500 ms invalidation for project.strip, and the visibility classification
// (companion sees a normal project group, never a dm pair room).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SseReplay } from "./sse-buffer.ts";
import { createProjectFrameEmitter, type ProjectFrameBroadcast } from "./project-frames.ts";
import { frameSubject, KNOWN_FRAME_KINDS, visibleToCompanion, type VisibilityStore } from "./sse-visibility.ts";

describe("project.board emit helper", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces card writes per group for 250 ms, merged by card id", () => {
    const sent: Array<Record<string, unknown>> = [];
    const broadcast: ProjectFrameBroadcast = payload => sent.push(payload);
    const emit = createProjectFrameEmitter(broadcast);
    emit.board("grp", [{ id: "c1", revision: 1, state: "todo", columnId: null }]);
    emit.board("grp", [{ id: "c2", revision: 3, state: "doing", columnId: null }]);
    emit.board("grp", [{ id: "c1", revision: 2, state: "doing", columnId: null }], 5);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(300);
    expect(sent).toHaveLength(1);
    const frame = sent[0]!;
    expect(frame.kind).toBe("project.board");
    expect(frame.groupId).toBe("grp");
    expect(frame.columnsRevision).toBe(5);
    const cards = frame.cards as Array<{ id: string; revision: number }>;
    expect(cards).toHaveLength(2);
    expect(cards.find(card => card.id === "c1")).toMatchObject({ revision: 2, state: "doing" });
    expect(cards.find(card => card.id === "c2")).toMatchObject({ revision: 3 });
  });

  it("keeps the highest revision per card, and a deleted entry wins over any revision", () => {
    const sent: Array<Record<string, unknown>> = [];
    const emit = createProjectFrameEmitter(payload => sent.push(payload));
    emit.board("grp", [{ id: "c1", revision: 9, state: "done", columnId: null }]);
    emit.board("grp", [{ id: "c1", revision: 3, state: "todo", columnId: null }]);
    emit.board("grp", [{ id: "c2", revision: 1, state: "todo", columnId: null, deleted: true }]);
    emit.board("grp", [{ id: "c2", revision: 7, state: "doing", columnId: null }]);
    vi.advanceTimersByTime(300);
    const cards = (sent[0]!.cards) as Array<{ id: string; revision: number; deleted?: boolean }>;
    expect(cards.find(card => card.id === "c1")!.revision).toBe(9);
    expect(cards.find(card => card.id === "c2")).toMatchObject({ deleted: true });
  });

  it("does not mix groups", () => {
    const sent: Array<Record<string, unknown>> = [];
    const emit = createProjectFrameEmitter(payload => sent.push(payload));
    emit.board("grp-a", [{ id: "c1", revision: 1, state: "todo", columnId: null }]);
    emit.board("grp-b", [{ id: "c9", revision: 1, state: "todo", columnId: null }]);
    vi.advanceTimersByTime(300);
    expect(sent).toHaveLength(2);
    expect(sent.map(frame => frame.groupId).sort()).toEqual(["grp-a", "grp-b"]);
  });
});

describe("project.strip emit helper", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is an invalidation coalesced over 500 ms per group", () => {
    const sent: Array<Record<string, unknown>> = [];
    const emit = createProjectFrameEmitter(payload => sent.push(payload));
    emit.strip("grp");
    emit.strip("grp");
    emit.strip("grp");
    vi.advanceTimersByTime(600);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "project.strip", groupId: "grp" });
    expect(Object.keys(sent[0]!)).toEqual(["kind", "groupId"]);
  });
});

describe("visibility classification (12.3)", () => {
  const store: VisibilityStore = {
    bot: () => null,
    botByThread: () => null,
    group: (id) => id === "dm-room" ? { dm: true } : id === "proj" ? {} : undefined,
    groupByThread: () => undefined,
  };

  it("both kinds are listed and resolve to a group subject explicitly", () => {
    expect(KNOWN_FRAME_KINDS).toContain("project.board");
    expect(KNOWN_FRAME_KINDS).toContain("project.strip");
    expect(frameSubject({ kind: "project.board", groupId: "proj" })).toEqual({ scope: "group", groupId: "proj" });
    expect(frameSubject({ kind: "project.strip", groupId: "proj" })).toEqual({ scope: "group", groupId: "proj" });
  });

  it("a companion sees frames for a normal project group and none for a dm pair room", () => {
    expect(visibleToCompanion(store, frameSubject({ kind: "project.board", groupId: "proj" }))).toBe(true);
    expect(visibleToCompanion(store, frameSubject({ kind: "project.strip", groupId: "proj" }))).toBe(true);
    expect(visibleToCompanion(store, frameSubject({ kind: "project.board", groupId: "dm-room" }))).toBe(false);
    expect(visibleToCompanion(store, frameSubject({ kind: "project.strip", groupId: "dm-room" }))).toBe(false);
  });
});

it("continuous board writes still emit within the 250 ms window", () => {
  vi.useFakeTimers();
  try {
    const sent: Record<string, unknown>[] = [];
    const emit = createProjectFrameEmitter(frame => sent.push(frame));
    for (let n = 0; n < 3; n++) { emit.board("g", [{ id: "c", revision: n, state: "todo", columnId: null }]); vi.advanceTimersByTime(100); }
    expect(sent).toHaveLength(1);
    emit.flush();
  } finally { vi.useRealTimers(); }
});

it("a project replay gap requires refetch instead of replaying partial state", () => {
  const buffer = new SseReplay({ maxBytes: 10000, maxEntries: 1, maxFrameBytes: 10000 });
  for (const seq of [1, 2]) {
    const payload = { kind: "project.board", groupId: "g", cards: [{ id: "c", revision: seq }] };
    buffer.append({ seq, kind: payload.kind, subject: frameSubject(payload) }, JSON.stringify(payload));
  }
  expect(buffer.prepare(0, 2, () => true)).toEqual({ resumed: false, frames: [] });
  expect(buffer.prepare(1, 2, () => true).resumed).toBe(true);
});
