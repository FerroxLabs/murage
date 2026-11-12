import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer;
let headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};

// The verification server owns its data and fake ACP process; no provider is contacted.
describe("room thinking dispatch", () => {
  beforeAll(async () => {
    const cli = `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(resolve(dirname(fileURLToPath(import.meta.url)), "testing/fake-custom-acp-models.ts"))}`;
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      process.env.NODE_ENV = 'test';
      globalThis[Symbol.for('murage.hostPower.testUnwrapped')] = true;
      const fs = await import('node:fs'); const path = await import('node:path');
      const file = path.join(process.env.MURAGE_DATA_DIR, 'config.json');
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      cfg.instances.thinking = { driver: 'customAcp', displayName: 'Thinking fixture',
        config: { cli: ${JSON.stringify(cli)}, fullAuto: false },
        environment: { FAKE_CUSTOM_ACP_DIRECTORY: process.env.MURAGE_DATA_DIR } };
      fs.writeFileSync(file, JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 120_000);
  afterAll(async () => { await fixture?.close(); });

  it("dispatches a room prompt with the bot's persisted native thinking choice", async () => {
    const fleet = await api("GET", "/api/instances?fresh=1");
    expect(fleet.status).toBe(200);
    const selection = { instanceId: "thinking", model: "glm-5.3", variant: "max" };
    const created = await api("POST", "/api/bots", { name: "Thinker", modelSelection: selection });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const bot = created.body.bot;
    const saved = await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    expect(saved.status).toBe(200);
    expect(saved.body.bot.modelSelection).toMatchObject(selection);
    const group = await api("POST", "/api/groups", { name: "Thinking room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
    expect(group.status).toBe(201);
    expect((await api("POST", `/api/groups/${group.body.group.id}/messages`, { text: "ACP_ROOM_THINKING_CHECK" })).status).toBe(202);
    const prompts = () => {
      try { return readFileSync(join(fixture.info.dataDir, "receipts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.method === "session/prompt"); }
      catch { return []; }
    };
    await expect.poll(() => prompts().length, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(prompts()[0]).toMatchObject({ model: "glm-5.3", variant: "max" });
  }, 60_000);
});
