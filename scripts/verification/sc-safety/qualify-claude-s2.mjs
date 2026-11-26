// Runner owner: MAIN dispatches T2 (Windows) and T3 (macOS).
// Receipt reviewer owner: MAIN; this runner never updates the production table.
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { safeWipe } from "../../../server/testing/safe-wipe.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const values = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  values.set(flag, flag === "--allow-provider-calls" ? true : process.argv[++i]);
}
if (!values.has("--allow-provider-calls")) throw new Error("Real qualification requires --allow-provider-calls from an authorized runner");
const cli = values.get("--cli"), destination = values.get("--output"), expectedBuild = values.get("--build-sha256");
if (typeof cli !== "string" || !isAbsolute(cli) || typeof destination !== "string" || !isAbsolute(destination)
  || typeof expectedBuild !== "string" || !/^[a-f0-9]{64}$/.test(expectedBuild)) {
  throw new Error("Usage: node scripts/verification/sc-safety/qualify-claude-s2.mjs --cli ABSOLUTE_NATIVE_CLI --output ABSOLUTE_JOB_EVIDENCE_DIR --build-sha256 INDEPENDENT_DIGEST --allow-provider-calls");
}
const output = join(await realpath(dirname(resolve(destination))), basename(destination));
const within = relative(await realpath(repo), output);
if (output === "/dev" || output.startsWith("/dev/")) throw new Error("Qualification evidence cannot be written under /dev");
if (!(isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`))) throw new Error("Qualification evidence must be outside the repository");
const key = process.env.S2_QUALIFICATION_ANTHROPIC_API_KEY;
const token = process.env.S2_QUALIFICATION_CLAUDE_CODE_OAUTH_TOKEN;
if (Boolean(key) === Boolean(token)) throw new Error("Supply exactly one dedicated S2_QUALIFICATION credential");
await mkdir(output, { mode: 0o700 });
const scratch = await mkdtemp(join(output, "qualification-scratch-"));
try {
  const home = join(scratch, "home"), configDir = join(scratch, "claude");
  await mkdir(home); await mkdir(configDir);
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT,
    HOME: home, USERPROFILE: home, TMPDIR: home, TEMP: home, TMP: home, CLAUDE_CONFIG_DIR: configDir,
    CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", NODE_OPTIONS: "--max-old-space-size=12000",
    ANTHROPIC_API_KEY: key, CLAUDE_CODE_OAUTH_TOKEN: token };
  const qualification = await import(pathToFileURL(join(repo, "server/drivers/claude-s2-qualification.ts")).href);
  const build = await qualification.claudeS2NativeBuild(cli);
  if (!build || build !== expectedBuild) throw new Error("Native artifact must match the independently supplied SHA256; shell/npm launchers are refused");
  const versionText = execFileSync(cli, ["--version"], { cwd: scratch, env, encoding: "utf8", timeout: 15_000 });
  const version = /^(\d+\.\d+\.\d+)\b/.exec(versionText)?.[1];
  if (!version) throw new Error("Native CLI did not report one exact release version");
  const candidate = { platform: process.platform, arch: process.arch, version, build, evidence: "review-required" };
  const config = join(scratch, "vitest.config.mjs"), report = join(output, "qualification-tests.json");
  await writeFile(config, `export default ${JSON.stringify({ root: repo, test: {
    environment: "node", include: ["server/drivers/claude-s2-platform.qualification.ts"],
    setupFiles: [join(repo, "server/testing/setup.ts")],
    pool: "forks", fileParallelism: false, maxWorkers: 1,
    reporters: ["json"], outputFile: report,
  } })};\n`);
  const log = [];
  const status = await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [join(repo, "node_modules/vitest/vitest.mjs"), "run", "--config", config], {
      cwd: repo, env: { ...env, MURAGE_QUAL_S2_CLI: cli,
        MURAGE_QUAL_S2_RECEIPT: JSON.stringify(candidate), MURAGE_QUAL_S2_OUTPUT: output },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", bytes => log.push(bytes)); child.stderr.on("data", bytes => log.push(bytes));
    child.once("error", reject); child.once("close", accept);
  });
  await writeFile(join(output, "qualification.log"), Buffer.concat(log));
  const finalBuild = await qualification.claudeS2NativeBuild(cli);
  let results;
  try { results = JSON.parse(await readFile(report, "utf8")); }
  catch { results = { success: false, numPassedTests: 0, numPendingTests: 0 }; }
  const pass = status === 0 && results.success === true && results.numPassedTests >= 3 && results.numPendingTests === 0 && finalBuild === build;
  await writeFile(join(output, "CANDIDATE-RECEIPT.json"), JSON.stringify({
    ...candidate, evidence: "qualification-tests.json", reviewed: false, pass,
    checks: ["relist", "no-cross-generation", "Stop-alone", "teardown", "latency"],
    tests: results.numPassedTests, artifactUnchanged: finalBuild === build,
  }, null, 2) + "\n");
  process.stdout.write(`S2 qualification ${pass ? "PASS" : "FAIL"}; candidate requires MAIN review before production admission.\n`);
  if (!pass) process.exitCode = 1;
} finally { await safeWipe(scratch, { within: output }); }
