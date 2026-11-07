// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The phone's four tabs (UX L7): order, one lit tab, the Needs you count in
// the name and the badge, 56 px tabs with 12 px labels, and the shell wiring
// (the real component in the slot, shown on the door pages only).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PhoneTabs, phoneBadge } from "./PhoneTabs";

const html = (props: Partial<Parameters<typeof PhoneTabs>[0]> = {}) =>
  renderToStaticMarkup(createElement(PhoneTabs, { active: "today", needsCount: 3, onSelect: vi.fn(), ...props }));
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("PhoneTabs", () => {
  it("shows Today, Chats, Needs you and Routines in that order, as four buttons in one nav", () => {
    const markup = html();
    expect(markup).toMatch(/^<nav aria-label="Main"/);
    expect([...markup.matchAll(/data-phone-tab="([a-z-]+)"/g)].map((match) => match[1])).toEqual(["today", "chats", "needs-you", "routines"]);
    expect(markup.match(/<button type="button"/g)).toHaveLength(4);
    for (const label of ["Today", "Chats", "Needs you", "Routines"]) expect(markup).toContain(`>${label}</span>`);
  });

  it("lights exactly the active tab", () => {
    const markup = html({ active: "needs-you" });
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    expect(markup).toMatch(/data-phone-tab="needs-you" aria-current="page"/);
  });

  it("speaks the Needs you count and shows it as a badge readers skip", () => {
    const markup = html({ needsCount: 3 });
    expect(markup).toContain('aria-label="Needs you, 3 waiting"');
    expect(markup).toMatch(/<span aria-hidden="true" data-phone-needs-count[^>]*>3<\/span>/);
    expect(html({ needsCount: 0 })).toContain('aria-label="Needs you, nothing waiting"');
    expect(html({ needsCount: 0 })).not.toContain("data-phone-needs-count");
    expect(html({ needsCount: undefined })).toContain('aria-label="Needs you, not known yet"');
    expect(phoneBadge(7)).toBe("7");
    expect(phoneBadge(140)).toBe("99+");
  });

  it("is a thumb bar: 56 px tabs, 12 px labels, the full width shared four ways", () => {
    const markup = html();
    expect(markup.match(/class="flex h-14 min-w-0 flex-1 /g)).toHaveLength(4);
    expect(markup.match(/text-\[12px\]/g)).toHaveLength(4);
    expect(markup).toContain("pb-[env(safe-area-inset-bottom)]");
  });

  it("reports the tab picked", () => {
    const source = read("./PhoneTabs.tsx");
    expect(source).toContain("onClick={() => onSelect(door)}");
  });

  it("is the component in the shell's phone slot, shown on the door pages and not over an open chat", () => {
    expect(read("../shell/lane-slots.tsx")).toContain('export { PhoneTabs } from "@/components/phone/PhoneTabs";');
    const app = read("../../App.tsx");
    expect(app).toContain('const phoneTab = state.activeView === "chat" ? null : doorForView(state.activeView);');
    expect(app).toMatch(/\{phoneTab && \(\s*<div className="md:hidden">\s*<PhoneTabs active=\{phoneTab\}/);
  });
});
