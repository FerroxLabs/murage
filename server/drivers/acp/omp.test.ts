// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OMP over ACP (`omp acp`). The scripted fake ACP CLI stands in for the program; no real omp binary or ~/.omp is
// touched, and every key below is a fixture.
import * as fsPromises from "node:fs/promises";
import { ProviderRegistry } from "../../harness/registry.ts";
import { makeFakeDriver } from "../../testing/fake-driver.ts";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs, instanceConfigs } from "../../config.ts";
import type { ModelCatalog, ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { fixtureCredentialFingerprint } from "../../testing/fixture-dump.ts";
import { fixtureBotFolder } from "../../testing/bot-folder-fixture.ts";
import { useOutsideStoreFixture } from "../../testing/outside-store-fixture.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { BUILT_IN_DRIVERS } from "../builtIn.ts";
import { OmpAgentDriver, ompSupport, resolveOmpModels } from "./omp.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const MODELS = "fixture/alpha,fixture/beta";

useOutsideStoreFixture();
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

describe("OMP ACP driver", () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  beforeEach(() => {
    ensureDirs();
    scratch = mkdtempSync(join(tmpdir(), "murage-omp-"));
  });
  afterEach(async () => {
    vi.mocked(fsPromises.rm).mockClear();
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    recorder = undefined;
    await removeTempDir(scratch);
  });

  async function create(environment: Record<string, string> = {}, config: { cli: string; fullAuto: boolean } = { cli: FAKE_CLI, fullAuto: false }) {
    instance = await OmpAgentDriver.create({
      instanceId: `omp-${Math.random().toString(36).slice(2)}`, displayName: "OMP", enabled: true,
      environment: { FAKE_ACP_MODELS: MODELS, FAKE_ACP_AUTH_METHODS: "agent", FAKE_ACP_DUMP: join(scratch, "launch.json"),
        FAKE_ACP_RPC_DUMP: join(scratch, "rpc.json"), ...environment },
      config,
    });
    recorder = recordEvents(instance.adapter);
    return { instance, recorder };
  }

  it("is a built-in custom engine in fresh and existing fleets, after Fuigo and Flux's engines", () => {
    expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === "ompAgent")).toBe(true);
    expect(instanceConfigs({}).omp?.driver).toBe("ompAgent");
    expect(instanceConfigs({ instances: { claude: { driver: "claudeAgent" } } }).omp?.driver).toBe("ompAgent");
    const order = Object.keys(instanceConfigs({}));
    expect(order.indexOf("omp")).toBeGreaterThan(order.indexOf("fuigo"));
    expect(order.indexOf("omp")).toBeGreaterThan(order.indexOf("claude"));
    expect(OmpAgentDriver.metadata).toMatchObject({ displayName: "OMP", access: "custom" });
  });

  it("lists the models its CLI advertises after its own default, cuts a larger catalog at 128, and keeps no session", async () => {
    const models = Array.from({ length: 130 }, (_, index) => `fixture/model-${index}`);
    const dump = join(scratch, "discovery.json");
    const rpc = join(scratch, "discovery-rpc.json");
    const catalog = await resolveOmpModels({
      ...process.env, FAKE_ACP_MODELS: models.join(","), FAKE_ACP_DUMP: dump, FAKE_ACP_RPC_DUMP: rpc,
      PI_CODING_AGENT_SESSION_DIR: join(scratch, "persons-sessions"),
    }, { cli: FAKE_CLI });
    expect(catalog.default).toBe("agent-default");
    expect(catalog.options.map((option) => option.id)).toEqual(["agent-default", ...models.slice(0, 128)]);
    expect(catalog.options.every((option) => option.custom)).toBe(true);
    // MAIN RULING 1115-NO-SILENT-CAP: the cut is shown, never silent.
    expect(catalog.note).toBe("Showing 128 of 130 models.");
    const launch = JSON.parse(readFileSync(dump, "utf8"));
    expect(launch.argv).toEqual(["acp"]);
    expect(launch.env.PI_CODING_AGENT_SESSION_DIR).not.toBe(join(scratch, "persons-sessions"));
    expect(existsSync(launch.env.PI_CODING_AGENT_SESSION_DIR)).toBe(false);
  });

  it("keeps the discovery cap note through the registry when a Flux row is filtered", async () => {
    const models = ["flux-auto", ...Array.from({ length: 129 }, (_, index) => `fixture/model-${index}`)];
    const catalog = await resolveOmpModels({ ...process.env, FAKE_ACP_MODELS: models.join(",") }, { cli: FAKE_CLI });
    const fake = makeFakeDriver({ kind: "ompAgent" });
    Object.assign(fake.driver, { models: catalog });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ omp: { driver: "ompAgent" } });
    try {
      const [pickerEngine] = await registry.describe();
      expect(pickerEngine.models.options.some(option => option.id === "flux-auto")).toBe(false);
      const pickerCatalog: ModelCatalog = pickerEngine.models;
      expect(pickerCatalog.note).toBe("Showing 128 of 130 models.");
      expect(pickerEngine.models.options.length).toBeGreaterThan(0);
    } finally {
      await registry.disposeAll();
    }
  });

  it("rejects discovery when its temporary session cannot be removed", async () => {
    let leakedDir = "";
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fsPromises.rm).mockImplementation(async (path, options) => {
      if (String(path).includes("murage-omp-discovery-")) {
        leakedDir = String(path);
        throw new Error("fixture cleanup refused");
      }
      return actual.rm(path, options);
    });
    try {
      await expect(resolveOmpModels({ ...process.env, FAKE_ACP_MODELS: MODELS }, { cli: FAKE_CLI })).rejects.toThrow("fixture cleanup refused");
    } finally {
      vi.mocked(fsPromises.rm).mockImplementation(actual.rm);
      if (leakedDir) await removeTempDir(leakedDir);
    }
  });

  it("adds no note when the catalog fits", async () => {
    const catalog = await resolveOmpModels({ ...process.env, FAKE_ACP_MODELS: MODELS }, { cli: FAKE_CLI });
    expect(catalog.note).toBeUndefined();
  });

  it("never hands another engine's sign-in key to OMP", async () => {
    const { instance, recorder } = await create({ COMMAND_CODE_API_KEY: "other-engine-fixture", KIRO_API_KEY: "other-engine-fixture" });
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "omp-isolation", text: "hello", model: "fixture/beta" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const launch = JSON.parse(readFileSync(join(scratch, "launch.json"), "utf8"));
    expect(launch.env.COMMAND_CODE_API_KEY).toBeUndefined();
    expect(launch.env.KIRO_API_KEY).toBeUndefined();
  });

  it("starts nothing when the instance is created", async () => {
    await create();
    expect(existsSync(join(scratch, "launch.json"))).toBe(false);
  });

  it("refuses to start when the CLI is not installed, naming the install command", async () => {
    const { instance, recorder } = await create({}, { cli: join(scratch, "no-such-omp"), fullAuto: false });
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "omp-missing", text: "hello", model: "agent-default" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const errors = recorder.events.filter((event) => event.type === "runtime.error") as Array<{ message: string }>;
    expect(errors.map((event) => event.message).join("\n")).toContain("isn't installed");
    expect(existsSync(join(scratch, "launch.json"))).toBe(false);
    expect(ompSupport.install?.command?.linux).toBe("npm install -g @oh-my-pi/pi-coding-agent");
  });

  it("runs `omp acp` with its provider keys and the picked model, and without a workspace credential", async () => {
    const { instance, recorder } = await create({ ANTHROPIC_API_KEY: "engine-fixture-key", OPENCODE_API_KEY: "workspace-fixture-key" });
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "omp-chat", text: "hello", model: "fixture/beta" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(recorder.events.every((event) => event.provider === "ompAgent")).toBe(true);
    expect(JSON.parse(readFileSync(join(scratch, "rpc.json"), "utf8"))).toContain("authenticate");
    const launch = JSON.parse(readFileSync(join(scratch, "launch.json"), "utf8"));
    expect(launch.argv).toEqual(["acp"]);
    expect(launch.env.ANTHROPIC_API_KEY).toBe(fixtureCredentialFingerprint("engine-fixture-key"));
    expect(launch.env.OPENCODE_API_KEY).toBeUndefined();
  });

  it.each([["ask", false], ["full", true]] as const)("sets no permission mode at %s, so every ask reaches Murage", async (approvalMode, fullAuto) => {
    const { instance, recorder } = await create({}, { cli: FAKE_CLI, fullAuto });
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: `omp-${approvalMode}`, text: "hello", model: "agent-default" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const rpc = JSON.parse(readFileSync(join(scratch, "rpc.json"), "utf8")) as string[];
    expect(rpc).not.toContain("session/set_mode");
    const launch = JSON.parse(readFileSync(join(scratch, "launch.json"), "utf8"));
    expect(launch.argv).toEqual(["acp"]);
  });

  it("turns OMP's session/request_permission into an approval card and answers with the person's choice", async () => {
    const answer = join(scratch, "permission.txt");
    const { instance, recorder } = await create({ FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_FILE: join(scratch, "edit.md"), FAKE_ACP_PERMISSION_ANSWER: answer });
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "omp-permission", text: "edit", model: "agent-default" });
    const ask = await recorder.until((event) => event.type === "request.opened");
    expect(ask.provider).toBe("ompAgent");
    await instance.adapter.respondToRequest("omp-permission", ask.requestId!, { behavior: "deny" });
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
    const threadId = `omp-level-${level.replace(" ", "-")}`;
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text: "edit", model: "agent-default", ...turn });
    const ask = await recorder.until((event) => event.type === "request.opened");
    expect(ask.provider).toBe("ompAgent");
    await instance.adapter.respondToRequest(threadId, ask.requestId!, { behavior: "deny" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const decision = JSON.parse(readFileSync(join(scratch, "launch.json"), "utf8")).decision;
    expect(String(decision?.outcome?.optionId)).toMatch(/^reject/);
  });
});
