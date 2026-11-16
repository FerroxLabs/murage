// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["server/channels/signal/{adapters,access,rpc,process-host,service}.test.ts", "scripts/release-workflows.test.mjs"], fileParallelism: false } });
