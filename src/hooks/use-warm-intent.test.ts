// 1.0.2 bgwork: the server must learn the owner is typing for as long as they type. RC1 logged zero
// "owner is typing" lines: the only signal waited for a 1.5 s pause and went out at most once a minute,
// while the server's hold lasts 8 s. The beat now goes out on the first key and at most every 5 s.
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerFirstGate, OWNER_INTERACTION_HOLD_MS, OWNER_TYPING_BEAT_MS } from "../../server/owner-first.ts";
import { TYPING_BEAT_MS, typingBeat } from "./use-warm-intent";

afterEach(() => { vi.useRealTimers(); });

describe("typing beat", () => {
  it("sends on the first key, then at most every 5 s, and the beats leave no gap in the server hold", () => {
    let now = 0;
    const sent: number[] = [];
    const key = typingBeat(() => sent.push(now), () => now);
    // one key every 90 ms for 30 s of continuous typing
    for (; now < 30_000; now += 90) key();
    expect(sent[0]).toBe(0);
    expect(sent.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < sent.length; i++) expect(sent[i]! - sent[i - 1]!).toBeLessThan(OWNER_INTERACTION_HOLD_MS);
    expect(TYPING_BEAT_MS).toBe(OWNER_TYPING_BEAT_MS);
    expect(TYPING_BEAT_MS).toBeLessThan(OWNER_INTERACTION_HOLD_MS);
  });

  it("CPU proxy: during 30 s of typing no background slice runs; after typing stops they resume", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const gate = new OwnerFirstGate({ now: () => Date.now(), log: () => {}, random: () => 0.5, load: { overloaded: () => false, reading: () => null } });
    // the beat the composer sends, wired straight to the server's handler (POST /api/bots/:id/typing)
    const key = typingBeat(() => gate.noteOwnerInteraction(), () => Date.now());
    const slices: number[] = [];
    let stop = false;
    key(); // the first key: held from now on
    const typingFrom = Date.now();
    // a background pass: one bounded slice, then a short pause, asking the gate before every slice
    const pass = (async () => {
      while (!stop) {
        await gate.wait("memory-idle");
        if (stop) break;
        slices.push(Date.now());
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    })();
    for (let t = 0; t < 30_000; t += 90) { await vi.advanceTimersByTimeAsync(90); key(); }
    const typingTo = Date.now();
    expect(slices.filter(at => at >= typingFrom && at <= typingTo)).toEqual([]);
    // the owner stops typing: the hold ends within one hold period plus the gate's backoff step
    await vi.advanceTimersByTimeAsync(OWNER_INTERACTION_HOLD_MS + 12_000);
    expect(slices.filter(at => at > typingTo).length).toBeGreaterThan(0);
    stop = true;
    await vi.advanceTimersByTimeAsync(20_000);
    await pass;
  });
});
