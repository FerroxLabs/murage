// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 lane roommcp: the owner's own integrations ride a room turn only
// when the room turn answers the owner (roomOwnerAudience: the room's human
// is the workspace owner, the words were proven to be the owner's, and the
// request the turn answers was not queued for anyone else).
//
// A 1:1 turn mounts the owner's custom MCP servers, connected apps and
// browser only for the owner (humanIsOwner, projectBotForTask). The room turn
// mounted all three with no audience check, so words nobody proved were the
// owner's (a script or a bot's own shell on loopback, no desktop secret, no
// paired phone) got a room member holding the owner's local MCP servers
// (which run on the owner's computer with the owner's env), the owner's
// connected apps and the owner's browser.
//
// Real server, the repository's fake Claude CLI (it dumps the --mcp-config
// it was handed, every turn), one room, the same bot, the owner's proven
// send and an unproven one.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { FAKE_FLUX_BROKER_INSTRUMENTATION } from "./testing/fake-flux-broker.ts";

const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>;
let room: { id: string; threadId: string };
const api = async (method: string, path: string, body?: unknown, proven = true) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...(proven ? headers : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const groupState = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.groups.find((group: any) => group.id === id);
const dumpFile = () => join(fixture.info.dataDir, "fake-claude-dump.json");

/** Send one room message and return the MCP server names its member's turn was handed. */
const roomTurnServers = async (text: string, proven: boolean): Promise<string[]> => {
  rmSync(dumpFile(), { force: true });
  expect((await api("POST", `/api/groups/${room.id}/messages`, { text }, proven)).status).toBe(202);
  await expect.poll(() => existsSync(dumpFile()) && readFileSync(dumpFile(), "utf8").includes(text), { timeout: 30000 }).toBe(true);
  await expect.poll(async () => { const state = await groupState(room.id); return !state.working && !state.busyBotId; }, { timeout: 30000 }).toBe(true);
  const dump = JSON.parse(readFileSync(dumpFile(), "utf8")) as { prompt: unknown; mcpConfig: { mcpServers?: Record<string, unknown> } | null };
  expect(JSON.stringify(dump.prompt)).toContain(text);
  return Object.keys(dump.mcpConfig?.mcpServers ?? {}).sort();
};

posixOnly("the owner's integrations in a room turn", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, {
      portRange: { from: 49_000, span: 900 },
      instrumentationSource: `
      ${FAKE_FLUX_BROKER_INSTRUMENTATION}
      const fs=await import('node:fs');const path=await import('node:path');
      // The browser engine is the node executable (found, never run) and its
      // version check passes, as in the late-terminal test's fixture.
      process.env.MURAGE_AGENT_BROWSER_PATH=process.execPath;
      const { registerHooks } = await import('node:module');
      registerHooks({ load(url, context, nextLoad) {
        if(!url.endsWith('/browser-engine.ts'))return nextLoad(url, context);
        const source=fs.readFileSync(new URL(url),'utf8');
        const start=source.indexOf('export async function verifyAgentBrowserBinary(');
        const end=source.indexOf('export async function ensureChrome(',start);
        if(start<0||end<0)throw new Error('Browser version fixture anchor changed');
        // The test container is a container: the engine's host check (it
        // refuses root and container hosts) is the one line this fixture lifts.
        const hostCheck='if (process.platform === "linux" && (process.getuid?.() === 0';
        if(!source.includes(hostCheck))throw new Error('Browser host-check fixture anchor changed');
        const body=source.slice(0,start).replace(hostCheck,'if (false && (process.getuid?.() === 0')+'export async function verifyAgentBrowserBinary() {}\\n'+source.slice(end);
        return { format:'module-typescript', shortCircuit:true, source: body };
      } });
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.features={...(cfg.features??{}),browser:true};
      // every turn's --mcp-config is dumped, not only the first one's
      cfg.instances.verification.environment={FAKE_CLAUDE_DUMP_EACH_TURN:'1'};
      // The owner's own local MCP server (never started: the fake CLI only reads the config).
      cfg.mcpServers={'owner-tools':{command:'owner-tools-fixture',args:['--serve'],env:{OWNER_TOOLS_FIXTURE:'1'}}};
      // A workspace connected-apps key (self-hosted): connected apps are configured.
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "verification").models.options;
    const created = [] as Array<{ id: string; threadId: string }>;
    for (const name of ["Lead", "Second"]) {
      const made = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model: models[0].id } });
      expect(made.status).toBe(201);
      created.push(made.body.bot);
    }
    // The lead holds every owner grant a bot can hold; the second holds none.
    expect((await api("PATCH", `/api/bots/${created[0].id}`, { computer: "off", browser: true, composio: true })).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${created[1].id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    const made = await api("POST", "/api/groups", { name: "Owner tools room", memberIds: created.map(bot => bot.id), setup: { bulletin: "", defaultResponder: { kind: "member", botId: created[0].id } } });
    expect(made.status).toBe(201);
    room = made.body.group;
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("mounts the owner's custom MCP servers for the owner's words, and not for words nobody proved", async () => {
    expect(await roomTurnServers("owner asks for the custom tools", true)).toContain("owner-tools");
    expect(await roomTurnServers("unproven caller asks for the custom tools", false)).not.toContain("owner-tools");
    // and the owner's next proven message has them again
    expect(await roomTurnServers("owner asks for the custom tools again", true)).toContain("owner-tools");
  }, 120000);

  it("mounts the owner's connected apps for the owner's words, and not for words nobody proved", async () => {
    expect(await roomTurnServers("owner asks for connected apps", true)).toContain("composio");
    expect(await roomTurnServers("unproven caller asks for connected apps", false)).not.toContain("composio");
    // the member is told its connected apps are off for it, never handed the tool guide
    const dump = JSON.parse(readFileSync(dumpFile(), "utf8")) as { systemPrompt: string | null };
    expect(dump.systemPrompt ?? "").not.toContain("COMPOSIO_MULTI_EXECUTE_TOOL");
    expect(await roomTurnServers("owner asks for connected apps again", true)).toContain("composio");
  }, 120000);

  it("mounts the owner's browser for the owner's words, and not for words nobody proved", async () => {
    expect(await roomTurnServers("owner asks for the browser", true)).toContain("browser");
    expect(await roomTurnServers("unproven caller asks for the browser", false)).not.toContain("browser");
    expect(await roomTurnServers("owner asks for the browser again", true)).toContain("browser");
  }, 120000);

  it("still mounts the room's own tools for words nobody proved", async () => {
    // Nothing is taken from the turn that is not the owner's: the room's
    // agents tools (asks and hand-offs) stay.
    expect(await roomTurnServers("unproven caller asks a teammate", false)).toContain("agents");
  }, 60000);
});
