// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { confirmInWindow, oneAtATime } from "./window-confirm";

describe("confirmInWindow", () => {
  it("asks through the desktop app so the question sits over the Murage window", async () => {
    const confirm = vi.fn(async () => true);
    const fallback = vi.fn(() => false);
    expect(await confirmInWindow("Delete the Local VM?", "Delete", { muragebox: { confirm }, confirm: fallback })).toBe(true);
    expect(confirm).toHaveBeenCalledWith("Delete the Local VM?", "Delete");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back to the browser's own confirm outside the desktop app", async () => {
    const fallback = vi.fn(() => true);
    expect(await confirmInWindow("Delete?", "Delete", { confirm: fallback })).toBe(true);
    expect(fallback).toHaveBeenCalledWith("Delete?");
    expect(await confirmInWindow("Delete?", "Delete", {})).toBe(false);
  });
});

describe("oneAtATime", () => {
  it("ignores a second click while the first action or its question is still open", async () => {
    const run = oneAtATime();
    let finish!: () => void;
    const first = vi.fn(() => new Promise<string>((resolve) => { finish = () => resolve("done"); }));
    const second = vi.fn(async () => "again");
    const pending = run(first);
    expect(await run(second)).toBeUndefined();
    expect(second).not.toHaveBeenCalled();
    finish();
    expect(await pending).toBe("done");
    expect(await run(second)).toBe("again");
  });

  it("opens again after a failed action", async () => {
    const run = oneAtATime();
    await expect(run(async () => { throw new Error("no"); })).rejects.toThrow("no");
    expect(await run(async () => 1)).toBe(1);
  });
});

describe("Local VM actions", () => {
  const source = readFileSync(new URL("../components/LocalComputerSection.tsx", import.meta.url), "utf8");

  it("confirm delete and replace over the Murage window, never with a bare window.confirm", () => {
    expect(source).not.toContain("window.confirm(");
    expect(source).toMatch(/confirmInWindow\("Delete the Local VM\?[^"]*", "Delete"\)/);
    expect(source).toMatch(/confirmInWindow\("Replace the existing Local VM[^"]*", "Replace"\)/);
  });

  it("run one action at a time, the question included", () => {
    const act = source.slice(source.indexOf("const act = "), source.indexOf("const savePolicy"));
    expect(act).toContain("runOne(async () => {");
    expect(act.indexOf("setPending(action)")).toBeLessThan(act.indexOf("confirmInWindow("));
  });
});
