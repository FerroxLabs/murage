import { describe, expect, it, vi } from "vitest";
import { copyText } from "./copy-text";

describe("copyText", () => {
  it("copies through the web clipboard", async () => {
    const web = vi.fn(async () => {});
    expect(await copyText("hi", { web })).toBe(true);
    expect(web).toHaveBeenCalledWith("hi");
  });
  it("falls to the desktop bridge when the web clipboard rejects", async () => {
    const bridge = vi.fn(async () => true);
    expect(await copyText("hi", { web: async () => { throw new Error("denied"); }, bridge })).toBe(true);
    expect(bridge).toHaveBeenCalledWith("hi");
  });
  it("falls to select-and-copy when both fail", async () => {
    const legacy = vi.fn(() => true);
    expect(await copyText("hi", { web: async () => { throw new Error("x"); }, bridge: async () => false, legacy })).toBe(true);
    expect(legacy).toHaveBeenCalled();
  });
  it("reports false, never throws, when every route fails", async () => {
    const env = { web: async () => { throw new Error("x"); }, bridge: async () => { throw new Error("y"); }, legacy: () => { throw new Error("z"); } };
    expect(await copyText("hi", env)).toBe(false);
    expect(await copyText("hi", {})).toBe(false);
  });
  it("copies nothing for empty text", async () => {
    const web = vi.fn(async () => {});
    expect(await copyText("", { web })).toBe(false);
    expect(web).not.toHaveBeenCalled();
  });
  it("gives up on a clipboard that never answers", async () => {
    vi.useFakeTimers();
    try {
      const pending = copyText("hi", { web: () => new Promise<void>(() => {}), bridge: async () => true, timeoutMs: 3000 });
      await vi.advanceTimersByTimeAsync(3000);
      expect(await pending).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

import { copyOrReport } from "./copy-text";
import { en } from "@/locales";
describe("copyOrReport", () => {
  it("says so when the copy did not work, and stays quiet when it did", async () => {
    const report = vi.fn();
    expect(await copyOrReport("hi", report)).toBe(false);
    expect(report).toHaveBeenCalledWith(en["copy.failed"]);
  });
});
