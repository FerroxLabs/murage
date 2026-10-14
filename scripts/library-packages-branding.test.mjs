// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Every package in library/packages is authored by Ferrox Labs. None may name
// or link a third-party source product or carry its authorship.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL("../library/packages/", import.meta.url);
const FORBIDDEN = /openmausbot|openmausbot\.com|mausbot|supamaus|botmrr|botmrr\.io/i;

describe("shipped library packages", () => {
  for (const file of readdirSync(dir)) {
    it(`${file} carries no third-party source-product name, link or authorship`, () => {
      expect(readFileSync(new URL(file, dir), "utf8")).not.toMatch(FORBIDDEN);
    });
  }
  it("the packages directory holds only json packages", () => {
    expect(readdirSync(dir).filter((file) => !file.endsWith(".json"))).toEqual([]);
  });
});
