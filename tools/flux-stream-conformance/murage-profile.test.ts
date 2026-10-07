import { describe, expect, it } from "vitest";

import { replayCallTurns } from "./murage-profile.ts";

describe("replayCallTurns", () => {
  it("holds a line that sounds unfinished and joins the rest (no host turn wasted)", () => {
    const r = replayCallTurns([
      { at: 1000, kind: "start" },
      { at: 2600, kind: "line", text: "My favourite movies are Blues Brothers,", endedAt: 1900 },
      { at: 3200, kind: "start" },
      { at: 5000, kind: "line", text: "and Heartbreak Ridge.", endedAt: 4300 },
    ]);
    expect(r).toMatchObject({ ownerTurns: ["My favourite movies are Blues Brothers, and Heartbreak Ridge."], sends: 1, superseded: 0, audibleRestarts: 0 });
  });

  it("joins a second half the hold missed (the provider ended the phrase with a period), before any reply audio", () => {
    // the spike: "Blues Brothers." / "And Heartbreak Ridge." in every run at 0.8, 1.3 and 2.0 s pauses
    const r = replayCallTurns([
      { at: 100, kind: "start" },
      { at: 1880, kind: "line", text: "Blues Brothers.", endedAt: 1130 },
      { at: 2470, kind: "start" },
      { at: 4280, kind: "line", text: "And Heartbreak Ridge.", endedAt: 3470 },
    ]);
    expect(r.ownerTurns).toEqual(["Blues Brothers. And Heartbreak Ridge."]);
    expect(r).toMatchObject({ sends: 2, superseded: 1, audibleRestarts: 0 });
  });

  it("holds a trailing comma through a 2.0 s pause on the stream path (the 2.8 s window)", () => {
    const events = [
      { at: 0, kind: "start" as const },
      { at: 2100, kind: "line" as const, text: "If it rains tomorrow,", endedAt: 1400 },
      { at: 3400, kind: "start" as const },
      { at: 5600, kind: "line" as const, text: "we should move the picnic indoors.", endedAt: 5000 },
    ];
    expect(replayCallTurns(events)).toMatchObject({ ownerTurns: ["If it rains tomorrow, we should move the picnic indoors."], sends: 1, superseded: 0 });
    // with only CallView's 1.2 s wait the held line would have gone out first
    expect(replayCallTurns(events, { streamHoldMs: 0 }).sends).toBe(2);
  });

  it("holds a line ending in an unfinished word (no comma) through a 2.4 s pause", () => {
    const r = replayCallTurns([
      { at: 0, kind: "start" },
      { at: 1700, kind: "line", text: "My favourite movie is", endedAt: 1000 },
      { at: 3400, kind: "start" },
      { at: 4800, kind: "line", text: "Casablanca.", endedAt: 4500 },
    ]);
    expect(r).toMatchObject({ ownerTurns: ["My favourite movie is Casablanca."], sends: 1, superseded: 0 });
  });

  it("does not hold a trailing comma past the window (3.2 s pause)", () => {
    const r = replayCallTurns([
      { at: 0, kind: "start" },
      { at: 1700, kind: "line", text: "If it rains tomorrow,", endedAt: 1000 },
      { at: 4200, kind: "start" }, // endedAt + 3200: after the 2.8 s window
      { at: 6000, kind: "line", text: "we should move the picnic indoors.", endedAt: 5600 },
    ]);
    // the held line went out at 3800 (two sends in all), but no reply audio had
    // started (first audio would be 7300), so CallView's joinsTurn still joins
    // the second half and asks again as one turn: it costs nothing
    expect(r).toMatchObject({ ownerTurns: ["If it rains tomorrow, we should move the picnic indoors."], sends: 2, superseded: 1, audibleRestarts: 0 });
  });

  it("counts an audible restart when the reply had started before the owner went on", () => {
    const r = replayCallTurns([
      { at: 100, kind: "start" },
      { at: 1000, kind: "line", text: "Tell me about Casablanca.", endedAt: 800 },
      { at: 2700, kind: "start" },
      { at: 3500, kind: "line", text: "In detail.", endedAt: 3300 },
    ], { hostFirstAudioMs: 1500 });
    expect(r).toMatchObject({ superseded: 1, audibleRestarts: 1 });
  });

  it("keeps two turns apart when the second starts after the join window", () => {
    const r = replayCallTurns([
      { at: 100, kind: "start" },
      { at: 1900, kind: "line", text: "Tell me a joke.", endedAt: 1200 },
      { at: 6000, kind: "start" },
      { at: 8000, kind: "line", text: "Actually, make it about cats.", endedAt: 7500 },
    ]);
    expect(r.ownerTurns).toHaveLength(2);
    expect(r.superseded).toBe(0);
  });

  it("joins a new question that lands before any reply audio (CallView's rule: it costs nothing)", () => {
    const r = replayCallTurns([
      { at: 100, kind: "start" },
      { at: 1900, kind: "line", text: "Tell me a joke.", endedAt: 1200 },
      { at: 4700, kind: "start" },
      { at: 6900, kind: "line", text: "Actually, make it about cats.", endedAt: 6400 },
    ]);
    expect(r).toMatchObject({ ownerTurns: ["Tell me a joke. Actually, make it about cats."], audibleRestarts: 0 });
  });

  it("sends a held line when the owner does not go on", () => {
    const r = replayCallTurns([
      { at: 0, kind: "start" },
      { at: 900, kind: "line", text: "and", endedAt: 400 },
    ]);
    expect(r).toMatchObject({ ownerTurns: ["and"], sends: 1 });
  });
});
