// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 03-A4: the reflection Claude child keeps the Flux privacy headers its route set.
import { expect, it } from "vitest";
import { claudeAllowlistEnv } from "./headless-text-only.ts";
import type { TempRoot } from "../memory/pip-transport.ts";

it("passes ANTHROPIC_CUSTOM_HEADERS through to the reflection child with the Flux credential", () => {
  const temp = { root: "/tmp/r", home: "/tmp/r/h" } as unknown as TempRoot;
  const headers = "x-flux-memory-capture: off\nx-flux-memory-inject: off";
  const env = claudeAllowlistEnv(
    { PATH: "/usr/bin", ANTHROPIC_BASE_URL: "https://api.fluxrouter.ai", ANTHROPIC_API_KEY: "k", ANTHROPIC_CUSTOM_HEADERS: headers } as NodeJS.ProcessEnv,
    temp,
    1000,
  );
  expect(env.ANTHROPIC_BASE_URL).toBe("https://api.fluxrouter.ai");
  expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(headers);
});
