import { describe, expect, it } from "vitest";

import { createSetupTiming, pressWaitOf, readSideBySide } from "./setup-timing.ts";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("setup answer timing", () => {
  it("reads the connected apps and the engines side by side, so an answer waits for the slower, not the sum", async () => {
    // Both reads are held open by hand: the engines read must START while the
    // apps read is still unanswered. One after the other, it never would.
    const started: string[] = [];
    let releaseApps!: (value: string) => void;
    let releaseEngines!: (value: string) => void;
    let now = 0;
    const timing = createSetupTiming(() => now);
    const both = readSideBySide(
      () => { started.push("apps"); return new Promise<string>((resolve) => { releaseApps = resolve; }); },
      () => { started.push("engines"); return new Promise<string>((resolve) => { releaseEngines = resolve; }); },
      timing,
      () => now,
    );
    await wait(0);
    expect(started, "the engines read starts before the apps read answers").toEqual(["apps", "engines"]);
    now = 30;
    releaseEngines("engines");
    await wait(0);
    now = 70;
    releaseApps("apps");
    expect(await both).toEqual(["apps", "engines"]);
    expect(timing.header()).toContain("engines;dur=30");
    expect(timing.header()).toContain("apps;dur=70");
  });

  it("names every phase on the header and the log line, total last, and never the answer", async () => {
    let now = 0;
    const timing = createSetupTiming(() => now);
    await timing.phase("prepare", () => { now += 5; });
    await timing.phase("live", async () => { now += 40; });
    timing.note("apps", 30);
    await timing.phase("drive", () => { now += 7; });
    expect(timing.header()).toBe("prepare;dur=5, live;dur=40, apps;dur=30, drive;dur=7, total;dur=52");
    const line = timing.line("answer", "hello", 120);
    expect(line).toBe("[setup-timing] answer step=hello press-to-send=120ms prepare=5ms live=40ms apps=30ms drive=7ms total=52ms");
    expect(timing.line("skip", "hello", null)).not.toContain("press-to-send");
  });

  it("keeps a phase's time when the phase throws", async () => {
    let now = 0;
    const timing = createSetupTiming(() => now);
    await expect(timing.phase("live", () => { now += 9; throw new Error("no"); })).rejects.toThrow("no");
    expect(timing.header()).toContain("live;dur=9");
  });

  it("reads the renderer's press-to-send wait only when it is a plain number", () => {
    expect(pressWaitOf("85")).toBe(85);
    expect(pressWaitOf(["12", "99"])).toBe(12);
    expect(pressWaitOf(undefined)).toBeNull();
    expect(pressWaitOf("-3")).toBeNull();
    expect(pressWaitOf("Sean")).toBeNull();
    expect(pressWaitOf("12345678")).toBeNull();
  });
});
