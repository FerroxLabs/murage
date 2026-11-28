// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Kiro CLI over ACP (`kiro-cli acp --agent-engine=v3 --auth-method=cli`). The scripted fake ACP CLI stands in for the
// program; no real kiro-cli or Kiro data folder is touched, and every key below is a fixture.
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs, instanceConfigs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { fixtureBotFolder } from "../../testing/bot-folder-fixture.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { useOutsideStoreFixture } from "../../testing/outside-store-fixture.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { BUILT_IN_DRIVERS } from "../builtIn.ts";
import { KiroAgentDriver, kiroDataDir, kiroSignedIn, kiroSupport, kiroUpdateFilter, resolveKiroModels } from "./kiro.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const MODELS = "auto,fixture/model-a,fixture/model-b";

useOutsideStoreFixture();

/** Writes Kiro's sign-in store as kiro-cli 3.1.0 lays it out: an `auth_kv` table of key and value rows. */
function writeStore(dir: string, rows: Array<[string, string]>): void {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "data.sqlite3"));
  try {
    db.exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
    const insert = db.prepare("INSERT INTO auth_kv (key, value) VALUES (?, ?)");
    for (const [key, value] of rows) insert.run(key, value);
  } finally {
    db.close();
  }
}

describe("Kiro sign-in", () => {
  let scratch: string;
  beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "murage-kiro-sign-in-")); });
  afterEach(async () => { await removeTempDir(scratch); });

  it("looks for Kiro's store in the system's local data folder on each platform", () => {
    const home = join(scratch, "home");
    expect(kiroDataDir({ HOME: home }, "darwin")).toBe(join(home, "Library", "Application Support", "kiro-cli"));
    expect(kiroDataDir({ HOME: home }, "linux")).toBe(join(home, ".local", "share", "kiro-cli"));
    expect(kiroDataDir({ HOME: home, XDG_DATA_HOME: join(scratch, "data") }, "linux")).toBe(join(scratch, "data", "kiro-cli"));
    expect(kiroDataDir({ USERPROFILE: home, LOCALAPPDATA: join(scratch, "local") }, "win32")).toBe(join(scratch, "local", "kiro-cli"));
  });

  it("is signed in by a token `kiro-cli login` stored, or by KIRO_API_KEY, and by nothing else", async () => {
    const home = join(scratch, "home");
    const env = { HOME: home };
    expect(await kiroSignedIn(env, "linux")).toBe(false);
    writeStore(kiroDataDir(env, "linux"), [["kirocli:odic:device-registration", "{\"client_id\":\"fixture\"}"], ["unrelated:token", "fixture"]]);
    expect(await kiroSignedIn(env, "linux")).toBe(false);
    expect(await kiroSignedIn({ HOME: home, KIRO_API_KEY: "fixture-key" }, "linux")).toBe(true);
    expect(await kiroSignedIn({ HOME: home, KIRO_API_KEY: "  " }, "linux")).toBe(false);
  });

  it("reads a Builder ID, Identity Center or social login token from the store", async () => {
    for (const [index, key] of ["kirocli:odic:token", "kirocli:social:token", "codewhisperer:odic:token"].entries()) {
      const home = join(scratch, `home-${index}`);
      writeStore(kiroDataDir({ HOME: home }, "darwin"), [[key, "{\"access_token\":\"fixture\"}"]]);
      expect(await kiroSignedIn({ HOME: home }, "darwin"), key).toBe(true);
      expect(await kiroSignedIn({ HOME: home }, "linux"), key).toBe(false);
    }
  });
});

describe("Kiro session updates", () => {
  it("hides Kiro's cloud-settings tool from its start to its end, and nothing after it", () => {
    const filter = kiroUpdateFilter();
    expect(filter({ sessionUpdate: "tool_call", toolCallId: "cloud-1", status: "in_progress", _meta: { kiro: { toolId: "fetch_cloud_config" } } })).toBeNull();
    expect(filter({ sessionUpdate: "tool_call_update", toolCallId: "cloud-1", status: "in_progress" })).toBeNull();
    expect(filter({ sessionUpdate: "tool_call_update", toolCallId: "cloud-1", status: "completed" })).toBeNull();
    const later = { sessionUpdate: "tool_call_update", toolCallId: "cloud-1", status: "completed" };
    expect(filter(later)).toBe(later);
    const work = { sessionUpdate: "tool_call", toolCallId: "write-1", title: "Write File", status: "in_progress" };
    expect(filter(work)).toBe(work);
  });

  it("cuts Kiro's steering echo out of the reply's text and keeps the text before it", () => {
    const filter = kiroUpdateFilter();
    const plain = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } };
    expect(filter(plain)).toBe(plain);
    expect(filter({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done. [STEERING steer-42] also do this" } }))
      .toEqual({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
    expect(filter({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "[STEERING steer-42] also do this" } })).toBeNull();
    const thought = { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "[STEERING steer-42]" } };
    expect(filter(thought)).toBe(thought);
  });
});

describe("Kiro ACP driver", () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  beforeEach(() => {
    ensureDirs();
    scratch = mkdtempSync(join(tmpdir(), "murage-kiro-contract-"));
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    recorder = undefined;
    await removeTempDir(scratch);
  });

  async function create(environment: Record<string, string> = {}, config: { cli: string; fullAuto: boolean } = { cli: FAKE_CLI, fullAuto: false }) {
    instance = await KiroAgentDriver.create({
      instanceId: `kiro-${Math.random().toString(36).slice(2)}`, displayName: "Kiro", enabled: true,
      environment: { FAKE_ACP_MODELS: MODELS, FAKE_ACP_AUTOPILOT: "1", FAKE_ACP_DUMP: join(scratch, "launch.json"),
        KIRO_API_KEY: "engine-fixture-key", ...environment },
      config,
    });
    recorder = recordEvents(instance.adapter);
    return { instance, recorder };
  }
  const configCalls = () => JSON.parse(readFileSync(join(scratch, "launch.json.config.json"), "utf8")) as Array<{ method: string; params: any }>;
  const autopilot = () => configCalls().filter((call) => call.params.configId === "autopilot").map((call) => call.params.value);

  it("is a built-in engine in fresh and existing fleets, after Fuigo and Claude", () => {
    expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === "kiroAgent")).toBe(true);
    expect(instanceConfigs({}).kiro?.driver).toBe("kiroAgent");
    expect(instanceConfigs({ instances: { claude: { driver: "claudeAgent" } } }).kiro?.driver).toBe("kiroAgent");
    const order = Object.keys(instanceConfigs({}));
    expect(order.indexOf("kiro")).toBeGreaterThan(order.indexOf("fuigo"));
    expect(order.indexOf("kiro")).toBeGreaterThan(order.indexOf("claude"));
    expect(KiroAgentDriver.models).toEqual({ default: "agent-default", options: [{ id: "agent-default", label: "Kiro default" }] });
  });

  it("lists the models its CLI advertises after Kiro's own default", async () => {
    const catalog = await resolveKiroModels({ ...process.env, FAKE_ACP_MODELS: MODELS }, { cli: FAKE_CLI });
    expect(catalog.default).toBe("agent-default");
    expect(catalog.options.map((option) => option.id)).toEqual(["agent-default", ...MODELS.split(",")]);
  });

  it("never hands Command Code's key to Kiro", async () => {
    const { instance, recorder } = await create({ COMMAND_CODE_API_KEY: "other-engine-fixture" });
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "kiro-isolation", text: "hello", model: "agent-default" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const launch = JSON.parse(readFileSync(join(scratch, "launch.json"), "utf8"));
    expect(launch.env.COMMAND_CODE_API_KEY).toBeUndefined();
  });

  it("starts nothing when the instance is created", async () => {
    await create();
    expect(existsSync(join(scratch, "launch.json"))).toBe(false);
  });

  it("refuses to start when the CLI is not installed, naming the install command", async () => {
    const { instance, recorder } = await create({}, { cli: join(scratch, "no-such-kiro-cli"), fullAuto: false });
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "kiro-missing", text: "hello", model: "agent-default" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const errors = recorder.events.filter((event) => event.type === "runtime.error") as Array<{ message: string }>;
    expect(errors.map((event) => event.message).join("\n")).toContain("isn't installed");
    expect(existsSync(join(scratch, "launch.json"))).toBe(false);
    expect(kiroSupport.install?.command?.linux).toContain("cli.kiro.dev/install");
  });

  it("runs Kiro's V3 engine over ACP with its key and the picked model", async () => {
    const { instance, recorder } = await create();
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "kiro-chat", text: "hello", model: "fixture/model-b" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(recorder.events.every((event) => event.provider === "kiroAgent")).toBe(true);
    const launch = JSON.parse(readFileSync(join(scratch, "launch.json"), "utf8"));
    expect(launch.argv.slice(-3)).toEqual(["acp", "--agent-engine=v3", "--auth-method=cli"]);
    expect(launch.env.KIRO_API_KEY).toBe("engine-fixture-key");
  });

  it.each([["ask", false], ["full", true]] as const)("keeps Autopilot off at %s, so every ask reaches Murage", async (approvalMode, fullAuto) => {
    const { instance, recorder } = await create({}, { cli: FAKE_CLI, fullAuto });
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: `kiro-${approvalMode}`, text: "hello", model: "agent-default" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(autopilot()).toEqual(["off"]);
  });

  it("shows neither Kiro's cloud-settings tool nor its steering echo in a turn", async () => {
    const frames = JSON.stringify([
      { update: { sessionUpdate: "tool_call", toolCallId: "cloud-1", title: "Fetching your cloud config", kind: "other", status: "in_progress", _meta: { kiro: { toolId: "fetch_cloud_config" } } } },
      { update: { sessionUpdate: "tool_call_update", toolCallId: "cloud-1", status: "completed" } },
    ]);
    const { instance, recorder } = await create({ FAKE_ACP_PRE_FRAMES: frames });
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "kiro-filter", text: "hello", model: "agent-default" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(JSON.stringify(recorder.events)).not.toContain("cloud config");
  });

  it("turns Kiro's session/request_permission into an approval card and answers with the person's choice", async () => {
    const { instance, recorder } = await create({ FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_FILE: join(scratch, "edit.md"), FAKE_ACP_PERMISSION_ANSWER: join(scratch, "permission.txt") });
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "kiro-permission", text: "edit", model: "agent-default" });
    const ask = await recorder.until((event) => event.type === "request.opened");
    expect(ask.provider).toBe("kiroAgent");
    await instance.adapter.respondToRequest("kiro-permission", ask.requestId!, { behavior: "deny" });
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
    const threadId = `kiro-level-${level.replace(" ", "-")}`;
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text: "edit", model: "agent-default", ...turn });
    const ask = await recorder.until((event) => event.type === "request.opened");
    expect(ask.provider).toBe("kiroAgent");
    await instance.adapter.respondToRequest(threadId, ask.requestId!, { behavior: "deny" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const decision = JSON.parse(readFileSync(join(scratch, "launch.json"), "utf8")).decision;
    expect(String(decision?.outcome?.optionId)).toMatch(/^reject/);
    expect(autopilot()).toEqual(["off"]);
  });
});
