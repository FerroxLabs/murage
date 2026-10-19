// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actionReason, createAction, type ActionOptions, type ActionSnapshot } from "./use-action";

const deferred = <T = void>() => {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
function make<R = void>(work: (...args: string[]) => Promise<R>, options: ActionOptions<R> = {}) {
  const action = createAction<string[], R>(() => work, () => options);
  const seen: ActionSnapshot[] = [];
  action.subscribe(() => seen.push(action.snapshot()));
  return { action, seen };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("useAction: pending", () => {
  it("is pending, with the pending label, before the work has done anything", () => {
    const gate = deferred();
    const { action, seen } = make(() => gate.promise, { idle: "Save", pending: "Saving…" });
    expect(action.snapshot()).toMatchObject({ pending: false, label: "Save", phase: "idle" });
    void action.run();
    // synchronously: a subscriber (the React state) has already been told
    expect(seen.at(-1)).toMatchObject({ pending: true, phase: "pending", label: "Saving…" });
    gate.resolve();
  });

  it("ignores a second press while the first is running", async () => {
    const gate = deferred();
    const work = vi.fn(() => gate.promise);
    const { action } = make(work);
    void action.run(); void action.run();
    expect(work).toHaveBeenCalledTimes(1);
    gate.resolve(); await vi.advanceTimersByTimeAsync(0);
    await action.run();
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("holds pending in React state, never a ref", () => {
    const source = readFileSync(fileURLToPath(new URL("./use-action.ts", import.meta.url)), "utf8");
    expect(source).toContain("useState<ActionSnapshot>");
    expect(source).not.toMatch(/useRef\(\s*false\s*\)/);
  });
});

describe("useAction: the slow hint and progress", () => {
  it("shows the hint after 2 s and not before", async () => {
    const gate = deferred();
    const { action } = make(() => gate.promise, { slowHint: "Still going" });
    void action.run();
    await vi.advanceTimersByTimeAsync(1999);
    expect(action.snapshot().slow).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(action.snapshot().slow).toBe(true);
    gate.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(action.snapshot().slow).toBe(false);
  });

  it("takes pushed progress while pending and drops it when the work ends", async () => {
    const gate = deferred();
    const { action } = make(() => gate.promise);
    action.setProgress({ percent: 5 });
    expect(action.snapshot().progress).toBeNull();
    void action.run();
    action.setProgress({ percent: 40, text: "Downloading" });
    expect(action.snapshot().progress).toEqual({ percent: 40, text: "Downloading" });
    gate.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(action.snapshot().progress).toBeNull();
  });

  it("polls progress on an interval, once at a time, and ignores a missed reading", async () => {
    const gate = deferred();
    let n = 0;
    const read = vi.fn(async () => { n += 1; if (n === 2) throw new Error("blip"); return { percent: n * 10 }; });
    const { action } = make(() => gate.promise, { poll: { read, everyMs: 1000 } });
    void action.run();
    await vi.advanceTimersByTimeAsync(1000);
    expect(action.snapshot().progress).toEqual({ percent: 10 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(action.snapshot().progress).toEqual({ percent: 10 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(action.snapshot().progress).toEqual({ percent: 30 });
    gate.resolve(); await vi.advanceTimersByTimeAsync(0);
    read.mockClear(); await vi.advanceTimersByTimeAsync(5000);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("useAction: success", () => {
  it("says Done by default, then fades, then goes", async () => {
    const { action } = make(async () => {}, { idle: "Save" });
    await action.run();
    expect(action.snapshot()).toMatchObject({ phase: "success", message: "Done", pending: false, fading: false, label: "Save" });
    await vi.advanceTimersByTimeAsync(3400);
    expect(action.snapshot().fading).toBe(true);
    await vi.advanceTimersByTimeAsync(700);
    expect(action.snapshot()).toMatchObject({ phase: "idle", message: null });
  });

  it("takes a custom line, or one built from the result, and none when asked for none", async () => {
    const a = make(async () => 3, { success: n => `${n} saved` });
    await a.action.run();
    expect(a.action.snapshot().message).toBe("3 saved");
    const b = make(async () => {}, { success: null });
    await b.action.run();
    expect(b.action.snapshot()).toMatchObject({ phase: "idle", message: null });
  });

  it("clears the line when the next run starts", async () => {
    const { action } = make(async () => {});
    await action.run();
    void action.run();
    expect(action.snapshot().message).toBeNull();
  });
});

describe("useAction: failure and retry", () => {
  it("keeps the server's own sentence as the reason", async () => {
    const onError = vi.fn();
    const { action } = make(async () => { throw new Error("Finish running work before changing this."); }, { onError });
    expect(await action.run()).toBeUndefined();
    expect(action.snapshot()).toMatchObject({ phase: "error", pending: false, error: "Finish running work before changing this." });
    expect(onError).toHaveBeenCalledOnce();
  });

  it("falls back to a plain sentence when the error reads like plumbing", async () => {
    const { action } = make(async () => { throw new TypeError("Cannot read properties of undefined (reading 'x')"); }, { failure: "That did not save. Try again." });
    await action.run();
    expect(action.snapshot().error).toBe("That did not save. Try again.");
  });

  it("does not drop the failure line on its own", async () => {
    const { action } = make(async () => { throw new Error("nope"); });
    await action.run();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(action.snapshot().phase).toBe("error");
  });

  it("retry runs the same call again with the same arguments, and a pass clears the failure", async () => {
    let fail = true;
    const work = vi.fn(async (_a: string, _b: string) => { if (fail) throw new Error("Try later."); return "ok"; });
    const action = createAction<[string, string], string>(() => work, () => ({ success: "Saved" }));
    await action.run("x", "y");
    expect(action.snapshot().error).toBe("Try later.");
    fail = false;
    expect(await action.retry()).toBe("ok");
    expect(work).toHaveBeenLastCalledWith("x", "y");
    expect(action.snapshot()).toMatchObject({ phase: "success", error: null, message: "Saved" });
  });

  it("retry before any run does nothing", async () => {
    const { action } = make(async () => {});
    expect(await action.retry()).toBeUndefined();
    expect(action.snapshot().phase).toBe("idle");
  });

  it("reports nothing after it is disposed (the control left the screen)", async () => {
    const gate = deferred();
    const { action, seen } = make(() => gate.promise);
    void action.run();
    const before = seen.length;
    action.dispose();
    gate.resolve(); await vi.advanceTimersByTimeAsync(10_000);
    expect(seen.length).toBe(before);
  });
});

describe("actionReason", () => {
  it("passes a plain sentence, closes one that has no full stop, and refuses plumbing", () => {
    expect(actionReason(new Error("Error invoking remote method 'x:y': Error: The folder is not writable."))).toBe("The folder is not writable.");
    expect(actionReason("Connection was refused by the server")).toBe("Connection was refused by the server.");
    expect(actionReason(new Error("ECONNREFUSED_LOCAL at /a/b.ts:3"), "Fallback.")).toBe("Fallback.");
    expect(actionReason(undefined, "Fallback.")).toBe("Fallback.");
    expect(actionReason(new Error("x"), "Fallback.")).toBe("Fallback.");
  });
});
