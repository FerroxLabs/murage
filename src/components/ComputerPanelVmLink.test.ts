// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Local VM settings button once wrote a sessionStorage key nothing read,
// so it opened whichever Settings section was used last.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./ComputerPanel.tsx", import.meta.url)), "utf8");
const body = /const openVmSettings = \(\) => \{([^]*?)\n  \};/.exec(source)?.[1] ?? "";

describe("Local VM settings button", () => {
  it("opens Settings at the Local VM section", () => {
    expect(body).toContain('section: "computer"');
    expect(body).not.toContain("sessionStorage");
  });
});
