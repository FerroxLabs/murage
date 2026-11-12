// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Socket-free mock tests for L5b-4. No server, database, provider, or app data is opened.
// CI uses the ordinary root config and its isolated-home setup.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: fileURLToPath(new URL("../", import.meta.url)),
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
  test: {
    environment: "node",
    fileParallelism: false,
    include: [
      "src/components/DelegationPack.test.ts",
      "src/components/DelegationPack.dom.test.ts",
      "server/delegation-pack-routes.test.ts",
      "scripts/delegation-pack-inventory.test.mjs",
    ],
  },
});
