import { existsSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { providerBankRevision } from "../electron/provider-connections.mjs";

// Isolated HTTP server and fake engine only. Plain Node has no Electron parent
// port, so the instrumentation delivers the desktop's uncertain-fence message
// to the same module instance before the server loads. External network is
// blocked; the seeded key is a fixture string.
const token = "c".repeat(64);
const bank = JSON.stringify([
  { id: "fixture-mistral", preset: "mistral", label: "Fixture", enabled: false, key: "FAKE_MISTRAL_ONLY", revision: "r1" },
]);
const fenceModule = new URL("./provider-bank-fence.ts", import.meta.url).href;
let fixture: VerificationServer;
let headers: Record<string, string> = {};
async function api(method: string, path: string, body?: unknown, bearer = false) {
  const response = await fetch(fixture.info.url + path, {
    method,
    headers: {
      ...headers,
      ...(bearer ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, {
    instrumentationSource: `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { applyProviderBankFenceMessage } from ${JSON.stringify(fenceModule)};
    const file=join(process.env.MURAGE_DATA_DIR,'config.json');
    const config=JSON.parse(readFileSync(file,'utf8'));
    config.modelProviders={bank:${JSON.stringify(bank)}};
    writeFileSync(file,JSON.stringify(config));
    process.env.MURAGE_MODEL_PROVIDER_COMMIT_TOKEN='${token}';
    if(!applyProviderBankFenceMessage({type:'murage:provider-bank-fence',held:true}))throw Error('fence fixture rejected');
    const originalFetch=globalThis.fetch;
    globalThis.fetch=(input,init)=>String(input).startsWith('https://')?Promise.reject(Error('External network blocked in fence fixture')):originalFetch(input,init);
  `,
  });
  const proof = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
}, 30_000);
afterAll(async () => {
  await fixture?.close();
});

it("reads back the harness bank revision only for the desktop commit token, matching the replace compare-and-swap", async () => {
  expect((await api("GET", "/api/provider-connections/revision")).status).toBe(404);
  const readback = await api("GET", "/api/provider-connections/revision", undefined, true);
  expect(readback.status).toBe(200);
  expect(readback.body).toEqual({ revision: providerBankRevision(bank) });
  expect(JSON.stringify(readback.body)).not.toContain("FAKE_");
  // Reconciliation must still be able to compensate while dispatch is fenced.
  expect((await api("POST", "/api/provider-connections/replace", { bank, expectedRevision: "[]" }, true)).status).toBe(409);
  expect(
    (await api("POST", "/api/provider-connections/replace", { bank, expectedRevision: readback.body.revision }, true)).status,
  ).toBe(200);
});

it("refuses new direct dispatch while the desktop holds the uncertain fence", async () => {
  const engines = (await api("GET", "/api/instances")).body.instances;
  const model = engines.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
  const created = await api("POST", "/api/bots", { name: "Fence fixture", modelSelection: { instanceId: "verification", model } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;

  const sent = await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "must not dispatch while fenced" });
  expect(sent.status).toBe(409);
  expect(sent.body.error).toMatch(/being reconciled/);
  expect(existsSync(fixture.fixtureDumpPath)).toBe(false);
});
