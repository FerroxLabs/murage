// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureFlagConfig } from "@/lib/feature-flags";
import { WorkspaceFeatureRow } from "./SettingsModal";
import type { Switch } from "./SettingsPrimitives";

const fixture = vi.hoisted(() => ({
  config: {} as FeatureFlagConfig | null,
  dispatch: vi.fn(),
  api: vi.fn(),
  control: undefined as ComponentProps<typeof Switch> | undefined,
}));

vi.mock("@/state/store", async (original) => ({
  ...(await original<typeof import("@/state/store")>()),
  useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }),
  api: fixture.api,
}));
vi.mock("./SettingsPrimitives", async (original) => {
  const primitives = await original<typeof import("./SettingsPrimitives")>();
  return {
    ...primitives,
    Switch: (props: ComponentProps<typeof Switch>) => {
      fixture.control = props;
      return createElement(primitives.Switch, props);
    },
  };
});

beforeEach(() => {
  fixture.config = {};
  fixture.control = undefined;
  fixture.api.mockReset();
  fixture.dispatch.mockReset();
  vi.stubGlobal("window", { muragebox: { browser: {} } });
});
afterEach(() => vi.unstubAllGlobals());

describe.each([
  ["browser", "Built-in browser", "Enable the built-in browser"],
  ["skillRecorder", "Teach a skill", "Show Teach a skill"],
] as const)("%s workspace setting", (feature, title, label) => {
  it("renders on with no saved switch and persists only its explicit opt-out", async () => {
    const saved = { features: { [feature]: false } };
    fixture.api.mockResolvedValue(saved);
    const html = renderToStaticMarkup(createElement(WorkspaceFeatureRow, { feature }));
    expect(html).toContain(title);
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain('aria-checked="true"');
    expect(html).not.toContain("Experimental");
    fixture.control!.onClick!({} as never);
    await expect.poll(() => fixture.dispatch.mock.calls.length).toBe(1);
    expect(fixture.api).toHaveBeenCalledOnce();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PATCH", body: JSON.stringify({ features: { [feature]: false } }) });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: saved });
  });

  it("renders an explicit off and lets the owner turn it back on", async () => {
    fixture.config = { features: { [feature]: false } };
    fixture.api.mockResolvedValue({ features: { [feature]: true } });
    expect(renderToStaticMarkup(createElement(WorkspaceFeatureRow, { feature }))).toContain('aria-checked="false"');
    fixture.control!.onClick!({} as never);
    await expect.poll(() => fixture.dispatch.mock.calls.length).toBe(1);
    expect(fixture.api).toHaveBeenCalledOnce();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PATCH", body: JSON.stringify({ features: { [feature]: true } }) });
  });
});

it("keeps browser re-enabling behind the desktop browser bridge", () => {
  vi.stubGlobal("window", {});
  fixture.config = { features: { browser: false } };
  const html = renderToStaticMarkup(createElement(WorkspaceFeatureRow, { feature: "browser" }));
  expect(html).toContain("Needs the Murage desktop app.");
  expect(fixture.control!.disabled).toBe(true);
  expect(fixture.api).not.toHaveBeenCalled();
});

it("waits for the saved switches before the row can save", () => {
  fixture.config = null;
  for (const feature of ["browser", "skillRecorder"] as const) {
    renderToStaticMarkup(createElement(WorkspaceFeatureRow, { feature }));
    expect(fixture.control!.disabled, feature).toBe(true);
  }
});

describe("the row words in every language", () => {
  const keys = [
    "settings.workspaceFeature.browser.note", "settings.workspaceFeature.browser.desktopOnly", "settings.workspaceFeature.browser.aria",
    "settings.workspaceFeature.recorder.note", "settings.workspaceFeature.recorder.aria", "settings.workspaceFeature.saveError",
  ];
  const pack = (code: string) => JSON.parse(readFileSync(new URL(`../locales/${code}.json`, import.meta.url), "utf8")) as Record<string, string>;
  const en = pack("en");
  const hashes = JSON.parse(readFileSync(new URL("../locales/source-hashes.json", import.meta.url), "utf8")) as { locales: Record<string, Record<string, string>> };

  for (const code of ["de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
    it(`${code} carries every key, translated, against the current English`, () => {
      const words = pack(code);
      for (const key of keys) {
        expect(words[key], `${code} ${key}`).toBeTruthy();
        expect(words[key], `${code} ${key}`).not.toBe(en[key]);
        expect(hashes.locales[code]![key], `${code} ${key}`).toBe(createHash("sha256").update(en[key]!).digest("hex"));
      }
    });
  }

  it("names the Settings path in Hindi", () => {
    expect(pack("hi")["settings.bot.browser.featureOff"]).not.toContain("App Settings");
  });

  it("leaves no English in the row", () => {
    const source = readFileSync(new URL("./SettingsModal.tsx", import.meta.url), "utf8");
    const row = source.slice(source.indexOf("export function WorkspaceFeatureRow"), source.indexOf("export function BrowserProfilesRow"));
    for (const key of keys) expect(row).toContain(`"${key}"`);
    expect(row).not.toMatch(/"Needs the Murage desktop app\."|"Show Teach a skill"|"Enable the built-in browser"|Every change waits for your review|"Could not save this setting\."/);
  });
});
