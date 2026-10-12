// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every file the server starts as a process or a worker thread is resolved in one place, built into the package and required
// by the packaging check.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SERVER_ROOT, SPAWNED_PROXIES } from "./proxy-paths.ts";

const repo = join(SERVER_ROOT, "..");

it("names the engine-history worker, which exists in the source tree", () => {
  expect(SPAWNED_PROXIES.engineHistoryWorker).toBe(join(SERVER_ROOT, "engine-history-worker.ts"));
  expect(existsSync(SPAWNED_PROXIES.engineHistoryWorker)).toBe(true);
});

it("builds the engine-history worker into the package and requires it there", () => {
  expect(readFileSync(join(repo, "scripts/bundle-server.mjs"), "utf8")).toContain('"engine-history-worker.ts"');
  expect(readFileSync(join(repo, "scripts/after-pack.mjs"), "utf8")).toContain('path.join(server, "engine-history-worker.js")');
});

it("resolves a worker path with no backslash or drive assumption (the same join on Windows)", () => {
  expect(SPAWNED_PROXIES.engineHistoryWorker.startsWith(SERVER_ROOT)).toBe(true);
  expect(SPAWNED_PROXIES.engineHistoryWorker).not.toMatch(/\.\.[\\/]/);
});
