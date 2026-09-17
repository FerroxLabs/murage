import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SidebarSectionHeader } from "./SidebarSectionHeader";

describe("SidebarSectionHeader", () => {
  it("exposes collapse and keyboard reorder semantics without a fake grip button", () => {
    const html = renderToStaticMarkup(
      createElement(SidebarSectionHeader, {
        name: "Work",
        collapsed: false,
        onToggle: () => {},
        reorderable: true,
        dragging: false,
      }),
    );

    expect(html).toContain("<button");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="button"');
  });

  it("renders collapsed attention signals in the heading", () => {
    const html = renderToStaticMarkup(
      createElement(SidebarSectionHeader, {
        name: "Bot Chats",
        collapsed: true,
        attention: { waiting: 1, unread: 2, working: 1 },
        onToggle: () => {},
        reorderable: false,
        dragging: false,
      }),
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("1 waiting for you");
    expect(html).toContain("2 unread");
    expect(html).toContain("1 working");
  });

  it("offers a team's instructions editor from its header, and only where a team was given one", () => {
    const withEditor = renderToStaticMarkup(
      createElement(SidebarSectionHeader, {
        name: "Operations",
        collapsed: false,
        onToggle: () => {},
        onEditInstructions: () => {},
        reorderable: true,
        dragging: false,
      }),
    );
    expect(withEditor).toContain('aria-label="Edit Operations team instructions"');
    expect(withEditor).toMatch(/<button[^>]*aria-label="Edit Operations team instructions"/);

    const pinned = renderToStaticMarkup(
      createElement(SidebarSectionHeader, {
        name: "Pinned",
        collapsed: false,
        onToggle: () => {},
        reorderable: true,
        dragging: false,
      }),
    );
    expect(pinned).not.toContain("team instructions");
  });
});
