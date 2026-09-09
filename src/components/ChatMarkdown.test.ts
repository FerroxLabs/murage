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
