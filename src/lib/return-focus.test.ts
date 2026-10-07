// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { returnFocus } from "./return-focus";

const element = (inert: boolean, connected = true) => ({ isConnected: connected, focus: vi.fn(), closest: (selector: string) => (selector === "[inert]" && inert ? {} : null) });

// An overlay opened from the phone drawer returns focus to its opener when it
// closes, but the closed drawer is inert and that opener can no longer take
// it; focus fell to the page (0.1.61 cross-audit on 4808f04f).
describe("returning focus when an overlay closes", () => {
  it("gives it back to the opener when the opener can take it", () => {
    const opener = element(false), menu = element(false);
    returnFocus(opener as never, { querySelector: () => menu } as never);
    expect(opener.focus).toHaveBeenCalled();
    expect(menu.focus).not.toHaveBeenCalled();
  });

  it("gives it to the drawer's menu button when the opener is in the closed drawer", () => {
    const opener = element(true), menu = element(false);
    const querySelector = vi.fn(() => menu);
    returnFocus(opener as never, { querySelector } as never);
    expect(opener.focus).not.toHaveBeenCalled();
    expect(querySelector).toHaveBeenCalledWith("[data-focus-fallback]");
    expect(menu.focus).toHaveBeenCalled();
  });

  it("does nothing for an opener that is gone, as before", () => {
    const opener = element(false, false), menu = element(false);
    returnFocus(opener as never, { querySelector: () => menu } as never);
    expect(opener.focus).not.toHaveBeenCalled();
    expect(menu.focus).not.toHaveBeenCalled();
  });

  it("is what the overlays that can be opened from the drawer use", () => {
    for (const file of ["SettingsModal", "BotSettingsDialog", "PluginsPanel", "TeamLibraryPanel", "KeyboardShortcutsDialog"]) {
      expect(readFileSync(new URL(`../components/${file}.tsx`, import.meta.url), "utf8"), file).toContain("returnFocus(");
    }
    // The menu button moved out of App.tsx into each view's header
    // (OpenBotListButton.tsx, mobile/v1); the marker moved with it.
    expect(readFileSync(new URL("../components/OpenBotListButton.tsx", import.meta.url), "utf8")).toContain('data-focus-fallback=""');
  });
});
