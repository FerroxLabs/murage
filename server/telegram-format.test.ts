import { describe, expect, it } from "vitest";
import { formatTelegramHtml } from "./telegram-format.ts";

describe("Telegram Markdown formatting", () => {
  it("renders model bold and italic instead of literal Markdown delimiters", () => {
    expect(formatTelegramHtml("**Ready**: *first*, _second_, __done__."))
      .toBe("<b>Ready</b>: <i>first</i>, <i>second</i>, <b>done</b>.");
  });
  it("escapes raw HTML and entity-looking model text", () => {
    expect(formatTelegramHtml('<script a="x">&lt;& text</script>'))
      .toBe("&lt;script a=&quot;x&quot;&gt;&amp;lt;&amp; text&lt;/script&gt;");
  });
  it("keeps inline and fenced code literal, including incomplete streamed fences", () => {
    expect(formatTelegramHtml("`**a** < b`\n```ts\nconst x = '<b>';\n```"))
      .toBe("<code>**a** &lt; b</code>\n<pre>const x = '&lt;b&gt;';\n</pre>");
    expect(formatTelegramHtml("```js\nx < 2")).toBe("<pre>x &lt; 2</pre>");
  });
  it("escapes link attributes and permits only valid HTTP(S) links", () => {
    expect(formatTelegramHtml('[site](https://example.com/?a=1&b="x")'))
      .toBe('<a href="https://example.com/?a=1&amp;b=&quot;x&quot;">site</a>');
    for (const href of ["javascript:alert", "tg://user?id=1", "file:///tmp/a", "https://", "//example.com"]) {
      expect(formatTelegramHtml(`[site](${href})`)).toBe(`[site](${href})`);
    }
  });
  it("keeps unclosed formatting safe and respects escaped delimiters", () => {
    expect(formatTelegramHtml("**unfinished <b>")).toBe("**unfinished &lt;b&gt;");
    expect(formatTelegramHtml("\\*literal\\* file_name_here")).toBe("*literal* file_name_here");
  });
  it("closes formatting before truncation without cutting entities", () => {
    expect(formatTelegramHtml("**<&abcdef**", 5)).toBe("<b>&lt;&amp;ab</b>…");
    expect(formatTelegramHtml("**" + "&".repeat(4096) + "**"))
      .toBe("<b>" + "&amp;".repeat(4096) + "</b>");
    expect(formatTelegramHtml("`" + "x".repeat(5000) + "`"))
      .toBe("<code>" + "x".repeat(4095) + "</code>…");
  });
  it("preserves Unicode pairs at truncation boundaries and handles tiny limits", () => {
    expect(formatTelegramHtml("a😀zz", 3)).toBe("a…");
    expect(formatTelegramHtml("😀zz", 3)).toBe("😀…");
    expect(formatTelegramHtml("**hello**", 1)).toBe("…");
    expect(formatTelegramHtml("")).toBe("");
  });
  it("bounds the configured decoded length", () => {
    for (const limit of [0, -1, 4097, 1.5, NaN]) expect(() => formatTelegramHtml("text", limit)).toThrow(RangeError);
  });
});
