// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { withServerPlatform } from "./registry.ts";

describe("the install descriptor names the server's OS (item 167)", () => {
  const install = { command: { darwin: "brew install x", win32: "winget install x" }, docsUrl: "https://example.com" };
  it("sets the platform of the computer running the server", () => {
    expect(withServerPlatform(install, "win32")).toEqual({ ...install, platform: "win32" });
    expect(withServerPlatform(install, "linux")?.platform).toBe("linux");
  });
  it("leaves an engine with no install, and an unknown OS, alone", () => {
    expect(withServerPlatform(undefined, "darwin")).toBeUndefined();
    expect(withServerPlatform(install, "freebsd")).toEqual(install);
  });
  it("does not change the driver's own record", () => {
    withServerPlatform(install, "darwin");
    expect(install).not.toHaveProperty("platform");
  });
});
