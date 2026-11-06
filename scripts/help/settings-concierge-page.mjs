#!/usr/bin/env node
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SETTINGS-UX-1011 S9 (every-release checklist): writes the "every setting, its path, its state line, its address"
// Help page (apps/docs/content/docs/features/every-setting.mdx) from the Settings index, then rebuilds the help index
// so the concierge can quote it. The page is made by src/lib/settings-concierge.ts, which reads the app's own index and
// copy, so this runs it through the test runner that already resolves the app's modules.
//
//   node scripts/help/settings-concierge-page.mjs           write the page and the help index
//   node scripts/help/settings-concierge-page.mjs --check   fail when either is stale
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const check = process.argv.includes("--check");
const vitest = join(root, "node_modules", "vitest", "vitest.mjs");
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });

// The key carries the TEST word: the test setup strips every other MURAGE_ key (server/testing/murage-env.mjs), so a
// plain MURAGE_WRITE_* never reached the test and the page was not written.
run([vitest, "run", "src/lib/settings-concierge.test.ts"], check ? {} : { MURAGE_TEST_WRITE_CONCIERGE: "1" });
run([join(root, "scripts", "build-help-index.mjs"), ...(check ? ["--check"] : [])]);
