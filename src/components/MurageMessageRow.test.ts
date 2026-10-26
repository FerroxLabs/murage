// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { MurageMessageRow } from "./MurageMessageRow";
import { loopNoticeName } from "../../shared/loop-notice.ts";
import type { Group, Bot, Message } from "@/state/store";
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: { features: {} }, groups: [], bots: [] }, dispatch: vi.fn() }), api: vi.fn() }));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => true }));

const group = { id: "g", threadId: "room", memberIds: ["a"] } as Group;
const members = [{ id: "a", name: "Ember" }] as Bot[];

it("renders a repeat notice in a project chat as the readable line, not its stored key", () => {
  const message = { id: "loop", role: "bot", kind: "activity", tool: { name: loopNoticeName("repeat", 5, "Gmail: list drafts"), ok: false }, at: 1 } as Message;
  const html = renderToStaticMarkup(createElement(MurageMessageRow, { message, group, members }));
  expect(html).not.toContain("loop-notice:");
  expect(html).toContain("Same call repeated 5×: Gmail: list drafts");
});

it("renders the nudge notice readably and keeps other Murage lines as they were", () => {
  const nudged = { id: "n", role: "bot", kind: "activity", tool: { name: loopNoticeName("nudged"), ok: true }, at: 1 } as Message;
  expect(renderToStaticMarkup(createElement(MurageMessageRow, { message: nudged, group, members }))).toContain("Nudged after 5 identical failures");
  const failed = { id: "e", role: "bot", kind: "activity", tool: { name: "error: Ember stopped", ok: false }, at: 1 } as Message;
  const html = renderToStaticMarkup(createElement(MurageMessageRow, { message: failed, group, members }));
  expect(html).toContain("Ember stopped");
  expect(html).not.toContain("error:");
});
