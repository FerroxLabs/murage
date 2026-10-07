// The phone's "Open bot list" button lives IN each main view's header row.
//
// It used to float over the chat column from App.tsx at a fixed top offset,
// which could only approximate the row's centre: on an iPhone and a Samsung
// the icon sat a few points above the bot's name while the ••• on the same row
// lined up. Same shape as the other component tests here: node, no jsdom,
// markup through renderToStaticMarkup, plus source contracts for where the
// button is mounted. The rendered geometry is measured in Chromium by
// src/e2e/chat-header.human.spec.ts.
import { createElement, createRef, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { BotListButton, BotListDrawerProvider, OpenBotListButton, PhoneBotListBar, type BotListDrawerControl } from "./OpenBotListButton";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

function control(overrides: Partial<BotListDrawerControl> = {}): BotListDrawerControl {
  return { expanded: false, open: () => {}, buttonRef: createRef<HTMLButtonElement>(), takeFocusReturn: () => false, ...overrides };
}

function withDrawer(value: BotListDrawerControl | null, child: ReactElement): string {
  return renderToStaticMarkup(createElement(BotListDrawerProvider, { value, children: child }));
}

describe("OpenBotListButton", () => {
  it("renders the phone-only button with its name and expanded state", () => {
    const html = withDrawer(control(), createElement(OpenBotListButton));
    expect(html).toContain('aria-label="Open bot list"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/class="[^"]*\bmd:hidden\b/);
    // A flex item, never an overlay: that is the whole fix.
    expect(html).not.toMatch(/\babsolute\b/);
    expect(html).not.toMatch(/\btop-/);
    expect(withDrawer(control({ expanded: true }), createElement(OpenBotListButton))).toContain('aria-expanded="true"');
  });

  it("renders nothing without a drawer to open (md+ fixtures, the calendar focus view)", () => {
    expect(renderToStaticMarkup(createElement(OpenBotListButton))).toBe("");
    expect(withDrawer(null, createElement(OpenBotListButton))).toBe("");
    expect(withDrawer(null, createElement(PhoneBotListBar))).toBe("");
  });

  it("opens the drawer and hands App its ref for focus return", () => {
    const open = vi.fn();
    const buttonRef = createRef<HTMLButtonElement>();
    const element = BotListButton({ control: control({ open, buttonRef }) });
    expect(isValidElement(element)).toBe(true);
    const props = element.props as { onClick: () => void; type: string };
    expect(props.type).toBe("button");
    props.onClick();
    expect(open).toHaveBeenCalledTimes(1);
    expect((element as unknown as { props: { ref?: unknown } }).props.ref ?? (element as unknown as { ref?: unknown }).ref).toBe(buttonRef);
  });

  it("gives a view without a header a phone-only row below the status bar", () => {
    const html = withDrawer(control(), createElement(PhoneBotListBar));
    expect(html).toContain('aria-label="Open bot list"');
    expect(html).toMatch(/^<div class="[^"]*\bitems-center\b[^"]*pt-\[calc\(0\.75rem\+env\(safe-area-inset-top\)\)\] md:hidden"/);
  });
});

describe("where the button is mounted", () => {
  it("is no longer drawn by App.tsx, which provides the drawer instead", () => {
    const app = read("../App.tsx");
    expect(app).not.toContain('aria-label="Open bot list"');
    expect(app).toContain("<BotListDrawerProvider value={drawerControl}>");
    // The calendar focus view has no drawer, so no button.
    expect(app).toContain("useBotListDrawer(!calendarFocus)");
    // A pick or Escape closes through the hook, which returns focus to the
    // button the NEXT view mounts; never a synchronous .focus() on the old
    // one (measured across view kinds in src/e2e/bot-list-focus.human.spec.ts).
    expect(app).toContain("onClose={closeDrawer}");
    expect(app).not.toMatch(/menuButtonRef/);
  });

  it("is the first item of the bot chat header's row", () => {
    const header = read("./ChatHeader.tsx");
    const row = header.slice(header.indexOf("data-chat-header\n"));
    const rowOpen = row.slice(0, row.indexOf(">\n") + 2);
    expect(rowOpen).toContain('"flex items-center gap-2 px-5 py-3"');
    const firstChild = row.slice(rowOpen.length).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").trimStart();
    expect(firstChild.startsWith("<OpenBotListButton />")).toBe(true);
  });

  it("is the first item of the room header's title row", () => {
    const group = read("./GroupView.tsx");
    const at = group.indexOf("<OpenBotListButton />");
    expect(at).toBeGreaterThan(0);
    const before = group.slice(0, at);
    expect(before.slice(before.lastIndexOf("<div"))).toMatch(/^<div className="flex min-w-0 basis-full items-center gap-2[^"]*">\s*(\{\/\*[\s\S]*?\*\/\}\s*)?$/);
    expect(group.slice(at, at + 200)).toContain("{group.name}</span>");
  });

  it("is on every other main view a phone can reach", () => {
    for (const file of ["./TeamMapPage.tsx", "./SkillRecorderPage.tsx", "./BrowserWorkspace.tsx", "./LocalVmWorkspace.tsx"]) {
      expect(read(file), file).toContain("<OpenBotListButton />");
    }
    expect(read("./NoEngines.tsx")).toContain("<PhoneBotListBar />");
    expect(read("../App.tsx")).toContain("<PhoneBotListBar />");
  });
});
