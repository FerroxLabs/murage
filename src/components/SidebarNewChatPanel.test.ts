// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { SidebarNewChatPanel } from "./SidebarNewChatPanel";

it("names the active row for assistive technology", () => {
  const bots = [{ id: "a", name: "Ada" }, { id: "b", name: "Bea" }] as never;
  const html = renderToStaticMarkup(createElement(SidebarNewChatPanel, { bots, onPick: () => {}, onClose: () => {} }));
  expect(html).toContain('role="listbox"');
  expect(html).toContain('aria-activedescendant="new-chat-a"');
  expect(html).toContain('id="new-chat-a"');
  expect(html).toContain('role="option"');
  expect(html).toContain('aria-selected="true"');
});
