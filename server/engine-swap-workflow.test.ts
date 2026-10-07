import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer;
let headers: Record<string, string> = {};
const api = async (method: string, path: string, body?: unknown): Promise<any> => {
  const res = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await res.json(); expect(res.status, JSON.stringify(value)).toBeLessThan(300); return value;
};
const messages = async (threadId: string): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages`)).messages;
beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: `
    const fs = await import('node:fs'); const path = await import('node:path');
    const file = path.join(process.env.MURAGE_DATA_DIR, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    cfg.instances.second = {...cfg.instances.verification, displayName: 'Engine B'};
    cfg.instances.verification.displayName = 'Engine A';
    fs.writeFileSync(file, JSON.stringify(cfg));
    process.env.FAKE_CLAUDE_DUMP_EACH_TURN = '1';
    process.env.FAKE_CLAUDE_REPLIES = JSON.stringify([['I sent it.', 'Anything else?']]);
  ` });
  const proof = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 60000);
afterAll(async () => { await fixture?.close(); });

it("F9 drives engine A to B to A through the real isolated server and fake engines", async () => {
  const instances = (await api("GET", "/api/instances")).instances;
  const model = instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
  const bot = (await api("POST", "/api/bots", { name: "Swap fixture", modelSelection: { instanceId: "verification", model } })).bot;
  const snapshots = [];
  for (const [index, engine] of ["verification", "second", "verification"].entries()) {
    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: engine, model }, computer: "off", browser: false });
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `SWAP_STEP_${index}` });
    await expect.poll(async () => (await messages(bot.threadId)).filter(row => row.turnTerminal).length, { timeout: 20000 }).toBe(index + 1);
    await expect.poll(async () => !(await api("GET", "/api/bots?messages=0")).bots.find((item: any) => item.id === bot.id).busy, { timeout: 20000 }).toBe(true);
    const rows = await messages(bot.threadId), terminal = rows.filter(row => row.turnTerminal).at(-1);
    expect(terminal.engine.instanceId).toBe(engine);
    expect(terminal.actionCheck.claims.some((claim: any) => claim.pieceId !== terminal.id)).toBe(true);
    const tools = rows.filter(row => row.kind === "activity" && row.tool?.name === "Bash" && row.turnId === terminal.turnId);
    expect(tools.length).toBeGreaterThan(0); expect(tools.at(-1).tool.ok).toBe(true);
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    if (index > 0) expect(JSON.stringify(dump.prompt)).toContain("do not restate");
    if (index === 2) expect(JSON.stringify(dump.prompt)).toContain("Engine B");
    snapshots.push({ engine, rows, prompt: dump.prompt });
  }
  writeFileSync(join(process.cwd(), ".engine-swap-workflow-evidence.json"), JSON.stringify({ fixture: fixture.info, snapshots }, null, 2));
}, 60000);

it("F3 folds real tool start, completion and options events with the turn stamp read by the guard", async () => {
  const instances = (await api("GET", "/api/instances")).instances;
  const model = instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
  const bot = (await api("POST", "/api/bots", { name: "Fold fixture", modelSelection: { instanceId: "verification", model } })).bot;
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false });
  await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "__fixture_ask_user_question__" });
  await expect.poll(async () => (await messages(bot.threadId)).some(row => row.card?.questions?.length), { timeout: 20000 }).toBe(true);
  const card = (await messages(bot.threadId)).find(row => row.card?.questions?.length);
  expect(card.turnId).toEqual(expect.any(String)); expect(card.engine.instanceId).toBe("verification");
  await api("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.threadId, requestId: card.card.requestId, behavior: "answer", answers: [{ id: "q1", selected: ["Summary"] }, { id: "q2", selected: ["Intro", "Findings"] }] });
  await expect.poll(async () => (await messages(bot.threadId)).some(row => row.turnTerminal && row.turnId === card.turnId), { timeout: 20000 }).toBe(true);
  const rows = await messages(bot.threadId);
  expect(rows.filter(row => row.tool && !row.murage).every(row => row.turnId === card.turnId)).toBe(true);
}, 60000);
