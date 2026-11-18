// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A refusal counts as an engine-input refusal only for the lease whose own native-wire release is on the stack. Another lease's release
// (or none) never marks it, so its refusal keeps the host status line instead of the one-row note.
import { describe, expect, it } from "vitest";
import { EngineInputRevoked, releaseNativeWire, releasingEngineInput } from "./engine-input.ts";

function binding(generation: string, onRefused: () => void): any {
  return { identity: { botId: "b", threadId: "t", dispatchGeneration: generation, lineageTurnIds: [], adapterLeaseId: generation }, onLedgerRefused: onRefused };
}

describe("releasingEngineInput is scoped to the lease", () => {
  it("is true only for the generation whose release is on the stack", () => {
    const seen: Record<string, boolean> = {};
    const a = binding("gen-a", () => { seen.a = releasingEngineInput("gen-a"); seen.b = releasingEngineInput("gen-b"); });
    expect(() => releaseNativeWire(a, "no-such-sink", "x", () => undefined)).toThrow(EngineInputRevoked);
    expect(seen).toEqual({ a: true, b: false });
    expect(releasingEngineInput("gen-a")).toBe(false);
  });

  it("a refusal of lease B raised inside lease A's release is not an engine-input refusal for B", () => {
    let bSaw: boolean | undefined;
    const b = binding("gen-b", () => { bSaw = releasingEngineInput("gen-b"); });
    const a = binding("gen-a", () => b.onLedgerRefused({}));
    expect(() => releaseNativeWire(a, "no-such-sink", "x", () => undefined)).toThrow(EngineInputRevoked);
    expect(bSaw).toBe(false);
  });

  it("nested releases of one generation keep it marked until the outermost ends", () => {
    const seen: boolean[] = [];
    const inner = binding("gen-a", () => { seen.push(releasingEngineInput("gen-a")); });
    const outer = binding("gen-a", () => { try { releaseNativeWire(inner, "no-such-sink", "x", () => undefined); } catch { /* refused */ } seen.push(releasingEngineInput("gen-a")); });
    expect(() => releaseNativeWire(outer, "no-such-sink", "x", () => undefined)).toThrow(EngineInputRevoked);
    expect(seen).toEqual([true, true]);
    expect(releasingEngineInput("gen-a")).toBe(false);
  });
});
