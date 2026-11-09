import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const posixOnly = describe.skipIf(process.platform === "win32");
const MARKER = "ZEBRA-4471-VAULT";
let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const botState = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === id);
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
const replies = async (threadId: string) => (await messages(threadId)).filter(message => message.role === "bot" && message.kind === "text" && message.text);
const chips = (thread: any[]) => thread.filter(message => typeof message.tool?.name === "string" && message.tool.name.startsWith("error:")).map(message => message.tool.name);
const serverLog = () => readFileSync(fixture.info.logPath, "utf8");
const data = (name: string) => join(fixture.info.dataDir, name);
const dumpOf = (instance: string): any[] => { const file = data(`${instance}-dump.jsonl`); return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : []; };
const receipts = (threadId: string) => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try {
    const epoch = Number((db.prepare("SELECT deletion_epoch FROM memory_meta WHERE id=1").get() as { deletion_epoch: number }).deletion_epoch);
    const rows = db.prepare("SELECT state,deletion_epoch FROM memory_disclosures WHERE thread_id=? AND bundle_id NOT LIKE '%:lookup' ORDER BY created_at").all(threadId) as Array<{ state: string; deletion_epoch: number }>;
    return { epoch, rows };
  } finally { db.close(); }
};
const createBot = async (name: string, instanceId: string) => {
  const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === instanceId).models.options;
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: models[0].id } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
};
/** Another bot's task with a past (a message carrying the marker and its reply), on the plain fixture engine. */
const taskWithPast = async (title: string) => {
  const owner = await createBot(`Owner of ${title}`, "plain");
  const task = await api("POST", `/api/bots/${owner.id}/tasks`, { title });
  expect(task.status).toBe(201);
  const threadId = task.body.task.threadId as string;
  expect((await api("POST", `/api/bots/${owner.id}/messages`, { threadId, text: `Remember this: the vault code is ${MARKER}.` })).status).toBe(202);
  await expect.poll(async () => (await replies(threadId)).some(message => message.text === "Hello from late"), { timeout: 15000 }).toBe(true);
  await expect.poll(async () => (await botState(owner.id)).busy, { timeout: 15000 }).toBe(false);
  return { owner, threadId };
};

posixOnly("deleting one chat while an unrelated turn is in its dispatch window", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "drivers", "builtIn.ts")).href)});
      const { makeLateTerminalDriver } = await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-late-terminal-driver.ts")).href)});
      BUILT_IN_DRIVERS.push(makeLateTerminalDriver());
      const dataDir=process.env.MURAGE_DATA_DIR;
      const file=path.join(dataDir,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      const gated=(name,fenced)=>({driver:'fakeLateTerminal',displayName:name,environment:{FAKE_LATE_HANDBACK:'1',FAKE_LATE_PRE_HANDBACK_GATE:path.join(dataDir,name+'-gate'),
        FAKE_LATE_DUMP:path.join(dataDir,name+'-dump.jsonl'),FAKE_LATE_DUMP_FRAME:'1',...(fenced?{FAKE_LATE_FENCED_WRITES:'1',FAKE_LATE_IGNORE_STOP:'1'}:{})}});
      cfg.instances.fenced=gated('fenced',true);
      cfg.instances.unfenced=gated('unfenced',false);
      cfg.instances.late=gated('late',true);
      delete cfg.instances.late.environment.FAKE_LATE_PRE_HANDBACK_GATE;
      cfg.instances.late.environment.FAKE_LATE_SESSION_GATE=path.join(dataDir,'late-gate');
      cfg.instances.plain={driver:'fakeLateTerminal',displayName:'plain',environment:{}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  it.each(["fenced", "late"])("%s: the unrelated turn replies without rebuilding; deleted memory does not reach it", async (instance) => {
    expect((await api("GET", "/api/memory/status")).body.mode).toBe("active");
    const doomed = await taskWithPast("Doomed task");
    const second = await taskWithPast("Another doomed task");
    const bot = await createBot("Unrelated turn", instance);
    const gate = data(`${instance}-gate`);
    rmSync(gate, { force: true }); rmSync(`${gate}.waiting`, { force: true });
    const before = (await replies(bot.threadId)).length;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "keep working while I tidy up" })).status).toBe(202);
    await expect.poll(() => existsSync(`${gate}.waiting`), { timeout: 15000 }).toBe(true);
    const heldTurnId = readFileSync(`${gate}.waiting`, "utf8");
    const epochBefore = receipts(bot.threadId).epoch;

    // the chat goes while the unrelated turn has been handed to the engine and not yet accepted
    const deleted = await api("DELETE", `/api/bots/${doomed.owner.id}/tasks/${doomed.threadId}`);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect((await api("DELETE", `/api/bots/${second.owner.id}/tasks/${second.threadId}`)).status).toBe(200);
    expect(receipts(bot.threadId).epoch).toBe(epochBefore);
    writeFileSync(gate, "");


    await expect.poll(async () => (await botState(bot.id)).busy, { timeout: 20000 }).toBe(false);
    await expect.poll(async () => (await replies(bot.threadId)).length, { timeout: 15000 }).toBe(before + 1);
    const thread = await messages(bot.threadId);
    expect(chips(thread)).toEqual([]);
    expect(serverLog()).not.toContain(`[memory] context revoked during dispatch on thread ${bot.threadId} after`);
    expect(thread.filter(message => message.role === "user" && message.kind === "text").map(message => message.text)).toEqual(["keep working while I tidy up"]);

    // The original held attempt writes exactly once; no rebuild or refusal.
    const dump = dumpOf(instance).filter(row => row.threadId === bot.threadId);
    expect(dump.filter(row => row.refused)).toEqual([]);
    expect(serverLog()).not.toContain(`context revoked at a late submission on thread ${bot.threadId}`);
    expect(serverLog()).not.toContain(`context revoked during dispatch on thread ${bot.threadId}`);
    const prompts = dump.filter(row => row.prompt);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].turnId).toBe(heldTurnId);
    // No deleted words reach this turn, and its receipt retains the unchanged global epoch.
    expect(String(prompts[0].frame)).not.toContain(MARKER);
    const after = receipts(bot.threadId);
    const delivered = after.rows.filter(row => row.state === "delivered");
    expect(delivered.length).toBeGreaterThan(0);
    for (const row of delivered) expect(row.deletion_epoch).toBe(after.epoch);
  }, 90000);

  it("an unrelated unfenced engine also continues without rebuilding", async () => {
    const doomed = await taskWithPast("Second doomed task");
    const bot = await createBot("Unproven engine", "unfenced");
    const before = (await replies(bot.threadId)).length;
    const gate = data("unfenced-gate");
    rmSync(gate, { force: true }); rmSync(`${gate}.waiting`, { force: true });
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "this one cannot be proven unwritten" })).status).toBe(202);
    await expect.poll(() => existsSync(`${gate}.waiting`), { timeout: 15000 }).toBe(true);
    expect((await api("DELETE", `/api/bots/${doomed.owner.id}/tasks/${doomed.threadId}`)).status).toBe(200);
    writeFileSync(gate, "");

    await expect.poll(async () => (await botState(bot.id)).busy, { timeout: 20000 }).toBe(false);
    expect(chips(await messages(bot.threadId))).toEqual([]);
    await expect.poll(async () => (await replies(bot.threadId)).length, { timeout: 15000 }).toBe(before + 1);
    expect(serverLog()).not.toContain(`context revoked during dispatch on thread ${bot.threadId}`);
  }, 90000);
});
