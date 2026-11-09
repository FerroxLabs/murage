import { replaceClaudeAccountInstances, restoreClaudeAccountInstances } from "./claude-account-config.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR, loadConfig, instanceConfigs, saveConfig } from "./config.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { changedInstanceIds, commitEngineChange, reloadWithRollback, settleEngineChange } from "./engine-change.ts";

beforeEach(() => { removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
async function world(unsafe = false) {
  writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances: { claude: { driver: "fake" }, codex: { driver: "fake" }, fuigo: { driver: "fake" } } }));
  const registry = new ProviderRegistry([makeFakeDriver().driver]);
  const cfg = loadConfig();
  await registry.load(instanceConfigs(cfg));
  return { registry, cfg, loadConfig, instanceConfigs, changedInstanceIds, unsafe: () => unsafe };
}
describe("ENGINE-DEFAULT lifecycle", () => {
  it("EC1/EC4/EC9: marks before save and retains mismatches across unrelated settlements", async () => {
    const host = await world();
    const change = commitEngineChange(host, ["claude"], "scoped", () => {
      expect(host.registry.isRetired("claude")).toBe(true);
      saveConfig({ instances: { claude: { driver: "fake", config: { cli: "changed" } } } });
    });
    expect(host.registry.isRetired("claude")).toBe(true);
    expect(await reloadWithRollback(host, change, async () => { throw Error("failed"); })).toMatchObject({ outcome: "failed" });
    commitEngineChange(host, [], "none", () => saveConfig({ language: "fr" }));
    settleEngineChange(host);
    expect(host.registry.isRetired("claude")).toBe(true);
    await host.registry.reload(new Set(["claude"]), instanceConfigs(loadConfig()));
    settleEngineChange(host);
    expect(host.registry.isRetired("claude")).toBe(false);
  });
  it.each([true, false])("EC6: unsafe=%s determines the full union and reload scope", async unsafe => {
    const host = await world(unsafe);
    await host.registry.load({ extra: { driver: "fake" } });
    const change = commitEngineChange(host, ["claude"], "scoped", () => saveConfig({ instances: { claude: { driver: "fake", config: { revision: 2 } } } }));
    expect(change.wholeFleet).toBe(unsafe);
    expect([...change.marked].sort()).toEqual(unsafe ? ["claude", "codex", "extra", "fuigo"] : ["claude"]);
    const reload = vi.fn(async () => {});
    await reloadWithRollback(host, change, reload);
    expect(reload).toHaveBeenCalledExactlyOnceWith(unsafe ? undefined : new Set(["claude"]));
  });
  it("EC2/EC3/EC8: recovery removes stale cfg keys and keeps marks through recovery", async () => {
    const host = await world();
    const path = join(DATA_DIR, "config.json");
    writeFileSync(path, "{}");
    const before = readFileSync(path, "utf8");
    Object.assign(host.cfg, loadConfig());
    delete host.cfg.instances;
    let receipt!: ReturnType<typeof replaceClaudeAccountInstances>;
    const change = commitEngineChange(host, ["added"], "fleet", () => { receipt = replaceClaudeAccountInstances({ ...instanceConfigs(host.cfg), added: { driver: "fake" } }); });
    let calls = 0;
    const result = await reloadWithRollback(host, change, async () => {
      if (++calls === 1) throw Error("first reload");
      expect(host.registry.isRetired("added")).toBe(true);
      await host.registry.disposeAll();
      await host.registry.load(instanceConfigs(host.cfg));
    }, () => restoreClaudeAccountInstances(receipt));
    expect("instances" in host.cfg).toBe(false);
    expect(result.outcome).toBe("restored");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(host.registry.get("added")).toBeNull();
    expect(host.registry.isRetired("added")).toBe(false);
  });
  it("EC5a: a throwing restore leaves all marks and never settles", async () => {
    const host = await world();
    const change = commitEngineChange(host, ["claude"], "fleet", () => {});
    const settle = vi.spyOn(host.registry, "settle");
    const retire = vi.spyOn(host.registry, "retire");
    const reload = vi.fn(async () => { throw Error("reload"); });
    const restore = vi.fn(() => { saveConfig({ instances: { claude: { driver: "fake", config: { partial: true } } } }); throw Error("restore"); });
    expect(await reloadWithRollback(host, change, reload, restore)).toMatchObject({ outcome: "unconfirmed", restoreCause: expect.any(Error) });
    expect(settle).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(retire.mock.invocationCallOrder[0]).toBeLessThan(restore.mock.invocationCallOrder[0]);
    expect(new Set(host.registry.retiredIds())).toEqual(change.marked);
  });
});

it("EC5b: failed recovery settles only entries that match the restored file", async () => {
  const host = await world();
  const change = commitEngineChange(host, ["claude"], "fleet", () => saveConfig({ instances: { claude: { driver: "fake", config: { changed: true } } } }));
  await host.registry.load({ extra: { driver: "fake" } });
  host.registry.retire(["extra"]);
  const result = await reloadWithRollback(host, change, async () => { throw Error("reload"); }, () => {});
  expect(result).toMatchObject({ outcome: "unconfirmed", recoveryCause: expect.any(Error) });
  expect(host.registry.isRetired("claude")).toBe(true);
  expect(host.registry.isRetired("extra")).toBe(true);
  expect(host.registry.isRetired("codex")).toBe(false);
});
it("EC1(b): a save that writes and throws leaves its changed engine retired", async () => {
  const host = await world();
  expect(() => commitEngineChange(host, ["claude"], "scoped", () => {
    expect(host.registry.isRetired("claude")).toBe(true);
    saveConfig({ instances: { claude: { driver: "fake", config: { changed: true } } } });
    throw Error("save failed after write");
  })).toThrow("save failed after write");
  expect(host.registry.isRetired("claude")).toBe(true);
});
it("EC7: a new registry after restore uses the file with no inherited marker", async () => {
  const host = await world();
  const bytes = readFileSync(join(DATA_DIR, "config.json"), "utf8");
  const change = commitEngineChange(host, ["claude"], "fleet", () => saveConfig({ instances: { claude: { driver: "fake", enabled: false } } }));
  let calls = 0;
  await reloadWithRollback(host, change, async () => {
    if (++calls === 1) throw Error("failed");
    const restarted = new ProviderRegistry([makeFakeDriver().driver]);
    await restarted.load(instanceConfigs(loadConfig()));
    expect(restarted.get("claude")).not.toBeNull();
    expect(restarted.retiredIds()).toEqual([]);
  }, () => writeFileSync(join(DATA_DIR, "config.json"), bytes));
});
it("F11c: the Cloud save closure retires live Fuigo until reload settles", async () => {
  const { Store } = await import("./store.ts");
  const { withoutCloudCredentials } = await import("./cloud-home/credentials.ts");
  const { syncCredentialEnv } = await import("./config.ts");
  const host = await world();
  const live = host.registry.get("fuigo")!;
  const store = new Store({ copyChief: false, fuigo: () => [{ instanceId: "fuigo", driverKind: "fuigoAgent", models: live.models }], eligible: id => host.registry.get(id) !== null && !host.registry.isRetired(id) });
  const patch = { xai: { key: "fixture-cloud-key" } };
  const cloudHome = true, externalSecretStorage = false, persisted = structuredClone(patch);
  let configWriteCommitted = false;
  const change = commitEngineChange(host, [], "fleet", () => {
    if (cloudHome) saveConfig(withoutCloudCredentials(patch));
    else if (externalSecretStorage) saveConfig(persisted);
    else saveConfig(patch);
    configWriteCommitted = true;
    syncCredentialEnv(patch);
  });
  expect(configWriteCommitted).toBe(true);
  let release!: () => void;
  const operation = reloadWithRollback(host, change, () => new Promise<void>(resolve => { release = resolve; }));
  const bot = store.createBot({}, { seedMessages: false });
  expect(bot).toMatchObject({ modelSelection: { instanceId: "" }, engineAutoPicked: true });
  expect(JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")).find((b: any) => b.id === bot.id)).toMatchObject({ modelSelection: { instanceId: "" }, engineAutoPicked: true });
  release(); expect((await operation).outcome).toBe("applied");
  expect(store.birthSelection().instanceId).toBe("fuigo");
  delete process.env.XAI_API_KEY;
});

it("EC3/EC8: DELETE rollback keeps the account retired until real recovery completes", async () => {
  const host = await world();
  const original = instanceConfigs(host.cfg);
  let receipt!: ReturnType<typeof replaceClaudeAccountInstances>;
  const next = { ...original }; delete next.claude;
  const change = commitEngineChange(host, ["claude"], "fleet", () => { receipt = replaceClaudeAccountInstances(next); });
  const settle = vi.spyOn(host.registry, "settle");
  const retire = vi.spyOn(host.registry, "retire");
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const result = reloadWithRollback(host, change, async () => {
    if (++calls === 1) throw Error("rebuild failed");
    expect(settle).not.toHaveBeenCalled();
    expect(retire).toHaveBeenCalledWith(change.marked);
    expect(instanceConfigs(loadConfig()).claude).toEqual(original.claude);
    expect(host.registry.isRetired("claude")).toBe(true);
    entered(); await gate;
    await host.registry.disposeAll(); await host.registry.load(instanceConfigs(host.cfg));
  }, () => restoreClaudeAccountInstances(receipt));
  await waiting;
  expect(host.registry.get("claude")).not.toBeNull();
  expect(host.registry.isRetired("claude")).toBe(true);
  release(); expect((await result).outcome).toBe("restored");
  expect(host.registry.get("claude")).not.toBeNull();
  expect(host.registry.isRetired("claude")).toBe(false);
});
it("EC6(a/d): fleet mode covers registry-only ids and a no-reload save settles once", async () => {
  const host = await world();
  await host.registry.load({ extra: { driver: "fake" } });
  const change = commitEngineChange(host, ["new"], "fleet", () => saveConfig({ instances: { new: { driver: "fake" } } }));
  expect([...change.marked].sort()).toEqual(["claude", "codex", "extra", "fuigo", "new"]);
  const reload = vi.fn(async () => {});
  await reloadWithRollback(host, change, reload);
  expect(reload).toHaveBeenCalledExactlyOnceWith(undefined);
  const settle = vi.spyOn(host.registry, "settle");
  commitEngineChange(host, [], "none", () => saveConfig({ language: "fr" }));
  settleEngineChange(host);
  expect(settle).toHaveBeenCalledTimes(1);
  expect(host.registry.isRetired("new")).toBe(true);
});
