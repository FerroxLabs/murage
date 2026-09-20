// "Needs you" is a row of the sidebar, not an entry in the Tools menu, and
// there is exactly one way into it.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SidebarNeedsYou, needsYouLabel } from "./SidebarNeedsYou";

const render = (props: Partial<Parameters<typeof SidebarNeedsYou>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(SidebarNeedsYou, { density: "comfortable", count: 0, onOpen: vi.fn(), ...props }),
  );

describe("the Needs you row", () => {
  it("says what it is and how many, in its own row", () => {
    const markup = render({ count: 3 });
    expect(markup).toContain(">Needs you</span>");
    expect(markup).toContain("data-sidebar-needs-you");
    expect(markup).toContain("data-needs-you-count");
    expect(markup).toContain(">3</span>");
    expect(markup).toContain('aria-label="Needs you, 3"');
  });

  it("reads as waiting only when something is waiting", () => {
    expect(render({ count: 2 })).toContain("bg-accent/10");
    expect(render({ count: 0 })).not.toContain("bg-accent/10");
  });

  it("never invents a number it does not have, and says when one is old", () => {
    expect(render({ count: undefined })).toContain('aria-label="Needs you, not known yet"');
    expect(render({ count: undefined })).toContain(">?</span>");
    expect(needsYouLabel(4, true)).toBe("Needs you, 4, may be out of date");
    expect(render({ count: 4, stale: true })).toContain("4 ?");
  });

  it("keeps its label out of the way in the avatars-only density", () => {
    const icons = render({ density: "icons", count: 1 });
    expect(icons).toContain("hidden");
    expect(icons).toContain('aria-label="Needs you, 1"');
  });
});

describe("the sidebar's one door to it", () => {
  const sidebar = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");

  it("draws the row itself instead of folding approvals into Tools", () => {
    expect(sidebar).toContain("<SidebarNeedsYou");
    // the two entries that opened the same dialog are gone
    expect(sidebar).not.toContain('key: "pending-approvals"');
    expect(sidebar).not.toContain('key: "inbox"');
    // …and so is the second, approvals-only copy of the dialog
    expect(sidebar.match(/<InboxDialog/g)).toHaveLength(1);
    expect(sidebar).not.toContain('initialView="approvals"');
  });
});
