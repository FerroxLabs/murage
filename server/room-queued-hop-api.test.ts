// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 lane queuedhop: a room member that is busy is queued
// (queueRoomMemberTurn) and started later by the dispatcher
// (startRoomRequestTurn). The queued turn must run as the turn it was queued
// for: a teammate's @mention (hop 1) runs as hop 1, the owner's own message
// as hop 0, and words nobody proved were the owner's stay that way, whether
// or not the member had to wait.
//
// Before this lane the dispatcher started every queued room turn as hop 0.
// Until lane cards a teammate's @mention that had to wait was recorded as the
// owner's and came back as the owner's turn: the owner's comms depth (it
// could hand work on again) and a fresh @mention chain of its own. Since lane
// cards records it as the bot's, the dispatcher's reach check refused it
// ("did not get to this: This bot cannot be reached from here").
//
// Real server, the repository's fake Claude CLI (every turn appends the MCP
// servers it was handed and the agents server's depth and skill switch to a
// log), one room from before the turn engine (the one-hop @mention chain is
// on there) and a second room that keeps the teammate busy.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { FAKE_FLUX_BROKER_INSTRUMENTATION } from "./testing/fake-flux-broker.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";
import { TURN_SECRET_ENV } from "./drivers/turn-credentials.ts";

// A supervised owner mount must run, even when the fake engine only records its config.
const OWNER_TOOLS_STUB = `import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize'
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'owner-tools-fixture', version: '1' } }
    : request.method === 'tools/list' ? { tools: [] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + String.fromCharCode(10));
});`;

// Discovery reaches the native protocol; keep the real browser controller and authority.
const NATIVE_BROWSER_STUB = `export function createNativeBrowser() {
  return {
    request: async method => {
      if (method !== 'tools/list') throw new Error('Browser fixture only lists tools');
      return { tools: [{ name: 'agent_browser_snapshot', inputSchema: { type: 'object', properties: {} } }] };
    },
    protected: async () => false, resetStream() {}, input() {}, command: async () => '',
    connect: async () => 'fixture-stream', close: async () => {},
  };
}`;

const posixOnly = describe.skipIf(process.platform === "win32");
const MENTION = "__fixture_mention_teammates__";
const HOLD = "__fixture_hold_second__";
let fixture: VerificationServer, headers: Record<string, string>;
let lead: { id: string }, second: { id: string };
let legacy: { id: string; threadId: string }, elsewhere: { id: string; threadId: string };
const api = async (method: string, path: string, body?: unknown, proven = true) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...(proven ? headers : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const groupState = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.groups.find((group: any) => group.id === id);
const idle = async (id: string) => { const state = await groupState(id); return Boolean(state) && !state.working && !state.busyBotId; };
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const openRequests = async (groupId: string) => (await api("GET", `/api/groups/${groupId}/requests?open=1`)).body.requests as any[];
type Turn = { servers: string[]; botId: string | null; threadId: string | null; depth: number | null; agentsEnv: Record<string, string>; agentsEnvKeys: string[]; skillAuthoring: string | null; prompt: string };
const logFile = () => fixture.fixtureDumpLogPath;
// What the server's Claude driver fed its warm key per turn (written by the claude.ts load hook below; parts = the key's field digests).
const WARM_KEY_LOG = join(tmpdir(), `l2w-1b-warm-keys-${process.pid}.jsonl`);
type WarmKeyRow = { parts: Record<string, string>; mcp: any; mcpDigest: string };
const warmKeyRows = (): WarmKeyRow[] => existsSync(WARM_KEY_LOG) ? readFileSync(WARM_KEY_LOG, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as WarmKeyRow) : [];
// Read the admitted mount captured beside the shim, with this turn's credential snapshot.
const turns = (): Turn[] => existsSync(logFile()) ? readFileSync(logFile(), "utf8").trim().split("\n").filter(Boolean).map((line): Turn => {
  const dump = withTurnSecrets(JSON.parse(line));
  const servers = dump.mcpConfig?.mcpServers ?? {}, agents = servers.agents?.env ?? {};
  // the agents env as the warm key sees it: per-turn secrets left out (drivers/turn-credentials.ts)
  const agentsEnv = Object.fromEntries(Object.entries(agents as Record<string, string>).filter(([key]) => !(TURN_SECRET_ENV as readonly string[]).includes(key)));
  return { agentsEnv, servers: Object.keys(servers).sort(), botId: agents.MURAGE_BOT_ID ?? null, threadId: agents.MURAGE_THREAD_ID ?? null,
    agentsEnvKeys: Object.keys(agents).sort(), depth: typeof dump.claimDepth === "number" ? dump.claimDepth : null, skillAuthoring: agents.MURAGE_SKILL_AUTHORING_ENABLED ?? null,
    prompt: typeof dump.prompt === "string" ? dump.prompt : JSON.stringify(dump.prompt) };
}) : [];
const gate = () => join(fixture.info.dataDir, "hold-gate");
const seen = () => join(fixture.info.dataDir, "hold-seen");
const refreshProof = async () => {
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
};

/** Keep Second speaking in the other room until release() (so the legacy room queues it). */
const holdSecond = async () => {
  rmSync(gate(), { force: true }); rmSync(seen(), { force: true });
  expect((await api("POST", `/api/groups/${elsewhere.id}/messages`, { text: `${HOLD} a long one please` })).status).toBe(202);
  await expect.poll(() => existsSync(seen()), { timeout: 20000 }).toBe(true);
  return async () => {
    writeFileSync(gate(), "");
    await expect.poll(() => idle(elsewhere.id), { timeout: 30000 }).toBe(true);
  };
};

const transcript = async () => (await messages(legacy.threadId)).map((m) => `${m.from?.name ?? m.actorKind ?? m.role}: ${m.tool?.name ?? String(m.text ?? "").slice(0, 100)}`).join("\n");

/** Send to the legacy room and wait for it and its queue to settle; returns the turns it ran. */
const roomRun = async (text: string, proven: boolean, options: { hold?: boolean } = {}): Promise<{ lead: Turn[]; second: Turn[] }> => {
  const release = options.hold ? await holdSecond() : undefined;
  const from = turns().length;
  expect((await api("POST", `/api/groups/${legacy.id}/messages`, { text }, proven)).status).toBe(202);
  if (release) {
    try {
      // Second is queued behind the other room, and has not answered yet
      await expect.poll(async () => (await openRequests(legacy.id)).some((request) => request.verb === "room_turn" && request.toBotId === second.id && request.state === "queued"), { timeout: 30000 }).toBe(true)
        .catch(async (error) => { throw new Error(`${error}\n${await transcript()}`); });
      expect(turns().slice(from).some((turn) => turn.botId === second.id && turn.threadId === legacy.threadId)).toBe(false);
    } finally { await release(); }
  }
  await expect.poll(() => turns().slice(from).some((turn) => turn.botId === second.id && turn.threadId === legacy.threadId), { timeout: 30000 }).toBe(true)
    .catch(async (error) => { throw new Error(`${error}\n${await transcript()}`); });
  await expect.poll(async () => await idle(legacy.id) && (await openRequests(legacy.id)).length === 0, { timeout: 30000 }).toBe(true);
  const ran = turns().slice(from).filter((turn) => turn.threadId === legacy.threadId);
  return { lead: ran.filter((turn) => turn.botId === lead.id), second: ran.filter((turn) => turn.botId === second.id) };
};
const OWNER_TOOLS = ["browser", "murage_connectors", "owner-tools"];
const shape = (turn: Turn) => ({ servers: turn.servers, depth: turn.depth, skillAuthoring: turn.skillAuthoring });

posixOnly("a queued room turn runs as the turn it was queued for", () => {
  beforeAll(async () => {
    rmSync(WARM_KEY_LOG, { force: true });
    fixture = await launchVerificationServer(process.env, undefined, {
      portRange: { from: 49_000, span: 900 },
      dumpLog: true,
      instrumentationSource: `
      ${FAKE_FLUX_BROKER_INSTRUMENTATION}
      const fs=await import('node:fs');const path=await import('node:path');
      const data=process.env.MURAGE_DATA_DIR;
      // The browser engine is the node executable (found, never run) and its
      // version check passes, as in room-owner-integrations-api.test.ts.
      process.env.MURAGE_AGENT_BROWSER_PATH=process.execPath;
      const { registerHooks } = await import('node:module');
      registerHooks({ load(url, context, nextLoad) {
        if(url.endsWith('/browser-native-relay.ts'))return {format:'module',shortCircuit:true,source:${JSON.stringify(NATIVE_BROWSER_STUB)}};
        if(!url.endsWith('/browser-engine.ts'))return nextLoad(url, context);
        const source=fs.readFileSync(new URL(url),'utf8');
        const start=source.indexOf('export async function verifyAgentBrowserBinary(');
        const end=source.indexOf('export async function ensureChrome(',start);
        if(start<0||end<0)throw new Error('Browser version fixture anchor changed');
        const hostCheck='if (browserHostRequiresSandboxBypass({';
        if(!source.includes(hostCheck))throw new Error('Browser host-check fixture anchor changed');
        const body=source.slice(0,start).replace(hostCheck,'if (false && browserHostRequiresSandboxBypass({')+'export async function verifyAgentBrowserBinary() {}\\n'+source.slice(end);
        return { format:'module-typescript', shortCircuit:true, source: body };
      } });
      // L2W-1b: the production warm-key observer seam (claude.ts) is given a writer at load, so the key the driver itself builds for
      // each dispatched turn leaves the server process (its digests are salted per process, so the test reads them, never rebuilds them).
      registerHooks({ load(url, context, nextLoad) {
        const loaded = nextLoad(url, context);
        if(!url.endsWith('/server/drivers/claude.ts'))return loaded;
        const source=String(loaded.source);
        const anchor='let warmKeyObserverForTests: ((key: WarmKey, parts: { mcp: unknown }) => void) | null = null;';
        if(!source.includes(anchor))throw new Error('Warm key observer fixture anchor changed');
        const writer='(key, parts) => { process.getBuiltinModule("node:fs").appendFileSync('+JSON.stringify(${JSON.stringify(WARM_KEY_LOG)})+', JSON.stringify({ parts: key.parts, mcp: parts.mcp, mcpDigest: warmKey({ mcp: parts.mcp }).parts.mcp }) + String.fromCharCode(10)); }';
        return { ...loaded, source: source.replace(anchor, 'let warmKeyObserverForTests: ((key: WarmKey, parts: { mcp: unknown }) => void) | null = '+writer+';') };
      } });
      const file=path.join(data,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      // the skill recorder is on, so a turn's skill-authoring switch shows
      cfg.features={...(cfg.features??{}),browser:true,skillRecorder:true};
      cfg.instances.verification.environment={
        FAKE_CLAUDE_DUMP_EACH_TURN:'1',
        FAKE_CLAUDE_MENTION_MARKER:${JSON.stringify(MENTION)},
        FAKE_CLAUDE_MENTION_REPLY:'@Second and @Lead, over to you.',
        FAKE_CLAUDE_HOLD_MARKER:${JSON.stringify(HOLD)},
        FAKE_CLAUDE_HOLD_GATE:path.join(data,'hold-gate'),
        FAKE_CLAUDE_HOLD_SEEN:path.join(data,'hold-seen'),
      };
      const ownerService=path.join(process.env.MURAGE_DATA_DIR,'owner-tools.mjs');
      fs.writeFileSync(ownerService,${JSON.stringify(OWNER_TOOLS_STUB)});
      cfg.mcpServers={'owner-tools':{command:process.execPath,args:[ownerService],env:{OWNER_TOOLS_FIXTURE:'1'}}};
      fs.writeFileSync(file,JSON.stringify(cfg));
      // A room named "Legacy" reads as a channel from before the turn engine
      // (no mentionChain field), so the boot marks it and the one-hop
      // @mention chain runs there (SPEC-P 4 [AMB-8]).
      const groups=path.join(data,'groups.json');
      if(fs.existsSync(groups)){const raw=JSON.parse(fs.readFileSync(groups,'utf8'));for(const group of raw)if(group.name==='Legacy')delete group.mentionChain;fs.writeFileSync(groups,JSON.stringify(raw));}
    ` });
    await refreshProof();
    const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "verification").models.options;
    const made = [] as Array<{ id: string }>;
    for (const name of ["Lead", "Second"]) {
      const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model: models[0].id } });
      expect(created.status).toBe(201);
      made.push(created.body.bot);
      // both hold every owner grant a bot can hold
      expect((await api("PATCH", `/api/bots/${created.body.bot.id}`, { computer: "off", browser: true, composio: true })).status).toBe(200);
    }
    [lead, second] = made;
    const room = async (name: string, defaultResponder: string) => {
      const created = await api("POST", "/api/groups", { name, memberIds: [lead.id, second.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: defaultResponder } } });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      return created.body.group as { id: string; threadId: string };
    };
    legacy = await room("Legacy", lead.id);
    elsewhere = await room("Elsewhere", second.id);
    await fixture.restart();
    await refreshProof();
  }, 90000);
  afterAll(async () => { await fixture?.close(); rmSync(WARM_KEY_LOG, { force: true }); });

  it("a teammate's @mention that waited runs as the teammate's mention (hop 1), exactly as one that did not wait", async () => {
    // not queued: the owner's message, the lead's reply @mentions Second, Second answers at once
    const direct = await roomRun(`${MENTION} plan the launch`, true);
    expect(direct.lead).toHaveLength(1);
    expect(direct.second).toHaveLength(1);
    expect(direct.second[0].depth).toBe(1);
    // L2W-1b (#5768): depth is read from the token record, so the agents env carries no depth and a depth-1 turn's
    // mount differs from a depth-0 turn's by nothing the depth sets (the warm key's `mcp` field stays equal for a depth-only change)
    expect(direct.second[0].agentsEnvKeys).not.toContain("MURAGE_TURN_DEPTH");
    expect(direct.lead[0].depth).toBe(0);
    expect(direct.lead[0].agentsEnvKeys).not.toContain("MURAGE_TURN_DEPTH");
    expect(direct.second[0].skillAuthoring).toBe("0");
    // queued: the same, with Second busy in the other room when the lead's mention lands
    const queued = await roomRun(`${MENTION} plan the launch again`, true, { hold: true });
    expect(queued.second).toHaveLength(1);
    // the same comms depth, skill switch and servers as the mention that did not wait
    expect(shape(queued.second[0])).toEqual(shape(direct.second[0]));
    // and its own reply (it @mentions the lead) starts no second hop
    expect(queued.lead).toHaveLength(direct.lead.length);
    // the queued row recorded the bot as its sender
    const rows = (await api("GET", `/api/groups/${legacy.id}/requests`)).body.requests as any[];
    expect(rows.some((request) => request.verb === "room_turn" && request.toBotId === second.id && request.fromKind === "bot")).toBe(true);
  }, 180000);

  it("L2W-1b (#5768): a member's hop-1 and hop-0 turns in one room differ in the agents mount only by the skill switch", async () => {
    // A teammate's @mention runs Second at hop 1; the owner's own @Second runs it at hop 0 in the same room thread.
    const mention = await roomRun(`${MENTION} warm key at hop 1`, true);
    const owner = await roomRun("@Second warm key at hop 0", true);
    expect(mention.second).toHaveLength(1);
    expect(owner.second).toHaveLength(1);
    const [hop1, hop0] = [mention.second[0], owner.second[0]];
    const env = (turn: Turn) => turn.agentsEnv;
    // the turn-release instance and token are drawn fresh for every turn (proxy-turn-release.ts), so any two turns differ there
    const perTurn = new Set(["MURAGE_RELEASE_INSTANCE", "MURAGE_RELEASE_TOKEN"]);
    const changed = [...new Set([...Object.keys(env(hop1)), ...Object.keys(env(hop0))])].filter((key) => !perTurn.has(key) && env(hop1)[key] !== env(hop0)[key]).sort();
    // the depth is read from the token record, so the only agents-env difference is the skill switch the room gates on hop
    // (index.ts room turn: skillAuthoring needs hop === 0); a depth env would add MURAGE_TURN_DEPTH here
    expect(changed).toEqual(["MURAGE_SKILL_AUTHORING_ENABLED"]);
    expect([env(hop1).MURAGE_SKILL_AUTHORING_ENABLED, env(hop0).MURAGE_SKILL_AUTHORING_ENABLED]).toEqual(["0", "1"]);
    expect([hop1.depth, hop0.depth]).toEqual([1, 0]);
  }, 180000);

  // L2W-1b production-key half. The booted server's Claude driver writes, for every turn it dispatches, the `mcp` value it feeds
  // the warm key at claude.ts (`mcp: mcpPart`) next to the key's own digest of it (instrumentation in beforeAll). Nothing here
  // rebuilds the key: the rows are what the real room dispatch produced for the real hop-1 and hop-0 mounts.
  it("L2W-1b (#5768): the warm key the Claude driver builds for a member's hop-1 turn and hop-0 turn differs in the agents mount only by the skill switch", async () => {
    const before = warmKeyRows().length;
    await roomRun(`${MENTION} warm key at hop 1`, true);
    const middle = warmKeyRows().length;
    await roomRun("@Second warm key at hop 0", true);
    const ofSecond = (from: number, to?: number) => warmKeyRows().slice(from, to).filter((row) => row.mcp?.agents?.env?.MURAGE_BOT_ID === second.id && row.mcp.agents.env.MURAGE_THREAD_ID === legacy.threadId);
    const [hop1, hop0] = [ofSecond(before, middle), ofSecond(middle)];
    expect([hop1.length, hop0.length]).toEqual([1, 1]);
    // the mcp value logged is the one the key hashed (same digest the key holds for its `mcp` field)
    for (const row of [hop1[0]!, hop0[0]!]) expect(row.mcpDigest).toBe(row.parts.mcp);
    const env = (row: WarmKeyRow) => row.mcp.agents.env as Record<string, string>;
    // the turn-release instance and token are drawn fresh for every turn (proxy-turn-release.ts), so any two turns differ there
    const perTurn = new Set(["MURAGE_RELEASE_INSTANCE", "MURAGE_RELEASE_TOKEN"]);
    const changed = [...new Set([...Object.keys(env(hop1[0]!)), ...Object.keys(env(hop0[0]!))])].filter((name) => !perTurn.has(name) && env(hop1[0]!)[name] !== env(hop0[0]!)[name]).sort();
    expect(changed).toEqual(["MURAGE_SKILL_AUTHORING_ENABLED"]);
    expect([env(hop1[0]!).MURAGE_SKILL_AUTHORING_ENABLED, env(hop0[0]!).MURAGE_SKILL_AUTHORING_ENABLED]).toEqual(["0", "1"]);
  }, 180000);

  it("the owner's own message that waited keeps everything the owner's message gets at once", async () => {
    const direct = await roomRun("@Second owner asks for the tools", true);
    expect(direct.second).toHaveLength(1);
    expect(direct.second[0].servers).toEqual(expect.arrayContaining(OWNER_TOOLS));
    expect(direct.second[0].depth).toBe(0);
    const queued = await roomRun("@Second owner asks for the tools again", true, { hold: true });
    expect(queued.second).toHaveLength(1);
    expect(queued.second[0].prompt).toContain("owner asks for the tools again");
    // the same servers (the owner's integrations included) and comms depth;
    // a queued turn is started with its request's words as a continuation,
    // which never offers skill authoring (unchanged by this lane)
    expect({ servers: queued.second[0].servers, depth: queued.second[0].depth }).toEqual({ servers: direct.second[0].servers, depth: direct.second[0].depth });
  }, 180000);

  it("words nobody proved that waited get none of the owner's integrations, even after the owner speaks", async () => {
    const queued = await roomRun("@Second unproven caller asks for the tools", false, { hold: true });
    expect(queued.second).toHaveLength(1);
    expect(queued.second[0].prompt).toContain("unproven caller asks for the tools");
    for (const name of OWNER_TOOLS) expect(queued.second[0].servers).not.toContain(name);
    expect(queued.second[0].servers).toContain("agents");
  }, 180000);

  // 0.1.61 lane retryowner: Retry on a finished room turn (POST
  // .../requests/:id/retry) queues a new attempt that the dispatcher starts
  // like any queued turn. It is the same turn again: a teammate's @mention
  // stays the teammate's (hop 1), the owner's message stays the owner's.
  const roomRows = async () => (await api("GET", `/api/groups/${legacy.id}/requests`)).body.requests as any[];
  const retryAndRun = async (requestId: string) => {
    const from = turns().length;
    const retried = await api("POST", `/api/groups/${legacy.id}/requests/${requestId}/retry`, {});
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    await expect.poll(() => turns().slice(from).some((turn) => turn.botId === second.id && turn.threadId === legacy.threadId), { timeout: 30000 }).toBe(true)
      .catch(async (error) => { throw new Error(`${error}\n${await transcript()}`); });
    await expect.poll(async () => await idle(legacy.id) && (await openRequests(legacy.id)).length === 0, { timeout: 30000 }).toBe(true);
    const ran = turns().slice(from).filter((turn) => turn.threadId === legacy.threadId);
    return { request: retried.body.request, lead: ran.filter((turn) => turn.botId === lead.id), second: ran.filter((turn) => turn.botId === second.id) };
  };

  it("a retried teammate @mention runs as the teammate's mention (hop 1), never as the owner's turn", async () => {
    const direct = await roomRun(`${MENTION} plan the retry`, true);
    expect(direct.second).toHaveLength(1);
    expect(direct.second[0].depth).toBe(1);
    const mention = (await roomRows()).filter((request) => request.verb === "room_turn" && request.toBotId === second.id && request.fromKind === "bot" && request.state === "done").at(-1);
    expect(mention, JSON.stringify(await roomRows())).toBeTruthy();
    const again = await retryAndRun(mention.id);
    // recorded from the bot, as the turn it retries
    expect(again.request.fromKind).toBe("bot");
    expect(again.second).toHaveLength(1);
    // the mention's comms depth and servers, not the owner's hop 0
    expect(shape(again.second[0])).toEqual(shape(direct.second[0]));
    // and its own @mention reply starts no new hop
    expect(again.lead).toHaveLength(0);
  }, 180000);

  it("a retried owner room turn stays the owner's turn", async () => {
    const direct = await roomRun("@Second owner asks for the tools once more", true);
    expect(direct.second).toHaveLength(1);
    const owned = (await roomRows()).filter((request) => request.verb === "room_turn" && request.toBotId === second.id && request.fromKind === "owner" && request.state === "done").at(-1);
    expect(owned).toBeTruthy();
    const again = await retryAndRun(owned.id);
    expect(again.request.fromKind).toBe("owner");
    expect(again.second).toHaveLength(1);
    expect({ servers: again.second[0].servers, depth: again.second[0].depth }).toEqual({ servers: direct.second[0].servers, depth: 0 });
    expect(again.second[0].servers).toEqual(expect.arrayContaining(OWNER_TOOLS));
  }, 180000);

  it("a caller that cannot prove it is the owner cannot retry a room turn", async () => {
    const owned = (await roomRows()).filter((request) => request.verb === "room_turn" && request.fromKind === "owner" && request.state === "done").at(-1);
    expect(owned).toBeTruthy();
    const before = (await roomRows()).length;
    const refused = await api("POST", `/api/groups/${legacy.id}/requests/${owned.id}/retry`, {}, false);
    // the route admits only the desktop or the paired phone (route-policy.ts)
    expect(refused.status).toBe(404);
    expect((await roomRows()).length).toBe(before);
  }, 60000);
});

// The unproven branch of retryRoomRequest (server/index.ts cannot be imported
// in a test, and the route refuses such a caller before it runs): a retry
// keeps the old turn's sender, and a caller's origin can only narrow it.
describe("retryRoomRequest (source)", () => {
  const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
  const start = source.indexOf("function retryRoomRequest(");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  it("records the retried room_turn from the old row's sender and narrows an unproven caller's retry", () => {
    expect(start).toBeGreaterThan(0);
    const roomTurn = body.slice(body.indexOf('verb: "room_turn"') - 80);
    expect(roomTurn).toContain("fromKind: old.fromKind");
    expect(roomTurn).not.toMatch(/verb: "room_turn", fromKind: "owner"/);
    expect(body).toMatch(/origin === "unproven" \? \{ narrow: roomLineage\(threadId, origin\) \}/);
    // both the wake and the room_turn branches carry it
    expect(body.split("...narrowed").length - 1).toBe(2);
  });
});
