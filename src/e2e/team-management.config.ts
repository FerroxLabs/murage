// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({ testDir: ".", testMatch: "team-management.human.spec.ts", workers: 1, retries: 0, timeout: 90_000,
  expect: { timeout: 8_000 }, reporter: "list", outputDir: evidenceDir("team-management"), use: { headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" } });
