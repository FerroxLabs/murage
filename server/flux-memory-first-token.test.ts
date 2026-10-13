// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { FluxFirstTokenProbe } from "./flux-memory-first-token.ts";
import { FluxMemoryBreaker, setFluxMemorySettings } from "./flux-memory-headers.ts";

const owner = { botId: "b", audience: "owner" as const, decidedOwner: true };

function rig() {
  let t = 1000;
  const breaker = new FluxMemoryBreaker();
  const samples: Array<{ firstTokenMs: number; injectOn: boolean }> = [];
  const real = breaker.record.bind(breaker);
  breaker.record = (sample) => { samples.push(sample); real(sample); };
  return { probe: new FluxFirstTokenProbe({ breaker, now: () => t }), samples, advance: (ms: number) => { t += ms; } };
}

describe("first-token feed for the Flux Memory breaker", () => {
  it("records the first assistant token of a Flux turn once, with the recall state", () => {
    setFluxMemorySettings({});
    const { probe, samples, advance } = rig();
    probe.begin({ threadId: "t1", model: "flux-auto", warmIdentity: owner });
    advance(250);
    probe.observe({ type: "content.delta", threadId: "t1", streamKind: "assistant_text" });
    advance(100);
    probe.observe({ type: "content.delta", threadId: "t1", streamKind: "assistant_text" });
    expect(samples).toEqual([{ firstTokenMs: 250, injectOn: true }]);
  });

  it("a non-owner turn is the inject-off baseline", () => {
    const { probe, samples, advance } = rig();
    probe.begin({ threadId: "t2", model: "flux::flux-auto", warmIdentity: { botId: "b", audience: "non-owner", decidedOwner: false } });
    advance(90);
    probe.observe({ type: "content.delta", threadId: "t2", streamKind: "assistant_text" });
    expect(samples).toEqual([{ firstTokenMs: 90, injectOn: false }]);
  });

  it("a Flux connection counts, a native turn, a prewarm and other streams do not", () => {
    const { probe, samples, advance } = rig();
    probe.begin({ threadId: "c", model: "claude-opus-5-5", warmIdentity: owner, providerRoute: { preset: "flux" } as never });
    probe.begin({ threadId: "n", model: "gpt-5.6-sol", warmIdentity: owner });
    probe.begin({ threadId: "p", model: "flux-auto", prewarm: true });
    probe.begin({ threadId: "r", model: "flux-auto", warmIdentity: owner });
    advance(10);
    for (const id of ["c", "n", "p"]) probe.observe({ type: "content.delta", threadId: id, streamKind: "assistant_text" });
    probe.observe({ type: "content.delta", threadId: "r", streamKind: "reasoning_text" });
    expect(samples.map((s) => s.firstTokenMs)).toEqual([10]);
  });

  it("a turn that ends with no token leaves nothing behind", () => {
    const { probe, samples } = rig();
    probe.begin({ threadId: "e", model: "flux-auto", warmIdentity: owner });
    probe.observe({ type: "turn.completed", threadId: "e" });
    probe.observe({ type: "content.delta", threadId: "e", streamKind: "assistant_text" });
    expect(samples).toEqual([]);
  });
});
