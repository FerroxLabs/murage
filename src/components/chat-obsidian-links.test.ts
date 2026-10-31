// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ChatMarkdown } from "./ChatMarkdown";

// Adapted from OpenMausBot #3687: an obsidian:// note link stays a link; the
// default allow-list used to empty it. Other app schemes and image sources stay refused.
it("keeps an obsidian:// note link as a link and refuses other app schemes and obsidian image sources", () => {
  const html = renderToStaticMarkup(createElement(ChatMarkdown, { text: "[Plan](obsidian://open?vault=Work&file=Plan) [x](vscode://file/etc/passwd) ![i](obsidian://open?vault=Work&file=a.png)" }));
  expect(html).toContain('href="obsidian://open?vault=Work&amp;file=Plan"');
  expect(html).toContain(">Plan</a>");
  expect(html).not.toContain("vscode://");
  expect(html).not.toContain('src="obsidian:');
});

it("refuses every Obsidian action that could write a note or run a plugin", () => {
  for (const href of [
    "obsidian://new?vault=Work&name=x&content=y&overwrite=true&silent=true",
    "obsidian://open?vault=Work&file=Plan&clipboard=true",
    "obsidian://advanced-uri?vault=Work&commandid=editor%3Asave-file",
    "obsidian://search?vault=Work&query=x",
  ]) {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { text: `[note](${href})` }));
    expect(html, href).not.toContain("obsidian:");
  }
});
