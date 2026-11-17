// SPDX-License-Identifier: AGPL-3.0-or-later
// The WAL seam guard reads the production files from disk and never imports them. This config has no setup file and no source transform, so a
// production-file mutant makes the guard report a violation (an assertion) instead of breaking the shared test setup before any test runs.
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["server/wal-seam-guard.test.ts", "server/wal-transform-order.test.ts"], environment: "node", pool: "forks" } });
