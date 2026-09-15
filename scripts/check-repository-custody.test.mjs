import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { custodyViolations } from "./check-repository-custody.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RECEIPT = "native/backup-age/real-main-qualification/native-receipts/journey.json";

test("rejects tracked private records, including files forced past ignore rules", () => {
  const paths = [".planning/STATE.md", ".planning/run/trace.zip", ".ijfw/sessions/local.jsonl", "HANDOFF.md",
    "HANDOFF-PRIVATE.md", "B05-DIAGNOSTICS-EXECUTION.md", "docs/plans/HANDOFF-ASTRA.md", ".ijfw\\logs\\run.log",
    "cloudflare/composio-broker/.ijfw/session.json", "ijfw/memory/project-journal.md", "docs/plans/next-session/PLAN.md",
    "apps/docs/.planning/STATE.md", "server/HANDOFF.md", "docs/verification/B05-DIAG-EXECUTION.md", "apps\\docs\\.planning\\run.log",
    "native/backup-age/real-main-qualification/preflight-receipts/preflight-result-r2.json",
    "native/backup-age/real-main-qualification/native-receipts/journey-console.log.r1",
    "native\\backup-age\\real-main-qualification\\native-receipts\\run-3\\desktop-crashes.log"];
  expect(custodyViolations(paths)).toEqual(paths);
});

test("retains real product handoff features, skills and reusable fixtures", () => {
  expect(custodyViolations(["AGENTS.md", "docs/verification/README.md", "docs/plans/0153-RELEASE-NOTES.md", "scripts/native-fuigo-production-closeout.mjs",
    "electron/fixtures/updater-handoff.cjs", "electron/updater-handoff.electron.test.mjs",
    "skills-library/cs-handoff-document/SKILL.md", "skills-library/smith-agent-handoff/manifest.json",
    "src/components/PlanningPanel.tsx", "docs/verification/HANDOFF-GUIDE.txt", "server/execution.md",
    "native/backup-age/real-main-qualification/CONTRACT.md", "native/backup-age/real-main-qualification/preflight.ps1",
    "native/backup-age/real-main-qualification/verify.mjs", "native/backup-age/real-main-qualification/stage-manifest.ps1"])).toEqual([]);
});

test("the index gate fails on a synthetic record staged in a copy of the index", () => {
  // A copied index keeps the real checkout's staging untouched.
  const dir = mkdtempSync(join(tmpdir(), "murage-custody-index-"));
  try {
    const index = join(dir, "index");
    copyFileSync(resolve(ROOT, execFileSync("git", ["rev-parse", "--git-path", "index"], { cwd: ROOT, encoding: "utf8" }).trim()), index);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    const blob = execFileSync("git", ["hash-object", "--stdin"], { cwd: ROOT, input: "synthetic\n", encoding: "utf8" }).trim();
    const gate = () => spawnSync(process.execPath, ["scripts/check-repository-custody.mjs"], { cwd: ROOT, env, encoding: "utf8" });
    expect(gate().status).toBe(0);
    for (const path of ["apps/docs/.planning/STATE.md", RECEIPT]) {
      execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { cwd: ROOT, env });
    }
    const result = gate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("apps/docs/.planning/STATE.md");
    expect(result.stderr).toContain(RECEIPT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
