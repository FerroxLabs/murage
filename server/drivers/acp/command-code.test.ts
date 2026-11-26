// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Command Code over ACP (`command-code acp`). The scripted fake ACP CLI stands in for the program; no real
// command-code binary or ~/.commandcode is touched, and every key below is a fixture.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs, instanceConfigs, stripCliProbeCredentialEnv } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { useOutsideStoreFixture } from "../../testing/outside-store-fixture.ts";
import { fixtureBotFolder } from "../../testing/bot-folder-fixture.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { BUILT_IN_DRIVERS } from "../builtIn.ts";
import {
  classifyCommandCodeError, CommandCodeAgentDriver, commandCodeAuthFile, commandCodeSignedIn, commandCodeSupport,
  forgetCommandCodeDiscoverySession, resolveCommandCodeModels,
} from "./command-code.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const MODELS = "fixture/model-a,fixture/model-b";
const homeVar = process.platform === "win32" ? "USERPROFILE" : "HOME";

useOutsideStoreFixture();

describe("Command Code ACP driver", () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  beforeEach(() => {
    ensureDirs();
    scratch = mkdtempSync(join(tmpdir(), "murage-command-code-"));
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    recorder = undefined;
    await removeTempDir(scratch);
  });

  async function create(environment: Record<string, string> = {}, config: { cli: string; fullAuto: boolean } = { cli: FAKE_CLI, fullAuto: false }) {
    instance = await CommandCodeAgentDriver.create({
      instanceId: `command-code-${Math.random().toString(36).slice(2)}`, displayName: "Command Code", enabled: true,
      environment: { FAKE_ACP_MODELS: MODELS, FAKE_ACP_DUMP: join(scratch, "launch.json"), ...environment },
      config,
    });
    recorder = recordEvents(instance.adapter);
    return { instance, recorder };
  }
  const configCalls = () => JSON.parse(readFileSync(join(scratch, "launch.json.config.json"), "utf8")) as Array<{ method: string; params: any }>;
  const signIn = (home: string, file: string, contents: string) => {
    mkdirSync(join(home, ".commandcode"), { recursive: true });
    writeFileSync(join(home, ".commandcode", file), contents);
  };

  it("is registered as an optional engine, never first, beside a person's own custom instance", () => {
    expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === "commandCodeAgent")).toBe(true);
    expect(instanceConfigs({}).commandCode?.driver).toBe("commandCodeAgent");
    const existing = instanceConfigs({ instances: { claude: { driver: "claudeAgent" }, cmd: { driver: "customAcp", config: { cli: "cmd acp" } } } });
    expect(existing.cmd?.driver).toBe("customAcp");
    const order = Object.keys(instanceConfigs({}));
    expect(order.indexOf("commandCode")).toBeGreaterThan(order.indexOf("fuigo"));
    expect(order.indexOf("commandCode")).toBeGreaterThan(order.indexOf("claude"));
    expect(CommandCodeAgentDriver.models).toEqual({ default: "agent-default", options: [{ id: "agent-default", label: "Command Code default" }] });
  });

  it("is signed in by the key `cmd login` stored or by COMMAND_CODE_API_KEY, and by nothing else", () => {
    const home = join(scratch, "home");
    expect(commandCodeSignedIn({ [homeVar]: home })).toBe(false);
    signIn(home, "auth.json", "{\"userName\":\"someone\"}");
    expect(commandCodeSignedIn({ [homeVar]: home })).toBe(false);
    signIn(home, "auth.json", "not json");
    expect(commandCodeSignedIn({ [homeVar]: home })).toBe(false);
    signIn(home, "auth.json", JSON.stringify({ apiKey: "fixture-key", userName: "someone" }));
    expect(commandCodeSignedIn({ [homeVar]: home })).toBe(true);
    expect(commandCodeAuthFile({ [homeVar]: home, COMMANDCODE_API_ENV: "staging" })).toBe(join(home, ".commandcode", "auth.staging.json"));
    expect(commandCodeSignedIn({ [homeVar]: home, COMMANDCODE_API_ENV: "staging" })).toBe(false);
    expect(commandCodeAuthFile({ [homeVar]: home, COMMANDCODE_API_ENV: "constructor" })).toBe(join(home, ".commandcode", "auth.json"));
    expect(commandCodeSignedIn({ [homeVar]: join(scratch, "empty"), COMMAND_CODE_API_KEY: "fixture-key" })).toBe(true);
    expect(commandCodeSignedIn({ [homeVar]: join(scratch, "empty"), COMMAND_CODE_API_KEY: "  " })).toBe(false);
  });

  it("lists the models its CLI advertises after its own default, with no prompt sent", async () => {
    const catalog = await resolveCommandCodeModels({ ...process.env, FAKE_ACP_MODELS: MODELS }, { cli: FAKE_CLI });
    expect(catalog.default).toBe("agent-default");
    expect(catalog.options.map((option) => option.id)).toEqual(["agent-default", ...MODELS.split(",")]);
  });

  it("removes only the files the discovery session itself left in Command Code's projects", async () => {
    const home = join(scratch, "forget-home");
    const projects = join(home, ".commandcode", "projects");
    const file = (folder: string, name: string) => {
      mkdirSync(join(projects, folder), { recursive: true });
      writeFileSync(join(projects, folder, name), "{}");
      return join(projects, folder, name);
    };
    const cwd = join(scratch, "murage-acp-models-fixture");
    const ours = file("tmp-murage-acp-models-fixture", "c7b01536.meta.json");
    const sibling = file("tmp-murage-acp-models-other", "c7b01536.meta.json");
    const project = file("work-app", "c7b01536.meta.json");
    await forgetCommandCodeDiscoverySession({ cwd, sessionId: "c7b01536", env: { [homeVar]: home } });
    expect(existsSync(ours)).toBe(false);
    expect([existsSync(sibling), existsSync(project)]).toEqual([true, true]);
    await forgetCommandCodeDiscoverySession({ cwd, sessionId: "../../x", env: { [homeVar]: home } });
  });

  it("reads -32000 as a missing login only when Command Code says so", () => {
    expect(classifyCommandCodeError({ code: -32000, message: "Not authenticated. Run `cmd login` in a terminal first." })).toBe("invalid_credentials");
    expect(classifyCommandCodeError({ code: -32000, message: "session already active" })).toBeUndefined();
    expect(classifyCommandCodeError({ code: -32603, message: "Not authenticated" })).toBeUndefined();
    expect(classifyCommandCodeError(null)).toBeUndefined();
  });

  it("never hands Kiro's key to Command Code, and strips both keys from a CLI probe", async () => {
    const { instance, recorder } = await create({ KIRO_API_KEY: "other-engine-fixture" });
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "command-code-isolation", text: "hello", model: "agent-default" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const launch = JSON.parse(readFileSync(join(scratch, "launch.json"), "utf8"));
    expect(launch.env.KIRO_API_KEY).toBeUndefined();
    const probe: Record<string, string | undefined> = { COMMAND_CODE_API_KEY: "fixture", KIRO_API_KEY: "fixture", PATH: "/usr/bin" };
    stripCliProbeCredentialEnv(probe);
    expect(probe).toEqual({ PATH: "/usr/bin" });
  });

  it("starts nothing when the instance is created", async () => {
    await create();
    expect(existsSync(join(scratch, "launch.json"))).toBe(false);
  });

  it("refuses to start when the CLI is not installed, naming the install command", async () => {
    const { instance, recorder } = await create({}, { cli: join(scratch, "no-such-command-code"), fullAuto: false });
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "command-code-missing", text: "hello", model: "agent-default" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const errors = recorder.events.filter((event) => event.type === "runtime.error") as Array<{ message: string }>;
    expect(errors.map((event) => event.message).join("\n")).toContain("isn't installed");
    expect(existsSync(join(scratch, "launch.json"))).toBe(false);
    expect(commandCodeSupport.install?.command?.linux).toBe("npm install -g command-code");
  });

  it("runs `command-code acp` with the credential key and the picked model", async () => {
    const { instance, recorder } = await create({ COMMAND_CODE_API_KEY: "engine-fixture-key" });
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "command-code-chat", text: "hello", model: "fixture/model-b" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(recorder.events.every((event) => event.provider === "commandCodeAgent")).toBe(true);
    const launch = JSON.parse(readFileSync(join(scratch, "launch.json"), "utf8"));
    expect(launch.argv.at(-1)).toBe("acp");
    expect(launch.env.COMMAND_CODE_API_KEY).toBe("engine-fixture-key");
  });

  it.each([["ask", false], ["full", true]] as const)("runs %s in Command Code's asking mode, never its bypass mode", async (approvalMode, fullAuto) => {
    const { instance, recorder } = await create({}, { cli: FAKE_CLI, fullAuto });
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: `command-code-${approvalMode}`, text: "hello", model: "agent-default" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(configCalls().filter((call) => call.method === "session/set_mode").map((call) => call.params.modeId)).toEqual(["default"]);
  });

  it("turns Command Code's session/request_permission into an approval card and answers with the person's choice", async () => {
    const answer = join(scratch, "permission.txt");
    const { instance, recorder } = await create({ FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_FILE: join(scratch, "edit.md"), FAKE_ACP_PERMISSION_ANSWER: answer });
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "command-code-permission", text: "edit", model: "agent-default" });
    const ask = await recorder.until((event) => event.type === "request.opened");
    expect(ask.provider).toBe("commandCodeAgent");
    await instance.adapter.respondToRequest("command-code-permission", ask.requestId!, { behavior: "deny" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
  });

  // Murage's four levels reach the engine as these turn inputs; each one must still put the ask in front of Murage, and
  // the engine must receive Murage's denial, whatever the instance's own fullAuto setting says.
  it.each([
    ["Ask", { routeAsks: true as const, askLevel: true as const }],
    ["Auto", { routeAsks: true as const }],
    ["Full access", { stopLine: true as const }],
    ["No limits", { stopLine: true as const, noLimits: true as const }],
  ])("at %s a fullAuto instance still sends the ask to Murage and the engine is told no", async (level, turn) => {
    const { instance, recorder } = await create({ FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_FILE: join(scratch, "edit.md") }, { cli: FAKE_CLI, fullAuto: true });
    const threadId = `command-code-level-${level.replace(" ", "-")}`;
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text: "edit", model: "agent-default", ...turn });
    const ask = await recorder.until((event) => event.type === "request.opened");
    expect(ask.provider).toBe("commandCodeAgent");
    await instance.adapter.respondToRequest(threadId, ask.requestId!, { behavior: "deny" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const decision = JSON.parse(readFileSync(join(scratch, "launch.json"), "utf8")).decision;
    expect(String(decision?.outcome?.optionId)).toMatch(/^reject/);
    expect(configCalls().filter((call) => call.method === "session/set_mode").map((call) => call.params.modeId)).toEqual(["default"]);
  });
});
