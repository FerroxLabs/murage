// SPDX-License-Identifier: AGPL-3.0-or-later
// The WAL tests' Vitest config: the repo config plus the test-only source transform (enforce "pre") and forked workers.
import { defineConfig } from "vitest/config";
import base from "./vite.config.ts";

// The include list REPLACES the base list (mergeConfig would append to it and run the whole repo under the transform).
const wal = ["server/wal-maintenance.test.ts", "server/wal-park-guard.test.ts", "server/wal-transform.test.ts", "server/wal-seam-guard.test.ts", "server/engine-exclusion-meter-copy.test.ts", "server/engine-exclusion-meter-native.test.ts", "server/wal-d13.test.ts", "server/wal-review-credit.test.ts", "server/admission-ledger-d6.test.ts", "server/admission-lock-dead-holder.test.ts", "server/admission-lock-timeout-surface.test.ts", "server/admission-minute-boundary.test.ts"];
const cfg = typeof base === "function" ? null : base;
export default defineConfig({ ...(cfg as object), test: { ...(cfg?.test ?? {}), pool: "forks", include: wal } });
