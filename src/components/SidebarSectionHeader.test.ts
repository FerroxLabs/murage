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

  it("gives a closed section a count for waiting and a badge for nothing else", () => {
    const html = renderToStaticMarkup(
      createElement(SidebarSectionHeader, {
        name: "Bot Chats",
        collapsed: true,
        attention: { waiting: 2, unread: 5, working: 3 },
        onToggle: () => {},
        reorderable: false,
        dragging: false,
      }),
    );

    // The one count that is drawn, in the one colour that means "you".
    expect(html).toContain("bg-warning/15");
    expect(html).toMatch(/text-warning[^>]*>2</);
    // Unread's badge is gone: five unread chats no longer draw a number.
    expect(html).not.toContain("bg-accent/15");
    expect(html).not.toContain(">5<");
    // Working turns instead of holding a coloured dot, and never numbers itself.
    expect(html).toContain("animate-spin");
    expect(html).not.toContain("bg-success");
    expect(html).not.toContain(">3<");
    // …and all three still reach a screen reader.
    expect(html).toContain("2 waiting for you, 5 unread, 3 working");
  });

  it("draws nothing when a closed section is only unread", () => {
    const html = renderToStaticMarkup(
      createElement(SidebarSectionHeader, {
        name: "Work",
        collapsed: true,
        attention: { waiting: 0, unread: 4, working: 0 },
        onToggle: () => {},
        reorderable: false,
        dragging: false,
      }),
    );

    expect(html).not.toContain("bg-warning/15");
    expect(html).not.toContain("animate-spin");
    expect(html).not.toContain(">4<");
    expect(html).toContain("4 unread");
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

  it("gives a team heading a menu button with a 44px target, and built-in headings none", () => {
    const team = renderToStaticMarkup(
      createElement(SidebarSectionHeader, { name: "Operations", collapsed: false, onToggle: () => {}, reorderable: false, dragging: false, onManage: () => {} }),
    );
    expect(team).toContain('aria-label="Operations team options"');
    expect(team).toContain('aria-haspopup="menu"');
    expect(team).toContain('aria-expanded="false"');
    expect(team).toMatch(/after:-inset-2\.5/);
    // Closed: no menu in the page until it is opened.
    expect(team).not.toContain('role="menu"');
    const builtIn = renderToStaticMarkup(
      createElement(SidebarSectionHeader, { name: "Bots", collapsed: false, onToggle: () => {}, reorderable: false, dragging: false }),
    );
    expect(builtIn).not.toContain("team options");
  });
});
