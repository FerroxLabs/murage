import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SidebarMoreMenu, SidebarMoreMenuPanel, type MoreMenuItem } from "./SidebarMoreMenu";

const item = (over: Partial<MoreMenuItem> = {}): MoreMenuItem => ({
  key: "team-map",
  label: "Team map",
  icon: null,
  onSelect: vi.fn(),
  ...over,
});

const trigger = (items: MoreMenuItem[], compact = false) =>
  renderToStaticMarkup(createElement(SidebarMoreMenu, { items, compact }));

const panel = (items: MoreMenuItem[]) =>
  renderToStaticMarkup(createElement(SidebarMoreMenuPanel, { items }));

describe("sidebar more-menu trigger", () => {
  it("is a real button that announces the menu it owns, closed to begin with", () => {
    const markup = trigger([item()]);

    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Tools"');
    expect(markup).toContain(">Tools</span>");
    expect(markup).toContain("lucide-wrench");
    expect(markup).toContain("data-sidebar-more-trigger");
    // nothing is folded open on first paint: the four destinations are hidden
    expect(markup).not.toContain('role="menu"');
    expect(markup).not.toContain("Team map");
  });

  it("carries the attention dot on the folded items' behalf", () => {
    // the Calendar row's failed/missed dot would vanish with the row itself,
    // so the trigger has to show it while the menu is shut
    const quiet = trigger([item(), item({ key: "routines", label: "Calendar" })]);
    const loud = trigger([item(), item({ key: "routines", label: "Calendar", attention: true })]);

    expect(quiet).not.toContain("data-sidebar-more-attention");
    expect(loud).toContain("data-sidebar-more-attention");
    expect(loud).toContain("bg-danger");
    expect(loud).toContain('aria-label="Tools, items need attention"');
  });

  it("tightens its own height in the compact density without changing anything else", () => {
    expect(trigger([item()], false)).toContain("py-2");
    expect(trigger([item()], true)).toContain("py-1.5");
    expect(trigger([item()], true)).not.toContain("py-2");
  });
});

describe("sidebar more-menu panel", () => {
  const items = [
    item(),
    item({ key: "skill-recorder", label: "Teach a skill" }),
    item({ key: "routines", label: "Calendar", attention: true, active: true }),
    item({ key: "plugins", label: "Connected apps" }),
  ];

  it("lists every folded destination, in the order the sidebar gave them", () => {
    const markup = panel(items);

    expect(markup).toContain('role="menu"');
    const order = ["Team map", "Teach a skill", "Calendar", "Connected apps"].map((label) =>
      markup.indexOf(label),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(markup.match(/role="menuitem"/g)).toHaveLength(4);
  });

  it("keeps each item's own dot inside the menu and marks the active view", () => {
    const markup = panel(items);

    expect(markup).toContain("bg-danger");
    expect(markup).toContain("text-accent");
    expect(panel([item()])).not.toContain("bg-danger");
  });

  it("opens upward from the bar it hangs off, full width", () => {
    // the trigger is a pull-up handle sitting directly above the profile row;
    // a menu that dropped downward would open off the bottom of the sidebar
    const markup = panel(items);

    expect(markup).toContain("bottom-full");
    expect(markup).toContain("left-0");
    expect(markup).toContain("right-0");
  });
});
