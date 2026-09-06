import { expect, it } from "vitest";
import { instanceConfigs, parseStoredConfig, withInstanceEnabled } from "./config.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";

it("explicit discovery never resurrects a default fleet or silently adds Fuigo", () => {
  expect(instanceConfigs({ engineDiscovery: "explicit" })).toEqual({});
  expect(instanceConfigs({ engineDiscovery: "explicit", instances: {} })).toEqual({});
  const configured = instanceConfigs({ engineDiscovery: "explicit", instances: { claude: { driver: "claudeAgent", enabled: false } } });
  expect(Object.keys(configured)).toEqual(["claude"]);
  expect(configured.claude.enabled).toBe(false);
});
it("normal installations retain automatic shipped-engine discovery", () => {
  expect(instanceConfigs({}).fuigo.driver).toBe("fuigoAgent");
  expect(instanceConfigs({ instances: { claude: { driver: "claudeAgent" } } }).fuigo.driver).toBe("fuigoAgent");
});
it("stored explicit discovery survives validation and disabled engines stay unconstructed", async () => {
  const fake = makeFakeDriver({ kind: "claudeAgent" });
  const config = parseStoredConfig({ engineDiscovery: "explicit", instances: { claude: { driver: "claudeAgent", enabled: false } } });
  expect(config.engineDiscovery).toBe("explicit");
  const registry = new ProviderRegistry([fake.driver]);
  await registry.load(instanceConfigs(config));
  expect(fake.created.size).toBe(0);
  expect(registry.instances()).toEqual([]);
});
it("deliberate enablement preserves explicit discovery and never persists injected credentials", () => {
  const config = { engineDiscovery: "explicit" as const, xai: { key: "private-enable-canary" }, instances: { grok: { driver: "grok", enabled: false } } };
  const before = JSON.stringify(config);
  const enabled = withInstanceEnabled(config, "grok", true);
  expect(enabled.ok).toBe(true);
  expect(enabled.config.engineDiscovery).toBe("explicit");
  expect(enabled.config.instances?.grok.enabled).toBe(true);
  expect(JSON.stringify(enabled.config.instances)).not.toContain("private-enable-canary");
  expect(JSON.stringify(config)).toBe(before);
  expect(withInstanceEnabled(config, "__proto__", true).ok).toBe(false);
  expect(withInstanceEnabled(config, "missing", true).ok).toBe(false);
});
