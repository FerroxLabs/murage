import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { cloudEngineChoiceRefusal } from "../../cloud-home/runnable-engines.ts";
import { BUILT_IN_DRIVERS } from "../builtIn.ts";
import { DEFAULT_INSTANCES } from "../../default-instances.ts";
import { allInstanceConfigs, stripCliProbeCredentialEnv } from "../../config.ts";
import { recordEvents } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { fixtureBotFolder } from "../../testing/bot-folder-fixture.ts";

const driver = () => BUILT_IN_DRIVERS.find(row => row.driverKind === "deepseekAgent");
it("offers DeepSeek Harness in new and existing fleets after Fuigo", () => {
  expect(driver(), "DeepSeek Harness is selectable").toBeDefined();
  expect(cloudEngineChoiceRefusal(true, "deepseekAgent", true)).toBeTruthy();
  expect(Object.keys(DEFAULT_INSTANCES)[0]).toBe("fuigo");
  expect(DEFAULT_INSTANCES.deepseek).toEqual({ driver: "deepseekAgent" });
  expect(allInstanceConfigs({ instances: { claude: { driver: "claudeAgent" }, fuigo: { driver: "fuigoAgent" } } } as never).deepseek).toMatchObject({ driver: "deepseekAgent" });
});
it("offers the upstream npm install from Settings on each desktop OS", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    expect(driver()?.install?.command?.[platform]).toBe("npm install -g @deepseek-ai/dsh");
  }
  expect(driver()?.install?.needsNode).toBe(true);
});
it("does not hand a DeepSeek credential to unrelated engines", () => {
  const env = { DEEPSEEK_API_KEY: "fake-deepseek-key", PATH: "/bin" };
  stripCliProbeCredentialEnv(env);
  expect(env).toEqual({ PATH: "/bin" });
});
it("selects the model pair and native thinking, then resumes the same conversation", async () => {
  const selected = driver();
  expect(selected, "DeepSeek Harness driver is registered").toBeDefined();
  const home = mkdtempSync(join(tmpdir(), "murage-deepseek-"));
  const instance = await selected!.create({ instanceId: "deepseek", displayName: "DeepSeek Harness", enabled: true,
    environment: { HOME: home, USERPROFILE: home, DSH_HOME: home, DEEPSEEK_API_KEY: "fake-key", FAKE_CUSTOM_ACP_DIRECTORY: home, FAKE_CUSTOM_DEEPSEEK: "1" },
    config: { cli: `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(resolve("server/testing/fake-custom-acp-models.ts"))}`, fullAuto: false } });
  const recorder = recordEvents(instance.adapter);
  const rows = () => readFileSync(join(home, "receipts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  try {
    const first = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "dsh-thread", text: "ACP_PICKER_FIRST", model: "deepseek-official/deepseek-v4-flash", variant: "max" });
    expect(await recorder.until(event => event.type === "turn.completed" && event.turnId === first.turnId), JSON.stringify(recorder.events.filter(e => e.type === "runtime.error"))).toMatchObject({ ok: true });
    const prompt = rows().find(row => row.method === "session/prompt");
    expect(prompt).toMatchObject({ model: '["deepseek-official","deepseek-v4-flash"]', variant: "max" });
    const second = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "dsh-thread", text: "ACP_PICKER_SECOND", resumeCursor: prompt.sessionId, model: "deepseek-official/deepseek-v4-flash", variant: "low" });
    expect(await recorder.until(event => event.type === "turn.completed" && event.turnId === second.turnId)).toMatchObject({ ok: true });
    expect(rows().filter(row => row.method === "session/new")).toHaveLength(1);
    expect(rows().filter(row => row.method === "session/resume")).toHaveLength(1);
    expect(rows().filter(row => row.method === "session/prompt").map(row => row.variant)).toEqual(["max", "low"]);
  } finally { recorder.stop(); await instance.dispose(); await removeTempDir(home); }
});
it("discovers native model pairs and thinking only on explicit refresh", async () => {
  const selected = driver()!;
  const home = mkdtempSync(join(tmpdir(), "murage-deepseek-catalog-"));
  const instance = await selected.create({ instanceId: "dsh-discovery", displayName: "DeepSeek Harness", enabled: true,
    environment: { HOME: home, USERPROFILE: home, DSH_HOME: home, DEEPSEEK_API_KEY: "fake-key", FAKE_CUSTOM_ACP_DIRECTORY: home, FAKE_CUSTOM_DEEPSEEK: "1" },
    config: { cli: `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(resolve("server/testing/fake-custom-acp-models.ts"))}`, fullAuto: false } });
  try {
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(home, "receipts.jsonl"))).toBe(false);
    await instance.refreshModels!({ manual: true });
    expect(instance.models.options).toContainEqual(expect.objectContaining({ id: "deepseek-official/deepseek-v4-flash", variants: expect.arrayContaining([{ id: "max", label: "Max" }]) }));
    expect(readFileSync(join(home, "receipts.jsonl"), "utf8")).not.toContain('"method":"session/prompt"');
  } finally { await instance.dispose(); await removeTempDir(home); }
});
it("reads only a nonempty native API key from an isolated dsh home", async () => {
  const { hasDeepSeekKey, deepseekWireValue, deepseekPickerId } = await import("./deepseek.ts");
  const { writeFileSync } = await import("node:fs");
  const home = mkdtempSync(join(tmpdir(), "murage-dsh-key-"));
  try {
    const env = { DSH_HOME: home };
    expect(hasDeepSeekKey(env)).toBe(false);
    writeFileSync(join(home, ".credentials.yaml"), "version: 1\nrefs:\n  DEEPSEEK_API_KEY: ''\n");
    expect(hasDeepSeekKey(env)).toBe(false);
    writeFileSync(join(home, ".credentials.yaml"), "version: 1\nrefs:\n  DEEPSEEK_API_KEY: fake-native-key\n");
    expect(hasDeepSeekKey(env)).toBe(true);
    const id = "gateway/team/model";
    expect(deepseekPickerId(deepseekWireValue(id))).toBe(id);
    expect(deepseekPickerId('["provider/path","model"]')).toBeNull();
  } finally { await removeTempDir(home); }
});
