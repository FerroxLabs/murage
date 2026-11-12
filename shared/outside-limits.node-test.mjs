import test from "node:test";
import assert from "node:assert/strict";
import { OUTSIDE_ENVELOPES, OUTSIDE_SURFACES, fitsEnvelope, wrappedLineCount, repertoireOk, envelopeValid } from "./outside-limits.mjs";

const env = (over = {}) => ({ maxLines: 4, maxLineChars: 20, titleChars: 30, nameChars: 12, repertoire: "ascii", ...over });

test("before S0 every OS banner and the menu is Open only; own windows scroll", () => {
  for (const s of ["banner-mac", "banner-win", "banner-linux", "menu"]) assert.equal(fitsEnvelope("ls", "Run a command", "Sable", OUTSIDE_ENVELOPES[s]), false, s);
  for (const s of ["pill", "flyout", "bubble", "dock"]) assert.equal(fitsEnvelope("ls", "Run a command", "Sable", OUTSIDE_ENVELOPES[s]), true, s);
  assert.deepEqual([...OUTSIDE_SURFACES], Object.keys(OUTSIDE_ENVELOPES));
});
test("wrapping: explicit breaks, word moves whole, long token splits", () => {
  assert.equal(wrappedLineCount("a b c", 20), 1);
  assert.equal(wrappedLineCount("one\ntwo\nthree", 20), 3);
  assert.equal(wrappedLineCount("aaaaaaaaaa bbbbbbbbbb", 15), 2);
  assert.equal(wrappedLineCount("x".repeat(45), 20), 3);
  assert.equal(wrappedLineCount("hi " + "y".repeat(25), 20), 3, "a long token starts a fresh line then splits");
  assert.equal(wrappedLineCount("", 20), 1);
});
test("a short multi-line input over maxLines does not fit", () => {
  assert.equal(fitsEnvelope("a\nb\nc\nd", "T", "Bot", env()), true);
  assert.equal(fitsEnvelope("a\nb\nc\nd\ne", "T", "Bot", env()), false);
});
test("one long line that wraps past maxLines does not fit", () => {
  assert.equal(fitsEnvelope(("word ").repeat(30).trim(), "T", "Bot", env()), false);
});
test("a 15-character word straddling the line boundary moves whole", () => {
  assert.equal(fitsEnvelope("aaaaaaaaaaaaa 123456789012345", "T", "Bot", env({ maxLines: 2 })), true);
  assert.equal(fitsEnvelope("aaaaaaaaaaaaa 123456789012345", "T", "Bot", env({ maxLines: 1 })), false);
});
test("one long unbroken token fits only if its split lines fit", () => {
  assert.equal(fitsEnvelope("W".repeat(80), "T", "Bot", env()), true);
  assert.equal(fitsEnvelope("W".repeat(81), "T", "Bot", env()), false);
});
test("ascii repertoire refuses CJK, emoji, tabs and control characters; extended counts wide as two", () => {
  for (const bad of ["echo 日本語", "ok \u{1F600}", "a\tb", "a\u0007b", "a\rb", "café", "a‮b", "a​b"]) assert.equal(fitsEnvelope(bad, "T", "Bot", env()), false, JSON.stringify(bad));
  assert.equal(repertoireOk("日本語", "extended"), true);
  assert.equal(repertoireOk("a‮b", "extended"), false); assert.equal(repertoireOk("a​b", "extended"), false); assert.equal(repertoireOk("a\tb", "extended"), false);
  assert.equal(wrappedLineCount("日".repeat(10), 10), 2);
  assert.equal(fitsEnvelope("日".repeat(10), "T", "Bot", env({ repertoire: "extended", maxLines: 1, maxLineChars: 20 })), true);
  assert.equal(fitsEnvelope("日".repeat(11), "T", "Bot", env({ repertoire: "extended", maxLines: 1, maxLineChars: 20 })), false);
});
test("title and name limits, empty parts, bad types", () => {
  assert.equal(fitsEnvelope("ls", "t".repeat(31), "Bot", env()), false);
  assert.equal(fitsEnvelope("ls", "T", "n".repeat(13), env()), false);
  assert.equal(fitsEnvelope("ls", "T", "Bot", env()), true);
  for (const [w, t, n] of [["", "T", "B"], ["  ", "T", "B"], ["ls", "", "B"], ["ls", "T", ""], [null, "T", "B"], ["ls", "T\nU", "B"]]) assert.equal(fitsEnvelope(w, t, n, env()), false);
  assert.equal(fitsEnvelope("ls", "T", "B", undefined), false);
});

test("extended repertoire refuses every invisible, control, separator and unassigned character, by Unicode property", () => {
  const bad = ["\u{E0020}", "\u{E0001}", " ", " ", " ", "　", " ", "​", "‎", "‮", "⁦", "­", "؜", "᠎", "️", "\u{E0100}",
    "﻿", "͏", "ᅟ", "ㅤ", "ﾠ", "\u0085", "\uD800", "", "͸", "\u{10FFFF}"];
  for (const char of bad) assert.equal(repertoireOk(`a${char}b`, "extended"), false, `U+${char.codePointAt(0).toString(16)}`);
  for (const ok of ["plain text", "日本語 text", "café", "line one\nline two", "emoji \u{1F600}", "é"]) assert.equal(repertoireOk(ok, "extended"), true, ok);
});
test("an unknown or missing repertoire accepts nothing, and an OS surface must say ascii", () => {
  assert.equal(repertoireOk("ls", undefined), false); assert.equal(repertoireOk("ls", "latin"), false);
  assert.equal(fitsEnvelope("ls", "T", "Bot", { maxLines: 4, maxLineChars: 20, titleChars: 30, nameChars: 12 }), false);
  assert.equal(fitsEnvelope("ls", "T", "Bot", { maxLines: 4, maxLineChars: 20, titleChars: 30, nameChars: 12, repertoire: "unicode" }), false);
  for (const s of ["banner-mac", "banner-win", "banner-linux", "menu"]) { assert.equal(envelopeValid(s, { repertoire: "extended" }), false, s); assert.equal(envelopeValid(s, { repertoire: "ascii" }), true, s); }
  assert.equal(envelopeValid("pill", { repertoire: "extended" }), true); assert.equal(envelopeValid("pill", {}), false); assert.equal(envelopeValid("pill", undefined), false);
});
test("U+2028 and U+2029 never count as a line break that hides lines", () => {
  const e = { maxLines: 2, maxLineChars: 20, titleChars: 30, nameChars: 12, repertoire: "extended" };
  assert.equal(fitsEnvelope("one two three four", "T", "Bot", e), false);
});
test("templateLines bounds the whole template (name line, title line and the detail)", () => {
  const e = { maxLines: 6, maxLineChars: 20, titleChars: 30, nameChars: 12, repertoire: "ascii", templateLines: 4 };
  assert.equal(fitsEnvelope("a\nb", "T", "Bot", e), true);
  assert.equal(fitsEnvelope("a\nb\nc", "T", "Bot", e), false);
});

test("an OS envelope that turns actions on must carry a finite templateLines (the whole-template bound), and is checked at the decision point", () => {
  const live = { maxLines: 4, maxLineChars: 20, titleChars: 30, nameChars: 12, repertoire: "ascii" };
  assert.equal(envelopeValid("banner-win", live), false);
  assert.equal(envelopeValid("banner-win", { ...live, templateLines: 6 }), true);
  assert.equal(envelopeValid("banner-win", { ...live, templateLines: Infinity }), false);
  assert.equal(envelopeValid("banner-win", { ...live, maxLines: 0 }), true, "Open only needs no bound");
  assert.equal(envelopeValid("pill", live), true);
});
