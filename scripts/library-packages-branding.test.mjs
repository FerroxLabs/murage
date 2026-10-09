// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The vendored team packages are MIT (licence text ships under licenses/
// openmausbot-teams). The packages themselves must not name or link the
// source product, and the vendoring step strips it again on a re-vendor.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sanitizeTeamPackage } from "./team-package-sanitize.mjs";

const dir = new URL("../library/packages/", import.meta.url);

describe("shipped library packages", () => {
  for (const file of readdirSync(dir)) {
    it(`${file} carries no source-product name or link`, () => {
      expect(readFileSync(new URL(file, dir), "utf8")).not.toMatch(/openmausbot\.com|mausbot|supamaus/i);
    });
  }
  it("the vendoring step removes the link and the names", () => {
    const out = sanitizeTeamPackage("author:\n  name: OpenMausBot\n  url: https://openmausbot.com\nlicense: MIT\nOpenMausBot can install it. SupaMaus MausBot\n");
    expect(out).not.toMatch(/openmausbot|mausbot|supamaus/i);
    expect(out).toContain("license: MIT");
  });
});
