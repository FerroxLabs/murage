// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings L6: Usage and the Needs you card. Reads the sources (the repo's style for component copy and wiring) and runs the pure helpers.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { doubleLimitRequest, doubledCeiling, ceilingPercent, readLine, writtenLine } from "@/lib/learning-limit";
import { usageCsv } from "./UsageSection";
import { en } from "@/locales";

const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
const card = read("./LearningPausedCard.tsx"), usage = read("./UsageSection.tsx"), inbox = read("./Inbox.tsx");

describe("the learning limit helpers", () => {
  it("doubles both sides, capped at what a limit may be, and carries the revision", () => {
    expect(doubledCeiling({ input: 100_000_000, output: 15_000_000 })).toEqual({ input: 200_000_000, output: 30_000_000 });
    expect(doubledCeiling({ input: 900_000_000_000, output: 1 })).toEqual({ input: 1_000_000_000_000, output: 2 });
    expect(doubleLimitRequest({ input: 10, output: 4 }, 7)).toEqual({ action: "configure", ceiling: { input: 20, output: 8 }, learningRevision: 7 });
  });
  it("reads real figures as tokens and percent", () => {
    expect(readLine({ input: 100_000_000, inputUsed: 2_100_000 })).toBe("Read: 2.1M of 100M tokens");
    expect(writtenLine({ output: 15_000_000, outputUsed: 300_000 })).toBe("Written: 300k of 15M tokens");
    expect(ceilingPercent(2_100_000, 100_000_000)).toBe(2);
    expect(ceilingPercent(5, 0)).toBe(100);
    expect(ceilingPercent(999, 100)).toBe(100);
  });
  it("exports the table's own numbers", () => {
    expect(usageCsv([{ name: 'Sable, "S"', replies: 3, tokens: 1200 }])).toBe('Bot,Replies,Tokens\n"Sable, ""S""",3,1200\n');
  });
});

describe("the Needs you card and the Usage page", () => {
  it("answers through the shared action helper, with the stored-revision request", () => {
    expect(card).toContain("useAction");
    expect(card.match(/<ActionButton/g)).toHaveLength(2);
    expect(card).toContain("doubleLimitRequest(");
    expect(card).not.toMatch(/onClick=\{[^}]*\bapi\(/);
    expect(usage).toContain("<ActionButton action={exportCsv}");
  });
  it("sits in the Inbox decisions view, and Usage never prints a money figure", () => {
    expect(inbox).toContain("LearningPausedCard");
    expect(inbox).toContain('view === "decisions" || view === "all" ? result?.learningPaused');
    expect(usage).not.toMatch(/formatUsd|costUsd|\$\d/);
    expect(usage).not.toContain("allowance");
  });
  it("says it plainly: no em dash, no safe words, no price, no vendor name", () => {
    const words = Object.entries(en).filter(([key]) => key.startsWith("settings.l6.")).map(([, value]) => String(value));
    expect(words.length).toBeGreaterThan(10);
    for (const text of words) expect(text).not.toMatch(/—|\bsaf(?:e|ely|ety)\b|\bunsafe\b|composio|\$|price|dollar|cost/i);
    expect(en["settings.l6.paused.title"]).toBe("Learning paused for the rest of the month");
    expect(en["settings.l6.paused.double"]).toBe("Double the limit and resume");
    expect(en["settings.l6.paused.leave"]).toBe("Leave paused");
  });
});

describe("while learning is paused (PASTE-CAPTURE-FIX S1)", () => {
  it("says new chats are still noted, so learning picks up where it left off", () => {
    expect(en["settings.l6.paused.body"]).toContain("Murage keeps noting new chats so learning picks up where it left off.");
  });
});
