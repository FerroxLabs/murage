import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AckCues, ACK_TEXT, type CueStore } from "./ack-cue";
import { INHALE_AFTER_MS, Inhale, type InhaleTimers } from "./inhale";
import { Speaker, type Audible, type ClipPlayer, type ClipOutcome } from "./index";

/** A fake clock that also runs timers. */
class Clock implements InhaleTimers {
  t = 0;
  private timers: Array<{ id: number; at: number; fn: () => void }> = [];
  private next = 1;
  now = () => this.t;
  set(fn: () => void, ms: number) {
    const id = this.next++;
    this.timers.push({ id, at: this.t + ms, fn });
    return id;
  }
  clear(handle: unknown) {
    this.timers = this.timers.filter((x) => x.id !== handle);
  }
  advance(ms: number) {
    const to = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= to).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.t = due.at;
      this.timers = this.timers.filter((x) => x !== due);
      due.fn();
    }
    this.t = to;
  }
}

/** A player that records what it played and lets the test end each clip. */
class FakePlayer implements ClipPlayer {
  readonly streams = true;
  played: string[] = [];
  ends: Array<(o: ClipOutcome) => void> = [];
  torn = 0;
  play(clip: Audible): Promise<ClipOutcome> {
    this.played.push(clip instanceof Blob ? "blob" : "incoming");
    return new Promise((resolve) => this.ends.push(resolve));
  }
  pause() {}
  resume() {}
  teardown() {
    this.torn += 1;
    for (const end of this.ends.splice(0)) end("cut");
  }
}

const audioResponse = () =>
  new Response(new Blob(["mp3"]), { status: 200, headers: { "content-type": "audio/mpeg", "x-murage-ttfb-ms": "300", "x-murage-flux-ttfb-ms": "210" } });
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe("clips go out one after another, two ahead at most", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("never has more than two requests in flight, and sends the next only after the last answered", async () => {
    const releases: Array<() => void> = [];
    let inFlight = 0;
    let peak = 0;
    const sent: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (String(input).includes("prepare")) return new Response(JSON.stringify({ ready: true, utterances: ["one clause here now,", "the rest of it.", "Another sentence.", "And a last one."] }), { status: 200, headers: { "content-type": "application/json" } });
      sent.push(JSON.parse(String(init?.body)).text);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight -= 1;
      return audioResponse();
    }));
    const player = new FakePlayer();
    const speaker = new Speaker(() => 0, () => {});
    speaker.useOutput(player);
    void speaker.speak("whatever", { botId: "b" });
    await flush();
    // only the first clip is out until it answers
    expect(sent).toEqual(["one clause here now,"]);
    releases.shift()!();
    await flush();
    expect(sent).toHaveLength(2);
    expect(peak).toBeLessThanOrEqual(2);
    releases.shift()!();
    await flush();
    // the first is playing; the second answered; the third is prefetching
    expect(player.played.length).toBe(1);
    expect(inFlight).toBeLessThanOrEqual(2);
    speaker.stop();
  });

  it("plays the clause and its rest back to back: the second starts the moment the first ends, once each", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (String(input).includes("prepare")) return new Response(JSON.stringify({ ready: true, utterances: ["Okay, so the invoice went out,", "and the client paid already."] }), { status: 200, headers: { "content-type": "application/json" } });
      return audioResponse();
    }));
    const player = new FakePlayer();
    const speaker = new Speaker(() => 0, () => {});
    speaker.useOutput(player);
    const done = speaker.speak("x", { botId: "b" });
    await flush();
    expect(player.played).toHaveLength(1);
    player.ends.shift()!("ended");
    await flush();
    // the rest was already downloaded: no wait, no repeat
    expect(player.played).toHaveLength(2);
    player.ends.shift()!("ended");
    await done;
    expect(player.played).toHaveLength(2);
    expect(speaker.state.status).toBe("idle");
  });
});

describe("timing in the voice diagnostics", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("logs client first byte next to the harness's and the gateway's, with no text", async () => {
    const clock = new Clock();
    const lines: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (String(input).includes("prepare")) return new Response(JSON.stringify({ ready: true, utterances: ["A very private sentence here."] }), { status: 200, headers: { "content-type": "application/json" } });
      clock.advance(480);
      return audioResponse();
    }));
    const player = new FakePlayer();
    const speaker = new Speaker(clock.now, (l) => lines.push(l));
    speaker.useOutput(player);
    const done = speaker.speak("A very private sentence here.", { botId: "b" });
    await flush();
    player.ends.shift()?.("ended");
    await done;
    const ttfb = lines.find((l) => l.includes("ttfb"))!;
    expect(ttfb).toContain("client=480ms");
    expect(ttfb).toContain("server=300ms");
    expect(ttfb).toContain("flux=210ms");
    expect(lines.join("\n")).not.toMatch(/private|sentence/);
  });
});

describe("barge-in", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("is quiet within 150 ms: playback torn down and queued clips aborted in the same tick", async () => {
    const clock = new Clock();
    const lines: string[] = [];
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (String(input).includes("prepare")) return new Response(JSON.stringify({ ready: true, utterances: ["first one here now,", "second one.", "third one."] }), { status: 200, headers: { "content-type": "application/json" } });
      signals.push(init!.signal as AbortSignal);
      return audioResponse();
    }));
    const player = new FakePlayer();
    const speaker = new Speaker(clock.now, (l) => lines.push(l));
    speaker.useOutput(player);
    const done = speaker.speak("x", { botId: "b" });
    await flush();
    expect(player.played).toHaveLength(1);
    const took = speaker.cut();
    expect(took).toBeLessThanOrEqual(150);
    expect(player.torn).toBeGreaterThan(0);
    expect(signals.every((s) => s.aborted)).toBe(true);
    await done;
    expect(speaker.state.status).toBe("idle");
    // nothing more is requested or played after the cut
    await flush();
    expect(player.played).toHaveLength(1);
    expect(lines.some((l) => /barge-in stopped in \d+ms/.test(l))).toBe(true);
  });
});

describe("the instant acknowledgement", () => {
  const memoryStore = (): CueStore & { map: Map<string, Blob> } => {
    const map = new Map<string, Blob>();
    return { map, get: async (k) => map.get(k), set: async (k, v) => void map.set(k, v) };
  };

  it("is made once per voice through the normal speech path, kept, and played with no network", async () => {
    const made = vi.fn(async () => new Blob(["mm"]));
    const store = memoryStore();
    const cues = new AckCues(made, store);
    const cue = vi.fn(async () => {});
    expect(cues.play("b", "eve", { cue })).toBe(false);
    await cues.prime("b", "eve");
    await cues.prime("b", "eve");
    expect(made).toHaveBeenCalledTimes(1);
    expect(store.map.size).toBe(1);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(cues.play("b", "eve", { cue })).toBe(true);
    expect(cue).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("comes back from the local store on the next launch without asking the service again", async () => {
    const store = memoryStore();
    await new AckCues(async () => new Blob(["mm"]), store).prime("b", "ara");
    const made = vi.fn(async () => new Blob(["other"]));
    const next = new AckCues(made, store);
    await next.prime("b", "ara");
    expect(made).not.toHaveBeenCalled();
    expect(next.has("b", "ara")).toBe(true);
  });

  it("a different voice has its own cue; a failed make means no cue, not an error", async () => {
    const cues = new AckCues(async (_b, v) => { if (v === "bad") throw new Error("down"); return new Blob([v ?? ""]); });
    await cues.prime("b", "eve");
    await expect(cues.prime("b", "bad")).resolves.toBeUndefined();
    expect(cues.has("b", "eve")).toBe(true);
    expect(cues.has("b", "bad")).toBe(false);
    expect(cues.has("b", "rex")).toBe(false);
  });

  it("asks speech for the short cue text through the normal /api/tts/speak", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(new Blob(["mm"]), { status: 200 });
    }));
    await new AckCues().prime("bot1", "eve");
    expect(bodies).toEqual([{ text: ACK_TEXT, voiceId: "eve", botId: "bot1" }]);
    vi.unstubAllGlobals();
  });

  it("Speaker.cue plays through the output without changing speech state, and not over speech", async () => {
    const speaker = new Speaker(() => 0, () => {});
    const player = new FakePlayer();
    speaker.useOutput(player);
    void speaker.cue(new Blob(["mm"]));
    await flush();
    expect(player.played).toEqual(["blob"]);
    expect(speaker.state.status).toBe("idle");
  });
});

describe("the inhale", () => {
  it("shows only if no audio has started 300 ms after the ack", () => {
    const clock = new Clock();
    const states: boolean[] = [];
    const inhale = new Inhale((on) => states.push(on), clock, INHALE_AFTER_MS);
    inhale.start();
    clock.advance(299);
    expect(states).toEqual([]);
    clock.advance(1);
    expect(states).toEqual([true]);
    inhale.cancel();
    expect(states).toEqual([true, false]);
  });
  it("never shows on a fast reply", () => {
    const clock = new Clock();
    const states: boolean[] = [];
    const inhale = new Inhale((on) => states.push(on), clock);
    inhale.start();
    clock.advance(250);
    inhale.cancel();
    clock.advance(1000);
    expect(states).toEqual([]);
  });
  it("a new ack restarts the wait", () => {
    const clock = new Clock();
    const states: boolean[] = [];
    const inhale = new Inhale((on) => states.push(on), clock);
    inhale.start();
    clock.advance(200);
    inhale.start();
    clock.advance(200);
    expect(states).toEqual([]);
    clock.advance(100);
    expect(states).toEqual([true]);
  });
});
