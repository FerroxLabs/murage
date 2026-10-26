// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Arabic, Hebrew and Persian text aligns right on its own; English stays left.
// The test idea follows OpenMausBot's chat-dir-auto test (Apache-2.0), see NOTICE.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "./ChatMarkdown";

const source = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

describe("right-to-left text finds its own direction", () => {
  const html = renderToStaticMarkup(createElement(ChatMarkdown, {
    text: "مرحبا hello\n\n- نقطة\n\n> اقتباس\n\n## عنوان\n\n```js\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |",
  }));

  it("sets dir=auto on paragraphs, lists, quotes and headings", () => {
    expect(html).toContain('<p dir="auto">مرحبا hello</p>');
    expect(html).toContain('<ul dir="auto"');
    expect(html).toContain('<blockquote dir="auto"');
    expect(html).toMatch(/<div dir="auto" class="mt-2 text-\[15\.5px\]/);
  });

  it("leaves code blocks and tables of data left to right", () => {
    const code = html.slice(html.indexOf("const a"), html.indexOf("const a") + 20);
    expect(code).toContain("const a");
    const pre = html.slice(html.lastIndexOf("<pre", html.indexOf("const a")), html.indexOf("const a"));
    expect(pre).not.toContain('dir="auto"');
    expect(html).toMatch(/<table class="w-full border-collapse/);
  });

  it("uses logical padding so a list or quote indents from the reading side", () => {
    expect(html).toContain("ps-5");
    expect(html).toContain("border-inline-start-width:2px");
    expect(html).not.toContain("pl-5");
  });

  it("every text input and message body in the chat carries dir=auto", () => {
    expect(source("Composer.tsx")).toContain('<textarea dir="auto"');
    expect(source("ChatFindBar.tsx")).toMatch(/<input dir="auto"/);
    expect(source("OptionCard.tsx")).toMatch(/<input dir="auto"/);
    // the question card's Other field is the shared OtherRow's OtherField
    expect(source("QuestionCard.tsx")).toContain("<OtherRow");
    expect(source("ChoiceWithOther.tsx")).toMatch(/<OtherField dir="auto"/);
    expect(source("TaskPicker.tsx").match(/<input dir="auto"/g)?.length).toBe(2);
    const chat = source("ChatView.tsx");
    expect(chat).toMatch(/<textarea dir="auto"/);
    expect(chat).toContain('dir="auto"\n                  className={cn(collapsible');
    expect(source("GroupView.tsx")).toContain('<div dir="auto">{attachments?.display ?? m.text}</div>');
    expect(source("SearchResults.tsx")).toContain('<span dir="auto" className={cn("mt-0.5 line-clamp-2');
    expect(source("Sidebar.tsx")).toContain('<span dir="auto" className="truncate">{rowPreview}</span>');
  });
});
