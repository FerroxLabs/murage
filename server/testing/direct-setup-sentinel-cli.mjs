#!/usr/bin/env node
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture CLI owner: r7orph-fx3; reservation/Stop contract owner: MAIN G17.
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
const gate = fileURLToPath(new URL("./version-release", import.meta.url));
if (process.argv.includes("--version") && existsSync(gate + ".armed")) {
  writeFileSync(gate + ".waiting", "");
  while (!existsSync(gate)) await setTimeout(10);
}
await import("./fake-claude-cli.ts");
