import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ACK_AFTER_MS, ACK_KEYS, ACK_STALE_MS, AckGate, cueMayPlay, phaseAfterCue, pickAck, roomOtherSpeech, type AckKey } from "./call-ack";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function gate(opts: { last?: AckKey | null } = {}) {
  const fired: AckKey[] = [];
  const g = new AckGate({ fire: (key) => fired.push(key), ...opts });
  return { g, fired };
}

describe("AckGate", () => {
  it("fires once when no real piece lands by 1300 ms", () => {
    const { g, fired } = gate();
    g.start(Date.now());
    vi.advanceTimersByTime(ACK_AFTER_MS - 1);
    expect(fired).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(fired).toHaveLength(1);
    expect(g.fired).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(fired).toHaveLength(1);
  });

  it("times from the send, not from when the gate was armed", () => {
    const { g, fired } = gate();
    const sentAt = Date.now();
    vi.advanceTimersByTime(300);
    g.start(sentAt);
    vi.advanceTimersByTime(ACK_AFTER_MS - 300);
    expect(fired).toHaveLength(1);
  });

  it("never fires when a real piece lands at 1200 ms", () => {
    const { g, fired } = gate();
    g.start(Date.now());
    vi.advanceTimersByTime(1_200);
    g.realPiece();
    vi.advanceTimersByTime(5_000);
    expect(fired).toHaveLength(0);
    g.slow("engine");
    expect(fired).toHaveLength(0);
    expect(g.fired).toBe(false);
  });

  it("slow('engine') at 200 ms fires at once and the timer does not fire again", () => {
    const { g, fired } = gate();
    g.start(Date.now());
    vi.advanceTimersByTime(200);
    g.slow("engine");
    expect(fired).toHaveLength(1);
    vi.advanceTimersByTime(5_000);
    expect(fired).toHaveLength(1);
    g.slow("lookup");
    expect(fired).toHaveLength(1);
  });

  it("cancel() at 1000 ms never fires, and a later slow() does not either", () => {
    const { g, fired } = gate();
    g.start(Date.now());
    vi.advanceTimersByTime(1_000);
    g.cancel();
    vi.advanceTimersByTime(5_000);
    g.slow("engine");
    expect(fired).toHaveLength(0);
  });

  it("a gate that was never started does not fire on slow()", () => {
    const { g, fired } = gate();
    g.slow("engine");
    expect(fired).toHaveLength(0);
  });

  it("starting again re-arms a fresh turn", () => {
    const { g, fired } = gate();
    g.start(Date.now());
    g.cancel();
    g.start(Date.now());
    vi.advanceTimersByTime(ACK_AFTER_MS);
    expect(fired).toHaveLength(1);
  });

  it("draws only from the pool it was given, never repeating the last", () => {
    const pool = ["calls.ack.oneSec", "calls.ack.checking"] as const;
    const fired: AckKey[] = [];
    let last: AckKey | null = null;
    for (let i = 0; i < 20; i += 1) {
      const g: AckGate = new AckGate({ fire: (key) => void fired.push(key), keys: pool, last });
      g.start(Date.now());
      g.slow("engine");
      last = g.lastKey;
    }
    expect(fired.every((key) => (pool as readonly AckKey[]).includes(key))).toBe(true);
    for (let i = 1; i < fired.length; i += 1) expect(fired[i]).not.toBe(fired[i - 1]);
  });

  it("avoids the last key it was given", () => {
    const { g, fired } = gate({ last: "calls.ack.look" });
    g.start(Date.now());
    g.slow("engine");
    expect(fired[0]).not.toBe("calls.ack.look");
  });
});

describe("pickAck", () => {
  it("never repeats the last key over 100 draws, and uses every key", () => {
    let last: AckKey | null = null;
    const seen = new Set<AckKey>();
    for (let i = 0; i < 100; i += 1) {
      const next = pickAck(last, Math.random);
      expect(next).not.toBe(last);
      expect(ACK_KEYS).toContain(next);
      seen.add(next);
      last = next;
    }
    expect(seen.size).toBe(ACK_KEYS.length);
  });

  it("copes with random() returning 0 or just under 1", () => {
    for (const r of [0, 0.999999]) {
      for (const last of [null, ...ACK_KEYS] as Array<AckKey | null>) {
        expect(pickAck(last, () => r)).not.toBe(last);
      }
    }
  });
});

describe("cueMayPlay", () => {
  const ok = { live: true, superseded: false, held: false, realStarted: false, otherSpeech: false, closed: false, ageMs: 100 };

  it("plays when the turn is live and nothing else is happening", () => {
    expect(cueMayPlay(ok)).toBe(true);
  });

  it("never plays once the real reply started, the turn is gone, held, or other speech is on", () => {
    expect(cueMayPlay({ ...ok, realStarted: true })).toBe(false);
    expect(cueMayPlay({ ...ok, live: false })).toBe(false);
    expect(cueMayPlay({ ...ok, superseded: true })).toBe(false);
    expect(cueMayPlay({ ...ok, held: true })).toBe(false);
    // the instant "Mm." already played for this turn: one cue per turn
    expect(cueMayPlay({ ...ok, instantCued: true })).toBe(false);
    expect(cueMayPlay({ ...ok, instantCued: false })).toBe(true);
    expect(cueMayPlay({ ...ok, otherSpeech: true })).toBe(false);
  });

  it("never plays after a silent turn already ended (a late live-fetched clip)", () => {
    expect(cueMayPlay({ ...ok, closed: true })).toBe(false);
  });

  it("drops a cue whose clip arrived too late to be an acknowledgement", () => {
    expect(cueMayPlay({ ...ok, ageMs: ACK_STALE_MS })).toBe(true);
    expect(cueMayPlay({ ...ok, ageMs: ACK_STALE_MS + 1 })).toBe(false);
  });
});

describe("roomOtherSpeech", () => {
  it("the cue's own job does not count as other speech", () => {
    expect(roomOtherSpeech({ queuedJobs: 1, inJob: true, speaking: false })).toBe(false);
  });

  it("another queued job does, inside the job or out of it", () => {
    expect(roomOtherSpeech({ queuedJobs: 2, inJob: true, speaking: false })).toBe(true);
    expect(roomOtherSpeech({ queuedJobs: 1, inJob: false, speaking: false })).toBe(true);
    expect(roomOtherSpeech({ queuedJobs: 0, inJob: false, speaking: false })).toBe(false);
  });

  it("a speaker already sounding does", () => {
    expect(roomOtherSpeech({ queuedJobs: 1, inJob: true, speaking: true })).toBe(true);
  });
});

describe("phaseAfterCue", () => {
  const base = { live: true, realStarted: false, phase: "speaking", busy: false };

  it("returns a call that is still waiting to sending, or working while the member is busy", () => {
    expect(phaseAfterCue(base)).toBe("sending");
    expect(phaseAfterCue({ ...base, busy: true })).toBe("working");
  });

  it("leaves the phase alone once the real reply started, the turn is gone, or the phase moved on", () => {
    expect(phaseAfterCue({ ...base, realStarted: true })).toBeNull();
    expect(phaseAfterCue({ ...base, live: false })).toBeNull();
    expect(phaseAfterCue({ ...base, phase: "listening" })).toBeNull();
    expect(phaseAfterCue({ ...base, phase: "working" })).toBeNull();
  });
});
