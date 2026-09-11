// Where a human spec's screenshots, traces and reports land. Every per-spec
// Playwright config used to default its outputDir to a path under .planning/
// (or test-results/) inside the checkout, so a run left evidence in the
// repository and two lanes sharing a tree overwrote each other's (CLAC2 made
// claude-accounts refuse; CLAC3 swept the rest). A lane always sets
// MURAGE_E2E_DATA_DIR, the same directory its harness data lives in; there is
// no in-repo fallback.
import { join } from "node:path";

/** The lane's evidence root: MURAGE_E2E_DATA_DIR, required. */
export function evidenceRoot(name: string): string {
  const dataDir = process.env.MURAGE_E2E_DATA_DIR;
  if (!dataDir) throw new Error(`MURAGE_E2E_DATA_DIR is required — ${name} browser evidence is never written inside the repository.`);
  return dataDir;
}

/** `<MURAGE_E2E_DATA_DIR>/<name>-results`, or `override` when a spec's own
 * documented variable (MURAGE_E2E_OUTPUT, MURAGE_E2E_EVIDENCE_DIR, ...) names
 * somewhere else. The override is honoured only when set and non-empty. */
export function evidenceDir(name: string, override?: string): string {
  return override || join(evidenceRoot(name), `${name}-results`);
}
