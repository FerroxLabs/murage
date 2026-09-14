import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";

function fixture(models: Record<string, unknown>[], extra = {}) {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const match = source.match(/function selectedProviderRoute\(selection: ModelSelection, driverKind: string\): ProviderTurnRoute \| undefined \{([\s\S]*?)\n\}/);
  expect(match).not.toBeNull();
  const connection = { id: "fixture", enabled: true, preset: "flux", protocol: "openai", baseUrl: "https://fixture.invalid/v1", key: "FAKE_PRIVATE_ONLY", revision: "r1" };
  const getCatalog = vi.fn(() => ({ models, stale: false, ...extra }));
  const validate = vi.fn();
  const route = new Function("selection", "driverKind", "providerConnections", "providerEngineProtocol", "validateProviderTurnRoute", match![1]);
  const run = () => route({ connectionId: "fixture", model: "selected-pin" }, "claude", { resolve: () => connection, getCatalog }, () => "openai", validate);
  return { run, validate, connection };
}

it.each([
  [[], {}, "not listed"],
  [[], { stale: true }, "could not be confirmed"],
  [[], { error: { code: "offline", message: "PRIVATE_PROVIDER_BODY" } }, "could not be confirmed"],
  [[{ id: "selected-pin", enabled: false, chatEligible: true, capabilities: { chat: true } }], {}, "disabled"],
  [[{ id: "selected-pin", enabled: true, chatEligible: false, capabilities: { chat: false } }], {}, "does not identify"],
] as const)("classifies selected model refusal without changing routes (%s)", (models, extra, reason) => {
  const f = fixture([...models], extra);
  let failure: unknown;
  try { f.run(); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ status: 409, message: expect.stringContaining(reason) });
  expect(String(failure)).not.toMatch(/FAKE_PRIVATE_ONLY|PRIVATE_PROVIDER_BODY/);
  expect(f.validate).not.toHaveBeenCalled();
});

it("keeps the exact eligible selection using last-good metadata after a refresh failure", () => {
  const f = fixture([{ id: "selected-pin", enabled: true, chatEligible: true, capabilities: { chat: true } }], { stale: true, error: { code: "offline" } });
  expect(f.run()).toEqual({ connectionId: "fixture", preset: "flux", protocol: "openai", baseUrl: f.connection.baseUrl, apiKey: f.connection.key, model: "selected-pin", revision: "r1" });
  expect(f.validate).toHaveBeenCalledOnce();
});
