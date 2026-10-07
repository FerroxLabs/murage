// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// G3: at 1280x720 the Settings list was cut off below Skills; Usage could not
// be reached and nothing showed there was more. The dialog now has room for
// every section at 720px, and when a shorter window cannot fit them the list
// scrolls with the app's always-visible scrollbar (styles.css). The real
// window is proved by the lane's 1280x720 screenshot.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./SettingsModal.tsx", import.meta.url)), "utf8");
const nav = /<nav\s+className=\{cn\(([^]*?)\)\}/.exec(source)?.[1] ?? "";

describe("Settings list reaches every section (G3)", () => {
  it("scrolls on its own inside the dialog instead of being clipped", () => {
    expect(nav).toContain("md:min-h-0");
    expect(nav).toContain("md:overflow-y-auto");
    // the horizontal phone strip keeps its own scroller
    expect(nav).toContain("max-md:overflow-x-auto");
  });

  it("never scrolls the dialog itself, so focusing a low section cannot push the header off", () => {
    const dialog = /role="dialog"[^]*?className=\{cn\(\s*"([^"]+)"/.exec(source)?.[1] ?? "";
    expect(dialog).toContain("overflow-clip");
    expect(dialog).not.toContain("overflow-hidden");
  });

  it("gives the grouped list room at 1440x900 and never outgrows the window", () => {
    // 0.1.62: six group headings of 22px over nineteen 28px rows, with the
    // title and search, need about 750px. 920x780 fits them in a 1440x900
    // window; a 1280x720 window caps the dialog at 688px and the list
    // scrolls on its own (the first test).
    const height = Number(/"h-\[min\((\d+)px,calc\(100dvh-2rem\)\)\]"/.exec(source)?.[1]);
    expect(height).toBeGreaterThanOrEqual(760);
    expect(height).toBeLessThanOrEqual(900 - 32);
    expect(source).toContain('"h-[min(780px,calc(100dvh-2rem))]"');
    // fixed row and heading heights, so the sum holds in every font
    expect(source).toContain('"flex h-7 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px]"');
    expect(source).toContain('"flex h-[22px] items-end px-2.5');
  });

  it("scrolls each page on its own too, below its header", () => {
    expect(source).toContain('"flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto');
  });
});
