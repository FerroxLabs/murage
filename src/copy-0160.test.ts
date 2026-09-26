// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The 0.1.60 Mac pass copy flags, held by their exact product strings: no em
// dash in Settings, General and Settings, Engines, and no "safe" or "safely"
// in Bot settings, Permissions, Review routine approvals.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { peerContactHint } from "@/lib/permission-mode";

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

  // Routines follow their own level in 0.1.60 (the bot's unless a routine has
  // one), so no level description may say routine turns still ask.
  it("no level description says routine turns still ask", () => {
    for (const file of ["./components/BotPermissionDefault.tsx", "./components/FullAccessWarning.tsx", "./lib/permission-mode.ts"]) {
      expect(source(file), file).not.toMatch(/routines? turns still|webhooks? (and|or) routines? (turns )?still/i);
    }
    expect(source("./components/BotPermissionDefault.tsx")).toContain("Webhook turns still ask. Routines use this level unless a routine has its own.");
    const hint = peerContactHint({ autoApprove: true, fullAccess: true, approvePeerComms: true });
    expect(hint).toContain("in routines at that level; webhook turns still stop and ask");
  });

  // Linux and Windows pass copy flags
  it("the remaining flagged lines have no em dash and never say safe", () => {
    expect(source("./components/BackupSettings.tsx")).not.toMatch(/somewhere safe/);
    expect(source("./lib/first-run-copy.ts")).not.toMatch(/somewhere safe/);
    expect(source("./components/LocalComputerSection.tsx")).not.toContain("Safety and storage");
    expect(source("./components/PushToTalk.tsx")).toContain('"Voice typing unavailable. Tap to find out why"');
    expect(source("./lib/local-models-view.ts")).toContain("`Looked for ${where}. Nothing answered.`");
    expect(source("../server/drivers/openai-compat.ts")).toContain('"No API key yet. Add one in App Settings → Models."');
  });
});
