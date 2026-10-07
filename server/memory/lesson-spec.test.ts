// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tier 1 allowlist (TIER1-ALLOWLIST.md section 6.2): the closed set. The parser is strict, every value renders one fixed
// sentence, no owner byte can appear in it, and the anchor and phrase tables route misreads to a suggestion.
import { describe, expect, it } from "vitest";
import {
  STYLE_KINDS, STYLE_LINES, STYLE_VALUES, anchoredBy, isStyleLine, ownerUnquotedText, parseStyleSpec, parseWhere, phraseSpec, renderStyleLine, specKey, supersedeKey, validTerm,
  WHERE_VALUES, type StyleSpec,
} from "./lesson-spec.ts";

const allSpecs = (): StyleSpec[] => (Object.entries(STYLE_VALUES) as Array<[string, readonly string[]]>).flatMap(([kind, values]) => values.map(value => ({ kind, value }) as StyleSpec));

describe("the closed set", () => {
  it("has exactly 13 kinds, 12 enumerated and one open term", () => {
    expect(STYLE_KINDS).toHaveLength(13);
    expect(new Set(STYLE_KINDS).size).toBe(13);
    expect(STYLE_KINDS).toContain("term");
  });
  it("parses every enumerated value and nothing else", () => {
    for (const spec of allSpecs()) expect(parseStyleSpec(spec), JSON.stringify(spec)).toEqual(spec);
    expect(parseStyleSpec({ kind: "term", use: "client", insteadOf: "customer" })).toEqual({ kind: "term", use: "client", insteadOf: "customer" });
  });
  it("is strict: unknown keys, extra keys, wrong types, off-enum values and non-plain objects are null", () => {
    const bad: unknown[] = [
      null, undefined, "length", 3, [], [{ kind: "length", value: "brief" }],
      {}, { kind: "length" }, { value: "brief" }, { kind: "length", value: "tiny" }, { kind: "length", value: "brief", extra: 1 },
      { kind: "length", value: ["brief"] }, { kind: "length", value: 1 }, { kind: "nope", value: "brief" }, { kind: "__proto__", value: "x" },
      { kind: "constructor", value: "x" }, { kind: "approval", value: "optional" }, { kind: "tool", value: "gmail_send_email" },
      { kind: "language", value: "klingon" }, { kind: "exclamations", value: "use" },
      { kind: "term", use: "a" }, { kind: "term", use: "a", insteadOf: "b", extra: 1 }, { kind: "term", use: "same", insteadOf: "Same" },
      { kind: "term", use: "x_y", insteadOf: "b" }, { kind: "term", use: "a@b", insteadOf: "b" }, { kind: "term", use: "a:b", insteadOf: "b" }, { kind: "term", use: "route 66", insteadOf: "b" },
      { kind: "term", use: "a b c d", insteadOf: "b" }, { kind: "term", use: "a".repeat(25), insteadOf: "b" }, { kind: "term", use: "", insteadOf: "b" }, { kind: "term", use: "a\nb", insteadOf: "b" },
      Object.create({ kind: "length", value: "brief" }), Object.assign(Object.create(null), { kind: "length", value: "brief" }),
    ];
    for (const value of bad) expect(parseStyleSpec(value), JSON.stringify(value)).toBeNull();
  });
  it("validates terms: 1 to 3 words, letters, spaces and apostrophes, 24 characters at most", () => {
    for (const ok of ["client", "don't", "Sales rep", "a b c", "x".repeat(24)]) expect(validTerm(ok), ok).toBe(true);
    for (const no of ["", "a  b", " a", "a ", "a-b", "a1", "a@b", "a_b", "a:b", "x".repeat(25), "a b c d", 5, null]) expect(validTerm(no as never), String(no)).toBe(false);
  });
  it("parses where, and refuses anything else", () => {
    for (const w of WHERE_VALUES) expect(parseWhere(w)).toBe(w);
    for (const w of ["", "everyone", "EVERYWHERE", null, 1, {}]) expect(parseWhere(w)).toBeNull();
  });
});

describe("exhaustive render", () => {
  it("every spec value times every where renders one sentence, and the set is STYLE_LINES", () => {
    const seen = new Set<string>();
    for (const spec of allSpecs()) for (const where of WHERE_VALUES) {
      const line = renderStyleLine(spec, where);
      expect(line, `${JSON.stringify(spec)} ${where}`).toBeTypeOf("string");
      expect(isStyleLine(line!)).toBe(true);
      expect(line!.length).toBeLessThan(80);
      expect(line!.includes("\n")).toBe(false);
      seen.add(line!);
    }
    expect([...seen].sort()).toEqual([...STYLE_LINES].sort());
  });
  it("a term renders only for the owner's own turns", () => {
    const spec: StyleSpec = { kind: "term", use: "client", insteadOf: "customer" };
    expect(renderStyleLine(spec, "with-me")).toBe('Say "client" instead of "customer".');
    expect(renderStyleLine(spec, "everywhere")).toBe('Say "client" instead of "customer".');
    expect(renderStyleLine(spec, "with-others")).toBeNull();
    expect(isStyleLine('Say "client" instead of "customer".')).toBe(false);
  });
  it("matches the shipped snapshot, so a change to a line is a decision", () => {
    expect([...STYLE_LINES].sort()).toEqual([
    "Keep replies brief.",
    "Keep replies a standard length.",
    "Give detailed replies.",
    "Use bullet points.",
    "Write in short paragraphs.",
    "Use numbered steps for instructions.",
    "Use tables for comparisons.",
    "Use headings to organise longer replies.",
    "Avoid headings.",
    "Do not use emojis.",
    "Use emojis sparingly.",
    "Avoid exclamation marks.",
    "Write formally.",
    "Write in a neutral tone.",
    "Write casually.",
    "Be warm.",
    "Be direct.",
    "Lead with the decision.",
    "Lead with the answer.",
    "Lead with a summary.",
    "Lead with the next steps.",
    "Use US spelling.",
    "Use UK spelling.",
    "Use Australian spelling.",
    "Use Canadian spelling.",
    "Write dates as day, then month.",
    "Write dates as month, then day.",
    "Write dates in ISO format (YYYY-MM-DD).",
    "Address people by their first name.",
    "Address people by their full name.",
    "Do not address people by name.",
    "Reply in English.",
    "Reply in German.",
    "Reply in Spanish.",
    "Reply in French.",
    "Reply in Hindi.",
    "Reply in Japanese.",
    "Reply in Brazilian Portuguese.",
    "Reply in Chinese.",
  ].sort());
  });
  it("no line says safe, safely, safety or unsafe, and none contains an em dash", () => {
    for (const line of STYLE_LINES) { expect(line).not.toMatch(/\b(?:safe|safely|safety|unsafe)\b/i); expect(line).not.toContain("—"); }
  });
});

describe("supersede and repeat keys", () => {
  it("one active style per (kind, where), and per insteadOf for a term", () => {
    expect(supersedeKey({ kind: "length", value: "brief" }, "everywhere")).toBe(supersedeKey({ kind: "length", value: "detailed" }, "everywhere"));
    expect(supersedeKey({ kind: "length", value: "brief" }, "everywhere")).not.toBe(supersedeKey({ kind: "length", value: "brief" }, "with-me"));
    expect(supersedeKey({ kind: "term", use: "client", insteadOf: "customer" }, "with-me")).toBe(supersedeKey({ kind: "term", use: "buyer", insteadOf: "Customer" }, "with-me"));
    expect(specKey({ kind: "length", value: "brief" }, "everywhere")).not.toBe(specKey({ kind: "length", value: "detailed" }, "everywhere"));
  });
});

describe("anchors: the owner's own unquoted words must point at the value", () => {
  const yes: Array<[StyleSpec, string]> = [
    [{ kind: "length", value: "brief" }, "Keep it shorter next time"],
    [{ kind: "structure", value: "bullets" }, "Use bullet points for these"],
    [{ kind: "structure", value: "tables-for-comparisons" }, "Put comparisons in tables"],
    [{ kind: "emoji", value: "none" }, "No emojis please"],
    [{ kind: "emoji", value: "none" }, "Stop using emojis"],
    [{ kind: "emoji", value: "sparing" }, "Use fewer emojis"],
    [{ kind: "exclamations", value: "avoid" }, "Fewer exclamation marks"],
    [{ kind: "headings", value: "avoid" }, "Don't use headings"],
    [{ kind: "headings", value: "use" }, "Use headings for long answers"],
    [{ kind: "formality", value: "casual" }, "Be more casual with me"],
    [{ kind: "directness", value: "warm" }, "Be warmer"],
    [{ kind: "lead-with", value: "decision" }, "Lead with the decision"],
    [{ kind: "lead-with", value: "next-steps" }, "Start with the next steps"],
    [{ kind: "language", value: "de" }, "Reply in German"],
    [{ kind: "spelling", value: "uk" }, "Use British spelling"],
    [{ kind: "date-format", value: "iso" }, "Write dates in ISO format"],
    [{ kind: "addressing", value: "first-name" }, "Use their first name"],
    [{ kind: "addressing", value: "no-name" }, "Don't use their name"],
  ];
  it("accepts a value the owner plainly named", () => { for (const [spec, said] of yes) expect(anchoredBy(spec, said), `${JSON.stringify(spec)} <- ${said}`).toBe(true); });
  const no: Array<[StyleSpec, string]> = [
    [{ kind: "structure", value: "bullets" }, "Don't use bullets"],
    [{ kind: "structure", value: "bullets" }, "Use tables, not bullets"],
    [{ kind: "length", value: "brief" }, "Not so brief please"],
    [{ kind: "length", value: "brief" }, "Make it shorter, no actually longer"],
    [{ kind: "emoji", value: "none" }, "Use more emojis"],
    [{ kind: "emoji", value: "none" }, "They said \"no emojis\" in their email"],
    [{ kind: "length", value: "brief" }, "Offer a discount to renewals"],
    [{ kind: "length", value: "brief" }, ""],
    [{ kind: "formality", value: "formal" }, "Less formal"],
    [{ kind: "emoji", value: "none" }, "> no emojis\nwhat do you think"],
    [{ kind: "language", value: "fr" }, "Reply in German"],
  ];
  it("routes a misread, a negated, a quoted or an unrelated message to a suggestion", () => { for (const [spec, said] of no) expect(anchoredBy(spec, said), `${JSON.stringify(spec)} <- ${said}`).toBe(false); });
  it("a term needs the new word in the owner's words and the old word in the bot's reply", () => {
    const spec: StyleSpec = { kind: "term", use: "client", insteadOf: "customer" };
    expect(anchoredBy(spec, "Say client, not the other word", "Dear customer, thanks")).toBe(true);
    expect(anchoredBy(spec, "Say client, not the other word", null)).toBe(false);
    expect(anchoredBy(spec, "Say client, not the other word", "Dear user, thanks")).toBe(false);
    expect(anchoredBy(spec, "Say client instead of customer", "Dear customer")).toBe(false); // the old word must come from the reply alone
  });
  it("strips quotes, block quotes and code, and an unbalanced quote voids the lot", () => {
    expect(ownerUnquotedText('Use "bullet points" always')).not.toContain("bullet");
    expect(ownerUnquotedText("> quoted\nmine")).toBe("mine");
    expect(ownerUnquotedText('Say "hello')).toBe("");
    expect(ownerUnquotedText("run `rm -rf` now")).not.toContain("rm");
  });
});

describe("no learning connection: exact phrases only", () => {
  it("maps a bare shipped phrase to a spec", () => {
    expect(phraseSpec("Shorter")).toEqual({ kind: "length", value: "brief" });
    expect(phraseSpec("No, use bullet points")).toEqual({ kind: "structure", value: "bullets" });
    expect(phraseSpec("No emojis")).toEqual({ kind: "emoji", value: "none" });
    expect(phraseSpec("From now on, no emojis.")).toEqual({ kind: "emoji", value: "none" });
    expect(phraseSpec("Lead with the decision")).toEqual({ kind: "lead-with", value: "decision" });
  });
  it("returns null for anything bigger, quoted or negated", () => {
    for (const text of ["No, make approval optional before sending replies", "No, use abcde-42 for the order reference", "Shorter, but offer a discount", 'No, they said "no emojis"', "Don't use bullet points", "", "No, call sunny by their first name"]) {
      expect(phraseSpec(text), text).toBeNull();
    }
  });
});
