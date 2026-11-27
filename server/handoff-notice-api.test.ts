// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SOCKET TEST (real server, real HTTP + SSE): a direct hand-off (delegate_bot) announces the peer's committed reply ONCE, in the ASKING
// conversation, under the asking bot (notify.ts buildDelegationNotification via askerWakePort.returned), and the worker's own turn end
// raises no second "done" buzz (index.ts delegatedFinish suppression). Controls: the same peer finishing an ordinary owner turn keeps its
// own done notice. Observed the way a desktop client sees it: the /api/events "notify" frames.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { openSse } from "./testing/sse.ts";
import { readFileSync } from "node:fs";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

let fixture: VerificationServer, desktop: Record<string, string>;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const HOLD = "__fixture_hold_authority__";
const post = async (path: string, body: unknown, headers: Record<string, string> = desktop, method = "POST") => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const newBot = async (name: string) => (await post("/api/bots", { name })).body.bot as { id: string; threadId: string };
type Turn = { pid: number; mcpConfig?: { mcpServers?: Record<string, { env?: Record<string, string> }> } };
const turnFor = async (tag: string): Promise<Turn> => {
  for (const started = Date.now(); Date.now() - started < 40000; await sleep(100)) {
    let lines: string[] = [];
    try { lines = readFileSync(fixture.fixtureDumpLogPath, "utf8").split("\n"); } catch { /* not yet */ }
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes(tag)) return withTurnSecrets(JSON.parse(lines[i]) as Turn);
  }
  throw new Error(`no turn for ${tag}`);
};
const tokenOf = (turn: Turn) => Object.values(turn.mcpConfig?.mcpServers ?? {}).map(server => server.env?.MURAGE_COMMS_TOKEN).find(Boolean)!;
const finish = (turn: Turn) => writeFileSync(join(fixture.fixtureFinishGateDir, String(turn.pid)), "finish");
type Frame = { kind: string; notification?: { kind: string; botId: string; threadId: string; body?: string; messageId?: string; deliveryId?: string; botName?: string } };

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { dumpLog: true });
  const secret = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
}, 90000);
afterAll(async () => { await fixture?.close(); });

describe.skipIf(process.platform === "win32")("a direct hand-off's completion notice, through the running server", () => {
  it("the peer's finished reply is announced once, in the asking chat under the asking bot, and the worker thread buzzes nothing", async () => {
    const asker = await newBot("Asker notice"), peer = await newBot("Peer notice");
    expect((await post(`/api/bots/${asker.id}/messages`, { text: `NOTICE_ASK ${HOLD}` })).status).toBeLessThan(300);
    const askerTurn = await turnFor("NOTICE_ASK");
    const stream = await openSse(`${fixture.info.url}/api/events`);
    try {
      await stream.until(frame => frame.kind === "hello");
      const handoff = post("/api/internal/delegate-bot", { fromBotId: asker.id, fromThreadId: asker.threadId, toBotId: peer.id, message: `Do it. NOTICE_PEER ${HOLD}` }, { authorization: `Bearer ${tokenOf(askerTurn)}` });
      const started = await Promise.race([handoff, sleep(8000).then(() => null)]);
      expect(started, "delegate-bot did not answer").not.toBeNull();
      expect(started!.status, JSON.stringify(started!.body)).toBe(200);
      // the hand-off is parked until the asking turn settles, then the peer's turn starts
      finish(askerTurn);
      const peerTurn = await turnFor("NOTICE_PEER");
      finish(peerTurn);
      const handoffNotice = (frame: Frame) => frame.kind === "notify" && frame.notification?.kind === "done" && Boolean(frame.notification.deliveryId?.startsWith("delegation:"));
      const notice = await stream.until((frame: Frame) => handoffNotice(frame), 15000).catch(() => null) as Frame | null;
      expect(notice, "no hand-off notice reached the stream").not.toBeNull();
      expect(notice!.notification).toMatchObject({ botId: asker.id, botName: "Peer notice", threadId: asker.threadId });
      expect(notice!.notification!.body).toContain("Fixture turn finished.");
      await sleep(1500);
      const dones = (stream.frames as Frame[]).filter(frame => frame.kind === "notify" && frame.notification?.kind === "done");
      expect((stream.frames as Frame[]).filter(handoffNotice)).toHaveLength(1);
      expect(dones.filter(frame => frame.notification!.threadId === peer.threadId)).toHaveLength(0);
    } finally { stream.close(); finish(askerTurn); }
  }, 120000);

  it("control: the same peer finishing an ordinary owner turn keeps its own done notice", async () => {
    const peer = await newBot("Peer control");
    expect((await post(`/api/bots/${peer.id}/messages`, { text: `CONTROL_PEER ${HOLD}` })).status).toBeLessThan(300);
    const turn = await turnFor("CONTROL_PEER");
    const stream = await openSse(`${fixture.info.url}/api/events`);
    try {
      await stream.until(frame => frame.kind === "hello");
      finish(turn);
      const done = await stream.until((frame: Frame) => frame.kind === "notify" && frame.notification?.kind === "done" && frame.notification.botId === peer.id, 20000) as Frame;
      expect(done.notification).toMatchObject({ botId: peer.id, threadId: peer.threadId });
    } finally { stream.close(); }
  }, 60000);
});
