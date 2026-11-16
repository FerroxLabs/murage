// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test("desktop launch and recovery preserve the one-time index contract", () => {
  const result = spawnSync(process.execPath, ["--test", "electron/data-owner-integration.node-test.mjs"], { encoding: "utf8", timeout: 120_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 130_000);

// Keep adjacent probe and recovery contracts available through the scoped fixture runner.
for (const file of ["server-boot-probe", "memory-upgrade-status", "installation-recovery-window"]) {
  test(`boot and recovery neighbour: ${file}`, () => {
    const result = spawnSync(process.execPath, ["--test", `electron/${file}.node-test.mjs`], { encoding: "utf8", timeout: 120_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }, 130_000);
}
