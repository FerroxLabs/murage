import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { candidatePaths, custodyViolations, privateContentPattern, retiredEvidencePath } from "./check-repository-custody.mjs";
import { gitFixture } from "../server/testing/git-fixture.mjs";
import { removeTempDirSync } from "../server/testing/cleanup.ts";

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

const EVIDENCE_ROOTS = ["evidence", "lane-evidence", "proof", "docs/verification/c2-rule-evidence", "scripts/example/evidence", "lanes/example/shots"];

test("the checkout tracks no historical run artifacts in the retired roots", () => {
  expect(candidatePaths(ROOT).filter(retiredEvidencePath)).toEqual([]);
});

test("normal staging ignores new artifacts in the retired roots", () => {
  const fixture = gitFixture([".gitignore"]);
  try {
    for (const root of EVIDENCE_ROOTS) {
      mkdirSync(join(fixture.root, root), { recursive: true });
      writeFileSync(join(fixture.root, root, "receipt.json"), "{}\n");
    }
    fixture.git("add", "--all");
    expect(fixture.git("ls-files").trim()).toBe(".gitignore");
  } finally {
    fixture.dispose();
  }
});

test.each([
  { roots: EVIDENCE_ROOTS },
  { roots: ["Evidence", "Lane-Evidence", "Proof", "docs/verification/C2-Rule-Evidence", "scripts/example/Evidence", "LANES/example/Shots"] },
])("the custody command rejects force-staged retired roots: $roots", ({ roots }) => {
  const fixture = gitFixture(["scripts/check-repository-custody.mjs"]);
  try {
    for (const root of roots) {
      mkdirSync(join(fixture.root, root), { recursive: true });
      writeFileSync(join(fixture.root, root, "receipt.json"), "{}\n");
    }
    fixture.git("add", "--force", "--", ...roots);
    const result = spawnSync(process.execPath, ["scripts/check-repository-custody.mjs"], {
      cwd: fixture.root, env: fixture.env, encoding: "utf8",
    });
    expect(result.status).toBe(1);
    for (const root of roots) expect(result.stderr).toContain(root + "/receipt.json");
  } finally {
    fixture.dispose();
  }
});

test("qualification output stays outside each checkout, when an explicit directory is supplied", async () => {
  const { assertExternalEvidencePath, evidencePath } = await import("./evidence-path.mjs");
  const fixture = gitFixture([".gitignore"]);
  const output = mkdtempSync(join(tmpdir(), "murage-custody-output-"));
  try {
    expect(() => evidencePath("receipt.json", fixture.root)).toThrow("outside");
    expect(() => evidencePath("../receipt.json", output)).toThrow("relative path");
    expect(evidencePath("run/receipt.json", output)).toBe(join(assertExternalEvidencePath(output), "run", "receipt.json"));
  } finally {
    fixture.dispose();
    removeTempDirSync(output);
  }
});

test("the answer-key harness can execute its relocated fake engine", () => {
  const source = readFileSync(join(ROOT, "server/testing/no-limits-answer-key-fixture.mjs"), "utf8");
  const cli = /const cli=resolve\('([^']+)'\)/.exec(source)?.[1];
  expect(cli).toBeDefined();
  const result = process.platform === "win32"
    ? spawnSync(process.execPath, [cli, "--version"], { cwd: ROOT, encoding: "utf8" })
    : spawnSync("./" + cli, ["--version"], { cwd: ROOT, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
});

test.skipIf(process.platform !== "linux")("qualification overrides are refused before writing to a checkout", () => {
  const commands = [
    ["scripts/ask-regress/fix-round.py", [], "ASK_FIX_EVIDENCE_ROOT"],
    ["scripts/ask-regress/full-shard.py", ["1"], "ASK_FULL_EVIDENCE_ROOT"],
    ["server/testing/search-index-amend-mutants.py", [], "MUTANT_OUTPUT"],
    ["server/testing/english-inventory.py", ["--output"], null],
  ];
  const fixture = gitFixture(["scripts/evidence_path.py", ...commands.map(([file]) => file)]);
  try {
    for (const [file, args, variable] of commands) {
      const output = join(fixture.root, "forbidden");
      const env = variable ? { ...fixture.env, [variable]: output } : fixture.env;
      const result = spawnSync("python3", ["-B", file, ...args, ...(variable ? [] : [output])], {
        cwd: fixture.root, env, encoding: "utf8",
      });
      expect(result.status, file).toBe(1);
      expect(result.stderr, file).toContain("ValueError: Evidence must be outside");
      expect(existsSync(output), file).toBe(false);
    }
  } finally {
    fixture.dispose();
  }
});

test.skipIf(process.platform !== "linux")("the qualification reporter publishes its capture to the external job", () => {
  const fixture = gitFixture(["scripts/evidence-path.mjs", "server/testing/gnl-apps-gate.mjs"]);
  const output = mkdtempSync(join(tmpdir(), "murage-gate-output-"));
  try {
    for (const name of ["shared", "src", "companion", "electron"]) mkdirSync(join(fixture.root, name));
    writeFileSync(join(output, "pnpm"), `#!/usr/bin/env node
require('node:fs').writeFileSync(process.argv.find(arg => arg.startsWith('--outputFile=')).slice(13), 'report');
`, { mode: 0o755 });
    const result = spawnSync(process.execPath, ["server/testing/gnl-apps-gate.mjs", "2/2"], {
      cwd: fixture.root, encoding: "utf8",
      env: { ...fixture.env, MURAGE_EVIDENCE_ROOT: output, PATH: output + ":" + process.env.PATH },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(output, "evidence/gnl-apps-gate/shard-2-2.json"), "utf8")).toBe("report");
    expect(existsSync(join(fixture.root, "evidence"))).toBe(false);
  } finally {
    fixture.dispose();
    removeTempDirSync(output);
  }
});

test.each([
  ["scripts/verify-gnl-product-cells.mjs", "--out"],
  ["scripts/verify-gnl-r3-cells.mjs", ""],
  ["scripts/qualify-search/compare.mjs", ""],
])("%s rejects a checkout capture before opening inputs", (file, flag) => {
  const fixture = gitFixture(["scripts/evidence-path.mjs", "scripts/check-repository-custody.mjs", file]);
  try {
    const output = join(fixture.root, "forbidden");
    const result = spawnSync(process.execPath, [file, ...(flag ? [flag] : []), output], {
      cwd: fixture.root, env: fixture.env, encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Evidence must be outside");
    expect(existsSync(output)).toBe(false);
  } finally {
    fixture.dispose();
  }
});

test("both cell verifiers publish source inventories to an external job", () => {
  const product = "scripts/verify-gnl-product-cells.mjs";
  const r3 = "scripts/verify-gnl-r3-cells.mjs";
  const fixture = gitFixture(["scripts/evidence-path.mjs", "scripts/check-repository-custody.mjs", product, r3]);
  const temp = mkdtempSync(join(tmpdir(), "murage-cell-capture-"));
  try {
    const archive = join(temp, "archive");
    const plans = join(archive, "evidence", "gnl-prod");
    mkdirSync(plans, { recursive: true });
    const plan = join(plans, "affected-cells.json");
    writeFileSync(plan, "{}");
    writeFileSync(join(plans, "fixture-files.json"), "[]");
    for (const [file, args] of [[product, ["--out", join(temp, "product")]], [r3, [join(temp, "r3"), plan]]]) {
      const result = spawnSync(process.execPath, [file, ...args], {
        cwd: fixture.root, env: { ...fixture.env, MURAGE_EVIDENCE_ARCHIVE: archive }, encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
    }
    for (const name of ["product", "r3"]) {
      expect(JSON.parse(readFileSync(join(temp, name, "source.json"), "utf8")).files).toEqual({});
    }
    expect(existsSync(join(fixture.root, "evidence"))).toBe(false);
  } finally {
    fixture.dispose();
    removeTempDirSync(temp);
  }
});

test.skipIf(process.platform === "win32")("a search comparison cannot overwrite a retained receipt through its final filename", () => {
  const file = "scripts/qualify-search/compare.mjs";
  const fixture = gitFixture(["scripts/evidence-path.mjs", "scripts/check-repository-custody.mjs", file]);
  const temp = mkdtempSync(join(tmpdir(), "murage-compare-custody-"));
  const archive = join(temp, "retained");
  const capture = join(temp, "capture");
  try {
    mkdirSync(archive);
    mkdirSync(capture);
    const receipt = join(archive, "receipt.json");
    writeFileSync(receipt, "pinned");
    const leg = { qualification: true, pass: { ready: true }, raw: {
      bound: Array.from({ length: 100 }, () => ({ statements: 1, frames: 1, scans: [] })),
    } };
    for (const name of ["q1-103k", "q1-1m"]) {
      writeFileSync(join(capture, name + ".json"), JSON.stringify(leg));
    }
    const run = directory => spawnSync(process.execPath, [file, directory], {
      cwd: fixture.root, env: { ...fixture.env, MURAGE_EVIDENCE_ARCHIVE: archive }, encoding: "utf8",
    });
    const ok = run(capture);
    expect(ok.status, ok.stderr).toBe(0);
    const linked = join(capture, "linked");
    mkdirSync(linked);
    for (const name of ["q1-103k", "q1-1m"]) {
      writeFileSync(join(linked, name + ".json"), JSON.stringify(leg));
    }
    symlinkSync(receipt, join(linked, "q1-combined.json"));
    const rejected = run(linked);
    expect(readFileSync(receipt, "utf8") === "pinned").toBe(true);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("overlaps the retained archive");
  } finally {
    fixture.dispose();
    removeTempDirSync(temp);
  }
});

test("capture roots cannot equal, contain, or descend from the pinned archive", async () => {
  const { evidencePath } = await import("./evidence-path.mjs");
  const temp = mkdtempSync(join(tmpdir(), "murage-capture-custody-"));
  const archive = join(temp, "archive");
  const prev = process.env.MURAGE_EVIDENCE_ARCHIVE;
  process.env.MURAGE_EVIDENCE_ARCHIVE = archive;
  try {
    mkdirSync(archive);
    const receipt = join(archive, "receipt.json");
    writeFileSync(receipt, "pinned");
    for (const dir of [archive, temp, join(archive, "nested")]) {
      expect(() => evidencePath("receipt.json", dir)).toThrow("overlaps the retained archive");
    }
    expect(readFileSync(receipt, "utf8") === "pinned").toBe(true);
  } finally {
    if (prev === undefined) delete process.env.MURAGE_EVIDENCE_ARCHIVE;
    else process.env.MURAGE_EVIDENCE_ARCHIVE = prev;
    removeTempDirSync(temp);
  }
});

test.skipIf(process.platform !== "linux")("a successful labeled Ask shard publishes both copies outside the checkout", () => {
  const file = "scripts/ask-regress/full-shard.py";
  const fixture = gitFixture(["scripts/evidence_path.py", file]);
  const capture = mkdtempSync(join(tmpdir(), "ask-capture-"));
  try {
    writeFileSync(join(capture, "README"), "fixture");
    execFileSync("tar", ["-czf", "head.tar.gz", "README"], { cwd: capture });
    writeFileSync(join(capture, "node"), `#!/usr/bin/env python3
import json, pathlib, sys
args = sys.argv
if 'list' in args:
    result = pathlib.Path(args[args.index('--json') + 1])
    result.write_text(json.dumps([{'file': str(pathlib.Path.cwd() / 'example.test.ts')}]))
else:
    result = next(arg.split('=', 1)[1] for arg in args if arg.startswith('--outputFile='))
    pathlib.Path(result).write_text(json.dumps({'numPassedTests': 1}))
`, { mode: 0o755 });
    const guard = `
import runpy, shutil, sys
from pathlib import Path
capture = Path(sys.argv[1]).resolve()
original_mkdir = Path.mkdir
def external_mkdir(path, *args, **kwargs):
    if path.is_relative_to(Path('/work/evidence')):
        raise AssertionError('Ask shard attempted to create a checkout capture directory')
    return original_mkdir(path, *args, **kwargs)
Path.mkdir = external_mkdir
original = shutil.copy2
def copy_to_job(src, dest, **kwargs):
    if not Path(dest).resolve().is_relative_to(capture):
        raise AssertionError('Ask shard attempted to publish outside the capture root')
    return original(src, dest, **kwargs)
shutil.copy2 = copy_to_job
sys.argv = sys.argv[2:]
runpy.run_path(sys.argv[0], run_name='__main__')
`;
    const result = spawnSync("python3", ["-B", "-c", guard, capture, file, "1", "head"], {
      cwd: fixture.root, encoding: "utf8",
      env: { ...fixture.env, ASK_FULL_EVIDENCE_ROOT: capture, ASK_FULL_EVIDENCE_LABEL: "review", PATH: capture + ":" + process.env.PATH },
    });
    expect(result.status, result.stderr).toBe(0);
    const receipt = readFileSync(join(capture, "full", "head-1.json"), "utf8");
    expect(JSON.parse(receipt)).toEqual({ numPassedTests: 1 });
    expect(readFileSync(join(capture, "review", "head-1.json"), "utf8")).toBe(receipt);
    expect(existsSync(join(fixture.root, "evidence"))).toBe(false);
  } finally {
    fixture.dispose();
    removeTempDirSync(capture);
  }
});

test.skipIf(process.platform === "win32")("the search report checks the final receipt target", async () => {
  const { Report } = await import("./qualify-search/support.ts");
  const temp = mkdtempSync(join(tmpdir(), "murage-search-report-"));
  const archive = join(temp, "archive");
  const output = join(temp, "output");
  const oldArchive = process.env.MURAGE_EVIDENCE_ARCHIVE;
  const oldOutput = process.env.MURAGE_QUAL_EVIDENCE;
  try {
    mkdirSync(archive);
    mkdirSync(output);
    const receipt = join(archive, "report.json");
    writeFileSync(receipt, "pinned");
    symlinkSync(receipt, join(output, "report.json"));
    process.env.MURAGE_EVIDENCE_ARCHIVE = archive;
    process.env.MURAGE_QUAL_EVIDENCE = output;
    expect(() => new Report("report").finish()).toThrow("overlaps the retained archive");
    expect(readFileSync(receipt, "utf8") === "pinned").toBe(true);
  } finally {
    if (oldArchive === undefined) delete process.env.MURAGE_EVIDENCE_ARCHIVE;
    else process.env.MURAGE_EVIDENCE_ARCHIVE = oldArchive;
    if (oldOutput === undefined) delete process.env.MURAGE_QUAL_EVIDENCE;
    else process.env.MURAGE_QUAL_EVIDENCE = oldOutput;
    removeTempDirSync(temp);
  }
});

test("retains real product handoff features, skills and reusable fixtures", () => {
  expect(custodyViolations(["AGENTS.md", "docs/verification/README.md", "server/wipe-proof/regression.test.mjs", "docs/plans/0153-RELEASE-NOTES.md", "scripts/native-fuigo-production-closeout.mjs",
    "electron/fixtures/updater-handoff.cjs", "electron/updater-handoff.electron.test.mjs",
    "skills-library/cs-handoff-document/SKILL.md", "skills-library/smith-agent-handoff/manifest.json",
    "src/components/PlanningPanel.tsx", "docs/verification/HANDOFF-GUIDE.txt", "server/execution.md",
    "native/backup-age/real-main-qualification/CONTRACT.md", "native/backup-age/real-main-qualification/preflight.ps1",
    "native/backup-age/real-main-qualification/verify.mjs", "native/backup-age/real-main-qualification/stage-manifest.ps1"])).toEqual([]);
});

test("the index gate fails on a synthetic record staged in a copy of the index", () => {
  // Each gate starts with its own Git object store and index.
  const fixture = gitFixture(["scripts/check-repository-custody.mjs"]);
  const { root: dir, env } = fixture;
  try {
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, env, input: "synthetic\n", encoding: "utf8" }).trim();
    const gate = () => spawnSync(process.execPath, ["scripts/check-repository-custody.mjs"], { cwd: dir, env, encoding: "utf8" });
    expect(gate().status).toBe(0);
    for (const path of ["apps/docs/.planning/STATE.md", RECEIPT]) {
      execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { cwd: dir, env });
    }
    const result = gate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("apps/docs/.planning/STATE.md");
    expect(result.stderr).toContain(RECEIPT);
  } finally {
    fixture.dispose();
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
  "/volumes/" + "mando/workspace",
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
  const fixture = gitFixture(["scripts/check-repository-custody.mjs"]);
  const { root: dir, env } = fixture;
  try {
    const gate = () => spawnSync(process.execPath, ["scripts/check-repository-custody.mjs"], { cwd: dir, env, encoding: "utf8" });
    expect(gate().status).toBe(0);
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, env, input: `first line\n${PRIVATE_LINES[0]}\n${PRIVATE_LINES[4]}\n`, encoding: "utf8" }).trim();
    execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},src/e2e/synthetic-private.spec.ts`], { cwd: dir, env });
    const result = gate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/e2e/synthetic-private.spec.ts:2");
    expect(result.stderr).toContain("src/e2e/synthetic-private.spec.ts:3"); // lower-cased volume path
    expect(result.stderr).not.toContain(HOME);
  } finally {
    fixture.dispose();
  }
});

test("the tree gate (build-image.sh on the unpacked archive) fails on private paths and lines, skips binaries, names only locations", () => {
  const dir = mkdtempSync(join(tmpdir(), "murage-custody-tree-"));
  try {
    const gate = () => spawnSync(process.execPath, ["scripts/check-repository-custody.mjs", "--tree", dir], { cwd: ROOT, encoding: "utf8" });
    mkdirSync(join(dir, "server", "cloud-home"), { recursive: true });
    writeFileSync(join(dir, "server", "cloud-home", "boot.ts"), "export const ok = 1;\n");
    writeFileSync(join(dir, "logo.bin"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(PRIVATE_LINES[0])]));
    const clean = gate();
    expect(clean.status, clean.stderr).toBe(0);
    mkdirSync(join(dir, "docs", ".planning"), { recursive: true });
    writeFileSync(join(dir, "docs", ".planning", "STATE.md"), "neutral\n");
    writeFileSync(join(dir, "server", "cloud-home", "notes.md"), `first line\n${PRIVATE_LINES[3]}\n${PRIVATE_LINES[5]}\n`);
    const result = gate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/.planning/STATE.md");
    expect(result.stderr).toContain("server/cloud-home/notes.md:2");
    expect(result.stderr).toContain("server/cloud-home/notes.md:3");
    expect(result.stderr).not.toContain("logo.bin");
    expect(result.stderr).not.toContain("Mando");
  } finally {
    removeTempDirSync(dir);
  }
});

test("the tree gate refuses to run without a directory", () => {
  const result = spawnSync(process.execPath, ["scripts/check-repository-custody.mjs", "--tree"], { cwd: ROOT, encoding: "utf8" });
  expect(result.status).toBe(2);
});

test.skipIf(process.platform !== "linux")("Ask receipts from real Vitest shards compare across all eight shards", () => {
  const temp = mkdtempSync(join(tmpdir(), "ask-roundtrip-"));
  try {
    const source = join(temp, "source");
    const capture = join(temp, "capture");
    mkdirSync(source);
    mkdirSync(capture);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: join(temp, "gitconfig"), GIT_CONFIG_SYSTEM: join(temp, "gitconfig") };
    for (const key of ["MURAGE_EVIDENCE_ARCHIVE", "MURAGE_EVIDENCE_ROOT", "ASK_FULL_EVIDENCE_LABEL"]) delete env[key];
    writeFileSync(env.GIT_CONFIG_GLOBAL, "");
    const git = (...args) => execFileSync("git", args, { cwd: source, env, encoding: "utf8" }).trim();
    git("init", "--quiet");
    const shas = {};
    for (const phase of ["base", "head"]) {
      for (let n = 1; n <= 8; n++) {
        // Same test IDs in both phases (only a comment differs), so a comparable pair must qualify.
        writeFileSync(join(source, `example-${n}.test.ts`), `import { expect, test } from "vitest";\n// ${phase}\ntest("holds", () => expect(${n}).toBe(${n}));\n`);
      }
      git("add", "--all");
      git("-c", "user.name=ci", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", phase);
      shas[phase] = git("rev-parse", "HEAD");
      git("archive", "--format=tar.gz", "-o", join(capture, phase + ".tar.gz"), "HEAD");
    }
    for (let shard = 1; shard <= 8; shard++) {
      const run = spawnSync("python3", ["-B", join(ROOT, "scripts/ask-regress/full-shard.py"), String(shard)], {
        cwd: temp, env: { ...env, ASK_FULL_EVIDENCE_ROOT: capture }, encoding: "utf8",
      });
      expect(run.status, run.stderr).toBe(0);
    }
    const compared = spawnSync("python3", ["-B", join(ROOT, "scripts/ask-regress/compare.py"), "--root", join(capture, "full"), "--base-sha", shas.base, "--head-sha", shas.head], {
      cwd: temp, env, encoding: "utf8",
    });
    expect(compared.status, compared.stderr + compared.stdout).toBe(0);
    const summary = JSON.parse(readFileSync(join(capture, "full", "comparison.json"), "utf8"));
    expect(summary.qualified).toBe(true);
    expect(summary.baseStatus).toEqual({ passed: 8 });
    expect(summary.headStatus).toEqual({ passed: 8 });
    expect([summary.baseSource, summary.headSource]).toEqual([shas.base, shas.head]);
  } finally {
    removeTempDirSync(temp);
  }
}, 600_000);

// A substitute package runner stands in for Vitest so the replay reaches its receipt writes quickly.
// Runners that clean up through safe-wipe need its import closure in the fixture.
const SAFE_WIPE = ["server/testing/safe-wipe.mjs", "electron/data-dir-lease.mjs", "electron/windows-native.mjs", "shared/win-hide-child-process.mjs", "shared/win-hide-child-process.cjs"];
function replayFixture(files) {
  const fixture = gitFixture(["scripts/evidence-path.mjs", "scripts/check-repository-custody.mjs", ...files]);
  const temp = mkdtempSync(join(tmpdir(), "murage-replay-custody-"));
  const archive = join(temp, "archive");
  const capture = join(temp, "capture");
  const bin = join(temp, "bin");
  for (const dir of [archive, capture, bin]) mkdirSync(dir);
  writeFileSync(join(bin, "pnpm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const receipt = join(archive, "receipt.json");
  writeFileSync(receipt, "pinned");
  const link = (kind, target) => {
    mkdirSync(dirname(target), { recursive: true });
    if (kind === "symlink") symlinkSync(receipt, target);
    else linkSync(receipt, target);
  };
  const run = (args, extra = {}) => spawnSync(process.execPath, args, {
    cwd: fixture.root, encoding: "utf8",
    env: { ...fixture.env, MURAGE_EVIDENCE_ARCHIVE: archive, PATH: bin + ":" + process.env.PATH, ...extra },
  });
  return { fixture, temp, archive, capture, receipt, link, run, dispose: () => { fixture.dispose(); removeTempDirSync(temp); } };
}

(process.platform === "win32" ? test.skip : test).each(["symlink", "hardlink"])("the product mutant replay refuses a %s final receipt in its capture", kind => {
  const f = replayFixture(["scripts/verify-gnl-product-mutants.mjs", "server/drivers/antigravity.ts"]);
  try {
    f.link(kind, join(f.capture, "P1-antigravity-input-control.log"));
    const result = f.run(["scripts/verify-gnl-product-mutants.mjs", f.capture]);
    expect(readFileSync(f.receipt, "utf8") === "pinned").toBe(true);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/already exists|hard-linked|overlaps the retained archive/);
  } finally {
    f.dispose();
  }
});

(process.platform === "win32" ? test.skip : test).each(["symlink", "hardlink"])("the R5 replay refuses a %s final manifest in its capture", kind => {
  const f = replayFixture(["scripts/verify-gnl-r5.mjs", ...SAFE_WIPE]);
  try {
    const inputs = join(f.archive, "evidence", "gnl-prod-r5");
    mkdirSync(inputs, { recursive: true });
    writeFileSync(join(inputs, "baseline-runtime.json"), JSON.stringify({ base: "fixture", files: {} }));
    writeFileSync(join(inputs, "tests.json"), "[]");
    const out = join(f.capture, "evidence", "gnl-prod-r5", "final", "0");
    f.link(kind, join(out, "manifest.json"));
    const result = f.run(["scripts/verify-gnl-r5.mjs", "final", "0"], { MURAGE_EVIDENCE_ROOT: f.capture });
    expect(readFileSync(f.receipt, "utf8") === "pinned").toBe(true);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/already exists|hard-linked|overlaps the retained archive/);
    expect(existsSync(join(out, "results.json"))).toBe(false);
  } finally {
    f.dispose();
  }
});

test.skipIf(process.platform === "win32")("the search report refuses a hard-linked final receipt", async () => {
  const { Report } = await import("./qualify-search/support.ts");
  const temp = mkdtempSync(join(tmpdir(), "murage-search-hardlink-"));
  const archive = join(temp, "archive");
  const output = join(temp, "output");
  const oldArchive = process.env.MURAGE_EVIDENCE_ARCHIVE;
  const oldOutput = process.env.MURAGE_QUAL_EVIDENCE;
  try {
    mkdirSync(archive);
    mkdirSync(output);
    const receipt = join(archive, "report.json");
    writeFileSync(receipt, "pinned");
    linkSync(receipt, join(output, "report.json"));
    process.env.MURAGE_EVIDENCE_ARCHIVE = archive;
    process.env.MURAGE_QUAL_EVIDENCE = output;
    expect(() => new Report("report").finish()).toThrow("hard-linked");
    expect(readFileSync(receipt, "utf8") === "pinned").toBe(true);
  } finally {
    if (oldArchive === undefined) delete process.env.MURAGE_EVIDENCE_ARCHIVE;
    else process.env.MURAGE_EVIDENCE_ARCHIVE = oldArchive;
    if (oldOutput === undefined) delete process.env.MURAGE_QUAL_EVIDENCE;
    else process.env.MURAGE_QUAL_EVIDENCE = oldOutput;
    removeTempDirSync(temp);
  }
});

test.skipIf(process.platform === "win32")("the R8 replay never writes baseline bytes into the caller's checkout, even when stopped mid-run", () => {
  const tracked = ["shared/no-limits-raw-wipe.ts", "server/no-limits-wipe-scripts.ts"];
  const f = replayFixture(["scripts/verify-no-limits-r8-compare.mjs", ...SAFE_WIPE, ...tracked]);
  try {
    const inputs = join(f.archive, "evidence", "wipe-final-r8");
    mkdirSync(inputs, { recursive: true });
    writeFileSync(join(inputs, "pre-fix-raw-wipe.ts"), "// baseline raw wipe\n");
    writeFileSync(join(inputs, "start-wipe-scripts.ts"), "// baseline wipe scripts\n");
    // The substitute runner records the source it was given, then optionally kills the replay before its cleanup.
    const vitest = join(f.fixture.root, "node_modules", "vitest", "vitest.mjs");
    mkdirSync(dirname(vitest), { recursive: true });
    writeFileSync(vitest, `import { readFileSync, writeFileSync } from "node:fs";
const out = process.argv.find(arg => arg.startsWith("--outputFile=")).slice("--outputFile=".length);
writeFileSync(out, readFileSync("shared/no-limits-raw-wipe.ts", "utf8") + readFileSync("server/no-limits-wipe-scripts.ts", "utf8"));
if (process.env.R8_STOP_REPLAY === "1") process.kill(process.ppid, "SIGKILL");
`);
    const original = tracked.map(file => readFileSync(join(f.fixture.root, file), "utf8"));
    const scratch = join(f.temp, "tmp");
    mkdirSync(scratch);
    const complete = join(f.temp, "complete");
    const ok = f.run(["scripts/verify-no-limits-r8-compare.mjs"], { CI: "1", TMPDIR: scratch, MURAGE_EVIDENCE_ROOT: complete });
    expect(ok.status, ok.stderr).toBe(0);
    expect(readFileSync(join(complete, "evidence", "wipe-final-r8", "comparison-start.json"), "utf8")).toBe("// baseline raw wipe\n// baseline wipe scripts\n");
    const stopped = f.run(["scripts/verify-no-limits-r8-compare.mjs"], { CI: "1", TMPDIR: scratch, MURAGE_EVIDENCE_ROOT: join(f.temp, "stopped"), R8_STOP_REPLAY: "1" });
    expect(stopped.signal).toBe("SIGKILL");
    expect(tracked.map(file => readFileSync(join(f.fixture.root, file), "utf8"))).toEqual(original);
    expect(f.fixture.git("diff", "--name-only")).toBe("");
    const rerun = f.run(["scripts/verify-no-limits-r8-compare.mjs"], { CI: "1", TMPDIR: scratch, MURAGE_EVIDENCE_ROOT: complete });
    expect(rerun.status).toBe(1);
    expect(rerun.stderr).toContain("already exists");
  } finally {
    f.dispose();
  }
});

(process.platform === "win32" ? test.skip : test).each([
  ["symlink", "manifest.json"], ["hardlink", "manifest.json"], ["symlink", "run.log"], ["hardlink", "run.log"], ["symlink", "rc.json"], ["hardlink", "rc.json"],
])("the AFIX r5 runner refuses a %s %s receipt in a reused evidence root", (kind, name) => {
  const afix = "scripts/verify-afix-gnl-r5.mjs";
  const f = replayFixture([afix, ...SAFE_WIPE]);
  try {
    for (const [file, value] of [["afix-gnl-prod-r5/base-runtime.json", { sha: "fixture", files: {} }], ["gnl-prod-r5/complete-tests.json", []]]) {
      mkdirSync(dirname(join(f.archive, "evidence", file)), { recursive: true });
      writeFileSync(join(f.archive, "evidence", file), JSON.stringify(value));
    }
    for (const dir of ["server", "docs", "shared", "src", "electron", "extensions", "companion", "tools", "cloudflare", "apps"]) {
      mkdirSync(join(f.fixture.root, dir), { recursive: true });
    }
    for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "vite.config.ts", "tsconfig.json", "tsconfig.server.json"]) {
      if (!existsSync(join(f.fixture.root, file))) writeFileSync(join(f.fixture.root, file), "{}");
    }
    // The harness kind spawns a missing test file, so the runner reaches every receipt write without a real suite.
    f.link(kind, join(f.capture, "evidence", "afix-gnl-prod-r5", "final-harness-0", name));
    const result = f.run([afix, "final", "harness"], { MURAGE_EVIDENCE_ROOT: f.capture });
    expect(readFileSync(f.receipt, "utf8")).toBe("pinned");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/already exists|hard-linked|overlaps the retained archive/);
  } finally {
    f.dispose();
  }
});

test.skipIf(process.platform === "win32")("external R3 cell runs aggregate through the report entry point, including the AFIX caller", () => {
  const r3 = "scripts/verify-gnl-r3-cells.mjs";
  const afix = "scripts/verify-afix-gnl-r5.mjs";
  const f = replayFixture([r3, afix, "scripts/verify-gnl-r3-report.py", "scripts/evidence_path.py", ...SAFE_WIPE]);
  try {
    // The substitute sweep judges each requested cell PASS; the writer/aggregator handoff is the unit under test.
    const sweep = join(f.fixture.root, "scripts", "no-limits-live", "scenario-sweep.mjs");
    mkdirSync(dirname(sweep), { recursive: true });
    writeFileSync(sweep, `import { mkdirSync, writeFileSync } from "node:fs";
const arg = name => process.argv[process.argv.indexOf(name) + 1];
mkdirSync(arg("--out"), { recursive: true });
writeFileSync(arg("--out") + "/verdict.json", JSON.stringify({ rows: arg("--cases").split(",").map(id => ({ engine: arg("--engines"), id, verdict: "PASS" })), errors: [] }));
`);
    const plan = { family: [{ engine: "fixture-engine", id: "cell-1" }] };
    for (const [name, value] of [["gnl-prod/fixture-files.json", []], ["gnl-prod/affected-cells.json", plan], ["gnl-prod-r3/all-cells-latest.json", plan],
      ["afix-gnl-prod-r5/base-runtime.json", { sha: "fixture", files: {} }], ["gnl-prod-r5/complete-tests.json", []]]) {
      mkdirSync(dirname(join(f.archive, "evidence", name)), { recursive: true });
      writeFileSync(join(f.archive, "evidence", name), JSON.stringify(value));
    }
    const cells = f.run([r3, join(f.capture, "all-cells", "shard-0"), join(f.archive, "evidence", "gnl-prod-r3", "all-cells-latest.json")]);
    expect(cells.status, cells.stderr + cells.stdout).toBe(0);
    const report = spawnSync("python3", ["-B", "scripts/verify-gnl-r3-report.py", "--root", f.capture], {
      cwd: f.fixture.root, encoding: "utf8", env: { ...f.fixture.env, MURAGE_EVIDENCE_ARCHIVE: f.archive },
    });
    expect(report.status, report.stderr).toBe(0);
    const summary = JSON.parse(readFileSync(join(f.capture, "cells-summary.json"), "utf8"));
    expect([summary.planned, summary.observed, summary.pass, summary.missing]).toEqual([1, 1, 1, []]);
    expect(summary.originalFamilies.family).toEqual({ expected: 1, pass: 1, fail: 0, missing: [] });
    expect(existsSync(join(f.fixture.root, "evidence"))).toBe(false);

    // The AFIX workflow caller copies these source roots into its disposable fixture.
    for (const dir of ["server", "docs", "shared", "src", "electron", "extensions", "companion", "tools", "cloudflare", "apps"]) {
      mkdirSync(join(f.fixture.root, dir), { recursive: true });
    }
    for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "vite.config.ts", "tsconfig.json", "tsconfig.server.json"]) {
      if (!existsSync(join(f.fixture.root, file))) writeFileSync(join(f.fixture.root, file), "{}");
    }
    const afixRoot = join(f.temp, "afix");
    const workflow = f.run([afix, "final", "workflow"], { MURAGE_EVIDENCE_ROOT: afixRoot });
    expect(workflow.status, workflow.stderr).toBe(0);
    const verdict = JSON.parse(readFileSync(join(afixRoot, "evidence", "afix-gnl-prod-r5", "final-workflow-0", "verdict.json"), "utf8"));
    expect(verdict.rows.map(row => row.id)).toEqual(["cell-1"]);
    expect(verdict.errors).toEqual([]);
  } finally {
    f.dispose();
  }
});

test("the Windows identity scan rejects staged SIDs and profiles and reports locations only", () => {
  const { root: dir, env, git, dispose } = gitFixture(["scripts/check-repository-custody.mjs"]);
  const profile = ["c:", "uSeRs", "Fixture Person", "file"].join("\\");
  const publicPath = ["C:", "Users", "Public", "file"].join("\\");
  const defaultPath = ["c:", "users", "dEfAuLt"].join("\\\\");
  const sid = ["S-1-5", "21", "1", "2", "3", "1001"].join("-");
  const gate = () => spawnSync(process.execPath, ["scripts/check-repository-custody.mjs", "--windows-private"], { cwd: dir, env, encoding: "utf8" });
  try {
    const file = join(dir, "fixture.txt");
    writeFileSync(file, `${profile}\n${sid}\n`);
    expect(gate().status).toBe(0);
    writeFileSync(file, `${publicPath}\n"${defaultPath}"\n`);
    git("add", "--", "fixture.txt");
    expect(gate().status).toBe(0);
    writeFileSync(file, `${publicPath}\n${sid}\n"${defaultPath}" "${profile}"\n"${publicPath.replace("Public", "Public Booth")}"\n`);
    git("add", "--", "fixture.txt");
    writeFileSync(file, "working copy changed\n");
    const result = gate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fixture.txt:2 Windows account SID");
    expect(result.stderr).toContain("fixture.txt:3 Windows profile path");
    expect(result.stderr).toContain("fixture.txt:4 Windows profile path");
    expect(result.stderr).not.toContain("fixture.txt:1");
    expect(result.stderr).not.toContain(profile);
    expect(result.stderr).not.toContain(sid);
  } finally {
    dispose();
  }
});

test("an allowed profile word is allowed only as the whole path component", () => {
  const { root: dir, env, git, dispose } = gitFixture(["scripts/check-repository-custody.mjs"]);
  const gate = () => spawnSync(process.execPath, ["scripts/check-repository-custody.mjs", "--windows-private"], { cwd: dir, env, encoding: "utf8" });
  const path = name => ["C:", "Users", name, "file"].join("\\");
  const bare = word => ["C:", "Users", word].join("\\");
  try {
    const file = join(dir, "fixture.txt");
    writeFileSync(file, [`'${bare("Public")}'`, `\`${bare("Default")}\``, `("${bare("Public")}")`, `'${path("Default")}', x`].join("\n") + "\n");
    git("add", "--", "fixture.txt");
    const clean = gate();
    expect(clean.status, clean.stderr).toBe(0);
    writeFileSync(file, [path("Public'Fixture"), path("Default`Fixture"), path("Public'Fixture'"), path("Public")].join("\n") + "\n");
    git("add", "--", "fixture.txt");
    const result = gate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fixture.txt:1 Windows profile path");
    expect(result.stderr).toContain("fixture.txt:2 Windows profile path");
    expect(result.stderr).toContain("fixture.txt:3 Windows profile path");
    expect(result.stderr).not.toContain("fixture.txt:4");
  } finally {
    dispose();
  }
});

// One row per allowed word and per way a name can carry on past it. Each row is one staged
// line run through the real script. TestUser is allowed only in its one approved file.
const SYNTHETIC_FILE = "server/protected-folders.test.ts";
const profileRows = [];
for (const [word, file] of [["Public", "fixture.txt"], ["Default", "fixture.txt"], ["TestUser", SYNTHETIC_FILE]]) {
  const bare = ["C:", "Users", word].join("\\");
  const mixed = ["d:", "uSeRs", [...word].map((c, i) => i % 2 ? c.toUpperCase() : c.toLowerCase()).join("")].join("/");
  for (const [shape, line, flagged] of [
    ["whole component", `${bare}\\file`, false],
    ["wrapped in apostrophes", `'${bare}'`, false],
    ["wrapped in backticks, then a period", `\`${bare}\`.`, false],
    ["in double quotes", `"${bare}"`, false],
    ["at the end of a sentence", `${bare}.`, false],
    ["quote, space, more name", `'${bare}' Fixture\\file'`, true],
    ["backtick, bracket, more name", `\`${bare}\`) x`, true],
    ["quote, comma", `'${bare}',`, true],
    ["two quotes, more name", `${bare}''Fixture`, true],
    ["closing quote never opened", `${bare}'`, true],
    ["quoted, then a further component", `'${bare}'\\file`, true],
    ["opened by a different quote", `\`${bare}'`, true],
    ["space, more name", `${bare} Fixture\\file`, true],
    ["more letters", `${bare}x\\file`, true],
    ["mixed case with forward slashes", `${mixed}/file`, false],
    ["mixed case with forward slashes, quote, more name", `${mixed}' x/file`, true],
  ]) profileRows.push([word, shape, file, line, flagged]);
}
profileRows.push(["TestUser", "outside its approved file", "fixture.txt", ["C:", "Users", "TestUser", "file"].join("\\"), true]);

test.each(profileRows)("%s profile, %s", (word, shape, file, line, flagged) => {
  const { root: dir, env, git, dispose } = gitFixture(["scripts/check-repository-custody.mjs"]);
  try {
    mkdirSync(join(dir, dirname(file)), { recursive: true });
    writeFileSync(join(dir, file), `${line}\n`);
    git("add", "--", file);
    const result = spawnSync(process.execPath, ["scripts/check-repository-custody.mjs", "--windows-private"], { cwd: dir, env, encoding: "utf8" });
    expect({ status: result.status, reported: result.stderr.includes(`${file}:1 Windows profile path`) }, `${word}: ${shape}\n${result.stderr}`).toEqual({ status: flagged ? 1 : 0, reported: flagged });
  } finally {
    dispose();
  }
});

test("the CI custody step rejects a private Windows identity added since the merge base", () => {
  const { root: dir, env, git, dispose } = gitFixture(["scripts/check-repository-custody.mjs"]);
  const step = parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")).jobs.quality.steps
    .find(step => step.name === "Reject private operational records in Git");
  const gate = (base = "comparison") => spawnSync("bash", ["-eo", "pipefail", "-c", step.run], {
    cwd: dir, env: { ...env, CUSTODY_BASE: base, CUSTODY_DEFAULT_REF: "refs/heads/comparison" }, encoding: "utf8",
  });
  const commit = () => {
    git("add", "--", ".");
    git("-c", "user.name=ci", "-c", "user.email=ci@example.invalid", "commit", "-qm", "fixture");
  };
  const profile = ["C:", "Users", "Fixture Person", "file"].join("/");
  const mixed = ["z:/uSeRs", "Fixture Person", "file"].join("\\");
  const legacy = ["C:", "Users", "Old Fixture", "file"].join("\\");
  const system = ["D:", "Users", "pUbLiC", "file"].join("/");
  const defaultPath = ["e:", "Users", "Default"].join("\\\\");
  const synthetic = ["F:", "Users", "TestUser", "file"].join("/");
  const sid = ["S-1-5", "21", "1", "2", "3", "1001"].join("-");
  try {
    const file = join(dir, "fixture.txt");
    writeFileSync(file, `${legacy}\n${sid}\nkeep\n`);
    commit();
    const common = git("rev-parse", "HEAD").trim();
    git("checkout", "-qb", "comparison");
    writeFileSync(file, `keep\n+++ ${profile}\n`);
    commit();
    git("checkout", "-q", "--detach", common);

    const clean = gate("");
    expect(clean.status, clean.stderr).toBe(0);
    mkdirSync(join(dir, "server"));
    const approvedFile = join(dir, "server", "protected-folders.test.ts");
    writeFileSync(approvedFile, `${synthetic}\n`);
    writeFileSync(file, `${legacy}\nkeep\n${system}\n"${defaultPath}"\n`);
    commit();
    const allowed = gate();
    expect(allowed.status, allowed.stderr).toBe(0);

    writeFileSync(file, `${legacy}\nkeep\n+++ ${profile}\n${mixed}\n${sid} shifted\n${synthetic}\n`);
    writeFileSync(approvedFile, `${synthetic}\n${mixed}\n`);
    commit();
    const result = gate();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr.split("\n").slice(1, -1)).toEqual([
      "fixture.txt:3 Windows profile path",
      "fixture.txt:4 Windows profile path",
      "fixture.txt:5 Windows account SID",
      "fixture.txt:6 Windows profile path",
      "server/protected-folders.test.ts:2 Windows profile path",
    ]);
    for (const value of [profile, mixed, legacy, sid, synthetic]) expect(result.stderr).not.toContain(value);
    expect(gate("missing-base").status).not.toBe(0);
    git("branch", "-f", "comparison", "HEAD");
    const manual = gate("");
    expect(manual.status).toBe(1);
    expect(manual.stderr).toBe(result.stderr);
  } finally {
    dispose();
  }
});
