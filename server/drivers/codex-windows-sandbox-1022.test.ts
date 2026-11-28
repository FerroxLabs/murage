// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 q1022-winterry (customer report, Windows team): a bot's Codex turn on Windows failed before PowerShell started with
// "orchestrator_helper_exit_nonzero", approving sent the user into the Codex app, and routines hung with no first response.
// The owner's config.toml is copied into each bot's scoped CODEX_HOME. It carried `[windows] sandbox = "elevated"` (the Codex app's
// setup, whose state stays in the owner's own home) and the Codex app's `notify` program. Driven through CodexDriver.sendTurn on the
// fake app-server: the app-server argv pins the unelevated sandbox over the copied file, and the scope's copy has no owner notify.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordAdmittedEvents, type EventRecorder } from "../testing/admitted-events.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
import { CodexDriver } from "./codex.ts";
import { resetIsolationCache } from "./isolation-cache.ts";

const FAKE_CODEX = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");
const OWNER_CONFIG = [
  'model = "gpt-owner"',
  'notify = ["C:\\\\Program Files\\\\Codex\\\\codex-app.exe", "--notify"]',
  "",
  "[windows]",
  'sandbox = "elevated"',
  "",
].join("\n");

let scratch: string;
let ownerHome: string;
let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;
let seq = 0;

beforeEach(() => {
  ensureDirs();
  resetIsolationCache();
  chmodSync(FAKE_CODEX, 0o755);
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "murage-codex-winsbx-")));
  ownerHome = join(scratch, "owner-codex");
  mkdirSync(ownerHome, { recursive: true });
  writeFileSync(join(ownerHome, "config.toml"), OWNER_CONFIG);
});
afterEach(async () => {
  delete process.env.FAKE_CODEX_DUMP;
  recorder?.stop();
  await instance?.dispose();
  instance = undefined;
  recorder = undefined;
  await removeTempDir(scratch);
});

async function botTurn(): Promise<{ argv: string[]; env: Record<string, string | undefined> }> {
  const dump = join(scratch, `codex-${++seq}.json`);
  process.env.FAKE_CODEX_DUMP = dump;
  instance = await CodexDriver.create({ instanceId: "codex-winsbx", displayName: "Codex", environment: { CODEX_HOME: ownerHome }, enabled: true, config: { cli: FAKE_CODEX, fullAuto: false } });
  recorder = recordAdmittedEvents(instance.adapter);
  await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), text: "read the report", threadId: `t-winsbx-${seq}`, model: "gpt-5.6-sol", warmIdentity: { botId: "b-winsbx", audience: "owner" } } as never);
  await vi.waitFor(() => expect(recorder!.events.some((event) => event.type === "turn.completed")).toBe(true), { timeout: 10_000, interval: 25 });
  return JSON.parse(readFileSync(dump, "utf8")) as { argv: string[]; env: Record<string, string | undefined> };
}

describe("q1022-winterry: a bot's Codex never inherits the owner's elevated Windows sandbox or notify program", () => {
  it("the app-server argv pins the unelevated Windows sandbox over the copied config", async () => {
    const { argv, env } = await botTurn();
    // the turn ran in a bot scope whose config.toml still names the elevated sandbox: the pin is what decides
    expect(env.CODEX_HOME).not.toBe(ownerHome);
    const pin = argv.findIndex((arg, i) => argv[i - 1] === "-c" && arg.startsWith("windows.sandbox="));
    expect(pin).toBeGreaterThan(0);
    expect(argv[pin]).toBe('windows.sandbox="unelevated"');
  });

  it("the app-server argv also pins the two legacy feature keys, so a Codex from before [windows] keeps the restricted-token sandbox", async () => {
    const { argv } = await botTurn();
    const pinned = argv.filter((arg, i) => argv[i - 1] === "-c" && arg.startsWith("features.") && arg.includes("windows_sandbox"));
    expect(pinned).toEqual(["features.elevated_windows_sandbox=false", "features.experimental_windows_sandbox=true"]);
  });

  // every TOML spelling of the top-level key: bare, basic-quoted, literal-quoted, and a multi-line array
  it.each([
    ["notify =", OWNER_CONFIG],
    ['"notify" =', OWNER_CONFIG.replace("notify =", '"notify" =')],
    ["'notify' = [\n", OWNER_CONFIG.replace('notify = ["C:\\\\Program Files\\\\Codex\\\\codex-app.exe", "--notify"]', "'notify' = [\n  'C:\\Program Files\\Codex\\codex-app.exe',\n  '--notify',\n]")],
  ])("the scope's config.toml has no owner notify program and keeps the rest (%j)", async (key, ownerConfig) => {
    writeFileSync(join(ownerHome, "config.toml"), ownerConfig);
    expect(ownerConfig).toContain(key);
    expect(ownerConfig).toContain("codex-app.exe");
    const { env } = await botTurn();
    const config = readFileSync(join(env.CODEX_HOME!, "config.toml"), "utf8");
    expect(config).toContain('model = "gpt-owner"');
    expect(config).not.toMatch(/^\s*["']?notify["']?\s*=/m);
    expect(config).not.toContain("codex-app.exe");
  });
});

describe("q1022-winterry: a Windows sandbox setup failure is named once, never left silent", () => {
  it("a command that failed on the setup helper gives the owner one line naming the code", async () => {
    process.env.FAKE_CODEX_TOOLS = JSON.stringify([
      { kind: "shell", id: "read-1", command: "Get-Content report.md", hook: false, failOutput: "orchestrator_helper_exit_nonzero: setup helper exited with status Some(1)" },
      { kind: "shell", id: "read-2", command: "Get-Content notes.md", hook: false, failOutput: "orchestrator_helper_exit_nonzero: setup helper exited with status Some(1)" },
    ]);
    try { await botTurn(); } finally { delete process.env.FAKE_CODEX_TOOLS; }
    const named = recorder!.events.filter((event: any) => event.type === "runtime.error" && String(event.message).includes("Windows sandbox"));
    expect(named.map((event: any) => event.message)).toEqual([
      "Codex could not set up its Windows sandbox on this PC (orchestrator_helper_exit_nonzero), so the command did not run. Murage never runs it outside the sandbox on its own; restart Murage, and if it keeps happening, update Codex.",
    ]);
  });

  it("a command that failed for any other reason is not named a sandbox failure", async () => {
    process.env.FAKE_CODEX_TOOLS = JSON.stringify([
      { kind: "shell", id: "py-1", command: "python orchestrator_main.py", hook: false, failOutput: "Traceback: orchestrator_main.py: sandbox helper_x failed" },
      { kind: "shell", id: "cat-1", command: "type missing.md", hook: false, failOutput: "The system cannot find the file specified (orchestrator_helper_exit_nonzero_count=0)" },
    ]);
    try { await botTurn(); } finally { delete process.env.FAKE_CODEX_TOOLS; }
    expect(recorder!.events.filter((event: any) => event.type === "item.completed" && event.ok === false)).toHaveLength(2);
    expect(recorder!.events.filter((event: any) => event.type === "runtime.error" && String(event.message).includes("Windows sandbox"))).toEqual([]);
  });
});
