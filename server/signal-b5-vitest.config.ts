// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["server/channels/signal/{g0-scrub,unlink,runtime-pin.schema,rpc,adapters,service,process-host,access,transport}.test.ts"], fileParallelism: false } });
