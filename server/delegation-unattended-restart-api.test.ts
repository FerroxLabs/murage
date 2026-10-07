// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A handoff queued by an unattended turn (words nobody proved the owner sent)
// keeps that mark when Murage restarts before it runs (audit round 5, Kimi
// M1). The unattended mark lived only in this process, so the boot drain ran
// the peer's turn as if the owner were present, and Full access then skipped
// the owner's cards for it. Observed through the peer-contact card: a peer on
// Full access that asks for review of its handoffs still asks when the turn
// it runs in came from a queued unattended handoff.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

let fixture: VerificationServer, desktop: Record<string, string>;

const post = async (path: string, body: unknown, headers: Record<string, string> = desktop, method = "POST") => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const signIn = async () => {
  const secret = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
};
const newBot = async (name: string) => (await post("/api/bots", { name })).body.bot as { id: string; threadId: string };
const turnFor = async (tag: string) => {
  for (const started = Date.now(); Date.now() - started < 30000; await new Promise(resolve => setTimeout(resolve, 100))) {
    try { const text = readFileSync(fixture.fixtureDumpPath, "utf8"); if (text.includes(tag)) return withTurnSecrets(JSON.parse(text)) as { pid: number; mcpConfig?: { mcpServers?: Record<string, { env?: Record<string, string> }> } }; } catch { /* not yet */ }
  }
  throw new Error(`no turn for ${tag}`);
};
const tokenOf = (turn: Awaited<ReturnType<typeof turnFor>>) => Object.values(turn.mcpConfig?.mcpServers ?? {}).map(server => server.env?.MURAGE_COMMS_TOKEN).find(Boolean)!;

describe.skipIf(process.platform === "win32")("a queued unattended handoff across a restart", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env);
    await signIn();
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("still runs unattended, so Full access keeps the owner's card", async () => {
    const asker = await newBot("Asker");
    const peer = await newBot("Peer");
    const third = await newBot("Third");
    // the peer is on Full access and asks the owner before contacting another bot
    const level = await post(`/api/bots/${peer.id}`, { autoApprove: true, fullAccess: true, acknowledgeFullAccess: true, acknowledgeLocalAuto: true, approvePeerComms: true }, desktop, "PATCH");
    expect(level.status, JSON.stringify(level.body)).toBe(200);
    // the peer is busy with the owner's own turn
    await post(`/api/bots/${peer.id}/messages`, { text: "Hold on. __fixture_hold_authority__ PEER_HOLD" });
    await turnFor("PEER_HOLD");
    // words nobody proved the owner sent start the asker's turn, unattended
    expect((await post(`/api/bots/${asker.id}/messages`, { text: "Hold on. __fixture_hold_authority__ ASKER_HOLD" }, {})).status).toBeLessThan(300);
    const askerToken = tokenOf(await turnFor("ASKER_HOLD"));
    const asked = await post("/api/internal/delegate-bot", { fromBotId: asker.id, fromThreadId: asker.threadId, toBotId: peer.id, message: "Pass this on. DRAINED_TAG __fixture_hold_authority__" }, { authorization: `Bearer ${askerToken}` });
    expect(asked.status).toBe(200);
    expect(asked.body.queued).toBe(true);
    // Murage restarts before the peer is free; the boot drain runs the handoff
    await fixture.restart();
    await signIn();
    const drained = await turnFor("DRAINED_TAG");
    const handoff = await post("/api/internal/delegate-bot", { fromBotId: peer.id, fromThreadId: peer.threadId, toBotId: third.id, message: "Take this on." }, { authorization: `Bearer ${tokenOf(drained)}` });
    expect(handoff.status, JSON.stringify(handoff.body)).toBe(200);
    expect(handoff.body.queued).toBe(true);
    expect(handoff.body.message).toMatch(/^Queued for review/);
    writeFileSync(join(fixture.fixtureFinishGateDir, String(drained.pid)), "finish");
  }, 120000);
});
