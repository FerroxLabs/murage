// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseStoredConfig, parseConfigPatch } from "./config.ts";
it("preserves optional board and digest booleans in stored config and patches", () => {
  for (const value of [true, false]) {
    const features = { projectsBoard: value, projectsDigest: value };
    expect(parseStoredConfig({ features }).features).toMatchObject(features);
    expect(parseConfigPatch({ features }).features).toMatchObject(features);
  }
  expect(parseStoredConfig({ features: {} }).features?.projectsBoard).toBeUndefined();
  expect(() => parseConfigPatch({ features: { projectsBoard: "yes" } })).toThrow();
});
it("projects both defaults on and guards the digest scheduler during restore", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  for (const key of ["projectsBoard", "projectsDigest"]) expect(source).toContain(`${key}: cfg.features?.${key} !== false`);
  expect(source).toContain("if (!backupRestartAdmission.held()) runProjectDigests(");
  expect(source).toContain("setInterval(digestTick, 15 * 60 * 1000)");
  expect(source).toContain("queueMicrotask(digestTick)");
});
