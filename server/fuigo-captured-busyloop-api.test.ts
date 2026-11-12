// Isolated HTTP fixture; captured bytes travel through a real Fuigo driver process.
import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
let fixture: VerificationServer;
let headers: Record<string, string>;
function evidence(name: string, value: unknown) {
  const directory = process.env.BUSYLOOP_EVIDENCE_DIR;
  if (directory) { mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, name), typeof value === "string" ? value : JSON.stringify(value, null, 2)); }
}
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(response.ok, `${method} ${path}: ${response.status}`).toBe(true);
  return await response.json() as any;
}
beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: `
    import {readFileSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    const dir=process.env.MURAGE_DATA_DIR;
    process.env.FLUX_API_KEY='sk-flux-Ffffffffffffffffffffffffffffffffffffffffff';
    const file=join(dir,'config.json'), cfg=JSON.parse(readFileSync(file,'utf8'));
    for (const scenario of ['S1','S2','S3','S4']) {
      const frames=join(${JSON.stringify(process.cwd())},'server/drivers/acp/__fixtures__/fuigo-1.0.41-free-cap-'+scenario+'-1.jsonl');
      const cli=[process.execPath,join(${JSON.stringify(process.cwd())},'server/testing/fuigo-captured-cli.mjs'),frames].map(p=>JSON.stringify(p)).join(' ');
      cfg.instances['captured-'+scenario]={driver:'fuigoAgent',displayName:'Fuigo',environment:{FUIGO_REPLAY_REQUESTS:join(dir,scenario+'-requests.jsonl')},config:{cli}};
    }
    writeFileSync(file,JSON.stringify(cfg));
  ` });
  evidence("launch.json", fixture.info);
  const proof = await fetch(fixture.info.url + "/api/desktop-secret").then(r => r.json()) as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 120000);
afterAll(async () => { if (fixture) evidence("api-server.log", readFileSync(fixture.info.logPath, "utf8")); await fixture?.close(); });
for (const [label, scenario, reasons] of [
  ["R4", "S1", ["freeCap", "freeCap", "freeCap"]],
  ["R2", "S2", ["freeCap", "freeCap", "freeCap"]],
  ["R5", "S3", ["busy", "busy", "repeated"]],
] as const) {
  it(`${label}: ${scenario} captured engine frames through three HTTP sends`, async () => {
    const bot = (await api("POST", "/api/bots", { name: `Captured ${scenario}`, modelSelection: { instanceId: `captured-${scenario}`, model: "flux-auto" } })).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    for (const [index, reason] of reasons.entries()) {
      await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `capture send ${index + 1}` });
      let rows: any[] = [];
      await expect.poll(async () => {
        rows = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=200`)).messages;
        evidence(`${scenario}-messages.json`, rows);
        return rows.filter(m => m.tool?.busy).length;
      }, { timeout: 60000 }).toBe(index + 1);
      expect(rows.filter(m => m.tool?.busy).at(-1).tool.busy.reason).toBe(reason);
      expect(rows.filter(m => m.role === "user").some(m => m.text === `capture send ${index + 1}`)).toBe(true);
      await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id)?.busy, { timeout: 15000 }).toBe(false);
    }
    const requests = readFileSync(join(fixture.info.dataDir, `${scenario}-requests.jsonl`), "utf8");
    evidence(`${scenario}-requests.jsonl`, requests);
    expect(requests.split("\n").filter(line => line && JSON.parse(line).method === "session/prompt")).toHaveLength(3);
  }, 180000);
}
