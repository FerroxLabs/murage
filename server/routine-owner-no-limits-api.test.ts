import { readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";
import { raiseLevel } from "./testing/raise-level.ts";

// A fake web reader releases a web-page mark immediately before the own-route
// middleware. All authority, routine writes, dispatch and engine turns stay real.
const instrumentation = `
const {registerHooks}=await import('node:module');
const fs=await import('node:fs');
registerHooks({load(url,context,next){
  if(!url.endsWith('/server/index.ts'))return next(url,context);
  const source=fs.readFileSync(new URL(url),'utf8');
  const anchor='const ownTool = ownToolOfRoute(method, path, ownBody);';
  if(!source.includes(anchor))throw Error('routine fixture anchor moved');
  return {format:'module-typescript',shortCircuit:true,source:source.replace(anchor,
    'if(path === "/api/internal/routine-requests") markTurnOutside(internalClaim.threadId, "web page");\\n'+anchor)};
}});
`;
let fixture: VerificationServer;
let desktop: Record<string, string>;
const evidence: unknown[] = [];
async function api(method: string, path: string, body?: unknown, headers = desktop) {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = { status: response.status, body: await response.json() as any };
  if (!path.includes("desktop-secret")) evidence.push({ method, path, ...result });
  return result;
}
const messages = async (thread: string) => (await api("GET", `/api/threads/${thread}/messages?limit=100`)).body.messages as any[];
// Newly made bots already contain an intake question, which grants no permission.
const cards = async (thread: string) => (await messages(thread)).filter(m => m.card && !m.card.intake);
const list = async () => (await api("GET", "/api/routines")).body;
async function bot(level: "ask" | "auto" | "unlimited") {
  const model = (await api("GET", "/api/instances")).body.instances.find((i: any) => i.instanceId === "verification").models.options[0].id;
  const made = (await api("POST", "/api/bots", { name: `Routine ${level}`, modelSelection: { instanceId: "verification", model } })).body.bot;
  expect((await api("PATCH", `/api/bots/${made.id}`, { computer: "off", browser: false, composio: false, autoReview: "off", autoApprove: level === "auto" })).status).toBe(200);
  if (level === "unlimited") expect((await raiseLevel(api, made.id, { noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
  return made as { id: string; threadId: string };
}
async function held(b: { id: string; threadId: string }) {
  rmSync(fixture.fixtureDumpPath, { force: true });
  expect((await api("POST", `/api/bots/${b.id}/messages`, { threadId: b.threadId, text: "__fixture_hold_authority__" })).status).toBe(202);
  let dump: any;
  await expect.poll(() => { try { dump = withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"))); return true; } catch { return false; } }, { timeout: 30_000 }).toBe(true);
  return { authorization: `Bearer ${dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN}` };
}
async function stop(b: { id: string; threadId: string }) {
  await api("POST", `/api/bots/${b.id}/interrupt`, { threadId: b.threadId });
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((v: any) => v.id === b.id)?.tasks.find((t: any) => t.threadId === b.threadId)?.busy, { timeout: 30_000 }).not.toBe(true);
}
const propose = (b: { id: string; threadId: string }, auth: Record<string, string>, proposal: unknown) => api("POST", "/api/internal/routine-requests", { fromBotId: b.id, fromThreadId: b.threadId, ...proposal as object }, auth);
const create = { action: "create", routine: { name: "Web-read routine", instructions: "Routine workflow witness", schedule: { type: "interval", everyMinutes: 60 } } };

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: instrumentation, dumpLog: true });
  console.info("G-NL isolated fixture", fixture.info);
  const proof = await api("GET", "/api/desktop-secret", undefined, {});
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
}, 120_000);
afterAll(async () => {
  if (process.env.G_NL_EVIDENCE_DIR) {
    mkdirSync(process.env.G_NL_EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(process.env.G_NL_EVIDENCE_DIR, "routine-http.json"), JSON.stringify({ fixture: fixture?.info, evidence }, null, 2));
  }
  await fixture?.close();
});

it("owner No limits after a web read creates, edits, runs and deletes with zero cards", async () => {
  const b = await bot("unlimited");
  const auth = await held(b);
  try {
    const made = await propose(b, auth, create);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ autoApproved: true, action: "create" });
    const routineId = made.body.resultId;
    expect((await list()).routines.find((r: any) => r.id === routineId)?.prompt).toBe("Routine workflow witness");
    expect((await propose(b, auth, { action: "update", routineId, changes: { name: "Edited after web read" } })).body.autoApproved).toBe(true);
    const run = await propose(b, auth, { action: "run_now", routineId });
    expect(run.body).toMatchObject({ autoApproved: true, action: "run_now" });
    expect(await cards(b.threadId)).toHaveLength(0);
    await stop(b);
    await expect.poll(async () => (await list()).runs.find((r: any) => r.id === run.body.resultId)?.status, { timeout: 30_000 }).toBe("completed");
    const finished = (await list()).runs.find((r: any) => r.id === run.body.resultId);
    expect((await messages(finished.threadId)).some(m => String(m.text).includes("Routine workflow witness"))).toBe(true);
    expect(await cards(finished.threadId)).toHaveLength(0);
    const next = await held(b);
    expect((await propose(b, next, { action: "delete", routineId })).body.autoApproved).toBe(true);
    expect((await list()).routines.some((r: any) => r.id === routineId)).toBe(false);
    expect(await cards(b.threadId)).toHaveLength(0);
  } finally { await stop(b); }
}, 120_000);

it.each(["ask", "auto"] as const)("%s after a web read still needs confirmation", async level => {
  const b = await bot(level);
  const auth = await held(b);
  try {
    const made = await propose(b, auth, create);
    expect(made.status).toBe(201);
    expect(made.body.autoApproved).not.toBe(true);
    expect((await messages(b.threadId)).filter(m => m.card?.routineRequest)).toHaveLength(1);
    expect((await list()).routines.some((r: any) => r.botId === b.id)).toBe(false);
  } finally { await stop(b); }
});

it("a routine's own No limits turn can propose another routine", async () => {
  const b = await bot("unlimited");
  const made = await api("POST", "/api/routines", { botId: b.id, name: "Non-owner fixture", prompt: "__fixture_hold_authority__", enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() } });
  expect(made.status).toBe(201);
  rmSync(fixture.fixtureDumpPath, { force: true });
  const started = await api("POST", `/api/routines/${made.body.routine.id}/run`, {});
  let dump: any;
  await expect.poll(() => { try { dump = withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"))); return true; } catch { return false; } }, { timeout: 30_000 }).toBe(true);
  const run = (await list()).runs.find((r: any) => r.id === started.body.run.id);
  const auth = { authorization: `Bearer ${dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN}` };
  try {
    const proposed = await propose({ id: b.id, threadId: run.threadId }, auth, create);
    expect(proposed.status).toBe(201);
    expect(proposed.body.autoApproved).toBe(true);
    expect((await messages(run.threadId)).filter(m => m.card?.routineRequest)).toHaveLength(0);
    expect((await list()).routines.filter((r: any) => r.botId === b.id)).toHaveLength(2);
  } finally { await stop({ id: b.id, threadId: run.threadId }); }
});
