// CLAC2: GET /api/claude-accounts ran registry.describe(), which refreshes
// every live model catalog and snapshots every engine. Under load the Claude
// accounts section kept every button disabled for seconds after each change.
// These tests run the real ProviderRegistry with counting drivers.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listClaudeAccounts } from "./claude-account-list.ts";
import { newClaudeAccount } from "./claude-accounts.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";

type Call = { instanceId: string; call: "snapshot" | "refreshModels" };
function countedFleet() {
  const calls: Call[] = [];
  const drivers = [makeFakeDriver({ kind: "claudeAgent" }), makeFakeDriver({ kind: "codex" })].map(({ driver }) => {
    const create = driver.create.bind(driver);
    driver.create = async input => {
      const instance = await create(input), snapshot = instance.snapshot;
      return Object.assign(instance, {
        snapshot: async () => { calls.push({ instanceId: input.instanceId, call: "snapshot" }); return { ...await snapshot(), authenticated: input.instanceId !== "claude" }; },
        refreshModels: async () => { calls.push({ instanceId: input.instanceId, call: "refreshModels" }); },
      });
    };
    return driver;
  });
  return { registry: new ProviderRegistry(drivers), calls };
}

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const instances: InstanceConfigMap = { codex: { driver: "codex" }, claude: { driver: "claudeAgent", config: { cli: "claude" } } };

describe("listClaudeAccounts", () => {
  it("probes only Claude accounts: no other engine's snapshot and no catalog refresh", async () => {
    const { registry, calls } = countedFleet();
    await registry.load(instances);
    // The full probe the list used to pay on every refresh.
    await registry.describe();
    expect(calls).toEqual(expect.arrayContaining([{ instanceId: "codex", call: "refreshModels" }, { instanceId: "codex", call: "snapshot" }]));
    calls.length = 0;

    const accounts = await listClaudeAccounts(registry, instances);
    expect(accounts.map(account => account.instanceId)).toEqual(["claude"]);
    expect(accounts[0]).toMatchObject({ displayName: "claude", managed: false, isDefault: true, configDir: "", snapshot: { state: "available", authenticated: false } });
    expect(calls).toEqual([{ instanceId: "claude", call: "snapshot" }]);
    await registry.disposeAll();
  });

  it("reflects a just-created account with its own directory, sign-in command and fresh snapshot", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "murage-claude-account-list-")); dirs.push(dataDir);
    const { registry, calls } = countedFleet();
    await registry.load(instances);
    expect((await listClaudeAccounts(registry, instances)).map(account => account.instanceId)).toEqual(["claude"]);

    // The route replaces the instance map and reloads the fleet before answering.
    const created = newClaudeAccount(instances, { displayName: "Work" }, dataDir);
    await registry.disposeAll(); await registry.load(created.instances); calls.length = 0;
    const directory = join(dataDir, "providers", created.instanceId);
    const accounts = await listClaudeAccounts(registry, created.instances);
    expect(accounts.map(account => account.instanceId)).toEqual(["claude", created.instanceId]);
    const work = accounts[1];
    expect(work).toMatchObject({ displayName: "Work", managed: true, isDefault: false, configDir: directory, snapshot: { state: "available", authenticated: true } });
    expect(work.signInCommand).toContain(`CLAUDE_CONFIG_DIR='${directory}'`);
    expect(work.signInCommand).toContain("'auth' 'login'");
    expect(calls.filter(call => call.instanceId === "codex" || call.call === "refreshModels")).toEqual([]);

    // A create/save receipt probes the changed account alone.
    calls.length = 0;
    const receipt = await listClaudeAccounts(registry, created.instances, created.instanceId);
    expect(receipt).toEqual([work]);
    expect(calls).toEqual([{ instanceId: created.instanceId, call: "snapshot" }]);
    await registry.disposeAll();
  });

  it("keeps a disabled, failing or unloaded account readable without probing anything else", async () => {
    const failing = makeFakeDriver({ kind: "claudeAgent", failSnapshot: "claude --version exited 1" });
    const registry = new ProviderRegistry([failing.driver]);
    const fleet: InstanceConfigMap = {
      claude: { driver: "claudeAgent" },
      "claude-off": { driver: "claudeAgent", displayName: "Off", enabled: false, config: { configDir: "/fixture/off" } },
    };
    await registry.load(fleet);
    const accounts = await listClaudeAccounts(registry, { ...fleet, "claude-new": { driver: "claudeAgent", displayName: "Not loaded", config: { configDir: "/fixture/new" } } });
    expect(accounts.map(account => [account.instanceId, account.snapshot])).toEqual([
      ["claude", { state: "unavailable", reason: "claude --version exited 1" }],
      ["claude-off", { state: "unavailable", reason: "This engine is disabled. Enable it before starting new work." }],
      ["claude-new", { state: "unavailable", reason: "Account engine is unavailable." }],
    ]);
    await registry.disposeAll();
  });
});
