// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The partition write gate's folder test on every platform's spelling. It was a
// `base + "/"` prefix test, which no Windows path ever matched, so a Full access
// bot's write into another team's folder was never refused there (CI 37733026826).
import { describe, expect, it } from "vitest";
import { inside } from "./partition-files.ts";

describe("partition folder containment", () => {
  it("matches a Windows path inside its folder, ignoring case and either separator", () => {
    const base = "D:\\Work\\Temp\\d\\.murage\\workspaces";
    expect(inside(`${base}\\bot\\MEMORY.md`, base, "win32")).toBe(true);
    expect(inside("d:\\WORK\\temp\\d\\.murage\\workspaces\\bot", base, "win32")).toBe(true);
    expect(inside("D:/Work/Temp/d/.murage/workspaces/bot", base, "win32")).toBe(true);
    expect(inside(base, base, "win32")).toBe(true);
  });

  it("never treats a sibling whose name only starts the same as inside", () => {
    expect(inside("C:\\data\\workspaces-other\\x", "C:\\data\\workspaces", "win32")).toBe(false);
    expect(inside("/data/workspaces-other/x", "/data/workspaces", "linux")).toBe(false);
    expect(inside("/data/x", "/data/workspaces", "linux")).toBe(false);
  });

  it("keeps case on POSIX, where two spellings are two folders", () => {
    expect(inside("/data/Workspaces/bot", "/data/workspaces", "linux")).toBe(false);
    expect(inside("/data/workspaces/bot", "/data/workspaces", "darwin")).toBe(true);
  });
});
