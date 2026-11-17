import { launchVerificationServer } from "../scripts/control-murage.ts";
import { STATIC_CLAUDE_MODELS } from "./drivers/claude.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderConnectionsService, normalizeProviderModels } from "./provider-connections.ts";
import { mutateProviderBank, parseProviderBank } from "../electron/provider-connections.mjs";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "./harness/registry.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";
import { orderModels } from "../shared/model-order.ts";

describe("server model list presentation", () => {
  it("the real isolated registry description sends the shared order and flags", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ fixture: { driver: "fake" } });
    try {
      const options = [
        { id: "model-1", label: "Model 1 (latest)" }, { id: "model-2", label: "Model 2" }, { id: "model-1", label: "Model 1 (latest)" },
      ];
      Object.defineProperty(registry.get("fixture")!, "models", { configurable: true, value: { default: "model-1", options } });
      const description = (await registry.describe()).find(row => row.instanceId === "fixture");
      expect(description!.models.options).toEqual(orderModels(options));
      expect(description!.models.default).toBe("model-1");
    } finally { await registry.disposeAll(); }
  });
});

it("provider catalog refresh, saved list and catalog routes expose the shared order", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "model-order-catalog-"));
  try {
    const bank = JSON.stringify(mutateProviderBank("[]", { action: "create", preset: "openai", key: "fixture-catalog-value" }, () => "catalog-fixture"));
    const connection = parseProviderBank(bank)[0]!;
    const payload = { data: [{ id: "gpt-6-sol", name: "Sol (latest)" }, { id: "gpt-6.1-sol", name: "Sol 6.1" }] };
    const service = new ProviderConnectionsService({ readBank: () => bank, cacheDir, now: () => 100, fetch: async () => new Response(JSON.stringify(payload)) });
    const expected = orderModels(normalizeProviderModels(connection, payload, 100));
    expect((await service.refresh(connection.id)).models).toEqual(expected);
    expect(service.list()[0]!.catalog.models).toEqual(expected);
    expect(service.getCatalog(connection.id).models).toEqual(expected);
  } finally { removeTempDirSync(cacheDir); }
});

// The real control-surface launcher gives the child its own data dir, home and
// fake engine. This exercises the HTTP list without touching a running app.
it("an isolated launched server returns the shared order over the actual instances route", async () => {
  const fixture = await launchVerificationServer(process.env);
  try {
    const proof = await fetch(`${fixture.info.url}/api/desktop-secret`).then(response => response.json()) as { secret: string };
    const response = await fetch(`${fixture.info.url}/api/instances`, { headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret } });
    expect(response.status).toBe(200);
    const body = await response.json() as { instances: Array<{ instanceId: string; models: typeof STATIC_CLAUDE_MODELS }> };
    const instance = body.instances.find(row => row.instanceId === "verification")!;
    expect(instance.models.options).toEqual(orderModels(STATIC_CLAUDE_MODELS.options));
    expect(instance.models.default).toBe(STATIC_CLAUDE_MODELS.default);
  } finally { await fixture.close(); }
}, 60_000);
