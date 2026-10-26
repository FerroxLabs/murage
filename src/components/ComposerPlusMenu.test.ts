// The phone composer's round +. Every control the desktop composer keeps in
// its lower row (Attach, Finish together, the approval level) is an entry of
// this menu, so nothing is lost, only moved. Node, no DOM: markup for the
// trigger, the entries as data, and source contracts for the composer.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { ComposerPlusMenu, composerPlusItems } from "./ComposerPlusMenu";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
const approval = { current: "Ask", renderMenu: () => null };

describe("the + menu's entries", () => {
  it("offers Attach to every conversation and calls the file picker", () => {
    const onAttach = vi.fn();
    const items = composerPlusItems({ onAttach }, () => {});
    expect(items.map((item) => item.id)).toEqual(["attach"]);
    items[0]!.onSelect();
    expect(onAttach).toHaveBeenCalledOnce();
  });

  it("adds Finish together in a room, as a toggle that reports its state", () => {
    const onToggle = vi.fn();
    const off = composerPlusItems({ onAttach: () => {}, goal: { on: false, onToggle } }, () => {});
    const on = composerPlusItems({ onAttach: () => {}, goal: { on: true, onToggle } }, () => {});
    expect(off.map((item) => item.id)).toEqual(["attach", "goal"]);
    expect(off[1]!.label).toBe("Finish together");
    expect(off[1]!.checked).toBe(false);
    expect(on[1]!.checked).toBe(true);
    on[1]!.onSelect();
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("adds the approval level with the current level named, opening the level menu", () => {
    const open = vi.fn();
    const items = composerPlusItems({ onAttach: () => {}, approval }, open);
    const entry = items.find((item) => item.id === "approval")!;
    expect(entry.label).toBe("Approval level");
    expect(entry.description).toBe("Ask");
    entry.onSelect();
    expect(open).toHaveBeenCalledOnce();
  });

  it("greys the approval level while the bot is working, and Attach while a send is pending", () => {
    const items = composerPlusItems({ onAttach: () => {}, attachDisabled: true, approval: { ...approval, disabled: true } }, () => {});
    expect(items.every((item) => item.disabled)).toBe(true);
  });

  it("keeps every entry of a room's full set in the desktop order: Attach, Finish together, Approval level", () => {
    const items = composerPlusItems({ onAttach: () => {}, goal: { on: false, onToggle: () => {} }, approval }, () => {});
    expect(items.map((item) => item.id)).toEqual(["attach", "goal", "approval"]);
  });
});

describe("the + button", () => {
  const html = renderToStaticMarkup(createElement(ComposerPlusMenu, { onAttach: () => {}, approval }));

  it("is a labelled menu button, closed until pressed", () => {
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Message options"');
    expect(html).toContain("data-composer-plus");
    expect(html).not.toContain('role="menu"');
  });

  it("is the shared menu, opening above the composer, with Escape returning focus to the +", () => {
    const menu = read("./ChatHeaderMenu.tsx");
    const plus = read("./ComposerPlusMenu.tsx");
    expect(plus).toContain('variant="composer-plus"');
    expect(plus).toContain('menuLabel="Composer actions"');
    expect(menu).toMatch(/event\.key === "Escape" \|\| event\.key === "Tab"\) close\(true\)/);
    // the approval-level panel: Escape closes it and focus goes back to the +
    expect(plus).toMatch(/event\.key !== "Escape"[\s\S]{0,200}triggerRef\.current\?\.focus\(\)/);
    expect(plus).toContain("closeApproval");
    expect(plus).toContain('"pointerdown"');
  });
});

describe("the composer on a phone", () => {
  const composer = read("./Composer.tsx");

  it("mounts the + only on a phone and only while the composer is open", () => {
    expect(composer).toMatch(/phoneComposer && !locked && \(\s*<ComposerPlusMenu/);
    expect(composer).toContain("const phoneComposer = narrowPlaceholder;");
  });

  it("hides the lower row's Attach, Goal and approval chip on a phone, and keeps them on every other screen", () => {
    expect(composer).toMatch(/\{!locked && !phoneComposer && \(\s*<div className="flex items-center gap-1">/);
    // the desktop controls are still there for the wider layouts
    expect(composer).toContain('aria-label="Attach a file"');
    expect(composer).toContain('aria-label="Finish together"');
    expect(composer).toContain("<PermissionModeSelector");
  });

  it("shares one Goal toggle and one level menu between the chips and the +", () => {
    expect(composer).toContain("onClick={toggleGoal}");
    expect(composer).toContain("onToggle: toggleGoal");
    expect(composer.match(/<PermissionLevelMenu/g)?.length).toBe(2);
  });

  it("leaves Stop, Inject, dictation, the permission warnings and the send button outside every phone branch", () => {
    for (const marker of [
      'aria-label="Stop this turn"',
      "<ComposerInjectNow",
      'aria-label={recording ? "Stop dictation" : "Start dictation"}',
      "<PushToTalk",
      "<LocalComputerAutoWarning",
      "<FullAccessWarning",
    ]) {
      const at = composer.indexOf(marker);
      expect(at, marker).toBeGreaterThan(0);
      const before = composer.slice(Math.max(0, at - 220), at);
      expect(before, marker).not.toContain("phoneComposer");
    }
    expect(composer).toContain("{busy && !locked && !canInject && (");
    expect(composer).toContain("{canInject && <ComposerInjectNow");
  });

  it("puts the field and the mic in one pill beside the +, and leaves Call to the header", () => {
    expect(composer).toContain('phoneComposer ? "flex items-end gap-2" : "contents"');
    expect(composer).toContain("rounded-[26px]");
    // one call control on a phone: the header's, in every state
    expect(composer).not.toContain("<CallButton");
  });

  it("leaves the desktop and tablet composer's own classes as they were", () => {
    expect(composer).toContain('"flex-col rounded-3xl px-2"');
    expect(composer).toContain('"flex items-center gap-1", phoneComposer && "contents"');
  });

  it("keeps the dock padding and the keyboard-aware wrapper untouched", () => {
    expect(composer).toContain('data-composer className="pointer-events-none relative px-5 pb-3"');
  });
});
