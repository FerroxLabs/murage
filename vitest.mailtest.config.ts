import { defineConfig } from "vitest/config";
import base from "./vite.config.ts";

export default defineConfig({
  cacheDir: "/tmp/mailtest-vite",
  test: {
    testTimeout: typeof base === "function" ? undefined : base.test?.testTimeout,
    include: ["server/mailbox/testing/mail-server.test.ts"],
  },
});
