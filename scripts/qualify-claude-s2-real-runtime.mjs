#!/usr/bin/env node
// Supplement scripts/qualify-claude-s2.mjs with real Stop/order/fallback/latency.
// Run only on the separately authorized dedicated Linux qualification host.
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeS2NativeBuild } from "../server/drivers/claude-s2-qualification.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1];
const cli = value("--cli"), build = value("--build-sha256"), destination = value("--output");
if (!args.includes("--allow-provider-calls") || process.platform !== "linux") throw new Error("requires explicit provider-call authorization on Linux");
if (!args.includes("--cli") || !isAbsolute(cli) || !/^[a-f0-9]{64}$/.test(build ?? "") || !args.includes("--output")) throw new Error("supply --cli ABS_NATIVE_CLI --build-sha256 SHA256 --output NEW_DIRECTORY");
const output = resolve(destination), parent = realpathSync(dirname(output));
if (existsSync(output) || parent === "/dev" || parent.startsWith("/dev/")) throw new Error("output must be new and outside /dev");
if (await claudeS2NativeBuild(cli) !== build) throw new Error("CLI artifact differs from supplied pin");
if (Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) === Boolean(process.env.ANTHROPIC_API_KEY)) throw new Error("requires exactly one explicit dedicated credential");
const home = mkdtempSync(join(tmpdir(), "murage-s2-runtime-runner-"));
try {
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, "claude"),
    TEMP: home, TMP: home, TMPDIR: home, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", NODE_ENV: "test",
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    MURAGE_REAL_CLAUDE_S2: "1", MURAGE_REAL_CLAUDE_S2_CLI: cli, MURAGE_REAL_CLAUDE_S2_BUILD: build,
    MURAGE_QUAL_S2_LATENCY: join(output, "latency.jsonl") };
  mkdirSync(env.CLAUDE_CONFIG_DIR);
  const versionOutput = execFileSync(cli, ["--version"], { cwd: home, env, encoding: "utf8", timeout: 10_000 }).trim();
  if (versionOutput !== "2.1.310 (Claude Code)") throw new Error("requires exact pinned version 2.1.310");
  mkdirSync(output, { mode: 0o700 });
  const file = "server/drivers/claude-s2-real-runtime.test.ts";
  const sources = [file, "scripts/qualify-claude-s2-real-runtime.mjs", "server/drivers/claude.ts",
    "server/drivers/claude-s2-barrier.ts", "server/drivers/claude-s2-pending.ts", "server/drivers/cli-stdin.ts",
    "server/drivers/cli-mount-relay.ts", "server/drivers/claude-s2-qualification.ts"];
  writeFileSync(join(output, "identity.json"), JSON.stringify({ at: new Date().toISOString(), platform: process.platform,
    arch: process.arch, node: process.version, version: "2.1.310", versionOutput, build,
    sources: Object.fromEntries(sources.map(path => [path, createHash("sha256").update(readFileSync(join(root, path))).digest("hex")])) }, null, 2) + "\n");
  const result = spawnSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", file,
    "--reporter=default", "--reporter=json", `--outputFile=${join(output, "tests.json")}`],
  { cwd: root, env, stdio: "inherit", timeout: 600_000 });
  const report = existsSync(join(output, "tests.json")) ? JSON.parse(readFileSync(join(output, "tests.json"), "utf8")) : null;
  const assertions = report?.testResults.flatMap(file => file.assertionResults.map(test => ({ id: test.fullName, status: test.status, durationMs: test.duration }))) ?? [];
  const afterBuild = await claudeS2NativeBuild(cli);
  const passed = result.status === 0 && report?.success && assertions.length === 3
    && assertions.every(test => test.status === "passed") && afterBuild === build;
  writeFileSync(join(output, "assertions.json"), JSON.stringify(assertions, null, 2) + "\n");
  writeFileSync(join(output, "receipt.json"), JSON.stringify({ status: passed ? "PASSED-REQUIRES-REVIEW" : "FAILED",
    exitCode: result.status, signal: result.signal, error: result.error?.message,
    passed: assertions.filter(test => test.status === "passed").length,
    failed: assertions.filter(test => test.status === "failed").length,
    skipped: assertions.filter(test => ["pending", "skipped", "todo"].includes(test.status)).length,
    buildBefore: build, buildAfter: afterBuild }, null, 2) + "\n");
  process.exitCode = passed ? 0 : 1;
} finally { rmSync(home, { recursive: true, force: true }); }
