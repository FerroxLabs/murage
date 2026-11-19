import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { claudeS2Qualified as productionClaudeS2Qualified, claudeS2QualifiedCli, claudeS2NativeBuild,
  matchesClaudeS2Qualification, type ClaudeS2Qualification } from "./claude-s2-qualification.ts";

// The isolated positive case supplies a receipt explicitly. The wrapper never
// derives authority from the environment map passed by its original assertion.
const isolatedReceipt: ClaudeS2Qualification = { platform: "linux", arch: "fixture", version: "0.0.0",
  build: "0".repeat(64), evidence: "isolated-qualification-fixture" };
let isolated: readonly ClaudeS2Qualification[] | undefined;
beforeEach(({ task }) => {
  isolated = task.name === "allows the isolated qualification harness to exercise S2" ? [isolatedReceipt] : undefined;
});
function claudeS2Qualified(...args: Parameters<typeof productionClaudeS2Qualified>): boolean {
  if (isolated) return productionClaudeS2Qualified({}, isolatedReceipt.platform, isolatedReceipt.version,
    isolatedReceipt.build, isolatedReceipt.arch, isolated);
  return productionClaudeS2Qualified(...args);
}

it.each(["linux", "darwin", "win32"] as const)("keeps unqualified production %s on single-use mounts", platform => {
  expect(claudeS2Qualified({ NODE_ENV: "production" }, platform)).toBe(false);
  expect(claudeS2Qualified({}, platform)).toBe(false);
});
it("allows the isolated qualification harness to exercise S2", () => {
  expect(claudeS2Qualified({ NODE_ENV: "test" })).toBe(true);
});

const receipt: ClaudeS2Qualification = { platform: "linux", arch: "x64", version: "2.1.310", build: "a".repeat(64), evidence: "isolated-unit-receipt" };
it("T-S2-QUAL-EXACT: a reviewed receipt matches only its exact platform, architecture, version and build", () => {
  const matches = (platform = receipt.platform, arch = receipt.arch, version: string | null = receipt.version, build: string | null = receipt.build) =>
    matchesClaudeS2Qualification([receipt], platform, arch, version, build);
  expect(matches()).toBe(true);
  expect(matches("darwin")).toBe(false);
  expect(matches("win32")).toBe(false);
  expect(matches("linux", "arm64")).toBe(false);
  for (const version of [null, "", "2.1.309", "2.1.311", "2.1.310-dev", "2.1.310 (Claude Code)", ">=2.1.310", "2.1.310\n"]) {
    expect(matches("linux", "x64", version)).toBe(false);
  }
  for (const build of [null, "", "b".repeat(64), "a".repeat(63), "A".repeat(64), "/path/claude@mtime:size"]) {
    expect(matches("linux", "x64", receipt.version, build)).toBe(false);
  }
  expect(matchesClaudeS2Qualification([{ ...receipt, evidence: "" }], "linux", "x64", receipt.version, receipt.build)).toBe(false);
});
it.each(["linux", "darwin", "win32"] as const)("T-S2-QUAL-DEFAULT: even pinned-looking %s identities and environment overrides stay S1", async platform => {
  const env = { NODE_ENV: "production", MURAGE_REAL_CLAUDE_S2: "1", MURAGE_CLAUDE_S2: "1" };
  expect(claudeS2Qualified(env, platform, receipt.version, receipt.build, "x64")).toBe(false);
  expect(claudeS2Qualified({}, platform, receipt.version, receipt.build, "x64")).toBe(false);
  expect(await claudeS2QualifiedCli("/does-not-exist/claude", receipt.version, env, platform, "x64")).toBe(false);
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("T-S2-QUAL-BUILD: digest distinguishes rebuilt artifacts with the same version and refuses opaque launchers", async () => {
  const root = mkdtempSync(join(tmpdir(), "s2-build-")); roots.push(root);
  const file = join(root, "claude");
  const bytes = Buffer.from("\x7fELFisolated-native-fixture"); writeFileSync(file, bytes);
  const first = await claudeS2NativeBuild(file);
  expect(first).toBe(createHash("sha256").update(bytes).digest("hex"));
  writeFileSync(file, Buffer.from("\x7fELFrebuilt-native-fixture"));
  expect(await claudeS2NativeBuild(file)).not.toBe(first);
  writeFileSync(file, "#!/bin/sh\nexec some-other-build\n");
  expect(await claudeS2NativeBuild(file)).toBeNull();
  expect(await claudeS2NativeBuild("claude")).toBeNull();
  expect(await claudeS2NativeBuild(join(root, "absent"))).toBeNull();
});

it("T-S2-RUNNER-NO-LOGIN: real mode without explicit provider-call authorization never invokes the supplied CLI", () => {
  const root = mkdtempSync(join(tmpdir(), "s2-runner-preflight-")); roots.push(root);
  const marker = join(root, "invoked"), cli = join(root, "cli.mjs");
  writeFileSync(cli, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'called');`);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../scripts/qualify-claude-s2.mjs", import.meta.url)),
    "--mode", "real", "--output", join(root, "evidence"), "--cli", cli, "--build-sha256", "a".repeat(64)],
  { env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, TMPDIR: root, TEMP: root, TMP: root }, encoding: "utf8", timeout: 10_000 });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("--allow-provider-calls");
  expect(() => readFileSync(marker)).toThrow();
  expect(readdirSync(root).sort()).toEqual(["cli.mjs"]);
});

it("T-S2-PLATFORM-RUNNER-NO-LOGIN: cross-platform qualification requires explicit provider-call authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "s2-platform-preflight-")); roots.push(root);
  const marker = join(root, "invoked"), cli = join(root, "cli.mjs");
  writeFileSync(cli, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'called');`);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../docs/verification/sc-safety-r4/qualify-claude-s2.mjs", import.meta.url)),
    "--output", join(root, "evidence"), "--cli", cli, "--build-sha256", "a".repeat(64)],
  { env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, TMPDIR: root, TEMP: root, TMP: root }, encoding: "utf8", timeout: 10_000 });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("--allow-provider-calls");
  expect(() => readFileSync(marker)).toThrow();
  expect(readdirSync(root).sort()).toEqual(["cli.mjs"]);
});
