// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A handoff made in an owner conversation has no stand-in room request: its queue row (pending_delegations) is all there is. It is recorded at queue time,
// no room lists anything for it, and after a restart it runs once: its prompt is written under the row's turn key (dlg-<id>) in the same commit as its start.
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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

const query = <T,>(sql: string) => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return db.prepare(sql).all() as T[]; }
  finally { db.close(); }
};
const rowsOf = () => query<{ id: string; phase: string; origin: string; turn_key: string | null; accepted_turn_id: string | null }>("SELECT id, phase, origin, turn_key, accepted_turn_id FROM pending_delegations");
const requestsOf = () => query<{ id: string }>("SELECT id FROM room_requests WHERE admission_key LIKE 'ask:delegation:%'");
const promptsOf = () => query<{ id: string; thread_id: string }>("SELECT id, thread_id FROM messages WHERE id LIKE 'dlg-%'");

describe.skipIf(process.platform === "win32")("an owner-conversation handoff is its queue row alone", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env);
    await signIn();
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("is recorded at queue time with no room request, and still runs once after a restart with one prompt", async () => {
    const asker = await newBot("Asker");
    const peer = await newBot("Peer");
    await post(`/api/bots/${peer.id}/messages`, { text: "Hold on. __fixture_hold_authority__ PEER_HOLD" });
    await turnFor("PEER_HOLD");
    await post(`/api/bots/${asker.id}/messages`, { text: "Hold on. __fixture_hold_authority__ ASKER_HOLD" });
    const askerToken = tokenOf(await turnFor("ASKER_HOLD"));
    const asked = await post("/api/internal/delegate-bot", { fromBotId: asker.id, fromThreadId: asker.threadId, toBotId: peer.id, message: "Pass this on. DRAINED_TAG __fixture_hold_authority__" }, { authorization: `Bearer ${askerToken}` });
    expect(asked.status).toBe(200);
    expect(asked.body.queued).toBe(true);
    const rows = rowsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phase: "fresh", origin: "owner", turn_key: `dlg-${rows[0]!.id}` });
    expect(requestsOf()).toEqual([]);
    // no room lists anything for it
    const groups = (await (await fetch(`${fixture.info.url}/api/groups`, { headers: desktop })).json() as { groups?: Array<{ id: string }> }).groups ?? [];
    for (const group of groups) {
      const listed = await fetch(`${fixture.info.url}/api/groups/${group.id}/requests`, { headers: desktop });
      if (listed.ok) expect(JSON.stringify(await listed.json())).not.toContain(rows[0]!.id);
    }
    // the restart runs the handoff once
    await fixture.restart();
    await signIn();
    const drained = await turnFor("DRAINED_TAG");
    for (const started = Date.now(); promptsOf().length === 0 && Date.now() - started < 15000; await new Promise(resolve => setTimeout(resolve, 100)));
    expect(promptsOf()).toHaveLength(1);
    expect(promptsOf()[0]!.id).toBe(rows[0]!.turn_key);
    expect(requestsOf()).toEqual([]);
    writeFileSync(join(fixture.fixtureFinishGateDir, String(drained.pid)), "finish");
  }, 120000);
});
