// Copyright 2026 Ferrox Labs
// Fixtures ported from Hermes Agent tests/gateway/test_whatsapp_formatting.py and
// tests/conformance/vectors/whatsapp.json (MIT, Nous Research). Table vectors differ on purpose:
// Murage wraps tables in a code block (OpenClaw "code" mode), Hermes leaves them raw.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { formatForWhatsApp, sanitizeOutbound } from "./format.ts";

describe("formatForWhatsApp (Hermes test_whatsapp_formatting)", () => {
  it("strikethrough", () => expect(formatForWhatsApp("~~deleted~~")).toBe("~deleted~"));
  it("headers become bold", () => {
    expect(formatForWhatsApp("# Title")).toBe("*Title*");
    expect(formatForWhatsApp("## Subtitle")).toBe("*Subtitle*");
    expect(formatForWhatsApp("### Deep")).toBe("*Deep*");
  });
  it("a bold header does not double wrap", () => {
    expect(formatForWhatsApp("# **Title**")).toBe("*Title*");
    expect(formatForWhatsApp("## __Strong__")).toBe("*Strong*");
  });
  it("markdown italics become WhatsApp italics; WhatsApp italics pass through", () => {
    expect(formatForWhatsApp("*italic*")).toBe("_italic_");
    expect(formatForWhatsApp("_italic_")).toBe("_italic_");
  });
  it("empty input is returned as is", () => {
    expect(formatForWhatsApp("")).toBe("");
  });
});

// [id, input, expected] from conformance vectors with expect:"parity".
const VECTORS: Array<[string, string, string]> = [
  ["plain-text", "Just a plain sentence.", "Just a plain sentence."],
  ["bold", "This is **bold** text.", "This is *bold* text."],
  ["italic", "This is *italic* text.", "This is _italic_ text."],
  ["bold-italic", "Mix of **bold** and *italic* in one line.", "Mix of *bold* and _italic_ in one line."],
  ["strikethrough", "This is ~~struck~~ text.", "This is ~struck~ text."],
  ["inline-code", "Run `pip install hermes` to start.", "Run `pip install hermes` to start."],
  ["fenced-code", "```\nprint('hello')\n```", "```\nprint('hello')\n```"],
  ["fenced-code-lang", "```python\ndef f(x):\n    return x * 2\n```", "```python\ndef f(x):\n    return x * 2\n```"],
  ["link", "See [the docs](https://example.com/docs) for more.", "See the docs (https://example.com/docs) for more."],
  ["link-parens-url", "See [spec](https://example.com/a_(b)) here.", "See spec (https://example.com/a_(b)) here."],
  ["header-h1", "# Big Title\nBody follows.", "*Big Title*\nBody follows."],
  ["header-h2", "## Section\nBody follows.", "*Section*\nBody follows."],
  ["header-h3", "### Sub-section\nBody follows.", "*Sub-section*\nBody follows."],
  ["ul-list", "- first\n- second\n- third", "- first\n- second\n- third"],
  ["ol-list", "1. first\n2. second\n3. third", "1. first\n2. second\n3. third"],
  ["nested-list", "- outer\n  - inner one\n  - inner two\n- outer two", "- outer\n  - inner one\n  - inner two\n- outer two"],
  ["blockquote", "> quoted wisdom\nregular line", "> quoted wisdom\nregular line"],
  ["hrule", "above\n\n---\n\nbelow", "above\n\n---\n\nbelow"],
  ["emoji", "Done \u2705 with \ud83c\udf89 emoji \ud83d\udc40 test.", "Done \u2705 with \ud83c\udf89 emoji \ud83d\udc40 test."],
  ["cjk", "\u4e2d\u6587\u6d4b\u8bd5\uff1a**\u7c97\u4f53** \u548c `\u4ee3\u7801` \u6df7\u6392\u3002", "\u4e2d\u6587\u6d4b\u8bd5\uff1a*\u7c97\u4f53* \u548c `\u4ee3\u7801` \u6df7\u6392\u3002"],
  ["bare-url", "Visit https://example.com/path?q=1&r=2 today.", "Visit https://example.com/path?q=1&r=2 today."],
  ["mixed-document", "## Report\n\nStatus: **green**. Details in `runbook.md`.\n\n- item *one*\n- item **two**\n\n```sh\nmake deploy\n```\n\nSee [dashboard](https://grafana.example.com/d/x).", "*Report*\n\nStatus: *green*. Details in `runbook.md`.\n\n- item _one_\n- item *two*\n\n```sh\nmake deploy\n```\n\nSee dashboard (https://grafana.example.com/d/x)."],
  ["mdv2-reserved-chars", "Price is 3.50 (was 4.00) \u2014 save ~12%! #deal +tax = win.", "Price is 3.50 (was 4.00) \u2014 save ~12%! #deal +tax = win."],
  ["mdv2-underscores", "snake_case_name and file_name.py in prose.", "snake_case_name and file_name.py in prose."],
  ["mdv2-brackets", "Array[0] and dict{key} and (parens) live here.", "Array[0] and dict{key} and (parens) live here."],
  ["slack-broadcast-mention", "Hey <!everyone> and <!channel> and <!here>!", "Hey <!everyone> and <!channel> and <!here>!"],
  ["backslash-in-code", "`C:\\Users\\ben\\file.txt` and ```\npath = \"a\\\\b\"\n```", "`C:\\Users\\ben\\file.txt` and ```\npath = \"a\\\\b\"\n```"],
  ["backtick-in-fence", "```\nuse `inline` inside fence\n```", "```\nuse `inline` inside fence\n```"],
  ["header-with-bold", "## The **Real** Deal", "*The *Real* Deal*"],
  ["link-display-escapes", "[v2.0 (beta)](https://example.com/v2)", "v2.0 (beta) (https://example.com/v2)"],
  ["media-tag", "Here you go\nMEDIA:/tmp/output.png\ndone", "Here you go\nMEDIA:/tmp/output.png\ndone"],
  ["pathological-nesting", "**bold *italic ~~struck `code` struck~~ italic* bold**", "*bold _italic ~struck `code` struck~ italic_ bold*"],
  ["triple-markers", "***what is this*** and ____that____", "**what is this** and *__that*__"],
  ["whitespace-only", "   \n\t\n   ", "   \n\t\n   "],
  ["slack-bold-conversion", "**important** word", "*important* word"],
  ["slack-link-conversion", "[click here](https://example.com)", "click here (https://example.com)"],
  ["fence-lang-tag-slack", "```text\nliteral first line issue\n```", "```text\nliteral first line issue\n```"],
  ["empty-string", "", ""],
  ["long-line", "word ".repeat(500), "word ".repeat(500)],
  ["many-fences", "```\na\n```\nmid\n```\nb\n```\nend ```inline``` tail", "```\na\n```\nmid\n```\nb\n```\nend ```inline``` tail"],
];

describe("Hermes conformance vectors", () => {
  it.each(VECTORS)("%s", (_id, input, expected) => {
    expect(formatForWhatsApp(input)).toBe(expected);
  });
});

// Table vectors (Hermes expect:"parity", leaves pipe tables raw): Murage wraps a table in a code block so
// WhatsApp shows it monospaced (OpenClaw "code" mode). The expected output is therefore adapted, not skipped.
describe("Hermes table vectors, adapted to code-block wrapping", () => {
  it("table-simple", () => {
    const table = "| name | value |\n|------|-------|\n| a    | 1     |\n| b    | 2     |";
    expect(formatForWhatsApp(table)).toBe("```\n" + table + "\n```");
  });
  it("table-cjk", () => {
    const table = "| \u540d\u524d | \u5024 |\n|------|----|\n| \u4e2d\u6587 | 42 |\n| b    | 2  |";
    expect(formatForWhatsApp(table)).toBe("```\n" + table + "\n```");
  });
});

// Vectors marked expect:"divergent" upstream: the renderers legitimately differ, so assert our own contract.
describe("Hermes divergent vectors (assert Murage behaviour)", () => {
  it("unclosed-fence: content is kept, nothing is dropped", () => {
    const input = "```python\nprint('never closed')";
    expect(formatForWhatsApp(input)).toBe(input);
  });
  it("placeholder-injection: NUL bytes are stripped so input cannot forge our placeholders; the words survive", () => {
    expect(formatForWhatsApp("sneaky \u0000PH0\u0000 token and \u0000SL1\u0000 too")).toBe("sneaky PH0 token and SL1 too");
  });
});

describe("Murage additions", () => {
  it("wraps pipe tables in a code block and leaves their cells alone", () => {
    const table = "| name | value |\n|------|-------|\n| a_b  | **1** |";
    expect(formatForWhatsApp(`before\n${table}\nafter`)).toBe(`before\n\`\`\`\n${table}\n\`\`\`\nafter`);
    expect(formatForWhatsApp("| \u540d\u524d | \u5024 |\n|------|----|\n| \u4e2d\u6587 | 42 |")).toBe("```\n| \u540d\u524d | \u5024 |\n|------|----|\n| \u4e2d\u6587 | 42 |\n```");
  });
  it("does not treat a lone pipe line as a table", () => {
    expect(formatForWhatsApp("| not | a table |")).toBe("| not | a table |");
  });
  it("does not rewrap a table that is already inside a fence", () => {
    const fenced = "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```";
    expect(formatForWhatsApp(fenced)).toBe(fenced);
  });
  it("strips invisible characters and folds odd spaces", () => {
    expect(sanitizeOutbound("a\u200bb\u2060c\ufeffd\u2063e")).toBe("abcde");
    expect(sanitizeOutbound("x\u202fy\u00a0z\u3000w")).toBe("x y z w");
    expect(formatForWhatsApp("\u2060\u202ftext")).toBe(" text");
  });
  it("cannot be tricked by placeholder look-alikes in the input", () => {
    expect(formatForWhatsApp("sneaky \u0000FENCE0\u0000 and \u0000CODE0\u0000 `real`")).toBe("sneaky FENCE0 and CODE0 `real`");
  });
  it("keeps dollar sequences in code and fences literal", () => {
    expect(formatForWhatsApp("`$1 and $&` ```\n$1\n```")).toBe("`$1 and $&` ```\n$1\n```");
  });
});
