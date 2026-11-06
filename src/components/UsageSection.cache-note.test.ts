// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// B102 (upstream f5ce311e6, #1878): "This month by bot" shows new tokens once a
// cache split is known, so it says so, and states what it leaves out and the
// whole amount that went through the model.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { monthCacheNote, monthTokensLabelKey } from "./UsageSection";
import { en } from "@/locales";

const usage = readFileSync(new URL("./UsageSection.tsx", import.meta.url), "utf8");

describe("Usage: what new tokens leave out", () => {
  it("names the cached share and the whole amount for a heavily cached month", () => {
    // ~500M through the model, nearly all of it the thread re-read from cache.
    const rows = [
      { input: 300_000_000, cachedInput: 299_100_000, output: 400_000 },
      { input: 199_000_000, cachedInput: 198_400_000, output: 200_000 },
    ];
    expect(monthCacheNote(rows)).toEqual({ cached: 497_500_000, total: 499_600_000 });
    expect(monthTokensLabelKey(rows)).toBe("settings.l6.usage.colNewTokens");
  });

  it("keeps the plain label and no note when no engine reported a cache split", () => {
    const rows = [{ input: 1_900_000, output: 12_000 }];
    expect(monthCacheNote(rows)).toBeNull();
    expect(monthTokensLabelKey(rows)).toBe("settings.l6.usage.colTokens");
  });

  it("never counts more cached input than input", () => {
    expect(monthCacheNote([{ input: 10, cachedInput: 50, output: 1 }])).toEqual({ cached: 10, total: 11 });
  });

  it("wires the label and the note into the table, with plain copy", () => {
    expect(usage).toContain("t(monthTokensLabelKey(rows))");
    expect(usage).toContain('t("settings.l6.usage.cachedNote"');
    expect(en["settings.l6.usage.colNewTokens"]).toBe("New tokens");
    const note = en["settings.l6.usage.cachedNote"];
    expect(note).toContain("{cached}");
    expect(note).toContain("{total}");
    expect(note).not.toMatch(/—|count everything/i);
  });
});
