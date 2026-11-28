import { defineConfig } from "vitest/config";

// Own config: tests/settings-v10 sits outside the base include list (vite.config.ts is not this lane's file).
export default defineConfig({ test: { include: ["tests/settings-v10/**/*.test.ts"], environment: "node", pool: "forks", testTimeout: 120_000, hookTimeout: 60_000 } });
