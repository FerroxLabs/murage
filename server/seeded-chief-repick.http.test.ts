// 1.0.13: a Flux key saved after the first run moves the Chief Murage seeded onto Fuigo, over the real server and real HTTP.
//
// The fixture has a Claude that is not signed in (the verification engine, FAKE_CLAUDE_AUTH=out) and a Fuigo that is installed but has no key, so its
// catalogue is empty and the seeded Chief lands on Claude. Saving a key through the same routes the app uses
// (/api/flux-connection/replace for the packaged desktop, /api/flux-connection/mutate otherwise) fills Fuigo's catalogue,
// and the Chief must follow it. A bot the owner placed on an engine must not move.
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const FAKE_ACP = fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url));
const TOKEN = "d".repeat(64);
const KEY = "sk-flux-FAKE_REPICK_KEY";

const running: VerificationServer[] = [];
afterEach(async () => { while (running.length) await running.pop()!.close(); });

async function launch() {
  const fixture = await launchVerificationServer({}, undefined, { instrumentationSource: `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const file=join(process.env.MURAGE_DATA_DIR,'config.json');
    const config=JSON.parse(readFileSync(file,'utf8'));
    config.instances.verification.environment={FAKE_CLAUDE_AUTH:'out'};
    config.instances.fuigo={driver:'fuigoAgent',displayName:'Fuigo fixture',config:{cli:${JSON.stringify(FAKE_ACP)}}};
    writeFileSync(file,JSON.stringify(config));
    delete process.env.FLUX_API_KEY;
    process.env.MURAGE_MODEL_PROVIDER_COMMIT_TOKEN='${TOKEN}';
    const originalFetch=globalThis.fetch;
    globalThis.fetch=(input,init)=>{
      const url=String(input);
      if(url==='https://api.fluxrouter.ai/v1/models')return Promise.resolve(new Response(JSON.stringify({data:[{id:'flux-fast'},{id:'flux-standard'}]})));
      if(url.startsWith('https://'))return Promise.reject(new TypeError('External network blocked in fixture'));
      return originalFetch(input,init);
    };
  ` });
  running.push(fixture);
  const secret = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  const headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret.secret };
  const api = async (method: string, path: string, body?: unknown, privateRoute = false) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, ...(privateRoute ? { authorization: `Bearer ${TOKEN}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const savedBots = () => JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8")) as Array<{ id: string; engineSeeded?: boolean; modelSelection: { instanceId: string; model: string } }>;
  return { fixture, api, savedBots };
}

type Harness = Awaited<ReturnType<typeof launch>>;

/** The one bot of a fresh workspace, and a check that the fixture really starts where the story starts. */
async function seededChief({ api, savedBots }: Harness) {
  const chief = (await api("GET", "/api/bots")).body.bots[0] as { id: string; modelSelection: { instanceId: string; model: string } };
  expect(chief.modelSelection.instanceId).toBe("verification");
  const claude = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification");
  expect(claude?.snapshot?.authenticated, "Claude is not signed in").toBe(false);
  expect(savedBots().find((bot) => bot.id === chief.id)?.engineSeeded).toBe(true);
  const fuigo = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "fuigo");
  expect(fuigo?.snapshot?.state, "fuigo fixture is installed").toBe("available");
  expect(fuigo.models.options, "and keyless, so it has nothing to offer yet").toHaveLength(0);
  return chief;
}

/** The packaged desktop's road: reserve, then commit, over the private port. */
async function saveKeyByReplace({ api }: Harness) {
  const start = (await api("GET", "/api/flux-connection")).body;
  const reserved = await api("POST", "/api/flux-connection/replace", { phase: "begin", input: { action: "connect", revision: start.revision, key: KEY } }, true);
  expect(reserved.status).toBe(200);
  const committed = await api("POST", "/api/flux-connection/replace", { phase: "commit", lease: reserved.body.lease }, true);
  expect(committed.status).toBe(200);
  expect((await api("POST", "/api/flux-connection/replace", { phase: "finish", lease: reserved.body.lease }, true)).status).toBe(200);
}

async function saveKeyByMutate({ api }: Harness) {
  const start = (await api("GET", "/api/flux-connection")).body;
  expect((await api("POST", "/api/flux-connection/mutate", { action: "connect", revision: start.revision, key: KEY })).status).toBe(200);
}

describe.skipIf(process.platform === "win32")("a Flux key saved after the first run, over HTTP", () => {
  it.each([["replace", saveKeyByReplace], ["mutate", saveKeyByMutate]] as const)("moves the Chief Murage seeded onto Fuigo, through /api/flux-connection/%s", async (_route, save) => {
    const harness = await launch();
    const chief = await seededChief(harness);
    await save(harness);
    const after = (await harness.api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === chief.id);
    expect(after.modelSelection.instanceId).toBe("fuigo");
    expect(after.modelSelection.model).toBeTruthy();
    const saved = harness.savedBots().find((bot) => bot.id === chief.id)!;
    expect(saved.modelSelection.instanceId).toBe("fuigo");
    expect(saved.engineSeeded).toBeUndefined();
  }, 120_000);

  it("leaves a bot the owner placed on Claude exactly where it was", async () => {
    const harness = await launch();
    const chief = await seededChief(harness);
    const placed = await harness.api("PATCH", `/api/bots/${chief.id}`, { modelSelection: { instanceId: "verification", model: chief.modelSelection.model } });
    expect(placed.status).toBe(200);
    const before = harness.savedBots().find((bot) => bot.id === chief.id)!;
    expect(before.engineSeeded, "an owner's pick drops the seed mark").toBeUndefined();
    await saveKeyByReplace(harness);
    const after = (await harness.api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === chief.id);
    expect(after.modelSelection).toEqual(before.modelSelection);
    expect(after.modelSelection.instanceId).toBe("verification");
  }, 120_000);
});
