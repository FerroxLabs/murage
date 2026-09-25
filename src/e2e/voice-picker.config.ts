// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
export default defineConfig({ testDir: ".", testMatch: "voice-picker.human.spec.ts", workers: 1, retries: 0, timeout: 60_000,
  expect: { timeout: 7_000 }, reporter: "list", outputDir: evidenceDir("voice-picker"), use: { headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" } });
