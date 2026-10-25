// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A draft-only turn on Claude (DRAFT-ONLY-ALLOWLIST-104 sections 2 and 7, R1, R2, R6), against the scripted fake CLI: the
// launch has no built-in tool, only Murage's connected-app relay, no broker, no extra folder and an empty private folder; and
// the driver judges the launch facts again before every spawn, reading the settings files the launch actually loads.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { invalidateCliVersions } from "../cli-version-cache.ts";
import { resetClaudeVersionGate } from "./claude-guards.ts";
import { ClaudeDriver, claudeDraftOnlyFacts } from "./claude.ts";

vi.mock("node:child_process", async (original) => (await import("../testing/exec-check-spy.ts")).withExecCheckSpy(await original()));

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");
// DRAFT-ONLY-ALLOWLIST-104 section 6, written out so the test runs its real assertions on a tree without it.
const OWNER_LINE = "This bot writes drafts for you to review and send, and it drafts on Claude or a connected chat model. Choose one of those in this bot's settings and it picks up from here.";
const CONNECTOR = { command: process.execPath, args: ["/tmp/connector-proxy.js"], env: { MURAGE_CONNECTOR_UPSTREAM_URL: "https://example.test/mcp" } };
const EVERY_MOUNT = {
  composio: CONNECTOR,
  agents: { command: process.execPath, args: ["fixture-agents-proxy"], env: { MURAGE_COMMS_TOKEN: "a".repeat(48) } },
  memory: { command: process.execPath, args: ["fixture-memory-proxy"], env: {} },
  phone: { command: process.execPath, args: ["fixture-phone-proxy"], env: {} },
  dweb: { url: "http://127.0.0.1:9" },
  custom: { mailer: { command: process.execPath, args: ["fixture-mailer"], env: {} } },
} as never;
const ENV = ["FAKE_CLAUDE_DUMP", "FAKE_CLAUDE_STATE", "FAKE_CLAUDE_PRE_ACCEPT_TRANSIENTS", "FAKE_CLAUDE_RETRY_SCALE", "FAKE_CLAUDE_LAUNCH_WRITE", "FAKE_CLAUDE_LAUNCH_WRITE_TEXT"];

let instance: ProviderInstance | undefined;
let recorder: EventRecorder;
let scratch: string;
let config: string;
const create = async (environment: Record<string, string> = {}) => {
  instance = await ClaudeDriver.create({ instanceId: "claude-draft", displayName: "Claude", environment: { CLAUDE_CONFIG_DIR: config, ...environment }, enabled: true, config: { cli: FAKE_CLI, permissionMode: "default" } });
  recorder = recordEvents(instance.adapter);
};
const dumpOf = (file: string) => JSON.parse(readFileSync(file, "utf8")) as { argv: string[]; env: Record<string, string | undefined>; mcpConfig: { mcpServers: Record<string, unknown> }; cwd: string; cwdEntries: string[]; systemPrompt?: string };
const refusedWithLine = async (threadId: string) => {
  const done = await recorder.until((e) => e.type === "turn.completed" && e.threadId === threadId);
  expect(done).toMatchObject({ ok: false, stopReason: "refused" });
  expect((recorder.events.find((e) => e.type === "runtime.error" && e.threadId === threadId) as { message?: string } | undefined)?.message).toBe(OWNER_LINE);
};

beforeEach(() => {
  ensureDirs();
  chmodSync(FAKE_CLI, 0o755);
  scratch = mkdtempSync(join(tmpdir(), "murage-claude-draft-"));
  config = join(scratch, "claude-config");
  mkdirSync(config, { recursive: true });
});
afterEach(async () => {
  recorder?.stop();
  await instance?.dispose();
  instance = undefined;
  for (const name of ENV) delete process.env[name];
  resetClaudeVersionGate();
  invalidateCliVersions();
  await removeTempDir(scratch);
});

describe("a draft-only turn on Claude", () => {
  it("launches with no built-in tool, only the connected-app relay, no broker, no extra folder and an empty private folder", async () => {
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await create();
    const workspace = join(scratch, "workspace");
    mkdirSync(join(workspace, ".claude"), { recursive: true });
    writeFileSync(join(workspace, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [] } }));
    await instance!.adapter.sendTurn({ threadId: "t-draft", text: "draft a reply to ticket 812", cwd: workspace, addDirs: [scratch], routeAsks: true, askLevel: true, draftOnly: true, integrations: EVERY_MOUNT });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-draft");
    expect(done).toMatchObject({ ok: true });
    const seen = dumpOf(dump);
    const tools = seen.argv.indexOf("--tools");
    expect(tools, seen.argv.join(" ")).toBeGreaterThan(-1);
    expect(seen.argv[tools + 1]).toBe("");
    expect(seen.argv).toContain("--strict-mcp-config");
    expect(seen.argv).not.toContain("--permission-prompt-tool");
    expect(seen.argv).not.toContain("--add-dir");
    expect(Object.keys(seen.mcpConfig.mcpServers)).toEqual(["murage_connectors"]);
    expect(seen.argv[seen.argv.indexOf("--allowedTools") + 1]).toBe("mcp__murage_connectors");
    expect(JSON.parse(readFileSync(seen.argv[seen.argv.indexOf("--settings") + 1]!, "utf8")).disableAllHooks).toBe(true);
    expect(seen.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(seen.cwd).not.toBe(workspace);
    expect(seen.cwd.startsWith(join(DATA_DIR, "draft-only-cwd"))).toBe(true);
    expect(seen.cwdEntries).toEqual([]);
  }, 30_000);

  it("with no connected apps, the strict MCP config is empty", async () => {
    const dump = join(scratch, "dump-empty.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await create();
    await instance!.adapter.sendTurn({ threadId: "t-draft-empty", text: "draft", routeAsks: true, askLevel: true, draftOnly: true });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-draft-empty");
    const seen = dumpOf(dump);
    expect(seen.argv[seen.argv.indexOf("--tools") + 1]).toBe("");
    expect(seen.mcpConfig?.mcpServers ?? {}).toEqual({});
    expect(seen.argv).not.toContain("--permission-prompt-tool");
  }, 30_000);

  // R6 (Astra r2): Claude loads cowork_settings.json instead of settings.json when CLAUDE_CODE_USE_COWORK_PLUGINS is set.
  it("refuses with the owner line when cowork_settings.json sets a credential helper, and starts nothing", async () => {
    const dump = join(scratch, "dump-cowork.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    writeFileSync(join(config, "cowork_settings.json"), JSON.stringify({ apiKeyHelper: "/usr/local/bin/print-key" }));
    await create({ CLAUDE_CODE_USE_COWORK_PLUGINS: "1" });
    await instance!.adapter.sendTurn({ threadId: "t-cowork", text: "draft", routeAsks: true, askLevel: true, draftOnly: true });
    await refusedWithLine("t-cowork");
    expect(existsSync(dump)).toBe(false);
  }, 30_000);

  it.each([
    ["a header helper in settings.json", "settings.json", JSON.stringify({ otelHeadersHelper: "/usr/local/bin/headers" })],
    ["an AWS refresh in settings.local.json", "settings.local.json", JSON.stringify({ awsAuthRefresh: "aws sso login" })],
    ["a settings.json that does not parse", "settings.json", "{ not json"],
  ])("refuses with the owner line on %s, and starts nothing", async (_name, file, text) => {
    const dump = join(scratch, `dump-${file}.json`);
    process.env.FAKE_CLAUDE_DUMP = dump;
    writeFileSync(join(config, file), text);
    await create();
    await instance!.adapter.sendTurn({ threadId: "t-helper", text: "draft", routeAsks: true, askLevel: true, draftOnly: true });
    await refusedWithLine("t-helper");
    expect(existsSync(dump)).toBe(false);
  }, 30_000);

  // R2: a helper that appears between a launch and its relaunch refuses the relaunch.
  it("judges a relaunch again: a helper written after the first launch refuses the retry", async () => {
    process.env.FAKE_CLAUDE_PRE_ACCEPT_TRANSIENTS = "1";
    process.env.FAKE_CLAUDE_STATE = join(scratch, "launches");
    process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
    process.env.FAKE_CLAUDE_LAUNCH_WRITE = join(config, "settings.json");
    process.env.FAKE_CLAUDE_LAUNCH_WRITE_TEXT = JSON.stringify({ apiKeyHelper: "/usr/local/bin/print-key" });
    await create();
    // larger than any pipe buffer, so the pre-accept launch's write is refused and the driver relaunches (claude.test.ts U-17)
    await instance!.adapter.sendTurn({ threadId: "t-relaunch", text: "x".repeat(4 * 1024 * 1024), routeAsks: true, askLevel: true, draftOnly: true });
    await refusedWithLine("t-relaunch");
    expect(readFileSync(join(scratch, "launches"), "utf8")).toBe("1");
  }, 30_000);

  it("judges every later turn again: a helper added after a turn refuses the next one", async () => {
    const dump = join(scratch, "dump-later.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await create();
    await instance!.adapter.sendTurn({ threadId: "t-later", text: "draft one", routeAsks: true, askLevel: true, draftOnly: true });
    expect(await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-later")).toMatchObject({ ok: true });
    writeFileSync(join(config, "settings.json"), JSON.stringify({ gcpAuthRefresh: "gcloud auth login" }));
    recorder.events.length = 0;
    await instance!.adapter.sendTurn({ threadId: "t-later", text: "draft two", routeAsks: true, askLevel: true, draftOnly: true });
    await refusedWithLine("t-later");
  }, 30_000);
});

describe("claudeDraftOnlyFacts (R1, R6)", () => {
  const managedIn = (root: string) => join(root, "managed-settings.json");
  it("reads the user file the launch loads: cowork_settings.json under CLAUDE_CODE_USE_COWORK_PLUGINS, settings.json otherwise", () => {
    const managed = managedIn(join(scratch, "policy"));
    writeFileSync(join(config, "cowork_settings.json"), JSON.stringify({ apiKeyHelper: "x" }));
    expect(claudeDraftOnlyFacts([{ CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_USE_COWORK_PLUGINS: "1" }], scratch, [managed]).claudeHelpers).toBe(true);
    expect(claudeDraftOnlyFacts([{ CLAUDE_CONFIG_DIR: config }], scratch, [managed]).claudeHelpers).toBe(false);
    // either env the launch is built from counts
    expect(claudeDraftOnlyFacts([{ CLAUDE_CONFIG_DIR: config }, { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_USE_COWORK_PLUGINS: "1" }], scratch, [managed]).claudeHelpers).toBe(true);
  });
  it("counts managed hooks, managed helpers, a managed-mcp.json and a managed file that does not parse", () => {
    const clean = { CLAUDE_CONFIG_DIR: config };
    const policy = (name: string) => { const dir = join(scratch, name); mkdirSync(dir, { recursive: true }); return dir; };
    let dir = policy("p-none");
    expect(claudeDraftOnlyFacts([clean], scratch, [managedIn(dir)])).toEqual({ claudeHelpers: false, managedHooks: false, managedMcp: false });
    dir = policy("p-hooks");
    writeFileSync(managedIn(dir), JSON.stringify({ hooks: { SessionStart: [] } }));
    expect(claudeDraftOnlyFacts([clean], scratch, [managedIn(dir)]).managedHooks).toBe(true);
    dir = policy("p-dropin");
    mkdirSync(join(dir, "managed-settings.d"));
    writeFileSync(join(dir, "managed-settings.d", "10-org.json"), JSON.stringify({ hooks: {} }));
    expect(claudeDraftOnlyFacts([clean], scratch, [managedIn(dir)]).managedHooks).toBe(true);
    dir = policy("p-helper");
    writeFileSync(managedIn(dir), JSON.stringify({ awsCredentialExport: "x" }));
    expect(claudeDraftOnlyFacts([clean], scratch, [managedIn(dir)]).claudeHelpers).toBe(true);
    dir = policy("p-mcp");
    writeFileSync(join(dir, "managed-mcp.json"), "{}");
    expect(claudeDraftOnlyFacts([clean], scratch, [managedIn(dir)]).managedMcp).toBe(true);
    dir = policy("p-bad");
    writeFileSync(managedIn(dir), "{");
    expect(claudeDraftOnlyFacts([clean], scratch, [managedIn(dir)])).toMatchObject({ claudeHelpers: true, managedHooks: true });
  });
  it("a model id map alone is not a helper", () => {
    writeFileSync(join(config, "settings.json"), JSON.stringify({ modelOverrides: { opus: "x" } }));
    expect(claudeDraftOnlyFacts([{ CLAUDE_CONFIG_DIR: config }], scratch, [managedIn(join(scratch, "none"))]).claudeHelpers).toBe(false);
  });
});
