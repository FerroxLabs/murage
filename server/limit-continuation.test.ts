// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { LimitTurns, type LimitTurn } from "./limit-continuation.ts";

const turn = (over: Partial<LimitTurn> = {}): LimitTurn => ({
  botId: "b1", threadId: "t1", selection: { instanceId: "verification", model: "m" } as LimitTurn["selection"], engineName: "Engine", driverKind: "claudeAgent",
  viaGateway: false, sendIds: [], sourceMessageId: "msg-1", sourceText: "hello", ownerDirect: true, routine: false, onFailover: false, activity: false, ...over,
});

describe("LimitTurns.observe: Murage's own chips are not engine activity", () => {
  const base = { threadId: "t1", turnId: "p1" };
  const chip = (itemId: string) => [
    { ...base, type: "item.started", itemId, itemType: "tool", origin: "murage", title: "trust chosen: AGENTS.md" },
    { ...base, type: "item.completed", itemId, itemType: "tool", ok: true },
  ];
  const seen = (...events: Parameters<LimitTurns["observe"]>[0][]) => {
    const turns = new LimitTurns();
    turns.begin(turn({ driverKind: "fuigoAgent", providerTurnId: "p1" }));
    for (const event of events) turns.observe(event);
    return turns.get("t1")!;
  };

  it("the folder trust chip, started with origin murage and completed without, leaves the turn inactive", () => {
    expect(seen(...chip("folder-trust-p1-1")).activity).toBe(false);
  });

  it("the engine's own tool still counts, beside a chip", () => {
    expect(seen(...chip("folder-trust-p1-1"),
      { ...base, type: "item.started", itemId: "call-1", itemType: "tool", origin: "engine" }).activity).toBe(true);
    expect(seen(...chip("folder-trust-p1-1"),
      { ...base, type: "item.completed", itemId: "call-1", itemType: "tool" }).activity).toBe(true);
  });

  it("reasoning still counts", () => {
    expect(seen({ ...base, type: "content.delta", streamKind: "reasoning_text", delta: "The" }).activity).toBe(true);
  });
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
