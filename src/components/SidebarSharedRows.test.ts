// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SPEC-X 13.2: the sidebar's light shared rows, the work thread strip and
// the closed thread's locked composer.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { SharedRowButton } from "./SidebarSharedRows";
import { WorkThreadNotice } from "./WorkThreadNotice";

const bot = { id: "iris", name: "Iris", section: "Design" };

it("a shared row names the bot and its home team, with working or waiting", () => {
  const working = renderToStaticMarkup(createElement(SharedRowButton, { bot, row: { teamId: "s", teamName: "Sales", threadId: "w", working: true, waiting: 0 }, selected: true, onOpen: () => {} }));
  expect(working).toContain("Iris · shared from Design");
  expect(working).toContain(">working<");
  expect(working).toContain('aria-current="true"');
  const waiting = renderToStaticMarkup(createElement(SharedRowButton, { bot, row: { teamId: "s", teamName: "Sales", threadId: null, working: false, waiting: 2 }, selected: false, onOpen: () => {} }));
  expect(waiting).toContain(">2 waiting<");
  expect(waiting).not.toContain("aria-current");
});

it("the work thread strip: the team and the brief, and once closed, the line kept for reading", () => {
  const open = renderToStaticMarkup(createElement(WorkThreadNotice, { bot: { name: "Iris", threadId: "w", tasks: [{ threadId: "w", title: "Work for Sales", createdAt: 1, sharedWork: { teamId: "s", teamName: "Sales", createdAt: 1 } }] } }));
  expect(open).toContain("Work for Sales. Iris follows the Sales brief and Iris&#x27;s Sales notes here.");
  expect(open).not.toContain("kept for reading");
  const closed = renderToStaticMarkup(createElement(WorkThreadNotice, { bot: { name: "Iris", threadId: "w", tasks: [{ threadId: "w", title: "Work for Sales", createdAt: 1, sharedWork: { teamId: "s", teamName: "Sales", createdAt: 1, closedAt: 2, closedReason: "revoked" } }] } }));
  expect(closed).toContain("Iris is no longer shared with Sales. This conversation is kept for reading.");
  expect(renderToStaticMarkup(createElement(WorkThreadNotice, { bot: { name: "Iris", threadId: "home", tasks: [{ threadId: "home", title: "Direct chat", createdAt: 1 }] } }))).toBe("");
});

it("the composer locks a closed work thread with that line, and the chat shows the strip", () => {
  const composer = readFileSync(new URL("./Composer.tsx", import.meta.url), "utf8");
  expect(composer).toMatch(/const closedWork = !group && bot \? closedComposerLine\(bot\) : null;/);
  expect(composer).toMatch(/const locked = setupLocked \|\| Boolean\(bot\?\.awaitingThreadSnapshot\) \|\| closedWork !== null;/);
  expect(composer).toMatch(/closedWork\s*\?\s*\{ lead: closedWork \}/);
  expect(readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")).toContain("<WorkThreadNotice bot={bot} />");
});
