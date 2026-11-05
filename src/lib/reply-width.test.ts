// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// E35: a bot reply with a table runs the message column's width so every
// column shows; its prose and every other bubble keep the reading width.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BUBBLE_WIDTH, WIDE_REPLY_WIDTH, bubbleWidth, replyHasTable } from "./reply-width";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, "..", path), "utf8");
const TABLE = "Here is the plan:\n\n| Day | Task | Owner | Status | Due | Notes | Link |\n| --- | :--- | ---: | --- | --- | --- | --- |\n| Mon | Draft | Ana | open | 4 Nov | first pass | x |\n";

describe("reply width with a table", () => {
  it("finds a markdown table by its divider row, and nothing else", () => {
    expect(replyHasTable(TABLE)).toBe(true);
    expect(replyHasTable("|---|---|\n")).toBe(true);
    expect(replyHasTable("A line with a | pipe and a - dash.")).toBe(false);
    expect(replyHasTable("Some text\n---\nA heading underline")).toBe(false);
  });

  it("widens a bot reply with a table, never a person's own message or a plain reply", () => {
    expect(bubbleWidth(TABLE, false)).toBe(WIDE_REPLY_WIDTH);
    expect(bubbleWidth(TABLE, true)).toBe(BUBBLE_WIDTH);
    expect(bubbleWidth("Just words.", false)).toBe(BUBBLE_WIDTH);
    expect(WIDE_REPLY_WIDTH).toContain("var(--chat-card-pct)");
  });

  it("1:1 chats and rooms size their bubbles by it, the table is marked, and its prose keeps the reading width", () => {
    expect(read("components/ChatView.tsx")).toContain("bubbleWidth(text, user),");
    expect(read("components/GroupView.tsx")).toContain('bubbleWidth(m.text ?? "", user),');
    expect(read("components/ChatMarkdown.tsx")).toContain('<div className="chat-table overflow-x-auto">');
    expect(read("styles.css")).toMatch(/\.chat-wide \.chat-md > :not\(\.chat-table\) \{\n  max-width: var\(--chat-bubble-max\);/);
  });
});
