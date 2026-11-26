// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PHONEAUD (arbiter3 G2 / Astra 6, phonefix r4): the owner's paired phone in a room, through a real queued dispatch. A member summoned
// by the owner's chain (the lead's @mention answering the owner's own words) that is busy elsewhere is queued (queueRoomMemberTurn, which
// stamps the request with the summoner's resolved ancestry) and started later by the dispatcher (startRoomRequestTurn). That queued turn
// keeps the paired phone exactly as the same mention that did not wait; so does the owner's own queued send (proved by its typed line).
// A summoned member's request queued without its stamp is unmarked and fails closed, so the first case is RED when the stamp or its
// carrier is lost; the owner's own queued send (hop 0) takes no stamp and rides its proof (roomRequestOwnerProof).
//
// Real server, the repository's fake Claude CLI (every turn dumps the MCP servers it was handed), one room from before the turn engine
// (the one-hop @mention chain runs there) and a second room that keeps the teammate busy. Shaped like room-queued-hop-api.test.ts.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { FAKE_FLUX_BROKER_INSTRUMENTATION } from "./testing/fake-flux-broker.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

const posixOnly = describe.skipIf(process.platform === "win32");
const MENTION = "__fixture_mention_teammates__";
const HOLD = "__fixture_hold_second__";
let fixture: VerificationServer, headers: Record<string, string>;
let lead: { id: string }, second: { id: string };
let legacy: { id: string; threadId: string }, elsewhere: { id: string; threadId: string };
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const groupState = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.groups.find((group: any) => group.id === id);
const idle = async (id: string) => { const state = await groupState(id); return Boolean(state) && !state.working && !state.busyBotId; };
const openRequests = async (groupId: string) => (await api("GET", `/api/groups/${groupId}/requests?open=1`)).body.requests as any[];
type Turn = { servers: string[]; botId: string | null; threadId: string | null; depth: string | null };
const turns = (): Turn[] => existsSync(fixture.fixtureDumpLogPath) ? readFileSync(fixture.fixtureDumpLogPath, "utf8").trim().split("\n").filter(Boolean).map((line): Turn => {
  const dump = withTurnSecrets(JSON.parse(line));
  const servers = dump.mcpConfig?.mcpServers ?? {}, agents = servers.agents?.env ?? {};
  return { servers: Object.keys(servers).sort(), botId: agents.MURAGE_BOT_ID ?? null, threadId: agents.MURAGE_THREAD_ID ?? null, depth: agents.MURAGE_TURN_DEPTH ?? null };
}) : [];
const gate = () => join(fixture.info.dataDir, "hold-gate");
const seen = () => join(fixture.info.dataDir, "hold-seen");
const refreshProof = async () => {
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
};

/** Keep Second speaking in the other room until the returned release (so the legacy room queues it). */
const holdSecond = async () => {
  rmSync(gate(), { force: true }); rmSync(seen(), { force: true });
  expect((await api("POST", `/api/groups/${elsewhere.id}/messages`, { text: `${HOLD} a long one please` })).status).toBe(202);
  await expect.poll(() => existsSync(seen()), { timeout: 20000 }).toBe(true);
  return async () => {
    writeFileSync(gate(), "");
    await expect.poll(() => idle(elsewhere.id), { timeout: 30000 }).toBe(true);
  };
};

/** The owner's words in the legacy room; with `hold`, Second is busy when its turn comes and is queued. Returns Second's turns there. */
const roomRun = async (text: string, hold: boolean): Promise<Turn[]> => {
  const release = hold ? await holdSecond() : undefined;
  const from = turns().length;
  expect((await api("POST", `/api/groups/${legacy.id}/messages`, { text })).status).toBe(202);
  if (release) {
    try {
      await expect.poll(async () => (await openRequests(legacy.id)).some((request) => request.verb === "room_turn" && request.toBotId === second.id && request.state === "queued"), { timeout: 30000 }).toBe(true);
      // queued, not yet answered
      expect(turns().slice(from).some((turn) => turn.botId === second.id && turn.threadId === legacy.threadId)).toBe(false);
    } finally { await release(); }
  }
  await expect.poll(() => turns().slice(from).some((turn) => turn.botId === second.id && turn.threadId === legacy.threadId), { timeout: 30000 }).toBe(true);
  await expect.poll(async () => await idle(legacy.id) && (await openRequests(legacy.id)).length === 0, { timeout: 30000 }).toBe(true);
  return turns().slice(from).filter((turn) => turn.threadId === legacy.threadId && turn.botId === second.id);
};

posixOnly("the owner's paired phone in a room survives a real queued dispatch", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, {
      portRange: { from: 49_000, span: 900 },
      dumpLog: true,
      instrumentationSource: `
      ${FAKE_FLUX_BROKER_INSTRUMENTATION}
      const fs=await import('node:fs');const path=await import('node:path');
      const data=process.env.MURAGE_DATA_DIR;
      const file=path.join(data,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.verification.environment={
        FAKE_CLAUDE_DUMP_EACH_TURN:'1',
        FAKE_CLAUDE_MENTION_MARKER:${JSON.stringify(MENTION)},
        FAKE_CLAUDE_MENTION_REPLY:'@Second and @Lead, over to you.',
        FAKE_CLAUDE_HOLD_MARKER:${JSON.stringify(HOLD)},
        FAKE_CLAUDE_HOLD_GATE:path.join(data,'hold-gate'),
        FAKE_CLAUDE_HOLD_SEEN:path.join(data,'hold-seen'),
      };
      fs.writeFileSync(file,JSON.stringify(cfg));
      // A room named "Legacy" reads as a channel from before the turn engine (no mentionChain field): the one-hop @mention chain runs there.
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
  afterAll(async () => { await fixture?.close(); });

  it("a member the owner's chain summons keeps the paired phone when it had to wait, as when it did not", async () => {
    // not queued: the lead's @mention answering the owner reaches Second at once, with the owner's phone
    const direct = await roomRun(`${MENTION} check my phone for the launch`, false);
    expect(direct).toHaveLength(1);
    expect(direct[0].depth).toBe("1");
    expect(direct[0].servers, "summoned member, not queued").toContain("phone");
    // queued: the same, with Second busy in the other room; the dispatcher starts it from the stamped request
    const queued = await roomRun(`${MENTION} check my phone for the launch again`, true);
    expect(queued).toHaveLength(1);
    expect(queued[0].depth).toBe("1");
    expect(queued[0].servers, "summoned member, queued and dispatched").toEqual(direct[0].servers);
    const rows = (await api("GET", `/api/groups/${legacy.id}/requests`)).body.requests as any[];
    expect(rows.some((request) => request.verb === "room_turn" && request.toBotId === second.id && request.fromKind === "bot")).toBe(true);
  }, 180000);

  it("the owner's own queued send keeps the paired phone through its proof", async () => {
    const direct = await roomRun("@Second check my phone please", false);
    expect(direct).toHaveLength(1);
    expect(direct[0].servers, "owner's own send, not queued").toContain("phone");
    const queued = await roomRun("@Second check my phone please, again", true);
    expect(queued).toHaveLength(1);
    expect(queued[0].servers, "owner's own send, queued and dispatched").toEqual(direct[0].servers);
  }, 180000);
});
