// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
//
// 1.0.21 (Sean's live 1.0.20 walk of Models & engines): an engine that is not installed, opened from "More engines",
// says what it is and offers one plain button; its curl|bash / npm install line and the Node.js note show only in
// Advanced. The same card elsewhere (onboarding, a project's engine fix) keeps its command up front.
import { act, createElement } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount } from "../testing/dom-harness";
import type { InstanceInfo } from "@/state/store";
import { resetSettingsModeForTest, setSettingsMode, settingsMode } from "@/lib/settings-mode";

vi.mock("@/state/store", async original => ({
  ...await original<typeof import("@/state/store")>(),
  api: vi.fn(async () => ({ instances: [] })),
  useStore: () => ({ dispatch: vi.fn() }),
}));
import { EngineSetup } from "./EngineSetup";

const COMMAND = "npm install -g @fixture/engine-cli";
const missing: InstanceInfo = {
  instanceId: "fixture", driverKind: "fixtureAgent", displayName: "Fixture Engine",
  models: { default: "", options: [] },
  snapshot: { state: "unavailable", reason: "Fixture Engine isn't installed on this computer." },
  install: { command: { linux: COMMAND }, platform: "linux", needsNode: true },
};
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(() => { cleanup(); document.body.replaceChildren(); resetSettingsModeForTest(); });

const text = () => document.body.textContent ?? "";

describe("an engine opened from More engines", () => {
  it("keeps its install command and Node.js note out of Simple, and the button opens Advanced where they show", async () => {
    setSettingsMode("simple");
    mount(createElement(EngineSetup, { instance: missing, commandInAdvanced: true }));
    expect(text()).toContain("Fixture Engine");
    expect(text()).not.toContain(COMMAND);
    expect(text()).not.toContain("Requires Node.js");
    const button = document.querySelector<HTMLButtonElement>("[data-show-install-command]");
    expect(button?.textContent).toBe("Show how to install it");
    await act(async () => { button!.click(); });
    expect(settingsMode()).toBe("advanced");
    expect(text()).toContain(COMMAND);
    expect(text()).toContain("Requires Node.js");
  });

  it("shows the command up front everywhere else", () => {
    setSettingsMode("simple");
    mount(createElement(EngineSetup, { instance: missing }));
    expect(text()).toContain(COMMAND);
    expect(document.querySelector("[data-show-install-command]")).toBeNull();
  });
});
