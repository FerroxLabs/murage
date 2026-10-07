// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The Connect Netlify route (POST /api/publish/netlify/check) in a group chat:
// the member that raised the card is the one resumed, and only once, however
// many times the owner presses Connect.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { clearAllMcpServerSecrets, setMcpServerSecrets } from "../mcp-secrets.ts";
import { Store } from "../store.ts";
import { checkNetlifyConnection, NETLIFY_CONNECTED_PROMPT, settleNetlifyConnect, type ConnectResume } from "./connect.ts";
import { PublishOperations } from "./publish-ops.ts";
import { NETLIFY_PAT_SERVER } from "./token.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { closeDatabase(); clearAllMcpServerSecrets(); });

function groupChat() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const first = store.createBot(), second = store.createBot();
  const group = store.createGroup("Launch team", [first.id, second.id]);
  let token: string | undefined;
  const operations = new PublishOperations({ store, waiting: vi.fn(), token: () => token, workspaceFor: () => undefined });
  const netlify = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
  const resumed: ConnectResume[] = [];
  const route = (press: { botId?: string; threadId?: string; messageId?: string }) => settleNetlifyConnect({
    check: () => checkNetlifyConnection({ servers: {}, fetchImpl: netlify }),
    cards: operations, threadBot: (threadId) => store.botByThread(threadId)?.id, resume: (entry) => resumed.push(entry),
  }, press);
  return { store, first, second, group, operations, route, resumed, netlify, connect: (value: string) => { token = value; setMcpServerSecrets(NETLIFY_PAT_SERVER, { env: { NETLIFY_AUTH_TOKEN: value } }); } };
}

it("in a group chat, Connect resumes the member that asked, once, and a second press does not resume again", async () => {
  const f = groupChat();
  // The second member tries to publish with nothing connected: the chat gets one Connect Netlify card.
  const actor = { botId: f.second.id, threadId: f.group.threadId, generation: randomUUID(), signal: new AbortController().signal, assertActive: () => {} };
  await expect(f.operations.publish(actor, { folder: "site", name: "shop" })).rejects.toMatchObject({ code: "reconnect" });
  const card = f.store.messagesFor(f.group.threadId).find(m => m.card?.publish?.action === "connect")!;
  expect(card.card!.publish!.connect).toMatchObject({ state: "needed", botId: f.second.id });

  // Pressed before anything is connected: no call to Netlify, the card stays, nobody is resumed.
  expect(await f.route({ threadId: f.group.threadId, messageId: card.id })).toEqual({ connected: false, reason: "none" });
  expect(f.netlify).not.toHaveBeenCalled();
  expect(f.resumed).toEqual([]);

  f.connect("nfp_route_test_token");
  // The renderer may name a different bot; the card's own bot wins.
  const press = { botId: f.first.id, threadId: f.group.threadId, messageId: card.id };
  expect(await f.route(press)).toEqual({ connected: true, via: "token" });
  expect(f.resumed).toEqual([{ botId: f.second.id, threadId: f.group.threadId, resumeKey: `netlify-${card.id}`, labels: ["Netlify"], prompt: NETLIFY_CONNECTED_PROMPT }]);
  expect(f.store.messagesFor(f.group.threadId).find(m => m.id === card.id)!.card!.publish!.connect!.state).toBe("connected");

  // A second press, and two presses at once, still resume nobody else.
  expect(await f.route(press)).toEqual({ connected: true, via: "token" });
  await Promise.all([f.route(press), f.route(press)]);
  expect(f.resumed).toHaveLength(1);
  expect(JSON.stringify(f.resumed)).not.toContain("nfp_route_test_token");
});

it("a press that names no card, or a message that is not a connect card, resumes nobody", async () => {
  const f = groupChat();
  f.connect("nfp_route_test_token");
  const other = f.store.appendMessage(f.group.threadId, { role: "bot", kind: "text", text: "hello" } as never);
  expect(await f.route({ threadId: f.group.threadId })).toEqual({ connected: true, via: "token" });
  expect(await f.route({ threadId: f.group.threadId, messageId: other.id })).toEqual({ connected: true, via: "token" });
  expect(await f.route({ threadId: f.group.threadId, messageId: "no-such-card" })).toEqual({ connected: true, via: "token" });
  expect(f.resumed).toEqual([]);
});
