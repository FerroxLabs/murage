// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX L7 part 2: the phone's level sheet sets Ask or Auto and refuses Full
// access and No limits; a Needs you row swipes left to "Not now" and its sheet
// has Next under the thumb.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhoneLevelSheet, phoneLevelPick } from "./PhoneLevelSheet";
import { NeedsRow, isSwipeLeft } from "../needs/NeedsRow";
import { inPhoneSheet } from "./sheet-layer";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const setPhone = (matches: boolean) => vi.stubGlobal("matchMedia", (query: string) => ({ matches: matches && query.includes("max-width"), addEventListener() {}, removeEventListener() {} }));
afterEach(() => { vi.unstubAllGlobals(); });

const sheet = (current: "ask" | "auto" | "full" | "unlimited" = "ask") =>
  renderToStaticMarkup(createElement(PhoneLevelSheet, { botName: "Nova", current, onPick: vi.fn(), onClose: vi.fn() }));

describe("PhoneLevelSheet", () => {
  it("is a sheet of four levels where only Ask and Auto can be picked", () => {
    const html = sheet();
    expect(html).toContain(">Level for Nova</h2>");
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/role="radio"/g)).toHaveLength(4);
    for (const mode of ["ask", "auto"]) expect(html).toMatch(new RegExp(`role="radio" aria-checked="(true|false)" data-phone-level="${mode}"`));
    for (const mode of ["full", "unlimited"]) expect(html).toMatch(new RegExp(`aria-disabled="true" data-phone-level="${mode}"`));
    expect(html).toContain("Full access and No limits are set on your computer, where you can see what they change.");
    expect(html).toContain("This changes the level for this chat. Routines keep their own.");
    expect(html).not.toContain("Routines follow this level");
  });

  it("says a routine's sheet sets that routine only (MurageMain copy ruling)", () => {
    const html = renderToStaticMarkup(createElement(PhoneLevelSheet, { botName: "Nova", current: "ask", routine: "Morning brief", onPick: vi.fn(), onClose: vi.fn() }));
    expect(html).toContain("This routine follows this level.");
    expect(html).not.toContain("This changes the level for this chat.");
  });

  it("refuses Full access and No limits as a pick", () => {
    expect(phoneLevelPick("ask")).toBe("ask");
    expect(phoneLevelPick("auto")).toBe("auto");
    expect(phoneLevelPick("full")).toBeNull();
    expect(phoneLevelPick("unlimited")).toBeNull();
    expect(read("./PhoneLevelSheet.tsx")).toContain("onClick={() => { const pick = phoneLevelPick(entry.mode); if (pick) onPick(pick); }}");
  });

  it("keeps the engine's own notes beside the choices", () => {
    const html = renderToStaticMarkup(createElement(PhoneLevelSheet, { botName: "Nova", current: "ask", engineCannotAsk: "Cline", engineOwnApprovals: "OpenClaw", onPick: vi.fn(), onClose: vi.fn() }));
    expect(html).toContain("data-phone-level-engine");
    expect(html).toContain("OpenClaw");
    expect(html.match(/Cline/g)?.length).toBe(2);
  });

  it("shows the level in force even when it is one the phone cannot set", () => {
    expect(sheet("full")).toMatch(/aria-checked="true" aria-disabled="true" data-phone-level="full"/);
  });

  it("opens from the composer's level menu below md, loaded on first open, and a tap in it does not close the menu first", () => {
    const composer = read("../Composer.tsx");
    expect(composer).toContain('retryableLazy(() => import("@/components/phone/PhoneLevelSheet")');
    expect(composer).not.toMatch(/^import .*PhoneLevelSheet/m);
    // a narrowed desktop window keeps the full menu: the sheet is for the phone and browser door only
    expect(composer).toMatch(/const phone = useNarrowViewport\(\) && desktop === false;\s*if \(phone\) \{/);
    expect(composer).toContain("!inPhoneSheet(e.target)) setOpen(false);");
    const plus = read("../ComposerPlusMenu.tsx");
    expect(plus).toContain("!inPhoneSheet(event.target)) setApprovalOpen(false);");
    // Tab inside the sheet moves to Ask and Auto; it must not close the + menu (Astra r1 High)
    expect(plus).toMatch(/if \(event\.key !== "Escape" && event\.key !== "Tab"\) return;\s*if \(inPhoneSheet\(event\.target\)\) return;/);
    expect(inPhoneSheet(null)).toBe(false);
  });
});

describe("Needs you on a phone", () => {
  const row = (props: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(NeedsRow, { id: "r1", line: "Send the Dana email?", meta: "Max", open: false, onToggle: () => undefined, ...props }, createElement("p", null, "card")));

  it("a swipe left is a long, mostly sideways drag", () => {
    expect(isSwipeLeft(-90, 10)).toBe(true);
    expect(isSwipeLeft(-40, 0)).toBe(false);
    expect(isSwipeLeft(90, 0)).toBe(false);
    expect(isSwipeLeft(-90, 60)).toBe(false);
  });

  it("a closed row swipes to Not now on a phone only", () => {
    setPhone(true);
    expect(row({ onNotNow: vi.fn() })).toContain('data-swipe="not-now"');
    expect(row({})).not.toContain("data-swipe");
    expect(row({ onNotNow: vi.fn(), open: true })).not.toContain("data-swipe");
    setPhone(false);
    expect(row({ onNotNow: vi.fn() })).not.toContain("data-swipe");
  });

  it("the open sheet has Next under the thumb, and none on the last request", () => {
    setPhone(true);
    const html = row({ open: true, onNext: vi.fn() });
    expect(html).toMatch(/data-phone-sheet-footer[^>]*><button type="button" data-needs-next="r1"[^>]*>Next<\/button>/);
    expect(row({ open: true })).not.toContain("data-phone-sheet-footer");
  });

  it("the door wires Not now to the row's snooze and Next to the following row", () => {
    const inbox = read("../Inbox.tsx");
    expect(inbox).toContain("onNotNow={item.snoozedUntil !== null && item.snoozedUntil > Date.now() ? undefined : () => snooze(item)}");
    expect(inbox).toContain("const nextId = doorIds[doorIds.indexOf(item.id) + 1];");
    expect(inbox).toContain("onNext={nextId ? () => openRow(nextId) : undefined}");
  });
});
