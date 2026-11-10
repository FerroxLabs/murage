// SPDX-License-Identifier: AGPL-3.0-or-later
// FIRSTRUN-1019 slice B: when the picture is rewritten (B5 and B7), on fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PICTURE_DEBOUNCE_MS, PICTURE_MIN_INTERVAL_MS, createPictureScheduler, pictureHeld, pictureSignature } from "./startup-picture-schedule";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { vi.useRealTimers(); });

const make = (result: boolean | Error = true) => {
  const run = vi.fn(async (_signature: string) => { if (result instanceof Error) throw result; return result; });
  return { run, scheduler: createPictureScheduler({ run }) };
};
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("B5 a renamed, recoloured or re-bodied Chief rewrites the picture once (debounced)", () => {
  it("uses the spec's 2 s debounce and one-minute spacing", () => {
    expect(PICTURE_DEBOUNCE_MS).toBe(2000);
    expect(PICTURE_MIN_INTERVAL_MS).toBe(60_000);
  });

  it("writes once, 2 s after the last change, with the latest signature", async () => {
    const { run, scheduler } = make();
    scheduler.update("a", false);
    await tick(1900);
    scheduler.update("b", false);
    await tick(1900);
    scheduler.update("c", false);
    await tick(1999);
    expect(run).not.toHaveBeenCalled();
    await tick(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("c", expect.any(Function));
  });

  it("never rewrites a picture it already wrote for the same signature", async () => {
    const { run, scheduler } = make();
    scheduler.update("a", false);
    await tick(2000);
    scheduler.update("a", false);
    await tick(10 * 60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("builds a signature from the Chief's name, colour, body, photo and framing, the first two teammates and the language", () => {
    const base = { chief: { id: "s", name: "Sable", color: "orange" as const }, mates: [{ id: "n", name: "Nova", color: "blue" as const }, { id: "p", name: "Pepper", color: "green" as const }, { id: "q", name: "Quill", color: "red" as const }] };
    const sig = (extra: object = {}, mates = base.mates, language = "en") => pictureSignature({ chief: { ...base.chief, ...extra }, mates } as never, language, true);
    const reference = sig();
    expect(sig()).toBe(reference);
    for (const change of [{ name: "Sable 2" }, { color: "blue" }, { mascotBody: "star" }, { avatarUrl: "/api/attachments/a-1.png" }, { avatarCrop: "circle" }, { avatarZoom: 2 }, { avatarFocusX: 0.2 }, { avatarFocusY: 0.9 }]) {
      expect(sig(change), JSON.stringify(change)).not.toBe(reference);
    }
    expect(sig({}, [base.mates[1], base.mates[0], base.mates[2]])).not.toBe(reference);
    expect(sig({}, base.mates, "de")).not.toBe(reference);
    // the third teammate is not in any tip, so it must not rewrite the picture
    expect(sig({}, base.mates.slice(0, 2))).toBe(reference);
    expect(pictureSignature({ chief: null, mates: [] }, "en", true)).toBeNull();
  });
});

describe("B7 the welcome rule: held until the setup view answers, and while first run is live and hello is untouched", () => {
  it("holds for an unknown view and for the welcome, and lets everything else through", () => {
    expect(pictureHeld(null)).toBe(true);
    expect(pictureHeld({ firstRun: true, next: "hello" })).toBe(true);
    expect(pictureHeld({ firstRun: true, next: "detect" })).toBe(false);
    expect(pictureHeld({ firstRun: true, next: null })).toBe(false);
    expect(pictureHeld({ firstRun: false, next: "hello" })).toBe(false);
    expect(pictureHeld({ firstRun: false, next: null })).toBe(false);
  });
});

describe("B7 the writer never runs while the welcome is up and never more than once a minute", () => {
  it("does not write while suspended, however long it waits, and writes after the welcome", async () => {
    const { run, scheduler } = make();
    scheduler.update("a", true);
    await tick(10 * 60_000);
    expect(run).not.toHaveBeenCalled();
    scheduler.update("a", false);
    await tick(1999);
    expect(run).not.toHaveBeenCalled();
    await tick(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a welcome that opens during the debounce cancels the pending write", async () => {
    const { run, scheduler } = make();
    scheduler.update("a", false);
    await tick(1000);
    scheduler.update("a", true);
    await tick(60_000);
    expect(run).not.toHaveBeenCalled();
  });

  it("starts the next write at least a minute after the last one", async () => {
    const { run, scheduler } = make();
    scheduler.update("a", false);
    await tick(2000);
    const first = Date.now();
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.update("b", false);
    await tick(2000);
    expect(run).toHaveBeenCalledTimes(1);
    await tick(PICTURE_MIN_INTERVAL_MS - 2000 - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(Date.now() - first).toBeGreaterThanOrEqual(PICTURE_MIN_INTERVAL_MS);
  });

  it("a write already composing is never saved after the welcome opens, a change arrives or the writer is disposed", async () => {
    const saved: string[] = [];
    let release: () => void = () => {};
    const run = vi.fn(async (signature: string, isCurrent: () => boolean) => {
      await new Promise<void>((resolve) => { release = resolve; });
      if (!isCurrent()) return false;
      saved.push(signature);
      return true;
    });
    const scheduler = createPictureScheduler({ run });
    scheduler.update("a", false);
    await tick(2000);
    scheduler.update("a", true);
    release();
    await tick(0);
    expect(saved).toEqual([]);
    scheduler.update("b", false);
    await tick(PICTURE_MIN_INTERVAL_MS);
    scheduler.update("c", false);
    release();
    await tick(0);
    expect(saved).toEqual([]);
    await tick(PICTURE_MIN_INTERVAL_MS);
    release();
    await tick(0);
    expect(saved).toEqual(["c"]);
    scheduler.update("d", false);
    await tick(PICTURE_MIN_INTERVAL_MS);
    scheduler.dispose();
    release();
    await tick(0);
    expect(saved).toEqual(["c"]);
  });

  it("the same picture that came back (after the welcome, or A to B to A) while a slow write ran is still written afterwards", async () => {
    const saved: string[] = [];
    let release: () => void = () => {};
    const run = vi.fn(async (signature: string, isCurrent: () => boolean) => {
      await new Promise<void>((resolve) => { release = resolve; });
      if (!isCurrent()) return false;
      saved.push(signature);
      return true;
    });
    const scheduler = createPictureScheduler({ run });
    scheduler.update("a", false);
    await tick(2000);
    scheduler.update("a", true);
    scheduler.update("a", false);
    await tick(PICTURE_MIN_INTERVAL_MS);
    release();
    await tick(0);
    expect(saved).toEqual([]);
    await tick(PICTURE_MIN_INTERVAL_MS + 2000);
    release();
    await tick(0);
    expect(saved).toEqual(["a"]);
    scheduler.update("b", false);
    await tick(PICTURE_MIN_INTERVAL_MS);
    scheduler.update("c", false);
    scheduler.update("b", false);
    release();
    await tick(0);
    await tick(PICTURE_MIN_INTERVAL_MS + 2000);
    release();
    await tick(0);
    expect(saved).toEqual(["a", "b"]);
  });

  it("counts the minute from when a slow write finished, so two saves are never closer than a minute", async () => {
    const savedAt: number[] = [];
    let release: () => void = () => {};
    const run = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      savedAt.push(Date.now());
      return true;
    });
    const scheduler = createPictureScheduler({ run });
    scheduler.update("a", false);
    await tick(2000);
    await tick(30_000);
    scheduler.update("b", false);
    release();
    await tick(0);
    await tick(PICTURE_MIN_INTERVAL_MS + 2000);
    release();
    await tick(0);
    expect(savedAt).toHaveLength(2);
    expect(savedAt[1] - savedAt[0]).toBeGreaterThanOrEqual(PICTURE_MIN_INTERVAL_MS);
  });

  it("a failed write is not retried in a loop, and the next change still goes through", async () => {
    const { run, scheduler } = make(false);
    scheduler.update("a", false);
    await tick(2000);
    await tick(10 * 60_000);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.update("b", false);
    await tick(PICTURE_MIN_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("a write that throws is contained, and dispose cancels what is waiting", async () => {
    const { run, scheduler } = make(new Error("boom"));
    scheduler.update("a", false);
    await tick(2000);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.update("b", false);
    scheduler.dispose();
    await tick(10 * 60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
