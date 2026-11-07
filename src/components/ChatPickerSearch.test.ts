// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { chatsSearchPath, chatsRequestPath } from "@/lib/all-chats";
import { HighlightedChatHit } from "./ChatThreadMatches";
import { ChatPickerSearch } from "./ChatPickerSearch";

it("asks the owner chats route for bot-scoped previews and grouped message matches", () => {
  const params = new URL(chatsSearchPath("lease", { botId: "ember", routines: true }), "http://fixture").searchParams;
  expect(params.get("view")).toBe("chats");
  expect(params.get("bot")).toBe("ember");
  expect(params.get("group_by")).toBe("thread");
  expect(chatsRequestPath({ botId: "ember" }, null)).toContain("/api/chats?");
  const source = readFileSync(new URL("./ChatPickerSearch.tsx", import.meta.url), "utf8") + readFileSync(new URL("../lib/chat-previews.ts", import.meta.url), "utf8");
  expect(source).toContain("chatsRequestPath({ ...scope, routines: true }");
  expect(source).toContain("generation.current !== mine");
  expect(source).toContain("clearTimeout(timer)");
  expect(source).toContain("}, 250)");
  const picker = readFileSync(new URL("./TaskPicker.tsx", import.meta.url), "utf8");
  expect(picker).toContain("query.trim().length >= 3 && onOpenHit");
  expect(picker).toContain("chatSnippet(summaries[task.threadId]!)");
  expect(picker).toContain("landOnSearchHit(hit, state, dispatch)");
});

it("renders a search status and highlights literal text without treating it as markup", () => {
  const loading = renderToStaticMarkup(createElement(ChatPickerSearch, { query: "lease", scope: { botId: "ember" }, onOpen: () => {} }));
  expect(loading).toContain('aria-label="Matches in messages"');
  expect(loading).toContain("Searching messages…");
  const html = renderToStaticMarkup(createElement(HighlightedChatHit, { hit: {
    threadId: "t", messageId: "m", name: "Ember", at: 1, role: "user", kind: "text",
    snippet: "a <lease> note", matchStart: 3, matchLength: 5,
  } }));
  expect(html).toContain(">lease</mark>");
  expect(html).toContain("&lt;");
  expect(html).not.toContain("<lease>");
});
