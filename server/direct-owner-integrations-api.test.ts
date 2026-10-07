// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 lane dmowner: the owner's own integrations ride a 1:1 turn only
// when the turn answers the owner's own words (the audience the 1:1 turn
// already writes its images line for: the thread is the owner's, the words
// were proven to be the owner's, and no chain such words started led here).
//
// The 1:1 turn gated the owner's custom MCP servers, the phone, the browser
// and dweb on humanIsOwner (the thread's principal only), and connected apps
// and the bot's computer on nothing more than the bot's own switches. So
// words nobody proved were the owner's (a script or a bot's own shell on
// loopback, no desktop secret, no paired phone) sent to the owner's own 1:1
// thread got all of them, several pre-allowed at the engine.
//
// Real server, the repository's fake Claude CLI (it dumps the --mcp-config
// it was handed, every turn), the owner's proven sends and unproven ones,
// and a routine run the owner made, which keeps everything.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { FAKE_FLUX_BROKER_INSTRUMENTATION } from "./testing/fake-flux-broker.ts";

const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>;
type Bot = { id: string; threadId: string };
let lead: Bot, vmBot: Bot, boxBot: Bot;
const api = async (method: string, path: string, body?: unknown, proven = true) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...(proven ? headers : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const taskState = async (bot: Bot, threadId = bot.threadId) =>
  (await api("GET", "/api/bots?messages=0")).body.bots.find((candidate: any) => candidate.id === bot.id).tasks.find((task: any) => task.threadId === threadId);
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
const dumpFile = () => join(fixture.info.dataDir, "fake-claude-dump.json");
const readDump = () => JSON.parse(readFileSync(dumpFile(), "utf8")) as { prompt: unknown; systemPrompt: string | null; mcpConfig: { mcpServers?: Record<string, unknown> } | null };
const dumpHas = (text: string) => existsSync(dumpFile()) && readFileSync(dumpFile(), "utf8").includes(text);
const idle = async (bot: Bot, threadId = bot.threadId) =>
  expect.poll(async () => (await taskState(bot, threadId))?.busy, { timeout: 30000 }).toBe(false);

/** Send one 1:1 message and return the MCP server names its turn was handed. */
const directTurnServers = async (bot: Bot, text: string, proven: boolean): Promise<string[]> => {
  rmSync(dumpFile(), { force: true });
  const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId }, proven);
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await expect.poll(() => dumpHas(text), { timeout: 30000 }).toBe(true);
  await idle(bot);
  const dump = readDump();
  expect(JSON.stringify(dump.prompt)).toContain(text);
  return Object.keys(dump.mcpConfig?.mcpServers ?? {}).sort();
};

posixOnly("the owner's integrations in a 1:1 turn", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, {
      portRange: { from: 49_000, span: 900 },
      instrumentationSource: `
      ${FAKE_FLUX_BROKER_INSTRUMENTATION}
      const fs=await import('node:fs');const path=await import('node:path');
      // The browser engine is the node executable (found, never run) and its
      // version check passes, as in the room test's fixture.
      process.env.MURAGE_AGENT_BROWSER_PATH=process.execPath;
      // dweb is opt-in by its daemon URL (never reached: the fake CLI only reads the config).
      process.env.DWEB_URL='http://127.0.0.1:9/dweb-fixture';
      const { registerHooks } = await import('node:module');
      registerHooks({ load(url, context, nextLoad) {
        if(!url.endsWith('/browser-engine.ts'))return nextLoad(url, context);
        const source=fs.readFileSync(new URL(url),'utf8');
        const start=source.indexOf('export async function verifyAgentBrowserBinary(');
        const end=source.indexOf('export async function ensureChrome(',start);
        if(start<0||end<0)throw new Error('Browser version fixture anchor changed');
        const hostCheck='if (process.platform === "linux" && (process.getuid?.() === 0';
        if(!source.includes(hostCheck))throw new Error('Browser host-check fixture anchor changed');
        const body=source.slice(0,start).replace(hostCheck,'if (false && (process.getuid?.() === 0')+'export async function verifyAgentBrowserBinary() {}\\n'+source.slice(end);
        return { format:'module-typescript', shortCircuit:true, source: body };
      } });
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.features={...(cfg.features??{}),browser:true};
      cfg.instances.verification.environment={FAKE_CLAUDE_DUMP_EACH_TURN:'1'};
      // The Computer engine: the whole agent runs on the owner's cloud box.
      cfg.instances.box={driver:'boxAgent',displayName:'Computer fixture',config:{}};
      cfg.mcpServers={'owner-tools':{command:'owner-tools-fixture',args:['--serve'],env:{OWNER_TOOLS_FIXTURE:'1'}}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "verification").models.options;
    const make = async (name: string, instanceId = "verification", model = models[0].id) => {
      const made = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model } });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      return made.body.bot as Bot;
    };
    lead = await make("Lead");
    // The lead holds every owner grant a bot can hold, except a computer.
    expect((await api("PATCH", `/api/bots/${lead.id}`, { computer: "off", browser: true, composio: true })).status).toBe(200);
    vmBot = await make("Vm");
    expect((await api("PATCH", `/api/bots/${vmBot.id}`, { computer: "vm", browser: false, composio: false })).status).toBe(200);
    boxBot = await make("Boxed", "box", "claude-fable-5");
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("mounts the owner's custom MCP servers for the owner's words, and not for words nobody proved", async () => {
    expect(await directTurnServers(lead, "owner asks for the custom tools", true)).toContain("owner-tools");
    expect(await directTurnServers(lead, "unproven caller asks for the custom tools", false)).not.toContain("owner-tools");
    expect(await directTurnServers(lead, "owner asks for the custom tools again", true)).toContain("owner-tools");
  }, 120000);

  it("mounts the owner's connected apps for the owner's words, and not for words nobody proved", async () => {
    expect(await directTurnServers(lead, "owner asks for connected apps", true)).toContain("composio");
    expect(await directTurnServers(lead, "unproven caller asks for connected apps", false)).not.toContain("composio");
    // the bot is told its connected apps are off for this turn, never handed the tool guide
    expect(readDump().systemPrompt ?? "").not.toContain("COMPOSIO_MULTI_EXECUTE_TOOL");
    expect(await directTurnServers(lead, "owner asks for connected apps again", true)).toContain("composio");
  }, 120000);

  it("mounts the owner's browser for the owner's words, and not for words nobody proved", async () => {
    expect(await directTurnServers(lead, "owner asks for the browser", true)).toContain("browser");
    expect(await directTurnServers(lead, "unproven caller asks for the browser", false)).not.toContain("browser");
    expect(await directTurnServers(lead, "owner asks for the browser again", true)).toContain("browser");
  }, 120000);

  it("mounts the owner's phone for the owner's words, and not for words nobody proved", async () => {
    expect(await directTurnServers(lead, "owner: open the settings app on my android", true)).toContain("phone");
    expect(await directTurnServers(lead, "unproven caller: open the settings app on my android", false)).not.toContain("phone");
    expect(await directTurnServers(lead, "owner again: open the settings app on my android", true)).toContain("phone");
  }, 120000);

  it("mounts dweb for the owner's words, and not for words nobody proved", async () => {
    expect(await directTurnServers(lead, "owner asks dweb", true)).toContain("dweb");
    expect(await directTurnServers(lead, "unproven caller asks dweb", false)).not.toContain("dweb");
    expect(await directTurnServers(lead, "owner asks dweb again", true)).toContain("dweb");
  }, 120000);

  it("reaches for the bot's computer for the owner's words, and not for words nobody proved", async () => {
    // The owner's words: the turn goes for the bot's Local VM (not set up in
    // this fixture, so the turn stops at the computer's setup, before the
    // engine). Matched on the setup failure's kind, not its copy: the copy
    // names a Settings section, and those move.
    rmSync(dumpFile(), { force: true });
    const text = "owner asks for the local vm";
    expect((await api("POST", `/api/bots/${vmBot.id}/messages`, { text, threadId: vmBot.threadId })).status).toBe(202);
    await expect.poll(async () => (await messages(vmBot.threadId)).some((message) => message.kind === "activity" && message.tool?.localFailure === "computer"), { timeout: 30000 }).toBe(true);
    await idle(vmBot);
    expect(dumpHas(text)).toBe(false);
    // Words nobody proved: no computer at all, so the turn runs without one.
    const servers = await directTurnServers(vmBot, "unproven caller asks for the local vm", false);
    expect(servers).not.toContain("computer");
    expect(servers).toContain("agents");
  }, 120000);

  it("refuses the Computer engine (the owner's cloud box) to words nobody proved", async () => {
    const refused = await api("POST", `/api/bots/${boxBot.id}/messages`, { text: "unproven caller asks the box", threadId: boxBot.threadId }, false);
    expect(refused.status).toBe(403);
    expect(JSON.stringify(await messages(boxBot.threadId))).not.toContain("unproven caller asks the box");
    // The owner's own words still go to the box (it is not reachable here).
    expect((await api("POST", `/api/bots/${boxBot.id}/messages`, { text: "owner asks the box", threadId: boxBot.threadId })).status).toBe(202);
    await idle(boxBot);
  }, 60000);

  it("still mounts the bot's own tools for words nobody proved", async () => {
    expect(await directTurnServers(lead, "unproven caller asks a teammate", false)).toContain("agents");
  }, 60000);

  it("keeps every owner integration on a routine run the owner made (no one present)", async () => {
    const created = await api("POST", "/api/routines", { botId: lead.id, name: "Morning sweep", prompt: "routine sweep: check my android and the connected apps", enabled: false,
      schedule: { type: "once", at: Date.now() + 3_600_000 } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    rmSync(dumpFile(), { force: true });
    const started = await api("POST", `/api/routines/${created.body.routine.id}/run`, {});
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    await expect.poll(() => dumpHas("routine sweep: check my android"), { timeout: 30000 }).toBe(true);
    const servers = Object.keys(readDump().mcpConfig?.mcpServers ?? {});
    for (const name of ["owner-tools", "composio", "browser", "phone", "dweb", "agents"]) expect(servers).toContain(name);
    await expect.poll(async () => (await api("GET", "/api/routines")).body.runs.find((run: any) => run.id === started.body.run.id)?.status, { timeout: 30000 })
      .toMatch(/completed|failed|cancelled/);
  }, 120000);
});
