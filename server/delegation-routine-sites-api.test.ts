// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SOCKET TEST (real server, real HTTP): the four places a turn hands work to another bot (ask_bot, delegation and the two queued
// bot-to-bot paths) must carry a routine's unattended mark. A live routine run on bot A (a scheduled or manual run is never marked
// itself) hands work to bot B; B's turn must be unattended. Observed the way the owner would: B is on Full access with "review peer
// contact" on, and asks a third bot. An unattended turn still raises the owner's card ("Queued for review"); an attended one is waived
// ("Delegation queued"). The control is the same hand-off from an ordinary owner conversation, which stays attended.
import { readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

let fixture: VerificationServer, desktop: Record<string, string>;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const post = async (path: string, body: unknown, headers: Record<string, string> = desktop, method = "POST") => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const signIn = async () => {
  const secret = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
};
const newBot = async (name: string) => (await post("/api/bots", { name })).body.bot as { id: string; threadId: string };
type Turn = { pid: number; mcpConfig?: { mcpServers?: Record<string, { env?: Record<string, string> }> } };
const turnFor = async (tag: string, notPids: number[] = []): Promise<Turn> => {
  for (const started = Date.now(); Date.now() - started < 40000; await sleep(100)) {
    try { const text = readFileSync(fixture.fixtureDumpPath, "utf8"); if (text.includes(tag)) { const turn = withTurnSecrets(JSON.parse(text) as Turn); if (!notPids.includes(turn.pid)) return turn; } } catch { /* not yet */ }
  }
  throw new Error(`no turn for ${tag}`);
};
const tokenOf = (turn: Turn) => Object.values(turn.mcpConfig?.mcpServers ?? {}).map(server => server.env?.MURAGE_COMMS_TOKEN).find(Boolean)!;
const threadOf = (turn: Turn) => Object.values(turn.mcpConfig?.mcpServers ?? {}).map(server => server.env?.MURAGE_THREAD_ID).find(Boolean)!;
const finish = (turn: Turn) => writeFileSync(join(fixture.fixtureFinishGateDir, String(turn.pid)), "finish");
const HOLD = "__fixture_hold_authority__";

beforeAll(async () => { fixture = await launchVerificationServer(process.env); await signIn(); }, 90000);
afterAll(async () => { await fixture?.close(); });

/** An asker, a peer on Full access that reviews its own peer contact, and a third bot for the peer's second hop. */
async function trio(label: string) {
  const asker = await newBot(`Asker ${label}`), peer = await newBot(`Peer ${label}`), third = await newBot(`Third ${label}`);
  const level = await post(`/api/bots/${peer.id}`, { autoApprove: true, fullAccess: true, acknowledgeFullAccess: true, acknowledgeLocalAuto: true, approvePeerComms: true }, desktop, "PATCH");
  expect(level.status, JSON.stringify(level.body)).toBe(200);
  return { asker, peer, third };
}
/** A live routine run on the asker, held, and its comms token. */
async function routineTurn(asker: { id: string }, tag: string) {
  const created = await post("/api/routines", { name: `Sweep ${tag}`, prompt: `${tag} ${HOLD}`, botId: asker.id, enabled: false, schedule: { type: "interval", everyMinutes: 30, anchorAt: Date.now() }, timeoutMinutes: 20, permissionMode: "ask" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await post(`/api/routines/${created.body.routine.id}/run`, {})).status).toBe(201);
  const turn = await turnFor(tag);
  return { turn, token: tokenOf(turn), threadId: threadOf(turn) };
}
/** An ordinary owner conversation's held turn on the asker (the control). */
async function ownerTurn(asker: { id: string }, tag: string) {
  expect((await post(`/api/bots/${asker.id}/messages`, { text: `${tag} ${HOLD}` })).status).toBeLessThan(300);
  const turn = await turnFor(tag);
  return { turn, token: tokenOf(turn), threadId: threadOf(turn) };
}
/** From the peer's turn, hand work to the third bot: the card is asked ("Queued for review") only when the peer's turn is unattended. */
async function secondHop(peerTurn: Turn, peer: { id: string; threadId: string }, third: { id: string }, tag?: string) {
  // a drained turn can be restarted once while the peer settles: use the latest token the dump shows for this turn
  let handoff: { status: number; body: any } = { status: 0, body: null };
  for (let attempt = 0; attempt < 15; attempt++) {
    const turn = tag ? await turnFor(tag) : peerTurn;
    handoff = await post("/api/internal/delegate-bot", { fromBotId: peer.id, fromThreadId: peer.threadId, toBotId: third.id, message: "Take this on." }, { authorization: `Bearer ${tokenOf(turn)}` });
    if (handoff.status !== 401) break;
    await sleep(400);
  }
  expect(handoff.status, JSON.stringify(handoff.body)).toBe(200);
  return String(handoff.body.message ?? "");
}
const ASKED = /^Queued for review/, WAIVED = /^Delegation queued/;
const fire = (path: string, token: string, body: unknown): Promise<any> => fetch(`${fixture.info.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json()).catch(() => undefined);

describe.skipIf(process.platform === "win32")("a live routine run hands work to another bot through each of the four sites", () => {
  it("control: the same hand-offs from an owner conversation keep the peer's turn attended", async () => {
    const { asker, peer, third } = await trio("control");
    const { token } = await ownerTurn(asker, "CTRL_ASK");
    void fire("/api/internal/ask-bot", token, { fromBotId: asker.id, fromThreadId: asker.threadId, toBotId: peer.id, message: `Do it. CTRL_PEER ${HOLD}`, depth: 0 });
    const peerTurn = await turnFor("CTRL_PEER");
    expect(await secondHop(peerTurn, peer, third)).toMatch(WAIVED);
    finish(peerTurn);
  }, 120000);

  it("ask_bot (an idle peer): the peer's turn is unattended", async () => {
    const { asker, peer, third } = await trio("ask");
    const { token, threadId } = await routineTurn(asker, "RT_ASK");
    void fire("/api/internal/ask-bot", token, { fromBotId: asker.id, fromThreadId: threadId, toBotId: peer.id, message: `Do it. ASK_PEER ${HOLD}`, depth: 0 });
    const peerTurn = await turnFor("ASK_PEER");
    expect(await secondHop(peerTurn, peer, third)).toMatch(ASKED);
    finish(peerTurn);
  }, 120000);

  // The queued ask's hand-off is parked in the delegation ledger on disk until the asker's turn settles: its mark is read there.
  const ledgerItem = (needle: string) => {
    const ledger = JSON.parse(readFileSync(join(fixture.info.dataDir, "delegations.json"), "utf8")) as Record<string, Array<{ message?: string; unattended?: boolean; routineAuthority?: { permissionMode?: string; triggerSource?: string } }>>;
    return Object.values(ledger).flat().find(item => String(item.message ?? "").includes(needle));
  };
  it("the queued ask while the peer is busy: the parked hand-off carries the routine's ceiling, not an unattended mark (and carries neither from an owner conversation)", async () => {
    const { asker, peer } = await trio("busy");
    expect((await post(`/api/bots/${peer.id}/messages`, { text: `PEER_BUSY ${HOLD}` })).status).toBeLessThan(300);
    const busy = await turnFor("PEER_BUSY");
    const routine = await routineTurn(asker, "RT_BUSY");
    const queued = await fire("/api/internal/ask-bot", routine.token, { fromBotId: asker.id, fromThreadId: routine.threadId, toBotId: peer.id, message: `Do it. BUSY_ROUTINE ${HOLD}`, depth: 0 });
    expect(queued?.busy, JSON.stringify(queued)).toBe(true);
    // s3b: bounded by the persisted ceiling (Ask by default), not marked unattended
    expect(ledgerItem("BUSY_ROUTINE")?.unattended).toBeUndefined();
    expect(ledgerItem("BUSY_ROUTINE")?.routineAuthority).toMatchObject({ permissionMode: "ask" });
    const asker2 = await newBot("Owner asker");
    const owner = await ownerTurn(asker2, "OWNER_BUSY");
    const parked = await fire("/api/internal/ask-bot", owner.token, { fromBotId: asker2.id, fromThreadId: owner.threadId, toBotId: peer.id, message: `Do it. BUSY_OWNER ${HOLD}`, depth: 0 });
    expect(parked?.busy, JSON.stringify(parked)).toBe(true);
    expect(ledgerItem("BUSY_OWNER")).toBeTruthy();
    expect(ledgerItem("BUSY_OWNER")?.unattended).toBeUndefined();
    expect(ledgerItem("BUSY_OWNER")?.routineAuthority).toBeUndefined();
    for (const turn of [busy, routine.turn, owner.turn]) finish(turn);
  }, 150000);

  it("delegate_bot (queued behind the routine's own turn, run after it): unattended", async () => {
    const { asker, peer, third } = await trio("delegate");
    const { turn, token, threadId } = await routineTurn(asker, "RT_DELEGATE");
    const queued = await fire("/api/internal/delegate-bot", token, { fromBotId: asker.id, fromThreadId: threadId, toBotId: peer.id, message: `Pass this on. DELEGATE_DRAINED ${HOLD}` });
    expect(queued?.queued, JSON.stringify(queued)).toBe(true);
    finish(turn);
    const drained = await turnFor("DELEGATE_DRAINED", [turn.pid]);
    expect(await secondHop(drained, peer, third)).toMatch(ASKED);
    finish(drained);
  }, 150000);
});
