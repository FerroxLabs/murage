// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Adapted from OpenMausBot #3374 (src/state/turn-status.test.ts), Apache-2.0 (see NOTICE).
import { beforeEach, describe, expect, it } from "vitest";

import { noteTurnEvent, resetTurnLive, turnLive } from "./turn-status";
import { showWorkingDots } from "@/lib/turn-tail";
import type { Message } from "@/state/store";

type Frame = Parameters<typeof noteTurnEvent>[0];
const frame = (type: string, turnId?: string, threadId = "t1"): Frame => ({ type, threadId, turnId } as Frame);
const reply: Message = { id: "r1", role: "bot", kind: "text", text: "Done.", at: 1 } as Message;

describe("turn status", () => {
  beforeEach(() => resetTurnLive());

  it("an unseen thread has not ended", () => {
    expect(turnLive("t1").ended).toBe(false);
    expect(turnLive(null).ended).toBe(false);
  });

  it("a turn runs from turn.started to turn.completed", () => {
    noteTurnEvent(frame("turn.started", "u1"));
    expect(turnLive("t1")).toEqual({ turnId: "u1", ended: false });
    noteTurnEvent(frame("item.completed", "u1"));
    expect(turnLive("t1").ended).toBe(false);
    noteTurnEvent(frame("turn.completed", "u1"));
    expect(turnLive("t1")).toEqual({ turnId: "u1", ended: true });
    // Only that thread.
    expect(turnLive("t2").ended).toBe(false);
  });

  it("a frame from a newer turn starts it even when turn.started was missed", () => {
    noteTurnEvent(frame("turn.started", "u1"));
    noteTurnEvent(frame("turn.completed", "u1"));
    noteTurnEvent(frame("item.started", "u2"));
    expect(turnLive("t1")).toEqual({ turnId: "u2", ended: false });
  });

  it("a late completion or session exit of an older turn never ends the running one", () => {
    noteTurnEvent(frame("turn.started", "u1"));
    noteTurnEvent(frame("turn.started", "u2"));
    noteTurnEvent(frame("turn.completed", "u1"));
    expect(turnLive("t1")).toEqual({ turnId: "u2", ended: false });
    noteTurnEvent(frame("session.exited", "u1"));
    noteTurnEvent(frame("session.exited"));
    expect(turnLive("t1").ended).toBe(false);
    noteTurnEvent(frame("session.exited", "u2"));
    expect(turnLive("t1").ended).toBe(true);
  });

  it("a late activity frame of an older turn, then its completion, never ends the newer turn", () => {
    noteTurnEvent(frame("turn.started", "u1"));
    noteTurnEvent(frame("turn.started", "u2"));
    noteTurnEvent(frame("item.updated", "u1"));
    expect(turnLive("t1")).toEqual({ turnId: "u2", ended: false });
    noteTurnEvent(frame("turn.completed", "u1"));
    noteTurnEvent(frame("session.exited", "u1"));
    expect(turnLive("t1")).toEqual({ turnId: "u2", ended: false });
    noteTurnEvent(frame("turn.completed", "u2"));
    expect(turnLive("t1")).toEqual({ turnId: "u2", ended: true });
    // Also once the newer turn has ended: the older one never comes back.
    noteTurnEvent(frame("item.started", "u1"));
    expect(turnLive("t1")).toEqual({ turnId: "u2", ended: true });
  });

  it("a thread first seen mid-turn (turn.started missed) is tracked, so that turn's exit ends it", () => {
    noteTurnEvent(frame("item.started", "u1"));
    expect(turnLive("t1")).toEqual({ turnId: "u1", ended: false });
    noteTurnEvent(frame("session.exited", "u1"));
    expect(turnLive("t1")).toEqual({ turnId: "u1", ended: true });
  });

  it("end-of-turn frames in order: the mascot stays through the reply and hides at turn.completed, never popping back", () => {
    noteTurnEvent(frame("turn.started", "u1"));
    // 1. the settled reply lands while busy: the turn has not ended, the mascot stays.
    expect(showWorkingDots(true, reply, undefined, turnLive("t1").ended)).toBe(true);
    // 2. turn.completed: hidden.
    noteTurnEvent(frame("turn.completed", "u1"));
    expect(showWorkingDots(true, reply, undefined, turnLive("t1").ended)).toBe(false);
    // 3. busy off: still hidden.
    expect(showWorkingDots(false, reply, undefined, turnLive("t1").ended)).toBe(false);
  });
});
