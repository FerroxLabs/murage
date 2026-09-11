import { defineConfig } from "@playwright/test";
// Screenshots and traces land in the lane's evidence folder when
// MURAGE_E2E_OUTPUT is set (docs/plans/0152-LOCAL-MODELS-PROOF.md), else
// beside the other human-spec results.
export default defineConfig({ testDir: ".", testMatch: "local-models.human.spec.ts", workers: 1, retries: 0, timeout: 90_000,
  expect: { timeout: 10_000 }, reporter: "list", outputDir: process.env.MURAGE_E2E_OUTPUT || "../../.planning/0152-local-models-browser-results",
  use: { headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" } });
