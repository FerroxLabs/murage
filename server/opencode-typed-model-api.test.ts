import { afterAll, beforeAll, expect, it } from "vitest";
import { resolve } from "node:path";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer;
let proof: string;
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(fixture.info.url + path, { method,
    headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: `
    const fs = await import('node:fs');
    const path = await import('node:path');
    const file = path.join(process.env.MURAGE_DATA_DIR, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    cfg.instances.typed = { driver: 'opencodeGo', displayName: 'Typed fixture',
      environment: { OPENCODE_API_KEY: 'fixture-key', FAKE_ACP_MODELS: 'venice/old' },
      config: { cli: ${JSON.stringify(resolve("server/testing/fake-acp-cli.ts"))}, fullAuto: false } };
    fs.writeFileSync(file, JSON.stringify(cfg));
  ` });
  proof = (await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string }).secret;
}, 120_000);
afterAll(async () => { await fixture?.close(); });

it.each(["bot", "task"])("checks typed IDs at the %s HTTP write boundary without changing stored selection", async surface => {
  const original = { instanceId: "typed", model: "typed::venice/x" };
  const made = await api("POST", "/api/bots", { name: "Typed admission", modelSelection: original });
  expect(made.status).toBe(201);
  const bot = made.body.bot;
  const path = surface === "bot" ? `/api/bots/${bot.id}` : `/api/bots/${bot.id}/tasks/${bot.threadId}`;
  // A new task follows its bot until an explicit task selection is saved.
  expect((await api("PATCH", path, { modelSelection: original })).status).toBe(200);
  const persisted = async () => {
    const bots = (await api("GET", "/api/bots?messages=0")).body.bots;
    const saved = bots.find((entry: any) => entry.id === bot.id);
    return surface === "bot" ? saved.modelSelection : saved.tasks.find((task: any) => task.threadId === bot.threadId).modelSelection;
  };
  expect(await persisted()).toEqual(original);
  for (const selection of [
    { ...original, model: "typed::venice/a;id" },
    { ...original, model: `typed::venice/${"x".repeat(201)}` },
    { ...original, instanceId: "verification" },
    { ...original, connectionId: "fixture-connection" },
    { ...original, model: "typed::flux/flux-auto" },
  ]) {
    const rejected = await api("PATCH", path, { modelSelection: selection });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe("Invalid typed OpenCode model");
    expect(await persisted()).toEqual(original);
  }
  const valid = { ...original, model: "typed::venice/new" };
  expect((await api("PATCH", path, { modelSelection: valid })).status).toBe(200);
  expect(await persisted()).toEqual(valid);
});
