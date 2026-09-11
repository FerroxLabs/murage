// Where a human spec's screenshots, traces and reports land. Every per-spec
// Playwright config used to default its outputDir to a path under .planning/
// (or test-results/) inside the checkout, so a run left evidence in the
// repository and two lanes sharing a tree overwrote each other's (CLAC2 made
// claude-accounts refuse; CLAC3 swept the rest). A lane always sets
// MURAGE_E2E_DATA_DIR, the same directory its harness data lives in; there is
// no in-repo fallback.
//
// Playwright deletes outputDir before a run, so an evidence directory is a
// wipe target like the data dir itself. Both are admitted by the same rules
// (lane-data-dir.ts / server/testing/safe-wipe.mjs): under the OS temp dir or
// carrying a *scratch*, *evidence* or *.e2e* segment, never a home or a
// Murage data directory. A spec's own override variable is held to the same
// rules, so MURAGE_E2E_OUTPUT=~ fails here instead of at Playwright's rm.
import { join, resolve } from "node:path";

import { assertSafeToWipe } from "../../server/testing/safe-wipe.mjs";
import { laneDataDir } from "./lane-data-dir";

/** The lane's evidence root: MURAGE_E2E_DATA_DIR, required and admitted. */
export function evidenceRoot(name: string): string {
  return laneDataDir(`${name} browser evidence is never written inside the repository`);
}

/** `<MURAGE_E2E_DATA_DIR>/<name>-results`, or `override` when a spec's own
 * documented variable (MURAGE_E2E_OUTPUT, MURAGE_E2E_EVIDENCE_DIR, ...) names
 * somewhere else. The override is honoured only when set and non-empty, and
 * only when it is a place Playwright may wipe. */
export function evidenceDir(name: string, override?: string): string {
  if (override) return assertSafeToWipe(resolve(override), { checkLeases: false }).path;
  return join(evidenceRoot(name), `${name}-results`);
}
