// SPDX-License-Identifier: AGPL-3.0-or-later
// The P3 behavioural witness runs the production worker source untransformed: no test seam is restored, so any eval of workerData is the production code's own.
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["server/wal-seam-eval-behaviour.test.ts", "server/wal-seam-spawn-behaviour.test.ts"], environment: "node", pool: "forks", testTimeout: 45_000, hookTimeout: 30_000 } });
