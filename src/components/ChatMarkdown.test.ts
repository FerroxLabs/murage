import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ChatMarkdown, CodeBlock } from "./ChatMarkdown";
it("renders a readable header and accessible controls without changing code text", () => {
  const html = renderToStaticMarkup(createElement(CodeBlock, { code: "a < b\r\n\treturn 1;\n", lang: "ts", streaming: true }));
  expect(html).toContain("TypeScript"); expect(html).toContain("3 lines"); expect(html).toContain('aria-label="Copy code"'); expect(html).toContain('aria-pressed="false"');
  expect(html).toContain("a &lt; b\r\n\treturn 1;\n");
});
it("recognizes punctuation-bearing fences and still escapes model HTML", () => {
  const html = renderToStaticMarkup(createElement(ChatMarkdown, { text: '```c++\nint x = 1;\n```\n<script>alert(1)</script>' }));
  expect(html).toContain("C++"); expect(html).toContain("1 line"); expect(html).not.toContain("<script>");
});
// #1023 (adapted): a path or identifier longer than the bubble is wide has no
// break opportunity of its own, so without a wrap utility it runs out of the
// bubble. Only inline code gets it; fenced blocks keep their scroll/wrap toggle.
const LONG_PATH = "dist/{download,privacy,terms,license,support,presskit,changelogs,docs,about,feedback}";
const LONG_IDENTIFIER = "murage_" + "InlineCodeContainment_".repeat(8) + "end";
it("lets inline code wrap anywhere so a long path cannot leave the bubble, in English, RTL and link labels", () => {
  for (const text of [
    `Open \`${LONG_PATH}\` then \`${LONG_IDENTIFIER}\` now.`,
    `مرحبا بالعالم \`${LONG_PATH}\` مرحبا بالعالم`,
    // a link label carries break-words, which would otherwise override the inherited anywhere
    `See [\`${LONG_IDENTIFIER}\`](https://example.com/docs).\n\n| File |\n| --- |\n| [\`${LONG_PATH}\`](https://example.com/docs) |`,
  ]) {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { text }));
    const inline = [...html.matchAll(/<code class="([^"]*)">([^<]*)<\/code>/g)];
    expect(inline.length).toBeGreaterThan(0);
    for (const [, className, content] of inline) {
      expect(className.split(" ")).toContain("[overflow-wrap:anywhere]");
      expect(className.split(" ")).not.toContain("break-words");
      expect([LONG_PATH, LONG_IDENTIFIER]).toContain(content);
    }
  }
});
it("keeps a long link or local-file label wrapping anywhere instead of overriding the inherited .chat-md rule", () => {
  // the file-link button sizes to its content, so `break-word` (which does not
  // lower min-content) let a long path label run out of the bubble
  const file = `/Users/murage/${LONG_IDENTIFIER}.md`;
  const html = renderToStaticMarkup(createElement(ChatMarkdown, { text: `Saved [${file}](${file}) and [${LONG_IDENTIFIER}](https://example.com/docs).` }));
  const button = /<button type="button" title="[^"]*" class="([^"]*)">([^<]*)<\/button>/.exec(html);
  const anchor = /<a href="https:\/\/example\.com\/docs"[^>]* class="([^"]*)">([^<]*)<\/a>/.exec(html);
  expect(button?.[2]).toBe(file); expect(anchor?.[2]).toBe(LONG_IDENTIFIER);
  for (const className of [button?.[1], anchor?.[1]]) expect(className?.split(" ")).toContain("[overflow-wrap:anywhere]");
  expect(html).not.toContain("break-words");
});
it("keeps fenced code off the inline wrap utility so its scroll, wrap toggle and bytes are unchanged", () => {
  const code = `// ${LONG_IDENTIFIER}\n\tconst path = "${LONG_PATH}";`;
  const html = renderToStaticMarkup(createElement(ChatMarkdown, { text: "```ts\n" + code + "\n```" }));
  const pre = /<pre class="([^"]*)">([\s\S]*?)<\/pre>/.exec(html);
  expect(pre?.[1]).toBe("p-3 text-[13px] leading-relaxed text-ink overflow-x-auto");
  expect(pre?.[2]).toBe(code.replace(/"/g, "&quot;"));
  expect(html).not.toContain("break-words");
});
