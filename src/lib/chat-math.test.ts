import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { katexOptions } from "@/components/ChatMath";
import { extractMath, MAX_TEX_LENGTH } from "./chat-math";

const texOf = (text: string) => extractMath(text).spans.map((span) => [span.tex, span.display]);
const html = (text: string) => renderToStaticMarkup(createElement(ChatMarkdown, { text }));
const mathCount = (markup: string) => markup.match(/data-chat-math=/g)?.length ?? 0;

describe("single dollars are money, never math", () => {
  for (const text of [
    "$5 to $10",
    "costs $20 and $30",
    "Buy at $4.50, sell at $5.25, stop at $4.10.",
    "Range $1,200-$1,450 this week; $AAPL and $TSLA up",
    "make $$$ fast",
    "$$$ and $$$",
    "I paid $$ for it, then $$ again",
    "from $$5 to $$10",
    "an escaped \\$$x$$ stays",
  ]) {
    it(JSON.stringify(text), () => {
      expect(extractMath(text)).toEqual({ text, spans: [] });
      expect(mathCount(html(text))).toBe(0);
    });
  }
  it("renders the prices as the same text", () => {
    expect(html("$5 to $10")).toContain("$5 to $10");
    expect(html("costs $20 and $30")).toContain("costs $20 and $30");
  });
});

describe("display and TeX-style math", () => {
  it("takes $$…$$ on its own line as display math", () => {
    expect(texOf("Energy:\n\n$$E=mc^2$$\n\nDone.")).toEqual([["E=mc^2", true]]);
    expect(texOf("$$\n\\int_0^3 2t\\,dt = 9\n$$")).toEqual([["\\int_0^3 2t\\,dt = 9", true]]);
    expect(texOf("> $$a^2+b^2=c^2$$")).toEqual([["a^2+b^2=c^2", true]]);
  });
  it("takes $$…$$ inside a sentence as inline math only with no space inside the fences", () => {
    expect(texOf("so $$x^2$$ grows")).toEqual([["x^2", false]]);
    expect(texOf("so $$ x^2 $$ grows")).toEqual([]);
  });
  it("takes \\[…\\] as display and \\(…\\) as inline", () => {
    expect(texOf("\\[y = mx + b\\] and \\(x^2\\)")).toEqual([["y = mx + b", true], ["x^2", false]]);
    expect(texOf("\\[\n\\frac{a}{b}\n\\]")).toEqual([["\\frac{a}{b}", true]]);
  });
  it("does not read a Windows path's escaped parentheses as math", () => {
    expect(texOf("[b](C:\\Apps\\x\\(1\\).md) and C:\\x\\[y\\]")).toEqual([]);
    expect(texOf("where \\(x\\) is, and (\\(y\\))")).toEqual([["x", false], ["y", false]]);
  });
  it("keeps \\(…\\) to one line and leaves unclosed delimiters alone while streaming", () => {
    expect(texOf("\\(a\nb\\)")).toEqual([]);
    expect(texOf("Unclosed \\(x and $$y")).toEqual([]);
  });
  it("keeps Markdown from eating the TeX", () => {
    const { spans } = extractMath("$$a_1*b_1 + a_2*b_2$$");
    expect(spans[0]?.tex).toBe("a_1*b_1 + a_2*b_2");
    expect(html("$$a_1*b_1 + a_2*b_2$$")).not.toContain("<em>");
  });
  it("renders a math element for each span, with its source as the fallback text", () => {
    const markup = html("Einstein: $$E=mc^2$$\n\nand \\(x^2\\)");
    expect(mathCount(markup)).toBe(0); // SSR: the element is replaced by ChatMath's fallback
    expect(markup).toContain("<code");
    expect(markup).toContain("$$E=mc^2$$");
    expect(markup).toContain("\\(x^2\\)");
  });
  it("leaves over-long TeX as text", () => {
    expect(texOf(`$$${"x".repeat(MAX_TEX_LENGTH + 1)}$$`)).toEqual([]);
  });
  it("leaves text that already holds the placeholder characters alone", () => {
    const text = "\uE0000\uE001 $$x$$";
    expect(extractMath(text)).toEqual({ text, spans: [] });
  });
});

describe("code is never math", () => {
  it("leaves inline code spans alone", () => {
    const text = "`$$E=mc^2$$` and ``\\(x\\)`` stay code";
    expect(extractMath(text)).toEqual({ text, spans: [] });
    expect(html(text)).toContain("$$E=mc^2$$");
  });
  it("leaves fenced code alone, backtick or tilde, quoted or CRLF", () => {
    for (const text of [
      "```tex\n$$E=mc^2$$\n\\(x\\)\n```",
      "  ~~~tex\n\\[not rendered\\]\n ~~~~",
      "> ```tex\n> \\(not rendered\\)\n> ```",
      "```tex\r\n$$x$$\r\n```",
    ]) expect(extractMath(text)).toEqual({ text, spans: [] });
    const mixed = "```tex\n$$inside$$\n```\n\nAfter $$outside$$";
    expect(texOf(mixed)).toEqual([["outside", false]]);
    expect(extractMath(mixed).text.startsWith("```tex\n$$inside$$\n```")).toBe(true);
  });
  it("gives an indented code block its source back, not a placeholder", () => {
    const markup = html("Intro\n\n    $$E=mc^2$$ in code\n\nAfter");
    expect(markup).toContain("$$E=mc^2$$ in code");
    expect(markup).not.toMatch(/[\uE000-\uE003]/);
  });
  it("never lets math swallow a code span", () => {
    expect(texOf("$$a `code` b$$")).toEqual([]);
  });
  it("puts the source back into a link target", () => {
    const markup = html("[see](https://example.com/?q=$$x$$)");
    expect(markup).not.toMatch(/[\uE000-\uE003]/);
    expect(markup).toContain("https://example.com/?q=$$x$$");
  });
});

describe("KaTeX options", () => {
  it("never trusts the input and bounds the work", () => {
    const options = katexOptions(true);
    expect(options).toMatchObject({ displayMode: true, trust: false, throwOnError: true, strict: "ignore" });
    expect(options.maxSize).toBeLessThanOrEqual(50);
    expect(options.maxExpand).toBeLessThanOrEqual(1000);
    // a fresh macro table per formula, so \gdef cannot leak between messages
    expect(katexOptions(false).macros).not.toBe(katexOptions(false).macros);
  });
});
