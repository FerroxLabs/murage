// Producer owner: sc-safety (verification source layout). Consumer owner: lane runner (external evidence).
import { expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
const root = process.env.SC_ARTIFACT_TEST_ROOT ?? process.cwd();
it.each(["assertion-continuity.mjs", "assertion-reporter.mjs", "mutants.json", "run-mutants.mjs", "run-mutant-shards.mjs", "qualify-claude-s2.mjs"])("ARTIFACT code is under scripts/verification/sc-safety: %s", name => {
  expect(existsSync(resolve(root, "scripts/verification/sc-safety", name))).toBe(true);
});
it.each(["DONE", "PRESERVATION.json", "SINKS-REVIEW.tsv", "OVERRIDES.tsv", "FIXTURE-REVIEW.tsv", "DEEPER.tsv", "RULINGS"])("ARTIFACT generated evidence is outside the worktree: %s", name => {
  expect(existsSync(resolve(root, "docs/verification/sc-safety-r4", name))).toBe(false);
});
