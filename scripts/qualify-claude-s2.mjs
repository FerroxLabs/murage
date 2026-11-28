#!/usr/bin/env node
// Produce reviewable receipts; this script never edits the production allowlist.
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir, release } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeS2NativeBuild } from "../server/drivers/claude-s2-qualification.ts";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
if (args.includes("--help")) {
  console.log("qualify-claude-s2.mjs --mode offline|real --output NEW_DIRECTORY [--cli ABS_NATIVE_CLI --build-sha256 SHA256 --allow-provider-calls]");
  process.exit(0);
}
const mode = value("--mode") ?? "offline";
if (!["offline", "real"].includes(mode)) throw new Error("mode must be offline or real");
const outputArg = value("--output");
if (!outputArg) throw new Error("an explicit new evidence directory is required");
const output = resolve(outputArg);
// Resolve the existing parent too, so a symlink cannot turn an evidence path
// into a device or the user's home/config folder.
const parent = realpathSync(dirname(output));
if (parent === "/dev" || parent.startsWith("/dev/") || existsSync(output)) throw new Error("output must be a new regular evidence directory outside /dev");
const home = mkdtempSync(join(tmpdir(), "murage-s2-runner-"));
let exitCode = 1;
try {
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT, TEMP: home, TMP: home, TMPDIR: home,
    HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, "claude"),
    CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", NODE_ENV: "test", NODE_OPTIONS: "--max-old-space-size=12000" };
  mkdirSync(env.CLAUDE_CONFIG_DIR);
  const drivers = "server/drivers/";
  let files = readdirSync(join(root, drivers)).filter(name => /^claude-s2-.*\.test\.ts$/.test(name) || /^cli-mount-.*\.test\.ts$/.test(name)).map(name => drivers + name).sort();
  let cliIdentity = null;
  if (mode === "real") {
    if (!args.includes("--allow-provider-calls")) throw new Error("real mode requires a separately authorized runner and --allow-provider-calls");
    // The current real shim PID witness uses /proc. Other platforms stay OPEN;
    // never present Linux receipts as Windows/macOS qualification.
    if (process.platform !== "linux") throw new Error("real qualification currently requires Linux; other platform receipts remain OPEN");
    const cli = value("--cli"), expected = value("--build-sha256");
    if (!cli || !isAbsolute(cli) || !expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("pin an absolute native CLI and its independently supplied SHA256");
    const build = await claudeS2NativeBuild(cli);
    if (build !== expected) throw new Error("native CLI build does not match the supplied pin");
    // Ambient login files and provider variables are never consulted. A
    // dedicated runner supplies ONE explicitly named qualification credential.
    const key = process.env.S2_QUALIFICATION_ANTHROPIC_API_KEY;
    const token = process.env.S2_QUALIFICATION_CLAUDE_CODE_OAUTH_TOKEN;
    if (Boolean(key) === Boolean(token)) throw new Error("supply exactly one dedicated S2_QUALIFICATION credential");
    env.ANTHROPIC_API_KEY = key; env.CLAUDE_CODE_OAUTH_TOKEN = token;
    const version = execFileSync(cli, ["--version"], { cwd: home, env, encoding: "utf8", timeout: 10_000 }).trim();
    if (version !== "2.1.310 (Claude Code)") throw new Error("real qualification requires exactly Claude 2.1.310 (Claude Code)");
    env.MURAGE_REAL_CLAUDE_S2 = "1"; env.MURAGE_REAL_CLAUDE_S2_CLI = cli;
    env.MURAGE_REAL_CLAUDE_S2_BUILD = build;
    cliIdentity = { platform: process.platform, arch: process.arch, version: "2.1.310", versionOutput: version, build };
    files = [drivers + "claude-s2-real.test.ts", drivers + "claude-s2-no-cross-production.test.ts"];
  }
  mkdirSync(output, { mode: 0o700 });
  env.MURAGE_QUAL_S2_LATENCY = join(output, "latency.jsonl");
  const hash = file => createHash("sha256").update(readFileSync(join(root, file))).digest("hex");
  const sourceFiles = [...new Set([...files, drivers + "claude.ts", drivers + "claude-s2-qualification.ts",
    drivers + "claude-s2-barrier.ts", drivers + "cli-stdin.ts", drivers + "cli-mount-relay.ts",
    drivers + "claude-s2-runtime-cli.fixture.mjs", drivers + "claude-s2-protocol-cli.fixture.mjs",
    drivers + "claude-s2-real-runner.fixture.ts", "scripts/qualify-claude-s2.mjs"])];
  writeFileSync(join(output, "identity.json"), JSON.stringify({ mode, at: new Date().toISOString(),
    platform: process.platform, arch: process.arch, kernel: release(), node: process.version, cli: cliIdentity,
    productionS2Enabled: false, source: Object.fromEntries(sourceFiles.map(file => [file, hash(file)])), files }, null, 2) + "\n");
  // The child gets a minimal environment and fresh home, including in offline
  // mode. No network settings, live credentials, hooks or login dirs leak in.
  const result = spawnSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", ...files,
    "--reporter=default", "--reporter=json", `--outputFile=${join(output, "tests.json")}`],
  { cwd: root, env, stdio: "inherit", timeout: mode === "real" ? 1_800_000 : 900_000 });
  const report = existsSync(join(output, "tests.json")) ? JSON.parse(readFileSync(join(output, "tests.json"), "utf8")) : null;
  const assertions = report?.testResults.flatMap(file => file.assertionResults.map(test => ({ file: relative(root, file.name).replaceAll("\\", "/"), id: test.fullName, status: test.status, durationMs: test.duration }))) ?? [];
  const realIds = assertions.filter(test => test.file.endsWith("claude-s2-real.test.ts") || test.id.startsWith("T-S2-NO-CROSS-PRODUCTION: real"));
  const invalidReal = mode === "real" && (realIds.length !== 5 || realIds.some(test => test.status !== "passed"));
  const invalidOffline = mode === "offline" && !assertions.some(test => test.id.startsWith("T-S2-NO-CROSS-PRODUCTION-OFFLINE:") && test.status === "passed");
  const afterBuild = mode === "real" ? await claudeS2NativeBuild(cliIdentity && value("--cli")) : null;
  exitCode = result.status === 0 && report?.success && !invalidReal && !invalidOffline
    && (mode !== "real" || afterBuild === cliIdentity.build) ? 0 : 1;
  writeFileSync(join(output, "assertions.json"), JSON.stringify(assertions, null, 2) + "\n");
  writeFileSync(join(output, "receipt.json"), JSON.stringify({ mode, status: exitCode === 0 ? "PASSED-REQUIRES-REVIEW" : "FAILED",
    exitCode: result.status, signal: result.signal, error: result.error?.message,
    passed: assertions.filter(test => test.status === "passed").length,
    failed: assertions.filter(test => test.status === "failed").length,
    skipped: assertions.filter(test => ["pending", "skipped", "todo"].includes(test.status)).length,
    realQualificationExecuted: mode === "real", productionS2Enabled: false,
    testsSha256: report ? createHash("sha256").update(readFileSync(join(output, "tests.json"))).digest("hex") : null }, null, 2) + "\n");
} finally {
  safeWipeSync(home);
}
process.exitCode = exitCode;
