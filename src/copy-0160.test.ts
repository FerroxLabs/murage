// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The 0.1.60 Mac pass copy flags, held by their exact product strings: no em
// dash in Settings, General and Settings, Engines, and no "safe" or "safely"
// in Bot settings, Permissions, Review routine approvals.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("0.1.60 copy flags", () => {
  it("Settings, General follows the system without an em dash", () => {
    const skin = source("./components/SkinPicker.tsx");
    expect(skin).toContain("Following your system, now {resolved");
    expect(skin).not.toContain("Following your system —");
  });

  it("Settings, Engines reports a CLI test without an em dash", () => {
    const engines = source("./components/EnginesSettings.tsx");
    expect(engines).toContain("Test failed: {probe.message}");
    expect(engines).toContain("Test passed: {probe.version}");
  });

  it("Settings, Engines says a Box key is missing without an em dash", () => {
    const box = source("../server/drivers/boxagent.ts");
    expect(box).toContain('"No Box key yet. Add one in App Settings → Tools & Connections."');
  });

  it("the error screen never says safe", () => {
    const screen = source("./components/RootErrorBoundary.tsx");
    expect(screen).toContain("Reloading the window loses nothing.");
    expect(screen).not.toMatch(/window is safe/);
  });

  it("Review routine approvals never says safe", () => {
    const panel = source("./components/SettingsPanel.tsx");
    const at = panel.indexOf("Review routine approvals");
    const block = panel.slice(at, panel.indexOf("</div>\n            <div", at) + 400);
    expect(block).not.toMatch(/\bsafe(ly|ty)?\b/i);
    expect(block).toContain("This engine cannot run a separate review, so approval cards keep waiting for you.");
  });
});
