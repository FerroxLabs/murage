import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  CLEANUP_PREF_KEY,
  applyCleanupResult,
  cleanupEnabled,
  dictatedPortion,
  finishThenStop,
  joinDictation,
  requestCleanup,
  setCleanupEnabled,
  undoCleanup,
  undoOffered,
} from "./dictation-cleanup";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

function memory(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe("the Clean up dictation setting", () => {
  it("is on by default", () => {
    expect(cleanupEnabled(memory())).toBe(true);
    expect(cleanupEnabled(null)).toBe(true);
  });

  it("can be turned off and back on", () => {
    const storage = memory();
    setCleanupEnabled(false, storage);
    expect(storage.getItem(CLEANUP_PREF_KEY)).toBe("off");
    expect(cleanupEnabled(storage)).toBe(false);
    setCleanupEnabled(true, storage);
    expect(cleanupEnabled(storage)).toBe(true);
  });

  it("stays on when storage throws", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(cleanupEnabled(broken)).toBe(true);
    expect(() => setCleanupEnabled(false, broken)).not.toThrow();
  });

  it("is a switch next to the voice settings", () => {
    const voice = read("../components/VoiceSettings.tsx");
    expect(voice).toContain("Clean up dictation");
    expect(voice).toContain("setCleanupEnabled");
  });

  it("says it applies on this device, for every bot", () => {
    const voice = read("../components/VoiceSettings.tsx");
    expect(voice).toContain("Clean up dictation on this device: removes ums, fixes punctuation and corrections. Undo anytime.");
    expect(voice).not.toContain("\u2014");
  });
});

describe("what was dictated", () => {
  it("is the text after what was already in the box", () => {
    expect(dictatedPortion("Hello", "Hello um world")).toBe("um world");
    expect(dictatedPortion("", "just this")).toBe("just this");
  });

  it("is nothing when the person edited the start of the box", () => {
    expect(dictatedPortion("Hello", "Hi there")).toBeNull();
    expect(dictatedPortion("Hello", "Hello")).toBeNull();
  });

  it("joins with one space", () => {
    expect(joinDictation("Hello", "World")).toBe("Hello World");
    expect(joinDictation("", "World")).toBe("World");
  });
});

describe("undo", () => {
  const undo = { raw: "Hello um world", cleaned: "Hello world." };

  it("restores the raw text", () => {
    expect(undoCleanup(undo)).toBe("Hello um world");
  });

  it("is offered only while the box still holds the cleaned text", () => {
    expect(undoOffered(undo, "Hello world.")).toBe(true);
    expect(undoOffered(undo, "Hello world. And more")).toBe(false);
    expect(undoOffered(null, "x")).toBe(false);
  });
});

describe("requestCleanup", () => {
  const ctx = { botId: "bot_1" };

  it("posts the text and returns the cleaned version", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: "Clean.", cleaned: true }), { status: 200 }));
    expect(await requestCleanup("um clean this up please", ctx, fetchImpl as never)).toEqual({ text: "Clean.", cleaned: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(url).toBe("/api/voice/cleanup");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ text: "um clean this up please", botId: "bot_1" });
  });

  it("returns the raw text on any failure", async () => {
    const raw = "um clean this up please";
    expect(await requestCleanup(raw, ctx, (async () => new Response("no", { status: 500 })) as never)).toEqual({ text: raw, cleaned: false });
    expect(await requestCleanup(raw, ctx, (async () => { throw new Error("offline"); }) as never)).toEqual({ text: raw, cleaned: false });
    expect(await requestCleanup(raw, ctx, (async () => new Response("not json", { status: 200 })) as never)).toEqual({ text: raw, cleaned: false });
    expect(await requestCleanup(raw, ctx, (async () => new Response(JSON.stringify({ text: "" }), { status: 200 })) as never)).toEqual({ text: raw, cleaned: false });
  });
});

describe("the composer", () => {
  const composer = read("../components/Composer.tsx");

  it("cleans up native dictation when it stops, and offers one-step undo", () => {
    expect(composer).toContain("requestCleanup");
    expect(composer).toContain("cleanupEnabled()");
    expect(composer).toContain("Undo clean-up");
    expect(composer).toContain("undoCleanup(");
    expect(composer).toContain("undoOffered(");
  });

  it("asks the batch push-to-talk path to clean up, with the same target", () => {
    const push = read("../components/PushToTalk.tsx");
    expect(push).toContain("cleanup=1");
    expect(composer).toMatch(/<PushToTalk[\s\S]{0,900}cleanup=\{/);
  });

  it("never asks for clean-up on a call turn", () => {
    expect(read("./call-mic.ts")).not.toMatch(/cleanup/i);
    expect(read("./group-call.ts")).not.toMatch(/api\/voice\/cleanup|cleanup=1/);
  });
});

describe("applying a clean-up result", () => {
  const result = { text: "Hello world.", cleaned: true };

  it("replaces the dictated part when the box is untouched", () => {
    expect(applyCleanupResult({ atStop: "Hi um hello world", base: "Hi", current: "Hi um hello world", result })).toEqual({
      next: "Hi Hello world.",
      undo: { raw: "Hi um hello world", cleaned: "Hi Hello world." },
    });
  });

  it("keeps what the person typed while it was in flight", () => {
    expect(applyCleanupResult({ atStop: "Hi um hello world", base: "Hi", current: "Hi um hello world and more", result })).toBeNull();
    expect(applyCleanupResult({ atStop: "Hi um hello world", base: "Hi", current: "", result })).toBeNull();
  });

  it("does nothing when clean-up changed nothing", () => {
    expect(applyCleanupResult({ atStop: "a b c d", base: "", current: "a b c d", result: { text: "a b c d", cleaned: false } })).toBeNull();
  });
});

describe("stopping dictation", () => {
  const harness = () => {
    let end: (() => void) | null = null;
    const done = vi.fn();
    const finish = vi.fn(async () => {});
    const offEnd = vi.fn();
    const onEnd = (cb: () => void) => {
      end = cb;
      return offEnd;
    };
    return { done, finish, onEnd, fire: () => end?.(), offEnd };
  };

  it("asks the helper to finish, then stops when it ends", () => {
    vi.useFakeTimers();
    const h = harness();
    finishThenStop({ finish: h.finish, onEnd: h.onEnd, done: h.done, deadlineMs: 1500 });
    expect(h.finish).toHaveBeenCalledTimes(1);
    expect(h.done).not.toHaveBeenCalled();
    h.fire();
    expect(h.done).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(h.done).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("gives up after the deadline, so stopping never hangs", () => {
    vi.useFakeTimers();
    const h = harness();
    finishThenStop({ finish: h.finish, onEnd: h.onEnd, done: h.done, deadlineMs: 1500 });
    vi.advanceTimersByTime(1499);
    expect(h.done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(h.done).toHaveBeenCalledTimes(1);
    expect(h.offEnd).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("stops at once if finish itself fails", async () => {
    const h = harness();
    finishThenStop({ finish: async () => { throw new Error("nope"); }, onEnd: h.onEnd, done: h.done, deadlineMs: 1500 });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.done).toHaveBeenCalledTimes(1);
  });

  it("is what the composer's stop and Escape use", () => {
    const composer = read("../components/Composer.tsx");
    expect(composer).toContain("finishThenStop(");
    expect(composer).toContain("speechFinish");
  });
});
