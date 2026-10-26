// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U34: typing in the Settings search hides the open page instead of unmounting
// it, so an unsaved skill draft (or any other page's typed words) is still there
// when the search is cleared.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const modal = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "SettingsModal.tsx"), "utf8");
const pane = modal.slice(modal.indexOf("<div ref={paneRef}"));

describe("Settings search and the open page", () => {
  it("does not swap the page out for the results", () => {
    expect(pane).not.toMatch(/\{q \? <SettingsSearchResults[^}]*\/> : <>/);
    expect(pane).toContain("{q && <SettingsSearchResults");
  });

  it("keeps the page mounted, hidden while a search is showing", () => {
    expect(pane).toMatch(/<div data-settings-page-body hidden=\{q \? true : undefined\} className=\{q \? "hidden" : "contents"\}>/);
    const body = pane.slice(pane.indexOf("data-settings-page-body"));
    expect(body).toContain('section === "skills"');
  });
});

describe("the Settings focus trap while a search hides the page", () => {
  // A stand-in for a control: `closest` answers from the ancestors listed for it.
  const control = (ancestors: Record<string, object>, tagName = "BUTTON", parentElement: object | null = null) =>
    ({ tagName, parentElement, closest: (selector: string) => ancestors[selector] ?? null }) as unknown as Element;

  it("skips controls inside the hidden page, so Tab cannot leave the dialog", async () => {
    const { inSettingsTabOrder } = await import("./SettingsModal");
    expect(inSettingsTabOrder(control({ "[hidden]": {} }))).toBe(false);
    expect(inSettingsTabOrder(control({}))).toBe(true);
  });

  it("still keeps a folded section's summary and skips its contents", async () => {
    const { inSettingsTabOrder } = await import("./SettingsModal");
    const folded = {};
    expect(inSettingsTabOrder(control({ "details:not([open])": folded }, "SUMMARY", folded))).toBe(true);
    expect(inSettingsTabOrder(control({ "details:not([open])": folded }))).toBe(false);
  });

  it("filters the trap's stops through that rule", () => {
    expect(modal).toMatch(/\)\.filter\(inSettingsTabOrder\);/);
  });
});
