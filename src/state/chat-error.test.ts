import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_ERROR_CLEAR_MS, createErrorClock, isTransientError, raiseTransientError } from "./chat-error";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("the error clock", () => {
  it("clears an error after six seconds", () => {
    const clear = vi.fn();
    const clock = createErrorClock(clear);
    clock.arm("first");
    vi.advanceTimersByTime(CHAT_ERROR_CLEAR_MS - 1);
    expect(clear).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });
  it("a second error gets its own full six seconds", () => {
    const clear = vi.fn();
    const clock = createErrorClock(clear);
    clock.arm("first");
    vi.advanceTimersByTime(4000);
    clock.arm("second");
    vi.advanceTimersByTime(4000);
    expect(clear).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(clear).toHaveBeenCalledTimes(1);
  });
  it("holds while the pointer is on the banner and restarts when it leaves", () => {
    const clear = vi.fn();
    const clock = createErrorClock(clear);
    clock.arm("e");
    clock.hold(true);
    vi.advanceTimersByTime(60_000);
    expect(clear).not.toHaveBeenCalled();
    clock.hold(false);
    vi.advanceTimersByTime(CHAT_ERROR_CLEAR_MS);
    expect(clear).toHaveBeenCalledTimes(1);
  });
  it("does nothing once stopped or with no error", () => {
    const clear = vi.fn();
    const clock = createErrorClock(clear);
    clock.arm(null);
    clock.arm("e");
    clock.stop();
    vi.advanceTimersByTime(20_000);
    expect(clear).not.toHaveBeenCalled();
  });
});

describe("which errors clear themselves", () => {
  it("only an error raised as transient auto-clears; any other stays until dismissed", () => {
    const dispatch = vi.fn();
    raiseTransientError(dispatch, "Could not save the file.");
    expect(dispatch).toHaveBeenCalledWith({ type: "error", message: "Could not save the file." });
    expect(isTransientError("Could not save the file.")).toBe(true);
    expect(isTransientError("Engine sign-in expired")).toBe(false);
    expect(isTransientError(null)).toBe(false);
  });
});
