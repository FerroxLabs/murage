// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { copyVersionText } from "./about-version";

describe("copyVersionText", () => {
  it("names the version, platform and architecture", () => {
    expect(copyVersionText("1.0.2", "darwin", "arm64")).toBe("Murage 1.0.2 (darwin/arm64)");
  });
  it("leaves out what the host does not say", () => {
    expect(copyVersionText("1.0.2")).toBe("Murage 1.0.2");
    expect(copyVersionText("1.0.2", "linux", null)).toBe("Murage 1.0.2 (linux)");
    expect(copyVersionText("1.0.2", " ", "")).toBe("Murage 1.0.2");
  });
});
