// The registry's contract is forward/backward compatibility: a config
// written by a newer or differently-built app must load as an
// unavailable shadow, never crash the fleet. These tests pin that.
import { describe, expect, it } from "vitest";

import type { ModelCatalog } from "../contracts.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { ProviderRegistry } from "./registry.ts";

describe("ProviderRegistry", () => {
  it("disabled instances never reach driver configuration, creation or discovery", async () => {
    const fake = makeFakeDriver();
    let defaults = 0, decoded = 0, created = 0;
    fake.driver.defaultConfig = () => { defaults++; return {}; };
    fake.driver.decodeConfig = () => { decoded++; return {}; };
    fake.driver.create = async () => { created++; throw new Error("disabled provider ran"); };
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ disabled: { driver: "fake", enabled: false, config: { cli: "/must-not-run" } } });
    const [description] = await registry.describe();
    expect({ defaults, decoded, created }).toEqual({ defaults: 0, decoded: 0, created: 0 });
    expect(registry.get("disabled")).toBeNull();
    expect(registry.instances()).toEqual([]);
    expect(description.snapshot).toMatchObject({ state: "unavailable", reason: expect.stringContaining("disabled") });
    expect(description.cliCandidates).toEqual([]);
  });
  it("creates live instances for known drivers", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake", displayName: "Bot A" } });

    const live = registry.get("a");
    expect(live).not.toBeNull();
    expect(live!.driverKind).toBe("fake");
    expect(live!.displayName).toBe("Bot A");
    expect(registry.instances()).toHaveLength(1);
  });

  it("uses defaultConfig when the entry has no config", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    // decodeConfig must NOT have been called — defaultConfig() is used verbatim
    expect(fake.decodedConfigs).toHaveLength(0);
    expect(registry.get("a")).not.toBeNull();
  });

  it("reports cli as overridden only when the raw config sets it", async () => {
    // Regression: override detection used to read the DECODED config, whose
    // cli field is always filled in with the driver default — every instance
    // then showed as "custom" though nothing was touched.
    const fake = makeFakeDriver();
    fake.driver.defaultConfig = () => ({ cli: "fakebin" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({
      untouched: { driver: "fake", config: { other: true } },
      overridden: { driver: "fake", config: { cli: "/opt/fake/custom-bin" } },
      bare: { driver: "fake" },
    });

    const described = Object.fromEntries((await registry.describe()).map((d) => [d.instanceId, d]));
    expect(described.untouched.cli).toBeUndefined();
    expect(described.bare.cli).toBeUndefined();
    expect(described.overridden.cli).toBe("/opt/fake/custom-bin");
    expect(described.untouched.cliDefault).toBe("fakebin");
    expect(described.untouched.access).toBe("subscription");
  });

  it("publishes custom-only access from driver metadata", async () => {
    const fake = makeFakeDriver();
    Object.assign(fake.driver.metadata, { access: "custom" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ local: { driver: "fake" } });
    const [described] = await registry.describe();
    expect(described.access).toBe("custom");
  });

  it("keeps an unknown driver as an unavailable shadow instead of failing", async () => {
    const registry = new ProviderRegistry([makeFakeDriver().driver]);
    await registry.load({ mystery: { driver: "from-the-future", displayName: "Tomorrow" } });

    expect(registry.get("mystery")).toBeNull();
    const [described] = await registry.describe();
    expect(described.snapshot.state).toBe("unavailable");
    expect(described.snapshot.reason).toContain("from-the-future");
    expect(described.displayName).toBe("Tomorrow");
    expect(described.models.options).toHaveLength(0);
  });

  it("downgrades a config-decode failure to a shadow with the error as reason", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ broken: { driver: "fake", config: { bad: true } } });

    expect(registry.get("broken")).toBeNull();
    const [described] = await registry.describe();
    expect(described.snapshot).toMatchObject({ state: "unavailable", reason: "fake: bad config" });
  });

  it("downgrades a create() rejection to a shadow without touching siblings", async () => {
    const good = makeFakeDriver({ kind: "good" });
    const flaky = makeFakeDriver({ kind: "flaky", failCreate: "boom at create" });
    const registry = new ProviderRegistry([good.driver, flaky.driver]);
    await registry.load({
      g: { driver: "good" },
      f: { driver: "flaky" },
    });

    expect(registry.get("g")).not.toBeNull();
    expect(registry.get("f")).toBeNull();
    const described = await registry.describe();
    const f = described.find((d) => d.instanceId === "f")!;
    expect(f.snapshot).toMatchObject({ state: "unavailable", reason: "boom at create" });
  });

  it("describe() reports a snapshot() failure as unavailable rather than throwing", async () => {
    const fake = makeFakeDriver({ failSnapshot: "provider probe exploded" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.snapshot).toMatchObject({ state: "unavailable", reason: "provider probe exploded" });
  });

  it("forwards a live instance's declared effort levels in describe()", async () => {
    const fake = makeFakeDriver({ effortLevels: ["low", "high"] });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.capabilities.effortLevels).toEqual(["low", "high"]);
  });

  it("omits effortLevels from describe() when the driver declares none", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.capabilities.effortLevels).toBeUndefined();
  });

  it("reports whether an instance supports isolated approval review", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    expect((await registry.describe())[0].capabilities.approvalReview).toBe(false);
    Object.assign(registry.get("a")!, { reviewPermission: async () => "ok" });
    expect((await registry.describe())[0].capabilities.approvalReview).toBe(true);
  });

  // describe() is the one choke point every catalog crosses on its way to the
  // picker, so the refresh has to happen HERE, per call and per instance --
  // otherwise the picker's new refresh button re-renders the same stale list.
  it("refreshes every live model catalog before returning each description", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" } });
    const refreshes = { a: 0, b: 0 };
    for (const instanceId of ["a", "b"] as const) {
      const instance = registry.get(instanceId)!;
      const models: ModelCatalog = { default: "", options: [] };
      Object.assign(instance, {
        models,
        refreshModels: async () => {
          refreshes[instanceId] += 1;
          const id = `${instanceId}-${refreshes[instanceId]}`;
          models.default = id;
          models.options = [{ id, label: `Dynamic ${id}` }];
        },
      });
    }

    const first = Object.fromEntries((await registry.describe()).map((row) => [row.instanceId, row.models]));
    expect(first.a.default).toBe("a-1");
    expect(first.b.default).toBe("b-1");

    const second = Object.fromEntries((await registry.describe()).map((row) => [row.instanceId, row.models]));
    expect(second.a.default).toBe("a-2");
    expect(second.b.default).toBe("b-2");
    expect(refreshes).toEqual({ a: 2, b: 2 });
  });

  it("refreshes due catalogs after24hours and manual describes bypass that age without replacing the instance", async () => {
    const fake = makeFakeDriver(); let now = 1000;
    const registry = new ProviderRegistry([fake.driver], () => now);
    await registry.load({ a: { driver: "fake" } });
    const instance = registry.get("a")!; let calls = 0;
    Object.assign(instance, { refreshModels: async () => { calls++; } });
    await registry.refreshModelCatalogs(); expect(calls).toBe(0);
    now += 24 * 60 * 60_000 - 1; await registry.refreshModelCatalogs(); expect(calls).toBe(0);
    now++; await registry.refreshModelCatalogs(); expect(calls).toBe(1);
    await registry.describe(); expect(calls).toBe(2);
    expect(registry.get("a")).toBe(instance); expect(fake.disposed).toEqual([]);
    await registry.disposeAll();
  });

  it("joins manual and scheduled catalog work and drains it before disposal", async () => {
    const fake = makeFakeDriver(); const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } }); let finish!: () => void, calls = 0;
    Object.assign(registry.get("a")!, { refreshModels: () => { calls++; return new Promise<void>(resolve => { finish = resolve; }); } });
    const first = registry.refreshModelCatalogs(false), second = registry.describe();
    await Promise.resolve(); expect(calls).toBe(1);
    const stopping = registry.disposeAll(); await Promise.resolve(); expect(fake.disposed).toEqual([]);
    finish(); await Promise.all([first, second, stopping]); expect(fake.disposed).toEqual(["a"]);
  });

  it("disposeAll disposes every live instance and empties the registry", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" } });

    await registry.disposeAll();
    expect(fake.disposed.sort()).toEqual(["a", "b"]);
    expect(registry.entries()).toHaveLength(0);
    expect(registry.get("a")).toBeNull();
  });
});
