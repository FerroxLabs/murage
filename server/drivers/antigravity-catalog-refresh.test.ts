import { describe, expect, it, vi } from "vitest";
const probe = vi.hoisted(() => ({ output: "provider-model\tProvider model\n", pending: null as null | ((callback: (error: Error | null, stdout: string, stderr: string) => void) => void) }));
vi.mock("../procs.ts", async (original) => {
  const actual = await original<typeof import("../procs.ts")>();
  return { ...actual, execCli: (...args: Parameters<typeof actual.execCli>) => {
    if (args[1][0] === "models") {
      const callback = args[3];
      if (probe.pending) { probe.pending(callback); return; }
      callback(probe.output ? null : new Error("offline"), probe.output, "");
      return;
    }
    return actual.execCli(...args);
  } };
});
import { AntigravityDriver } from "./antigravity.ts";

describe("Antigravity catalog refresh", () => {
  it("keeps its last usable live models when a later CLI probe fails", async () => {
    const instance = await AntigravityDriver.create({ instanceId: "catalog-fixture", displayName: "Fixture",
      environment: {}, enabled: true, config: AntigravityDriver.defaultConfig() });
    try {
      expect(instance.models.default).toBe("provider-model");
      probe.output = "";
      await instance.refreshModels?.();
      expect(instance.models.default).toBe("provider-model");
      expect(instance.models.source).toBe("static");
      probe.output = "new-model\tNew model\n";
      await instance.refreshModels?.();
      expect(instance.models.default).toBe("new-model");
      expect(instance.models.source).toBe("live");
    } finally { await instance.dispose(); }
  });
});

it("shares concurrent refreshes so late responses cannot roll back the catalog", async () => {
  probe.output = "initial\tInitial\n";
  const instance = await AntigravityDriver.create({ instanceId: "concurrent-catalog", displayName: "Fixture",
    environment: {}, enabled: true, config: AntigravityDriver.defaultConfig() });
  const callbacks: Array<(error: Error | null, stdout: string, stderr: string) => void> = [];
  try {
    probe.pending = callback => callbacks.push(callback);
    const first = instance.refreshModels!();
    const second = instance.refreshModels!();
    const count = callbacks.length;
    for (const callback of callbacks) callback(null, "fresh\tFresh\n", "");
    await Promise.all([first, second]);
    expect(count).toBe(1);
    expect(instance.models.default).toBe("fresh");
  } finally { probe.pending = null; await instance.dispose(); }
});
