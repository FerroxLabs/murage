// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { LimitTurns, type LimitTurn } from "./limit-continuation.ts";

const turn = (over: Partial<LimitTurn> = {}): LimitTurn => ({
  botId: "b1", threadId: "t1", selection: { instanceId: "verification", model: "m" } as LimitTurn["selection"], engineName: "Engine", driverKind: "claudeAgent",
  viaGateway: false, sendIds: [], sourceMessageId: "msg-1", sourceText: "hello", ownerDirect: true, routine: false, onFailover: false, activity: false, ...over,
});

describe("LimitTurns.markPhoneHeld (X2 carry)", () => {
  it("sets the flag only on the record whose sourceMessageId matches", () => {
    const turns = new LimitTurns();
    turns.begin(turn());
    turns.markPhoneHeld("t1", "other-message");
    expect(turns.get("t1")!.phoneHeld).toBeUndefined();
    turns.markPhoneHeld("t1", "msg-1");
    expect(turns.get("t1")!.phoneHeld).toBe(true);
  });

  it("is a no-op when the thread has no record", () => {
    const turns = new LimitTurns();
    expect(() => turns.markPhoneHeld("t-none", "msg-1")).not.toThrow();
    expect(turns.get("t-none")).toBeUndefined();
  });

  it("a record begun for a later turn is not marked by an earlier turn's id", () => {
    const turns = new LimitTurns();
    turns.begin(turn({ sourceMessageId: "msg-1" }));
    turns.begin(turn({ sourceMessageId: "msg-2" }));
    turns.markPhoneHeld("t1", "msg-1");
    expect(turns.get("t1")!.phoneHeld).toBeUndefined();
  });

  it("begin writes nothing about phones, and settle hands the flag back", () => {
    const turns = new LimitTurns();
    turns.begin(turn());
    expect(turns.get("t1")!.phoneHeld).toBeUndefined();
    turns.markPhoneHeld("t1", "msg-1");
    const settled = turns.settle("t1");
    expect(settled?.phoneHeld).toBe(true);
    expect(turns.get("t1")).toBeUndefined();
  });
});
