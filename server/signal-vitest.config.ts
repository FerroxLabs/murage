// SPDX-License-Identifier: AGPL-3.0-or-later
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// B8's injected fixtures need neither the global fake HTTP server nor any port.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  test: { include: ["server/signal-api.test.ts", "src/components/SignalSettings.test.ts"], fileParallelism: false },
});
