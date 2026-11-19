// SPDX-License-Identifier: AGPL-3.0-or-later
// The WAL recovery behaviour run: the repo config plus the test-only source transform, forked workers, only the recovery witness file.
import { defineConfig } from "vitest/config";
import base from "./vite.config.ts";

const cfg = typeof base === "function" ? null : base;
export default defineConfig({ ...(cfg as object), test: { ...(cfg?.test ?? {}), pool: "forks", include: ["server/wal-recovery-behaviour.test.ts"] } });
