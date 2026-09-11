import { defineConfig } from "@playwright/test";
import { evidenceDir } from "./evidence";
// Screenshots and traces land in the lane's evidence folder when
// MURAGE_E2E_OUTPUT is set (docs/plans/0152-LOCAL-MODELS-PROOF.md), else
// under MURAGE_E2E_DATA_DIR beside the other human-spec results.
export default defineConfig({ testDir: ".", testMatch: "local-models.human.spec.ts", workers: 1, retries: 0, timeout: 90_000,
  expect: { timeout: 10_000 }, reporter: "list", outputDir: evidenceDir("local-models", process.env.MURAGE_E2E_OUTPUT),
  use: { headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" } });
