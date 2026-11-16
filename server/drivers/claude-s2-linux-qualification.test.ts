import { expect, it, vi } from "vitest";
import * as qualification from "./claude-s2-qualification.ts";
vi.mock("./process-tree.ts", async original => ({ ...await original<typeof import("./process-tree.ts")>(), descendantBaseline: async () => new Set<number>(), untrackedDescendants: async () => new Set<number>() }));

const build = "b73676430af12f97316a798b8371f81d640f90a58bdcb8f3ce56a835bb47df56";
it("T-S2-QUAL-LINUX-RECEIPT admits the reviewed exact Linux build and refuses every other identity", () => {
  const admitted = qualification.claudeS2Qualified as (env: NodeJS.ProcessEnv, platform: NodeJS.Platform, version: string | null, build: string | null, arch: string) => boolean;
  const env = { NODE_ENV: "production" };
  expect(admitted(env, "linux", "2.1.310", build, "x64")).toBe(true);
  for (const platform of ["darwin", "win32", "freebsd"] as const) expect(admitted(env, platform, "2.1.310", build, "x64")).toBe(false);
  expect(admitted(env, "linux", "2.1.310", build, "arm64")).toBe(false);
  for (const version of [null, "2.1.309", "2.1.311", "2.1.310-dev"]) expect(admitted(env, "linux", version, build, "x64")).toBe(false);
  for (const digest of [null, "", "a".repeat(64), build.toUpperCase()]) expect(admitted(env, "linux", "2.1.310", digest, "x64")).toBe(false);
});

it("T-S2-QUAL-EXACT receipt matching requires platform, architecture, version, build and reviewed evidence", () => {
  const receipt = { platform: "linux" as const, arch: "x64", version: "2.1.310", build, evidence: "evidence/s2-real" };
  expect(qualification.matchesClaudeS2Qualification([receipt], "linux", "x64", "2.1.310", build)).toBe(true);
  expect(qualification.matchesClaudeS2Qualification([{ ...receipt, evidence: "" }], "linux", "x64", "2.1.310", build)).toBe(false);
  expect(qualification.matchesClaudeS2Qualification([receipt], "linux", "x64", "2.1.310", "a".repeat(64))).toBe(false);
  expect(qualification.matchesClaudeS2Qualification([receipt], "linux", "x64", "2.1.310-dev", build)).toBe(false);
});

it("T-S2-QUAL-BUILD fingerprints one open native artifact and never admits wrappers or absent files", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { removeTempDirSync } = await import("../testing/cleanup.ts");
  const root = mkdtempSync(join(tmpdir(), "s2-qualified-artifact-")), file = join(root, "cli");
  try {
    const first = Buffer.from("\x7fELFisolated-artifact"); writeFileSync(file, first);
    expect(await qualification.claudeS2NativeBuild(file)).toBe(createHash("sha256").update(first).digest("hex"));
    writeFileSync(file, "\x7fELFchanged-artifact");
    expect(await qualification.claudeS2NativeBuild(file)).not.toBe(createHash("sha256").update(first).digest("hex"));
    expect(await qualification.claudeS2QualifiedCli(file, "2.1.310", { NODE_ENV: "production" }, "linux", "x64")).toBe(false);
    writeFileSync(file, "#!/bin/sh\nexec another-program\n");
    expect(await qualification.claudeS2NativeBuild(file)).toBeNull();
    expect(await qualification.claudeS2NativeBuild("cli")).toBeNull();
    expect(await qualification.claudeS2NativeBuild(join(root, "absent"))).toBeNull();
  } finally { removeTempDirSync(root); }
});


it("T-S2-QUAL-DISPATCH keeps an unqualified identity decision on fresh single-use mount processes", async () => {
  const { mkdtempSync, chmodSync, writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const { ClaudeDriver, resetClaudeMcpReadinessForTests } = await import("./claude.ts");
  const { resetClaudeVersionGate } = await import("./claude-guards.ts");
  const { fixtureMountTurn } = await import("../testing/mcp-admission-fixture.ts");
  const { recordEvents } = await import("../testing/events.ts");
  const { removeTempDir } = await import("../testing/cleanup.ts");
  const { ensureDirs } = await import("../config.ts");
  ensureDirs();
  // An executable wrapper preserves the entry's relative preload dependency.
  const root = mkdtempSync(join(tmpdir(), "s2-production-s1-")), cli = join(root, "claude.mjs"), log = join(root, "stdin.jsonl"), release = join(root, "release");
  writeFileSync(cli, `#!/usr/bin/env node\nimport ${JSON.stringify(new URL("claude-s2-runtime-cli.fixture.mjs", import.meta.url).href)};\n`);
  chmodSync(cli, 0o755);
  writeFileSync(release, "ready");
  const rejected = vi.spyOn(qualification, "claudeS2QualifiedCli").mockResolvedValue(false);
  vi.stubEnv("FAKE_CLAUDE_S2_LOG", log); vi.stubEnv("FAKE_CLAUDE_S2_RELEASE", release);
  vi.stubEnv("CLAUDE_CONFIG_DIR", root); vi.stubEnv("MURAGE_CLOUD_ROLE", "");
  const instance = await ClaudeDriver.create({ instanceId: randomUUID(), displayName: "Unqualified S1 fixture", enabled: true, environment: {}, config: { cli, permissionMode: "acceptEdits" } });
  const events = recordEvents(instance.adapter), threadId = randomUUID(), botId = randomUUID();
  const turn = (text: string) => fixtureMountTurn({ threadId, text, cwd: root, draftOnly: true, warmIdentity: { botId, audience: "owner" }, integrations: { composio: { command: process.execPath, args: ["-e", "process.stdin.resume()"], env: {} } } });
  const users = (): Array<{ pid: number; frame: { type: string } }> => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.frame.type === "user") : [];
  try {
    const first = await instance.adapter.sendTurn(turn("first"));
    expect(await events.until(event => event.type === "turn.completed" && event.turnId === first.turnId)).toMatchObject({ ok: true });
    await instance.adapter.sendTurn(turn("second"));
    await expect.poll(() => users().length, { timeout: 20_000 }).toBe(2);
    expect(rejected).toHaveBeenCalled();
    expect(users()[1]!.pid).not.toBe(users()[0]!.pid);
  } finally { events.stop(); await instance.dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs(); resetClaudeMcpReadinessForTests(); resetClaudeVersionGate(); await removeTempDir(root); }
}, 60_000);

const { claudeS2Qualified, claudeS2QualifiedCli } = qualification;

it("T-S2-QUAL-LINUX-RECEIPT: production admits only the real-qualified Linux x64 version and native build", async () => {
  const env = { NODE_ENV: "production" };
  const build = "b73676430af12f97316a798b8371f81d640f90a58bdcb8f3ce56a835bb47df56";
  expect(claudeS2Qualified(env, "linux", "2.1.310", build, "x64")).toBe(true);
  for (const platform of ["darwin", "win32", "freebsd"] as const) {
    expect(claudeS2Qualified(env, platform, "2.1.310", build, "x64")).toBe(false);
  }
  expect(claudeS2Qualified(env, "linux", "2.1.310", build, "arm64")).toBe(false);
  for (const version of [null, "2.1.309", "2.1.311", "2.1.310-dev"]) {
    expect(claudeS2Qualified(env, "linux", version, build, "x64")).toBe(false);
  }
  for (const digest of [null, "", "a".repeat(64), build.toUpperCase()]) {
    expect(claudeS2Qualified(env, "linux", "2.1.310", digest, "x64")).toBe(false);
  }
  expect(await claudeS2QualifiedCli("/absent/claude", "2.1.310", env, "linux", "x64")).toBe(false);
});
