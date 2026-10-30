// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.12 phone preview switches (Settings > Phone and other devices > Preview). Each switch writes one body through
// PATCH /api/config; the write must land as exactly that flag and keep every other feature flag on disk.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR, loadConfig, parseConfigPatch, saveConfig } from "./config.ts";

describe("phone preview switches: the PATCH bodies", () => {
  const file = join(DATA_DIR, "config.json");
  const onDisk = () => JSON.parse(readFileSync(file, "utf8")).features as Record<string, unknown>;
  beforeEach(() => {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify({ features: { skillRecorder: false, showToolCalls: true, projectsBoard: true } }));
  });
  afterEach(() => { rmSync(file, { force: true }); });

  for (const [flag, other] of [["phoneTools", "phoneShareAsk"], ["phoneShareAsk", "phoneTools"]] as const) {
    it(`{features:{${flag}}} on then off writes only ${flag} and keeps every other flag`, () => {
      saveConfig(parseConfigPatch({ features: { [other]: true } }));
      saveConfig(parseConfigPatch({ features: { [flag]: true } }));
      expect(onDisk()).toEqual({ skillRecorder: false, showToolCalls: true, projectsBoard: true, [other]: true, [flag]: true });
      expect(loadConfig().features?.[flag]).toBe(true);
      saveConfig(parseConfigPatch({ features: { [flag]: false } }));
      expect(onDisk()).toEqual({ skillRecorder: false, showToolCalls: true, projectsBoard: true, [other]: true, [flag]: false });
      expect(loadConfig().features?.[other]).toBe(true);
    });
  }

  it("refuses a value that is not a boolean, and writes nothing", () => {
    expect(() => parseConfigPatch({ features: { phoneTools: "yes" } })).toThrow();
    expect(() => parseConfigPatch({ features: { phoneShareAsk: 1 } })).toThrow();
    expect(onDisk()).toEqual({ skillRecorder: false, showToolCalls: true, projectsBoard: true });
  });

  it("defaults stay off: a fresh config has neither flag on", () => {
    rmSync(file, { force: true });
    const features = loadConfig().features ?? {};
    expect(features.phoneTools === true).toBe(false);
    expect(features.phoneShareAsk === true).toBe(false);
  });
});
