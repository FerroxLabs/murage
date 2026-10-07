// The owner's split sentences (call-turns.ts), from the 2026-09-30 call:
// "Blues Brothers," then "Heartbreak Ridge.", and "dead on the money." then
// "across the board there." each cut Sable's reply off.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { answerCallQuestion, restates, LONG_ENDPOINT_HOLD_MS, CALL_ENDPOINT_LONG_MS, CALL_ENDPOINT_MS, UNFINISHED_WORDS, VAD_ENDPOINT_LONG_MS, VAD_ENDPOINT_MS, micEndStep, CONTINUATION_CAP_MS, CONTINUATION_WAIT_MS, groupBusyStep, HeldLine, HOLD_ON_MS, holdsOn, joinsTurn, soundsUnfinished, STALE_ONSET_MS, talkOverVerdict, turnTiming, UtteranceWords } from "./call-turns";

describe("soundsUnfinished", () => {
  it("hears a comma, an ellipsis or a word that leads on as a pause mid-thought", () => {
    for (const line of [
      "my favourite top three movies. Blues Brothers,",
      "That's actually...",
      "That's actually…",
      "I like to laugh and",
      "It was good, but",
      "I stopped because",
      "So I went home, so",
      "tea or",
      "and, ",
    ]) {
      expect(soundsUnfinished(line), line).toBe(true);
    }
  });

  it("hears a line that stops on an article, preposition, filler or helper word as unfinished", () => {
    for (const line of ["my top three movies are", "and um", "send it to", "I was thinking, uh", "it is a", "can you check the", "That depends on the", "what do you think of the", "so"]) {
      expect(soundsUnfinished(line), line).toBe(true);
    }
  });

  it("hears Apple's own sentence end as finished, even after such a word", () => {
    for (const line of ["send it.", "Is it ready?", "go on then!", "Check the deploy and send it to Sable."]) expect(soundsUnfinished(line), line).toBe(false);
  });

  it("hears a finished line as finished", () => {
    for (const line of ["Heartbreak Ridge.", "I think so.", "What about Band?", "Stop.", "Casablanca", "Sandor", "brand new"]) {
      expect(soundsUnfinished(line), line).toBe(false);
    }
  });
});

describe("holdsOn", () => {
  it("keeps a held line for a hold-on word with no stop word", () => {
    for (const line of ["hold on", "Hold on.", "wait", "wait, wait", "okay, pause", "just wait"]) expect(holdsOn(line), line).toBe(true);
  });

  it("any stop word wins, wherever it is (re-review 2)", () => {
    for (const line of ["wait, stop", "no, wait, stop", "stop, wait", "hold on, stop", "pause, be quiet", "wait, shut up", "hold on, that's enough", "wait, hush", "stop", "quiet", "enough"]) {
      expect(holdsOn(line), line).toBe(false);
    }
  });
});

describe("HeldLine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends a finished line at once", () => {
    const send = vi.fn();
    const held = new HeldLine(send, () => false);
    expect(held.take("Heartbreak Ridge.")).toBe("Heartbreak Ridge.");
    expect(held.holding).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("holds an unfinished line and joins the rest to it when it comes", () => {
    const send = vi.fn();
    const held = new HeldLine(send, () => false);
    expect(held.take("my top three movies. Blues Brothers,")).toBeNull();
    expect(held.holding).toBe(true);
    vi.advanceTimersByTime(CONTINUATION_WAIT_MS - 100);
    expect(held.take("Heartbreak Ridge.")).toBe("my top three movies. Blues Brothers, Heartbreak Ridge.");
    vi.advanceTimersByTime(10_000);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends the held line alone when the owner does not go on", () => {
    const send = vi.fn();
    const held = new HeldLine(send, () => false);
    held.take("That's actually...");
    vi.advanceTimersByTime(CONTINUATION_WAIT_MS - 1);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledWith("That's actually...");
    expect(held.holding).toBe(false);
  });

  it("once the owner has gone on, waits for that line, but no longer than the cap", () => {
    const send = vi.fn();
    let pending = true;
    const held = new HeldLine(send, () => pending);
    held.take("I like to laugh and");
    vi.advanceTimersByTime(3_000);
    expect(send).not.toHaveBeenCalled();
    // the rest came in: joined, nothing sent on its own
    expect(held.take("cerebral movies too.")).toBe("I like to laugh and cerebral movies too.");
    // and a line whose rest never lands goes by the cap
    held.take("Blues Brothers,");
    vi.advanceTimersByTime(CONTINUATION_CAP_MS + 200);
    expect(send).toHaveBeenCalledWith("Blues Brothers,");
    pending = false;
  });

  it("measures the cap from the owner's pause, not from when the line landed", () => {
    const send = vi.fn();
    const held = new HeldLine(send, () => true);
    // Flux's line landed 2.5 s after the owner stopped
    held.take("Blues Brothers,", Date.now() - 2_500);
    vi.advanceTimersByTime(CONTINUATION_CAP_MS - 2_500 - 200);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(send).toHaveBeenCalledWith("Blues Brothers,");
  });

  it("asks whether speech began after the pause, so an older start never stretches the wait", () => {
    const send = vi.fn();
    const pausedAt = Date.now() - 1_000;
    const asked: number[] = [];
    // a start from before the pause (a stale onset) is not more speech
    const staleOnset = pausedAt - 5_000;
    const held = new HeldLine(send, (since) => {
      asked.push(since);
      return staleOnset >= since;
    });
    held.take("Blues Brothers,", pausedAt);
    vi.advanceTimersByTime(CONTINUATION_WAIT_MS);
    expect(asked).toEqual([pausedAt]);
    expect(send).toHaveBeenCalledWith("Blues Brothers,");
  });

  it("a joined line that still sounds unfinished waits again", () => {
    const send = vi.fn();
    const held = new HeldLine(send, () => false);
    held.take("Blues Brothers,");
    expect(held.take("Trading Places,")).toBeNull();
    vi.advanceTimersByTime(CONTINUATION_WAIT_MS);
    expect(send).toHaveBeenCalledWith("Blues Brothers, Trading Places,");
  });

  it("park() (\"hold on\") keeps the held line waiting, so the next line joins it", () => {
    const send = vi.fn();
    const held = new HeldLine(send, () => false);
    held.take("My top three movies are,");
    vi.advanceTimersByTime(1_000);
    held.park();
    expect(held.holding).toBe(true);
    // well past the ordinary wait: still held
    vi.advanceTimersByTime(HOLD_ON_MS - 1_000);
    expect(send).not.toHaveBeenCalled();
    expect(held.take("Casablanca, Blues Brothers and Heartbreak Ridge.")).toBe("My top three movies are, Casablanca, Blues Brothers and Heartbreak Ridge.");
    vi.advanceTimersByTime(30_000);
    expect(send).not.toHaveBeenCalled();
  });

  it("a parked line nobody goes on from is sent as it is, after HOLD_ON_MS", () => {
    const send = vi.fn();
    const held = new HeldLine(send, () => false);
    held.take("My top three movies are,");
    held.park();
    vi.advanceTimersByTime(HOLD_ON_MS - 1);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledWith("My top three movies are,");
  });

  it("park() with nothing held does nothing", () => {
    const send = vi.fn();
    const held = new HeldLine(send, () => false);
    held.park();
    expect(held.holding).toBe(false);
    vi.advanceTimersByTime(HOLD_ON_MS * 2);
    expect(send).not.toHaveBeenCalled();
  });

  it("drop() forgets the held line without sending it", () => {
    const send = vi.fn();
    const held = new HeldLine(send, () => false);
    held.take("Blues Brothers,");
    held.drop();
    vi.advanceTimersByTime(10_000);
    expect(send).not.toHaveBeenCalled();
    expect(held.take("Hello.")).toBe("Hello.");
  });
});

describe("joinsTurn", () => {
  const sentAt = 100_000;

  it("joins anything while nothing of the reply has been heard", () => {
    expect(joinsTurn({ sentAt, playingAt: null }, { began: sentAt + 9_000, now: sentAt + 10_000 })).toBe(true);
  });

  it("joins the second half that began soon after the send, before 2 s of the reply played (T11, T24)", () => {
    // began 1.5 s after the send, the reply had played 0.5 s by then; the
    // line lands 3 s later, after the endpoint and transcription
    expect(joinsTurn({ sentAt, playingAt: sentAt + 1_000 }, { began: sentAt + 1_500, now: sentAt + 4_500 })).toBe(true);
    // began before the send (the words kept while the first half was out)
    expect(joinsTurn({ sentAt, playingAt: sentAt + 1_000 }, { began: sentAt - 500, now: sentAt + 4_000 })).toBe(true);
  });

  it("leaves a new turn alone once 2 s of the reply were heard, or 3 s had passed", () => {
    expect(joinsTurn({ sentAt, playingAt: sentAt + 500 }, { began: sentAt + 2_600, now: sentAt + 5_000 })).toBe(false);
    expect(joinsTurn({ sentAt, playingAt: sentAt + 2_900 }, { began: sentAt + 3_100, now: sentAt + 6_000 })).toBe(false);
  });

  it("a stale start never makes a real barge-in deep into the reply a continuation (review I-2)", () => {
    // an onset whose words never came, before the send; the owner talks over
    // the reply 30 s into it
    const now = sentAt + 31_000;
    expect(joinsTurn({ sentAt, playingAt: sentAt + 1_000 }, { began: sentAt - 2_000, now })).toBe(false);
    // the same start, fresh, is still the second half it looks like
    expect(joinsTurn({ sentAt, playingAt: sentAt + 1_000 }, { began: sentAt - 500, now: sentAt + STALE_ONSET_MS - 1_000 })).toBe(true);
  });

  it("without a known start, measures to now", () => {
    expect(joinsTurn({ sentAt, playingAt: sentAt + 1_000 }, { began: 0, now: sentAt + 2_000 })).toBe(true);
    expect(joinsTurn({ sentAt, playingAt: sentAt + 1_000 }, { began: 0, now: sentAt + 3_500 })).toBe(false);
  });
});

describe("turnTiming", () => {
  it("is one line of numbers, never words", () => {
    const line = turnTiming({ endedAt: 1_000, lineAt: 2_500, sentAt: 2_500, firstSentenceAt: 5_600, playingAt: 6_400 });
    expect(line).toBe(
      "[call-diag] turn timing: endpoint->transcript 1500 ms, transcript->sent 0 ms, sent->host first sentence 3100 ms, piece->tts headers - ms, headers->first byte - ms, first byte->playing - ms, ->first clip playing 800 ms, sent->playing 3900 ms, total 5400 ms, piece=-, player=-, path=host, ack=-",
    );
    expect(turnTiming({ lineAt: 2_500, sentAt: 3_700, firstSentenceAt: null, playingAt: null })).toContain("endpoint->transcript - ms");
  });

  it("splits the speech stage into tts headers, first byte and playing, and names the piece, player and path", () => {
    const line = turnTiming({
      endedAt: 1_000,
      lineAt: 2_500,
      sentAt: 2_600,
      firstSentenceAt: 3_000,
      ttsRequestedAt: 3_010,
      ttsHeadersAt: 3_400,
      ttsFirstByteAt: 3_650,
      playingAt: 3_800,
      piece: "clause",
      pieceChars: 42,
      player: "native",
      path: "host",
      ackAt: 3_100,
    });
    expect(line).toBe(
      "[call-diag] turn timing: endpoint->transcript 1500 ms, transcript->sent 100 ms, sent->host first sentence 400 ms, piece->tts headers 390 ms, headers->first byte 250 ms, first byte->playing 150 ms, ->first clip playing 800 ms, sent->playing 1200 ms, total 2800 ms, piece=clause:42, player=native, path=host, ack=500",
    );
  });

  it("names the engine path, which has no host piece", () => {
    const line = turnTiming({ lineAt: 2_000, sentAt: 2_000, firstSentenceAt: null, playingAt: 9_000, path: "engine" });
    expect(line).toContain("sent->playing 7000 ms");
    expect(line).toContain("path=engine");
    expect(line).toContain("piece=-");
  });
});

describe("answerCallQuestion (callbar-rereview3.md A2)", () => {
  it("posts the request's own id and the call's frozen thread, not a route that needs the bot's current task", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe("/api/threads/thread-a/respond");
      expect(JSON.parse(init?.body as string)).toEqual({ requestId: "req-1", behavior: "answer", message: "Use the private draft" });
      return new Response(null, { status: 200 });
    });
    const ok = await answerCallQuestion("thread-a", "req-1", "Use the private draft", fetchImpl);
    expect(ok).toBe("sent");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends the desktop surface proof, using the real request path with no injected fetch (C1)", async () => {
    vi.stubGlobal("muragebox", { desktopSurfaceSecret: "launch-secret" });
    const seen: Array<Record<string, string>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen.push(init?.headers as Record<string, string>);
        return new Response(null, { status: 200 });
      }),
    );
    try {
      expect(await answerCallQuestion("thread-a", "req-1", "yes")).toBe("sent");
      expect(seen[0]).toMatchObject({ "x-murage-surface": "desktop", "x-murage-surface-secret": "launch-secret", "content-type": "application/json" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("answers false, never throws, when the route refuses or the fetch itself fails", async () => {
    const refused = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(null, { status: 409 }));
    expect(await answerCallQuestion("thread-a", "req-1", "yes", refused)).toBe("refused");
    const down = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(null, { status: 503 }));
    expect(await answerCallQuestion("thread-a", "req-1", "yes", down)).toBe("failed");
    for (const status of [408, 429]) {
      const limited = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(null, { status }));
      expect(await answerCallQuestion("thread-a", "req-1", "yes", limited), String(status)).toBe("failed");
    }
    const broken = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => {
      throw new Error("network down");
    });
    await expect(answerCallQuestion("thread-a", "req-1", "yes", broken)).resolves.toBe("failed");
  });
});

describe("groupBusyStep (callbar-rereview3.md A3)", () => {
  const frozen = "thread-a";
  const live = (threadId: string, busy: boolean) => ({ threadId, working: busy, busyBotId: busy ? "bot-1" : null });

  it("a busy room on its own thread parks the call on working and hushes the microphone", () => {
    expect(groupBusyStep({ live: live(frozen, true), frozenThreadId: frozen, lastBusy: false, phase: "listening", asking: false, allowBargeIn: false })).toEqual({ busy: true, step: "work" });
  });

  it("another task of the room going busy never changes the call's phase or stops its recognition", () => {
    for (const phase of ["listening", "sending", "working", "speaking"] as const) {
      expect(groupBusyStep({ live: live("thread-b", true), frozenThreadId: frozen, lastBusy: false, phase, asking: false, allowBargeIn: false })).toEqual({ busy: false, step: "none" });
    }
  });

  it("another task going idle does not start listening over the call's own running work", () => {
    expect(groupBusyStep({ live: live("thread-b", false), frozenThreadId: frozen, lastBusy: true, phase: "working", asking: false, allowBargeIn: false })).toEqual({ busy: true, step: "none" });
  });

  it("the call's own work finishing returns it to listening", () => {
    expect(groupBusyStep({ live: live(frozen, false), frozenThreadId: frozen, lastBusy: true, phase: "working", asking: false, allowBargeIn: false })).toEqual({ busy: false, step: "listen" });
  });

  it("an open ask or a barge-in keeps the microphone as it is", () => {
    expect(groupBusyStep({ live: live(frozen, true), frozenThreadId: frozen, lastBusy: false, phase: "listening", asking: true, allowBargeIn: false }).step).toBe("none");
    expect(groupBusyStep({ live: live(frozen, true), frozenThreadId: frozen, lastBusy: false, phase: "listening", asking: false, allowBargeIn: true }).step).toBe("none");
  });
});

describe("micEndStep (A5)", () => {
  const base = { code: 1, hostOn: true, phase: "listening" as const, heard: false, sinceRestartMs: 10_000 };

  it("a transcription failure while listening says what failed and listens again", () => {
    for (const reason of ["transcription-unreachable", "transcription-failed"]) {
      expect(micEndStep({ ...base, reason })).toEqual({ note: "Couldn't reach Murage to transcribe that.", listen: true });
    }
  });

  it("a transcription failure is rate-limited like a recognition error: inside 3 s it only notes", () => {
    expect(micEndStep({ ...base, reason: "transcription-unreachable", sinceRestartMs: 1_000 })).toEqual({ note: "Couldn't reach Murage to transcribe that.", listen: false });
  });

  it("a transcription failure never reads as a macOS permissions fault", () => {
    expect(micEndStep({ ...base, reason: "transcription-failed", phase: "speaking" }).note).toBe("Couldn't reach Murage to transcribe that.");
  });

  it("a real helper fault still reads as access", () => {
    expect(micEndStep({ ...base, reason: "permission" })).toEqual({ note: "Dictation needs Microphone + Speech Recognition access in System Settings.", listen: false });
  });

  it("macOS Dictation being off is named as that, never as a microphone permission (upstream #2033)", () => {
    const step = micEndStep({ ...base, reason: "dictation-disabled" });
    expect(step).toEqual({ note: "Turn on Dictation in System Settings \u2192 Keyboard, then try again.", listen: false });
    expect(step.note).not.toMatch(/Microphone|Speech Recognition access/);
    // not the quiet reopen a recognition error gets: it would loop on a setting that is off
    expect(micEndStep({ ...base, reason: "dictation-disabled", hostOn: true, heard: false }).listen).toBe(false);
  });

  it("a recognition error reopens quietly only with the host on, listening and nothing heard", () => {
    expect(micEndStep({ ...base, reason: "recognition-error" })).toEqual({ note: null, listen: true });
    expect(micEndStep({ ...base, reason: "recognition-error", hostOn: false }).listen).toBe(false);
  });
});

describe("the end-of-turn windows", () => {
  it("are 1500 / 2800 ms on the Apple paths and 1200 / 2500 ms on the voice-detector path", () => {
    expect([CALL_ENDPOINT_MS, CALL_ENDPOINT_LONG_MS]).toEqual([1500, 2800]);
    expect([VAD_ENDPOINT_MS, VAD_ENDPOINT_LONG_MS]).toEqual([1200, 2500]);
  });

  it("use the very same unfinished-word list in the Mac helper", () => {
    const swift = readFileSync("electron/resources/speech-helper.swift", "utf8");
    const block = /let unfinishedWords: Set<String> = \[([^\]]*)\]/.exec(swift)?.[1] ?? "";
    const inSwift = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(inSwift).toEqual([...UNFINISHED_WORDS].sort());
  });
});

describe("one list, one set of matching rules, on both sides", () => {
  const cases: Array<{ line: string; unfinished: boolean }> = JSON.parse(readFileSync("src/lib/unfinished-cases.json", "utf8"));

  it("TypeScript agrees with every row of the shared table", () => {
    for (const row of cases) expect(soundsUnfinished(row.line), JSON.stringify(row.line)).toBe(row.unfinished);
  });

  it("does not hold on words that commonly end a finished sentence", () => {
    for (const word of ["that", "on", "in", "like", "for"]) expect(UNFINISHED_WORDS as readonly string[]).not.toContain(word);
    for (const word of ["to", "so", "and", "but", "or", "because", "the", "a", "an", "um", "uh"]) expect(UNFINISHED_WORDS as readonly string[]).toContain(word);
  });

  const hasSwiftc = (() => {
    try {
      execFileSync("swiftc", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  it.skipIf(!hasSwiftc)("the Mac helper's Swift agrees with every row of the same table", () => {
    const swift = readFileSync("electron/resources/speech-helper.swift", "utf8");
    const block = swift.slice(swift.indexOf("let unfinishedWords"), swift.indexOf("let stopFile"));
    const dir = mkdtempSync(path.join(tmpdir(), "unfinished-"));
    const source = path.join(dir, "main.swift");
    writeFileSync(
      source,
      `import Foundation
${block}
struct Row: Decodable { let line: String; let unfinished: Bool }
let rows = try! JSONDecoder().decode([Row].self, from: FileManager.default.contents(atPath: CommandLine.arguments[1])!)
var bad: [String] = []
for row in rows where soundsUnfinished(row.line) != row.unfinished { bad.append(row.line) }
print(bad.isEmpty ? "ok" : "mismatch: " + bad.joined(separator: " | "))
`,
    );
    execFileSync("swiftc", ["-o", path.join(dir, "check"), source], { stdio: "pipe" });
    const out = execFileSync(path.join(dir, "check"), [path.resolve("src/lib/unfinished-cases.json")], { encoding: "utf8" });
    expect(out.trim()).toBe("ok");
  }, 180_000);
});

describe("the hold after a line the helper already waited long for", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits 400 ms instead of 1.2 s, so the two waits do not stack", () => {
    expect(LONG_ENDPOINT_HOLD_MS).toBe(400);
    const send = vi.fn();
    const held = new HeldLine(send, () => false);
    expect(held.take("my top three movies are", undefined, LONG_ENDPOINT_HOLD_MS)).toBeNull();
    vi.advanceTimersByTime(399);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(send).toHaveBeenCalledWith("my top three movies are");
  });

  it("still waits the full 1.2 s when the helper did not use its long window", () => {
    const send = vi.fn();
    const held = new HeldLine(send, () => false);
    held.take("my top three movies are");
    vi.advanceTimersByTime(CONTINUATION_WAIT_MS - 1);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(send).toHaveBeenCalled();
  });

  it("keeps hold-on and the rest joining it, whatever the window", () => {
    const send = vi.fn();
    const held = new HeldLine(send, () => false);
    held.take("my top three movies are", undefined, LONG_ENDPOINT_HOLD_MS);
    held.park();
    vi.advanceTimersByTime(HOLD_ON_MS - 1);
    expect(send).not.toHaveBeenCalled();
    expect(held.take("Heartbreak Ridge.")).toBe("my top three movies are Heartbreak Ridge.");
  });

  it("a stop word's drop() still takes it back", () => {
    const send = vi.fn();
    const held = new HeldLine(send, () => false);
    held.take("my top three movies are", undefined, LONG_ENDPOINT_HOLD_MS);
    held.drop();
    vi.advanceTimersByTime(5_000);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("talkOverVerdict", () => {
  /**
   * A mic like CallMic: 32 ms frames, only the last 5 s kept (call-mic.ts
   * `recent`), speechWithin from the newest speech frame (unbounded),
   * speechShare over the frames still held. `bursts` are [from, to] speech
   * spans in epoch ms.
   */
  const FRAME = 32;
  const realisticMic = (bursts: Array<[number, number]>, now: number) => {
    const inSpeech = (t: number) => bursts.some(([a, b]) => t >= a && t < b);
    const frames: Array<{ at: number; speech: boolean }> = [];
    for (let t = now - 5_000; t <= now; t += FRAME) frames.push({ at: t, speech: inSpeech(t) });
    const lastSpeech = Math.max(0, ...frames.filter((f) => f.speech).map((f) => f.at));
    const everSpoke = bursts.some(([a]) => a <= now);
    return {
      sinceSpeechMs: everSpoke ? now - lastSpeech : undefined,
      speechWithin: (ms: number) => (everSpoke ? now - lastSpeech <= ms || bursts.some(([a, b]) => b > now - ms && a < now) : false),
      speechShare: (ms: number) => {
        const held = frames.filter((f) => f.at >= now - ms);
        return held.length ? held.filter((f) => f.speech).length / held.length : 0;
      },
    };
  };
  const verdict = (o: { began: number; now: number; bursts: Array<[number, number]>; endpointMs?: number; rejectedEarlier?: boolean }) =>
    talkOverVerdict({ final: true, began: o.began, now: o.now, evidence: undefined, endpointMs: o.endpointMs ?? CALL_ENDPOINT_MS, rejectedEarlier: o.rejectedEarlier, ...realisticMic(o.bursts, o.now) });

  it("accepts a short 'Wait' even when leftover bot echo keeps the mic's last speech frame fresh", () => {
    const t0 = 200_000;
    // "Wait" for 0.6 s; the final lands after the endpoint wait plus lag, and
    // faint echo of the bot keeps flagging speech right up to now
    const began = t0 + 300;
    const now = t0 + 600 + CALL_ENDPOINT_MS + 300;
    const bursts: Array<[number, number]> = [[t0, t0 + 600], [t0 + 1_500, t0 + 1_600], [t0 + 2_300, now + 1]];
    expect(verdict({ began, now, bursts }).accept).toBe(true);
  });

  it("accepts the 'Thanks' then 'Thanks Sable.' talk-over final (root-cause case)", () => {
    const t0 = 100_000;
    // speaks 1.3 s; the first partial ("Thanks") shows 0.5 s in; the final
    // lands after the 1.5 s endpoint wait plus the recognizer's lag
    const began = t0 + 500;
    const now = t0 + 1_300 + CALL_ENDPOINT_MS + 300;
    expect(verdict({ began, now, bursts: [[t0, t0 + 1_300]] }).accept).toBe(true);
  });

  it("accepts short replies said over the bot at 70% speech density with a slow recognizer and a long endpoint", () => {
    const t0 = 100_000;
    // [reply, speech ms]: "Thanks Sable." 0.8 s, "Wait"/"Yes"/"Tuesday" 0.4-0.5 s
    for (const [what, spoke] of [["Thanks Sable.", 800], ["Wait", 450], ["Yes", 400], ["Tuesday", 500]] as Array<[string, number]>) {
      for (const endpointMs of [CALL_ENDPOINT_MS, CALL_ENDPOINT_LONG_MS]) {
        // 70% density: speech frames with gaps, ending at t0 + spoke
        const bursts: Array<[number, number]> = [];
        for (let a = 0; a < spoke; a += 100) bursts.push([t0 + a, t0 + a + 70]);
        const last = bursts[bursts.length - 1][1];
        const began = t0 + 400;
        // the final lands endpoint wait + 1.3 s of recognizer delay after the last speech
        const now = last + endpointMs + 1_300;
        const v = verdict({ began, now, bursts, endpointMs });
        expect(v.accept, `${what} @${endpointMs}`).toBe(true);
      }
    }
  });

  it("accepts a long real utterance whose start has left the 5 s history", () => {
    const t0 = 100_000;
    const now = t0 + 9_000 + CALL_ENDPOINT_MS + 300;
    expect(verdict({ began: t0 + 500, now, bursts: [[t0, t0 + 9_000]] }).accept).toBe(true);
  });

  it("rejects TV or echo: 300 ms of speech scattered over 10 s", () => {
    const t0 = 100_000;
    const now = t0 + 10_000;
    const bursts: Array<[number, number]> = [1_000, 3_000, 5_000, 6_500, 8_000, 8_700].map((a) => [t0 + a, t0 + a + 50]);
    expect(verdict({ began: t0, now, bursts }).accept).toBe(false);
  });

  it("does not count speech that left the mic's 5 s history as if it were inside it", () => {
    const t0 = 100_000;
    // 4 s of speech early in a 12 s span, then nothing the mic still holds
    const now = t0 + 12_000;
    const v = verdict({ began: t0, now, bursts: [[t0, t0 + 4_000]] });
    expect(v.accept).toBe(false);
  });

  it("keeps the 250 ms floor as an additional minimum", () => {
    const t0 = 100_000;
    // a 200 ms blip is dense in a short utterance (share passes) but under the floor
    const began = t0;
    const now = t0 + 200 + CALL_ENDPOINT_MS + 100;
    expect(verdict({ began, now, bursts: [[t0, t0 + 200]] }).accept).toBe(false);
  });

  it("a final cannot overturn a partial already rejected for the same utterance", () => {
    const t0 = 100_000;
    const began = t0 + 500;
    const now = t0 + 1_300 + CALL_ENDPOINT_MS + 300;
    const bursts: Array<[number, number]> = [[t0, t0 + 1_300]];
    expect(verdict({ began, now, bursts }).accept).toBe(true);
    expect(verdict({ began, now, bursts, rejectedEarlier: true }).accept).toBe(false);
  });

  it("an unfinished-word final waits the long endpoint: the tail is not counted as speech time", () => {
    const t0 = 100_000;
    const now = t0 + 1_500 + CALL_ENDPOINT_LONG_MS + 300;
    expect(verdict({ began: t0 + 300, now, bursts: [[t0, t0 + 1_500]], endpointMs: CALL_ENDPOINT_LONG_MS }).accept).toBe(true);
  });

  it("keeps the trailing window and share bar for a partial line", () => {
    const now = 20_000;
    const mic = (startAt: number, speechMs: number) => realisticMic([[startAt, startAt + speechMs]], now);
    expect(talkOverVerdict({ final: false, began: now - 800, now, evidence: undefined, ...mic(now - 800, 700) }).accept).toBe(true);
    expect(talkOverVerdict({ final: false, began: now - 800, now, evidence: undefined, ...mic(now - 800, 100) }).accept).toBe(false);
    expect(talkOverVerdict({ final: false, began: 0, now, evidence: undefined, ...mic(now - 5_000, 500) }).accept).toBe(false);
  });

  it("uses a Flux utterance's own evidence when it has it", () => {
    const base = { final: true, began: 0, now: 5_000, endpointMs: CALL_ENDPOINT_MS, speechWithin: () => false, speechShare: () => null };
    expect(talkOverVerdict({ ...base, evidence: { heard: true, share: 0.6 } }).accept).toBe(true);
    expect(talkOverVerdict({ ...base, evidence: { heard: true, share: 0.1 } }).accept).toBe(false);
    expect(talkOverVerdict({ ...base, evidence: { heard: false, share: 0.9 } }).accept).toBe(false);
  });
});

describe("UtteranceWords", () => {
  it("never remembers Flux's placeholder, so an empty final after it sends nothing", () => {
    const w = new UtteranceWords();
    w.push("…");
    expect(w.text).toBe("");
    w.push("");
    expect(w.text).toBe("");
    expect(w.final("")).toBe("");
  });

  it("keeps committed and current text across resets: A, empty, B is A B", () => {
    const w = new UtteranceWords();
    w.push("A");
    w.push("");
    w.push("B");
    expect(w.text).toBe("A B");
    expect(w.final("B")).toBe("A B");
  });

  it("revisions of one segment replace it, they do not stack", () => {
    const w = new UtteranceWords();
    w.push("Remind me");
    w.push("Remind me to call");
    expect(w.text).toBe("Remind me to call");
  });

  it("an empty final after a reset still sends both halves", () => {
    const w = new UtteranceWords();
    w.push("Remind me to call mom and");
    w.push("");
    w.push("at five");
    expect(w.final("")).toBe("Remind me to call mom and at five");
  });

  it("does not double text a merging helper already joined", () => {
    const w = new UtteranceWords();
    w.push("A");
    w.push("");
    w.push("A B");
    expect(w.text).toBe("A B");
  });

  it("does not double a re-sent segment after an empty result: A, empty, A B is A B", () => {
    const w = new UtteranceWords();
    w.push("A");
    w.push("");
    w.push("A B");
    expect(w.text).toBe("A B");
  });

  it("does not double kept words Apple re-sends one word at a time after a reset", () => {
    const w = new UtteranceWords();
    w.push("call mom");
    w.push("");
    w.push("call");
    w.push("call mom and");
    expect(w.final("call mom and dad")).toBe("call mom and dad");
  });

  it("A, empty, B is A B", () => {
    const w = new UtteranceWords();
    w.push("A");
    w.push("");
    w.push("B");
    expect(w.text).toBe("A B");
  });

  it("matches the re-sent segment without regard to case", () => {
    const w = new UtteranceWords();
    w.push("call mom");
    w.push("");
    w.push("Call mom and");
    expect(w.text).toBe("Call mom and");
  });

  it("a new segment that merely starts with the same letters is not a merged one", () => {
    const w = new UtteranceWords();
    w.push("A");
    w.push("");
    w.push("Apple pie");
    expect(w.text).toBe("A Apple pie");
  });

  it("clear forgets everything", () => {
    const w = new UtteranceWords();
    w.push("A");
    w.clear();
    expect(w.text).toBe("");
    expect(w.final("")).toBe("");
  });
});

describe("restates (the shared word-based segment rule)", () => {
  it("is true for the same words, or the same words followed by more", () => {
    expect(restates("A", "A")).toBe(true);
    expect(restates("A", "A B")).toBe(true);
    expect(restates("Call mom", "call MOM and")).toBe(true);
  });
  it("is word-based: 'No' is not restated by 'Nothing else'", () => {
    expect(restates("No", "Nothing else")).toBe(false);
    expect(restates("A", "Apple pie")).toBe(false);
  });
  it("ignores trailing punctuation: a closing '.' cannot double a segment", () => {
    expect(restates("call mom and.", "call mom and at five")).toBe(true);
    expect(restates("Yes,", "Yes. Tuesday")).toBe(true);
  });
  it("is false for an empty kept segment", () => {
    expect(restates("", "A")).toBe(false);
  });
});
