// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { versionFromProbe } from "./core.ts";

// Upstream OpenMausBot #1524: Hermes prints its `--version` banner to stderr.
describe("versionFromProbe", () => {
  it("prefers stdout", () => {
    expect(versionFromProbe("codex-cli 0.154.0\n", "warning: noise")).toBe("codex-cli 0.154.0");
  });

  it("falls back to the first stderr line when stdout is empty (Hermes prints its banner there)", () => {
    const banner = "Hermes Agent v0.19.1 (2026.7.30) · upstream 0b48ae8d\nInstall directory: /Users/x/.hermes/hermes-agent\n";
    expect(versionFromProbe("", banner)).toBe("Hermes Agent v0.19.1 (2026.7.30) · upstream 0b48ae8d");
  });

  it("takes only the first line whatever the line ending", () => {
    expect(versionFromProbe("", "v1.2.3\r\nInstall directory: /x\r\n")).toBe("v1.2.3");
    expect(versionFromProbe("", "v1.2.3\rInstall directory: /x")).toBe("v1.2.3");
  });

  it("is empty when both streams are empty", () => {
    expect(versionFromProbe("", "")).toBe("");
    expect(versionFromProbe(undefined, undefined)).toBe("");
    expect(versionFromProbe("  \n", "\n")).toBe("");
  });
});
