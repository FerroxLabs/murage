// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("S8R verification evidence uses portable artifact references", () => {
  const evidence = readFileSync(new URL("../docs/verification/notify-s8r-integration-1019.md", import.meta.url), "utf8");
  expect(evidence.match(/[/]root[/][^\s`]+/g) ?? []).toEqual([]);
  const rawLogs = [...evidence.matchAll(/Raw log: ([^\n]+)/g)];
  expect(rawLogs.length).toBeGreaterThan(0);
  for (const [, reference] of rawLogs) expect(reference).toMatch(/^`out\/[^`]+\.log`\.?$/);
});
