// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { ensureDirs } from "../config.ts";
import { invalidateCliVersions } from "../cli-version-cache.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { bindFixtureAdapter } from "../testing/mcp-admission-fixture.ts";
import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
import { ClaudeDriver, resetClaudeMcpReadinessForTests, type ClaudeConfig } from "./claude.ts";
import { resetClaudeVersionGate } from "./claude-guards.ts";

vi.mock("node:child_process", async original => (await import("../testing/exec-check-spy.ts")).withExecCheckSpy(await original()));
vi.mock("./claude-s2-qualification.ts", async original => {
  const actual = await original<typeof import("./claude-s2-qualification.ts")>();
  return (await import("../testing/claude-s2-wire-receipt.ts")).withClaudeWireReceipt(actual);
});

const FAKE_CLI = fileURLToPath(new URL("../testing/fake-claude-cli.ts", import.meta.url));
const UNUSABLE = ["Workflow", "ScheduleWakeup", "ReportFindings", "ListAgents"];
let scratch: string;
let instance: ProviderInstance | undefined;
let recorder: EventRecorder;

beforeEach(() => {
  ensureDirs();
  chmodSync(FAKE_CLI, 0o755);
  scratch = mkdtempSync(join(tmpdir(), "murage-claude-cost-"));
  resetClaudeMcpReadinessForTests();
});
afterEach(async () => {
  recorder?.stop();
  await instance?.dispose();
  instance = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetClaudeVersionGate();
  resetClaudeMcpReadinessForTests();
  invalidateCliVersions();
  await removeTempDir(scratch);
});

async function create(config: Partial<ClaudeConfig> = {}, environment: Record<string, string> = {}) {
  instance = await ClaudeDriver.create({ instanceId: "claude-cost", displayName: "Claude", enabled: true,
    environment, config: { ...config, cli: FAKE_CLI, permissionMode: "acceptEdits" } });
  bindFixtureAdapter(instance.adapter);
  recorder = recordEvents(instance.adapter);
}
async function send(extra: Partial<SendTurnInput> = {}) {
  const sent = await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "cost-thread", text: "hello", ...extra });
  return recorder.until(e => e.type === "turn.completed" && e.turnId === sent.turnId);
}
function argv() {
  return (JSON.parse(readFileSync(join(scratch, "launch.json"), "utf8")) as { argv: string[] }).argv;
}
function denied() {
  const args = argv(), at = args.indexOf("--disallowedTools");
  return at < 0 ? [] : args[at + 1].split(",");
}

it("omits unusable native tools from a default isolated owner turn and keeps owner denials once", async () => {
  vi.stubEnv("FAKE_CLAUDE_DUMP", join(scratch, "launch.json"));
  await create({ disallowedTools: ["Edit", "Workflow", "Bash(git *)"] });
  expect(await send()).toMatchObject({ ok: true });
  for (const tool of [...UNUSABLE, "Edit", "Bash(git *)"]) expect(denied().filter(t => t === tool)).toHaveLength(1);
  expect(argv()).not.toContain("--tools");
});

for (const tools of [["Read", "Workflow", "ListAgents"], []]) {
  it(`keeps an explicit native tool list ${JSON.stringify(tools)}`, async () => {
    vi.stubEnv("FAKE_CLAUDE_DUMP", join(scratch, "launch.json"));
    await create({ tools, disallowedTools: ["Edit"] });
    expect(await send()).toMatchObject({ ok: true });
    expect(argv()[argv().indexOf("--tools") + 1]).toBe(tools.join(","));
    expect(denied()).toContain("Edit");
    for (const tool of UNUSABLE) expect(denied()).not.toContain(tool);
  });
}

for (const [name, extra] of [
  ["guest audience", { warmIdentity: { botId: "fixture-bot", audience: "non-owner" } }],
  ["tool-free draft", { draftOnly: true }],
  ["No limits", { noLimits: true }],
  ["live No limits", { permissionNow: () => ({ noLimits: true as const }) }],
] as const) {
  it(`keeps the ${name} tool policy`, async () => {
    vi.stubEnv("FAKE_CLAUDE_DUMP", join(scratch, "launch.json"));
    await create({ disallowedTools: ["Edit"] });
    expect(await send(extra)).toMatchObject({ ok: true });
    for (const tool of UNUSABLE) expect(denied()).not.toContain(tool);
    if (name.includes("No limits")) expect(denied()).not.toContain("Edit");
    else expect(denied()).toContain("Edit");
  });
}

it("names no saved-session cursor in the launch failure it logs", async () => {
  const cursor = "cursor-9f3a7c1e5b2d";
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await create({ tools: [] }, { FAKE_CLAUDE_PRE_ACCEPT_TRANSIENTS: "9", FAKE_CLAUDE_STATE: join(scratch, "launches"),
    FAKE_CLAUDE_PRE_ACCEPT_STDERR: `no conversation found with session ID: ${cursor}` });
  expect(await send({ resumeCursor: cursor })).toMatchObject({ ok: false });
  const logs = warn.mock.calls.flat().join("\n");
  expect(logs).toContain("no conversation found");
  expect(logs).not.toContain(cursor);
});

it("logs a saved-session launch failure with its redacted reason and no replay", async () => {
  const secret = "Q7x".repeat(70);
  const diagnostic = `could not load saved session: api_key=${secret}`;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await create({ tools: [] }, { FAKE_CLAUDE_PRE_ACCEPT_TRANSIENTS: "9", FAKE_CLAUDE_STATE: join(scratch, "launches"),
    FAKE_CLAUDE_PRE_ACCEPT_STDERR: diagnostic });
  expect(await send({ resumeCursor: "saved-session" })).toMatchObject({ ok: false });
  const logs = warn.mock.calls.flat().join("\n");
  expect(logs).toContain("could not resume the saved session");
  expect(logs).toContain("could not load saved session");
  expect(logs).not.toContain(secret);
  expect(logs).not.toContain("Q7x");
  expect(logs.length).toBeLessThan(9_000);
  expect(recorder.events.some(e => e.type === "turn.retrying")).toBe(false);
  expect(readFileSync(join(scratch, "launches"), "utf8")).toBe("1");
});

it("logs launch flag refusal when a saved session could not start", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await create({}, { FAKE_CLAUDE_REFUSE: "unknown-option" });
  expect(await send({ resumeCursor: "saved-session" })).toMatchObject({ ok: false });
  expect(warn.mock.calls.flat().join("\n")).toContain("could not resume the saved session");
});

it("does not log a resume failure for a successful resume or a fresh launch failure", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await create();
  expect(await send({ resumeCursor: "saved-session" })).toMatchObject({ ok: true });
  await instance!.dispose();
  await create({}, { FAKE_CLAUDE_REFUSE: "unknown-option" });
  expect(await send()).toMatchObject({ ok: false });
  expect(warn.mock.calls.flat().join("\n")).not.toContain("could not resume the saved session");
});

it("never relaunches a resumed turn whose model call already answered", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await create({}, { FAKE_CLAUDE_FAIL_AFTER: "text", FAKE_CLAUDE_STATE: join(scratch, "launches"), FAKE_CLAUDE_RETRY_SCALE: "0.001" });
  expect(await send({ resumeCursor: "saved-session" })).toMatchObject({ ok: false });
  expect(recorder.events.some(e => e.type === "item.completed" && e.itemType === "assistant_text")).toBe(true);
  expect(recorder.events.some(e => e.type === "turn.retrying")).toBe(false);
  expect(readFileSync(join(scratch, "launches"), "utf8")).toBe("1");
  expect(warn.mock.calls.flat().join("\n")).not.toContain("could not resume the saved session");
});

useOutsideStoreFixture();
