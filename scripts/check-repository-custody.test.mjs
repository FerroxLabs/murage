import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { custodyViolations, privateContentPattern } from "./check-repository-custody.mjs";

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

// The private forms are assembled at run time so this file never matches the
// rule it tests.
const HOME = "/Users/" + ["sean", "donahoe"].join("");
const PRIVATE_LINES = [
  `const LONG_PATH = "${HOME}/Library/Application Support/murage/x.json";`,
  "ls ~/." + "sable/ops/numbers/",
  "/tmp/" + "murage-qualification-" + "private-20260914/evidence/receipt.json",
  "const DEFAULT_SOURCE = \"/Volumes/" + "Mando/wayland/app\";",
  "/volumes/" + "mando/waylandbots",
  "ssh " + "sean." + "imsc.example",
];

test("rejects a maintainer's machine paths and private folder names in file content", () => {
  for (const line of PRIVATE_LINES) expect(privateContentPattern.test(line), line).toBe(true);
});

test("keeps the neutral examples that exercise the same product rules", () => {
  for (const line of ["ls ~/.acme/ops/numbers/", "Use ~/.old-assistant/scratch for older work", "/Volumes/Work/picked project",
    "/Users/exampleuser/Library/Application Support/murage/workspaces/calendars.json", "disposable/cache", "maintainer: Ferrox Labs"]) {
    expect(privateContentPattern.test(line), line).toBe(false);
  }
});

test("the index gate fails on a private path staged in a copy of the index, and names only the location", () => {
  // A copied index and a private object directory: the real checkout's staging
  // and object store are untouched; its objects are read as alternates.
  const dir = mkdtempSync(join(tmpdir(), "murage-custody-content-"));
  try {
    const index = join(dir, "index"), objects = join(dir, "objects");
    mkdirSync(objects);
    copyFileSync(resolve(ROOT, execFileSync("git", ["rev-parse", "--git-path", "index"], { cwd: ROOT, encoding: "utf8" }).trim()), index);
    const env = { ...process.env, GIT_INDEX_FILE: index, GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: resolve(ROOT, execFileSync("git", ["rev-parse", "--git-path", "objects"], { cwd: ROOT, encoding: "utf8" }).trim()) };
    const gate = () => spawnSync(process.execPath, ["scripts/check-repository-custody.mjs"], { cwd: ROOT, env, encoding: "utf8" });
    expect(gate().status).toBe(0);
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: ROOT, env, input: `first line\n${PRIVATE_LINES[0]}\n${PRIVATE_LINES[4]}\n`, encoding: "utf8" }).trim();
    execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},src/e2e/synthetic-private.spec.ts`], { cwd: ROOT, env });
    const result = gate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/e2e/synthetic-private.spec.ts:2");
    expect(result.stderr).toContain("src/e2e/synthetic-private.spec.ts:3"); // lower-cased volume path
    expect(result.stderr).not.toContain(HOME);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
