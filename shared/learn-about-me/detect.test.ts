// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { looksLikeExport } from "./detect.ts";

const lines = (n: number, make: (i: number) => string) => Array.from({ length: n }, (_, i) => make(i)).join("\n");

describe("looksLikeExport", () => {
  it("an answer to the export prompt with its headings reads as an export", () => {
    const text = ["INSTRUCTIONS", "undated Keep answers short.", "IDENTITY", "2024-03-01 My name is Sam.", "2024-05-02 I live in Austin.",
      "CAREER", "2023 I run a bakery.", "PROJECTS", "2025-01-10 A new storefront.", "PREFERENCES", "undated Plain words.", "undated No emoji."].join("\n");
    expect(looksLikeExport(text)).toBe(true);
  });

  it("dated lines alone are enough, keyed lines need a long paste", () => {
    expect(looksLikeExport(lines(12, i => `2024-0${(i % 9) + 1}-01 Note ${i}`))).toBe(true);
    expect(looksLikeExport(lines(26, i => (i % 4 === 0 ? `${["Name", "City", "Employer", "Bank", "Diet", "Kids", "Email"][i / 4]}: value ${i}` : `A plain line ${i}`)))).toBe(true);
    expect(looksLikeExport(lines(20, i => (i % 2 === 0 ? `Name: value ${i}` : `A plain line ${i}`)))).toBe(false);
  });

  it("short text, a code block and a log are not an export", () => {
    expect(looksLikeExport("IDENTITY\nCAREER\nhello")).toBe(false);
    expect(looksLikeExport(["```", ...Array.from({ length: 12 }, (_, i) => `2024-01-0${(i % 9) + 1} x`), "```"].join("\n"))).toBe(false);
    expect(looksLikeExport(lines(60, i => `2026-10-23 10:15:${String(i % 60).padStart(2, "0")} INFO worker ${i} started`))).toBe(false);
  });

  it("a long ordinary message is not an export", () => {
    expect(looksLikeExport(lines(30, i => `Point ${i}: we should look at the plan again.`))).toBe(false);
  });
});
