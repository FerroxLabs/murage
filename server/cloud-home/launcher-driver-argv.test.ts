// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The Cloud launcher must accept every argv the shipped drivers hand it for a normal turn. Each case
// runs the REAL driver on a Cloud home (fake CLI behind it), captures the argv and environment it
// hands the launcher (cloudTurnLaunch builds the request exactly as the server does), and feeds that
// request through the launcher's own Python validation (validate_request via the launcher rig).
// Guards the class of break where a driver gains an argv flag and the launcher grammar does not.
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as procs from "../procs.ts";
import { recordEvents } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { CodexDriver } from "../drivers/codex.ts";
import { ClaudeDriver } from "../drivers/claude.ts";
import { resetClaudeVersionGate } from "../drivers/claude-guards.ts";
import { invalidateCliVersions } from "../cli-version-cache.ts";
import { GrokAgentDriver } from "../drivers/acp/grok.ts";
import { KimiAgentDriver } from "../drivers/acp/kimi.ts";
import { createOpenCodeDriver } from "../drivers/acp/opencode-go.ts";
import { FuigoAgentDriver } from "../drivers/acp/fuigo.ts";
import type { ProviderDriver, ProviderInstance, SendTurnInput } from "../contracts.ts";
import { CLOUD_BROKER_DIR, TURN_BOT, cloudTurnLaunch } from "./turn-process.ts";
import { launcherRig, type Rig } from "./engine-launch-fixture.ts";

const FAKE_ACP = fileURLToPath(new URL("../testing/fake-acp-cli.ts", import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL("../testing/fake-claude-cli.ts", import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL("../testing/fake-codex-app-server.ts", import.meta.url));
const BOT = { botId: "bot-atlas", audience: "owner" as const };

interface Spawn { engine: string; command: string; args: string[]; env: Record<string, string | undefined>; cwd: string }

let rig: Rig | undefined;
let scratch: string;
const disposers: Array<() => Promise<void> | void> = [];

beforeAll(() => { chmodSync(FAKE_CODEX, 0o755); chmodSync(FAKE_ACP, 0o755); chmodSync(FAKE_CLAUDE, 0o755); });
afterEach(async () => {
  resetClaudeVersionGate();
  invalidateCliVersions();
  for (const dispose of disposers.splice(0).reverse()) await dispose();
  rig?.dispose();
  rig = undefined;
  if (scratch) await removeTempDir(scratch);
});

/** Run `drive` on a Cloud home and return every process the driver started (argv + env as handed to spawnCli). */
/** The version the fake CLI reports: a home strips FAKE_ACP_* from the probe environment, so the spawn stub restores it. */
let probeVersion = "";
async function onCloudHome(drive: () => Promise<void>, engine?: string): Promise<Spawn[]> {
  const real = procs.spawnCli;
  const spawned: Spawn[] = [];
  const spy = vi.spyOn(procs, "spawnCli").mockImplementation((cli, args, opts, ...rest) => {
    const env = { ...(opts.env as Record<string, string | undefined>) };
    if (engine) { env.MURAGE_CLOUD_TURN_ENGINE = engine; env[TURN_BOT] = BOT.botId; }
    spawned.push({ engine: env.MURAGE_CLOUD_TURN_ENGINE ?? "", command: String(cli), args: [...args], env, cwd: String(opts.cwd ?? "") });
    // The fake runs as a desktop spawn: the role is lifted for the call only.
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    try { return real(cli, args, { ...opts, env: { ...process.env } }, ...rest); }
    finally { vi.stubEnv("MURAGE_CLOUD_ROLE", engine ? "" : "home"); }
  });
  // The version probe runs the fake as a plain exec (a home sends it through the launcher, which this harness does not run).
  const realExec = procs.execCli;
  const execSpy = vi.spyOn(procs, "execCli").mockImplementation((cli, args, opts, cb) => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    try { realExec(cli, args, { ...opts, env: { ...process.env, ...(probeVersion ? { FAKE_ACP_VERSION: probeVersion } : {}) } }, cb); }
    finally { vi.stubEnv("MURAGE_CLOUD_ROLE", engine ? "" : "home"); }
  });
  vi.stubEnv("MURAGE_CLOUD_ROLE", engine ? "" : "home");
  try { await drive(); } finally { vi.unstubAllEnvs(); spy.mockRestore(); execSpy.mockRestore(); }
  return spawned;
}

/** What the launcher says about one captured spawn: the request is built by the server's own cloudTurnLaunch. */
function throughLauncher(spawn: Spawn, engine: string): { ok: boolean; reason: string; dropped: string[] } {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  let request: Record<string, unknown>;
  try { request = JSON.parse(cloudTurnLaunch(spawn.command, spawn.args, spawn.env, rig!.home(engine))!.request); } finally { vi.unstubAllEnvs(); }
  const verdict = rig!.plan({ ...request, command: rig!.command, cwd: rig!.home(engine) });
  const sent = Object.keys(request.env as object);
  return verdict.ok
    ? { ok: true, reason: "", dropped: sent.filter(name => !(name in verdict.ok!.env)) }
    : { ok: false, reason: verdict.error ?? "refused", dropped: [] };
}

async function turns(driver: ProviderDriver<any>, engine: string, config: Record<string, unknown>, environment: Record<string, string>, sends: SendTurnInput[]): Promise<Spawn[]> {
  return onCloudHome(async () => {
    const instance: ProviderInstance = await driver.create({ instanceId: `${engine}-argv`, displayName: engine, enabled: true, environment, config: driver.decodeConfig(config) });
    disposers.push(() => instance.dispose());
    const recorder = recordEvents(instance.adapter);
    disposers.push(() => recorder.stop());
    for (const send of sends) {
      await instance.adapter.sendTurn({ ...send, cwd: scratch, warmIdentity: BOT });
      await recorder.until(event => event.threadId === send.threadId && event.type === "turn.completed", 20000);
    }
    for (const event of recorder.events) if (event.type === "runtime.error") process.stderr.write(`DRIVER ${engine} runtime.error ${(event as { message?: string }).message}\n`);
  });
}

function expectAccepted(engine: string, spawned: Spawn[]): void {
  const turnSpawns = spawned.filter(spawn => spawn.env.MURAGE_CLOUD_TURN_ENGINE === engine);
  expect(turnSpawns.length, `${engine}: the driver started no process on a Cloud home`).toBeGreaterThan(0);
  rig = launcherRig("cloud-argv-");
  const refused: string[] = [];
  for (const spawn of turnSpawns) {
    const verdict = throughLauncher(spawn, engine);
    process.stderr.write(`ARGV ${engine} ${verdict.ok ? "ACCEPTED" : "REFUSED"} ${JSON.stringify(spawn.args)}${verdict.ok ? "" : " :: " + verdict.reason}${verdict.dropped.length ? " DROPPED_ENV " + verdict.dropped.join(",") : ""}\n`);
    if (!verdict.ok) refused.push(`${JSON.stringify(spawn.args)}: ${verdict.reason}`);
  }
  expect(refused, `${engine} argv the launcher refuses`).toEqual([]);
}

describe("the Cloud launcher accepts the argv the shipped drivers send", () => {
  it("codex: fresh, resumed, Full access and proposal-only turns", async () => {
    scratch = mkdtempSync(join(tmpdir(), "murage-argv-codex-"));
    process.env.FAKE_CODEX_MODE = "resume";
    disposers.push(() => { delete process.env.FAKE_CODEX_MODE; });
    const run = (fullAuto: boolean, sends: SendTurnInput[]) => turns(CodexDriver, "codex", { cli: FAKE_CODEX, fullAuto }, {}, sends);
    const all = [
      ...await run(false, [{ threadId: "t-fresh", text: "hi" }, { threadId: "t-resume", text: "again", resumeCursor: "0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4" }]),
      ...await run(true, [{ threadId: "t-full", text: "hi" }]),
      ...await run(false, [{ threadId: "t-proposal", text: "plan", proposalOnly: true }]),
    ];
    expectAccepted("codex", all);
  });

  // Claude's permission broker binds its socket under /data/broker on a home; the test needs that directory to exist.
  it.skipIf(!existsSync(CLOUD_BROKER_DIR))("claudeAgent: fresh, resumed and Full access turns", async () => {
    scratch = mkdtempSync(join(tmpdir(), "murage-argv-claude-"));
    const run = (permissionMode: string, sends: SendTurnInput[]) => turns(ClaudeDriver, "claudeAgent", { cli: FAKE_CLAUDE, permissionMode }, {}, sends);
    const all = [
      ...await run("acceptEdits", [{ threadId: "t-c-fresh", text: "hi", model: "sonnet" }, { threadId: "t-c-resume", text: "again", resumeCursor: "0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4" }]),
      ...await run("bypassPermissions", [{ threadId: "t-c-full", text: "hi" }]),
    ];
    expectAccepted("claudeAgent", all);
  });

  const acp: Array<[string, string, ProviderDriver<any>, Record<string, string>]> = [
    ["grokAgent", "grok", GrokAgentDriver, { FAKE_ACP_VERSION: "grok 1.0.52 (fixture)", FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized" }],
    ["kimiAgent", "kimi", KimiAgentDriver, {}],
    ["opencodeGo", "opencode", createOpenCodeDriver(async () => ({ default: "opencode-go/minimax-m3", options: [{ id: "opencode-go/minimax-m3", label: "MiniMax" }] })), { OPENCODE_API_KEY: "oc-fixture-key" }],
    ["fuigoAgent", "fuigo", FuigoAgentDriver, { FUIGO_API_KEY: "sk-flux-Ffffffffffffffffffffffffffffffffffffffffff" }],
  ];
  for (const [engine, label, driver, environment] of acp) {
    it(`${engine}: fresh, resumed and Full access turns with a model and effort`, async () => {
      scratch = mkdtempSync(join(tmpdir(), `murage-argv-${label}-`));
      const home = mkdtempSync(join(scratch, "home-"));
      writeFileSync(join(scratch, "x"), "");
      if (engine === "fuigoAgent") { process.env.FLUX_API_KEY = "sk-flux-Ffffffffffffffffffffffffffffffffffffffffff"; disposers.push(() => { delete process.env.FLUX_API_KEY; }); }
      const env = { HOME: home, USERPROFILE: home, FAKE_ACP_MODE: "happy", ...environment };
      probeVersion = environment.FAKE_ACP_VERSION ?? "";
      const sends = (suffix: string): SendTurnInput[] => [
        { threadId: `t-${suffix}-fresh`, text: "hi", model: engine === "opencodeGo" ? "opencode-go/minimax-m3" : "m-fixture", effort: "high" },
        { threadId: `t-${suffix}-resume`, text: "again", resumeCursor: "sess-1" },
      ];
      const all = [
        ...await turns(driver, engine, { cli: FAKE_ACP, fullAuto: false }, env, sends("a")),
        ...await turns(driver, engine, { cli: FAKE_ACP, fullAuto: true }, env, sends("b")),
      ];
      expectAccepted(engine, all);
    });
  }
});
