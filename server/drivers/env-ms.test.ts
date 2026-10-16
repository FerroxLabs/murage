// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { boundedEnvMs, MAX_TIMER_MS } from "./env-ms.ts";

it("keeps a usable value and falls back for the rest", () => {
  expect(boundedEnvMs("90000", 5)).toBe(90_000);
  expect(boundedEnvMs(String(MAX_TIMER_MS), 5)).toBe(MAX_TIMER_MS);
  for (const bad of [undefined, "", "abc", "0", "-5", "Infinity", String(MAX_TIMER_MS + 1), "1e400"]) expect(boundedEnvMs(bad, 5)).toBe(5);
});

it("is what both engine idle settings read", () => {
  const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
  expect(read("./claude.ts")).toContain('boundedEnvMs(process.env.MURAGE_CLAUDE_SESSION_IDLE_MS, 15 * 60_000)');
  expect(read("./acp/core.ts")).toContain("boundedEnvMs(process.env[key], fallback)");
});
