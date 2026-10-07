// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The mid-turn sign-in card (spec MCP-LINK 3.12, 7.4): a link server whose
// sign-in has ended while a bot is working. The relay answers the proxy with the
// sentence that ends the turn and posts ONE card in the conversation; signing
// in again (a secrets push from the desktop shell) settles it and resumes the
// paused task. Boots node server/index.ts on a throwaway home with a fake link
// server in this process.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BASE, MCP_COMMIT_TOKEN as COMMIT_TOKEN, DESKTOP_HEADERS, api, desktopApi, fakeClaudeDump, startInternalFixtureTurn, stopFixtureTurn } from "./testing/index-harness.ts";
import { startFakeRemoteMcp, type FakeRemoteMcp } from "./testing/fake-remote-mcp.ts";
import { MCP_SIGNIN_PHONE_NOTE, mcpSignInCardText, mcpSignInResumeKey, mcpSignInToolText } from "./mcp-signin-card.ts";

let fake: FakeRemoteMcp;
let fake2: FakeRemoteMcp;
beforeAll(async () => { fake = await startFakeRemoteMcp({ auth: "bearer" }); fake2 = await startFakeRemoteMcp({ auth: "bearer" }); });
afterAll(async () => { await fake?.close(); await fake2?.close(); });

const commit = (method: string, path: string, body?: unknown) => fetch(`${BASE}${path}`, {
  method, headers: { ...DESKTOP_HEADERS, authorization: `Bearer ${COMMIT_TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
}).then(async (res) => ({ status: res.status, body: await res.json() as any }));
const relay = (token: string, name: string, message: object) => fetch(`${BASE}/api/internal/mcp-remote/${name}`, {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(message),
}).then(async (res) => ({ status: res.status, body: JSON.parse(await res.text()) as any }));
const rpc = (method: string, id: number) => ({ jsonrpc: "2.0", id, method });
const cardsOf = async (botId: string) =>
  ((await api("GET", "/api/bots?messages=200")).body.bots.find((bot: { id: string }) => bot.id === botId)?.messages ?? []).filter((m: { kind: string }) => m.kind === "mcpSignIn");

async function withEndedSignIn<T>(name: string, run: (ctx: { botId: string; token: string; turn: Awaited<ReturnType<typeof startInternalFixtureTurn>>; threadId: string }) => Promise<T>): Promise<T> {
  expect((await desktopApi("POST", "/api/mcp/servers", { name, url: fake.mcpUrl, confirmLocal: "this-computer", auth: "oauth" })).status).toBe(201);
  expect((await desktopApi("PATCH", `/api/mcp/servers/${name}`, { enabled: true })).status).toBe(200);
  expect((await commit("PUT", `/api/mcp/servers/${name}/secrets`, { origin: fake.origin, oauth: { accessToken: "at_stale_value_1" } })).status).toBe(200);
  const bot = (await desktopApi("POST", "/api/bots", { name: "Sign-in card fixture" })).body.bot;
  let turn: Awaited<ReturnType<typeof startInternalFixtureTurn>> | undefined;
  try {
    turn = await startInternalFixtureTurn(bot.id, undefined, "__fixture_hold_authority__");
    const token = (turn.dump.mcpConfig.mcpServers as Record<string, { env: Record<string, string> }>)[name]!.env.MURAGE_MCP_TOKEN!;
    return await run({ botId: bot.id, token, turn, threadId: turn.env.MURAGE_THREAD_ID! });
  } finally {
    await api("POST", `/api/bots/${bot.id}/interrupt`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await api("POST", `/api/bots/${bot.id}/interrupt`);
    await desktopApi("DELETE", `/api/bots/${bot.id}`);
    await desktopApi("DELETE", `/api/mcp/servers/${name}`);
  }
}

describe("the card's words", () => {
  it("names the server, the host and the bot, and tells a phone where to finish", () => {
    const text = mcpSignInCardText({ name: "comfy", host: "cloud.comfy.org", botName: "Sable" });
    expect(text.title).toBe("Sign in to cloud.comfy.org");
    expect(text.body).toBe("comfy needs you to sign in again before Sable can use it.");
    expect(text.phone).toBe("Finish sign-in on the computer running Murage.");
    expect(MCP_SIGNIN_PHONE_NOTE).toBe(text.phone);
  });

  it("ends the turn, in the spec's sentence", () => {
    expect(mcpSignInToolText("comfy", "cloud.comfy.org")).toBe("comfy needs the owner to sign in to cloud.comfy.org again. Murage showed them a sign-in card. End this turn now; the app will continue after sign-in.");
  });

  it("follows the copy rules and keys a card to its turn", () => {
    const all = [...Object.values(mcpSignInCardText({ name: "comfy", host: "cloud.comfy.org", botName: "Sable" })), mcpSignInToolText("comfy", "cloud.comfy.org")].join("\n");
    expect(all).not.toMatch(/—|–|composio|price|\b(safe|safely|safety|unsafe)\b/i);
    expect(mcpSignInResumeKey("comfy", "gen-1")).toBe(mcpSignInResumeKey("comfy", "gen-1"));
    expect(mcpSignInResumeKey("comfy", "gen-1")).not.toBe(mcpSignInResumeKey("comfy", "gen-2"));
    expect(mcpSignInResumeKey("comfy", "gen-1")).toMatch(/^[\w-]{8,100}$/);
  });
});

describe("a sign-in that ended mid-turn", () => {
  it("posts one card per turn, answers the proxy with the end-the-turn sentence, and leaves no token in it", async () => {
    await withEndedSignIn("cardsvc", async ({ botId, token }) => {
      const first = await relay(token, "cardsvc", rpc("tools/list", 1));
      expect(first.status).toBe(401);
      expect(first.body.code).toBe("sign-in-ended");
      expect(first.body.error).toBe(mcpSignInToolText("cardsvc", "127.0.0.1"));
      const second = await relay(token, "cardsvc", rpc("tools/list", 2));
      expect(second.status).toBe(401);
      const cards = await cardsOf(botId);
      expect(cards).toHaveLength(1);
      expect(cards[0].mcpSignIn).toMatchObject({
        name: "cardsvc", host: "127.0.0.1", status: "required", reason: "sign-in-ended",
        title: "Sign in to 127.0.0.1", phone: "Finish sign-in on the computer running Murage.",
      });
      expect(cards[0].mcpSignIn.resumeKey).toMatch(/^[\w-]{8,100}$/);
      const exposed = JSON.stringify((await desktopApi("GET", "/api/bots?messages=200")).body);
      expect(exposed).not.toContain("at_stale_value_1");
      expect(exposed).not.toContain(token);
    });
  });

  it("posts no card for a server that simply needs a key", async () => {
    expect((await desktopApi("POST", "/api/mcp/servers", { name: "keysvc", url: fake.mcpUrl, confirmLocal: "this-computer", auth: "header", headers: { "x-api-key": true } })).status).toBe(201);
    expect((await desktopApi("PATCH", "/api/mcp/servers/keysvc", { enabled: true })).status).toBe(200);
    const bot = (await desktopApi("POST", "/api/bots", { name: "No card fixture" })).body.bot;
    let turn: Awaited<ReturnType<typeof startInternalFixtureTurn>> | undefined;
    try {
      turn = await startInternalFixtureTurn(bot.id, undefined, "__fixture_hold_authority__");
      const token = (turn.dump.mcpConfig.mcpServers as Record<string, { env: Record<string, string> }>).keysvc!.env.MURAGE_MCP_TOKEN!;
      expect((await relay(token, "keysvc", rpc("tools/list", 1))).body.code).toBe("needs-key");
      expect(await cardsOf(bot.id)).toHaveLength(0);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
      await desktopApi("DELETE", "/api/mcp/servers/keysvc");
    }
  });

  it("signing in again (the secrets push) settles the card and resumes the paused task", async () => {
    await withEndedSignIn("resumesvc", async ({ botId, token, turn, threadId }) => {
      expect((await relay(token, "resumesvc", rpc("tools/list", 1))).status).toBe(401);
      const [card] = await cardsOf(botId);
      // not signed in yet: the card cannot be resumed by hand
      const early = await desktopApi("POST", `/api/bots/${botId}/mcp-sign-in-cards/${card.id}/resume`, { threadId });
      expect(early.status).toBe(409);
      // a push of a token with no issue time, or one issued before the card, is not a new sign-in
      expect((await commit("PUT", "/api/mcp/servers/resumesvc/secrets", { origin: fake.origin, oauth: { accessToken: fake.mintAccessToken() } })).status).toBe(200);
      expect((await cardsOf(botId))[0].mcpSignIn.status).toBe("required");
      expect((await commit("PUT", "/api/mcp/servers/resumesvc/secrets", { origin: fake.origin, oauth: { accessToken: fake.mintAccessToken(), signedInAt: card.at - 1 } })).status).toBe(200);
      expect((await cardsOf(botId))[0].mcpSignIn.status).toBe("required");
      expect((await desktopApi("POST", `/api/bots/${botId}/mcp-sign-in-cards/${card.id}/resume`, { threadId })).status).toBe(409);
      expect((await commit("PUT", "/api/mcp/servers/resumesvc/secrets", { origin: fake.origin, oauth: { accessToken: fake.mintAccessToken(), signedInAt: Date.now() } })).status).toBe(200);
      const [settled] = await cardsOf(botId);
      expect(settled.mcpSignIn).toMatchObject({ status: "signed-in", resumed: true });
      // the turn was still running, so the resume waits and starts when it ends
      await stopFixtureTurn(botId, turn, threadId);
      await expect.poll(() => (JSON.parse(readFileSync(fakeClaudeDump, "utf8")) as { pid: number }).pid, { timeout: 20_000 }).not.toBe(turn.dump.pid);
      const resumed = JSON.parse(readFileSync(fakeClaudeDump, "utf8")) as { prompt?: unknown };
      expect(JSON.stringify(resumed.prompt)).toContain("signed in");
      expect(JSON.stringify(resumed.prompt)).toContain("resumesvc");
      expect(JSON.stringify(resumed.prompt)).not.toContain("at_");
    });
  });

  it("a card can be dismissed, and a card id that is not this bot's is not found", async () => {
    await withEndedSignIn("handsvc", async ({ botId, token, threadId }) => {
      expect((await relay(token, "handsvc", rpc("tools/list", 1))).status).toBe(401);
      const [card] = await cardsOf(botId);
      const dismissed = await desktopApi("POST", `/api/bots/${botId}/mcp-sign-in-cards/${card.id}/dismiss`, { threadId });
      expect(dismissed.status).toBe(200);
      expect((await cardsOf(botId))[0].mcpSignIn.dismissed).toBe(true);
      // another bot's card id is not this bot's
      expect((await desktopApi("POST", `/api/bots/${botId}/mcp-sign-in-cards/${card.id}x/resume`, { threadId })).status).toBe(404);
    });
  });

  it("the card routes are the desktop's alone", async () => {
    const plain = await api("POST", "/api/bots/anybot/mcp-sign-in-cards/anycard/resume", { threadId: "t" });
    expect(plain.status).toBe(404);
  });

  it("a token refresh never settles a card, however often it happens: a server with 1-second tokens that keeps rejecting causes no unattended turn (review M1)", async () => {
    await withEndedSignIn("refreshsvc", async ({ botId, token, turn }) => {
      expect((await relay(token, "refreshsvc", rpc("tools/list", 1))).status).toBe(401);
      const [card] = await cardsOf(botId);
      const staleSignIn = card.at - 5_000;
      for (let round = 0; round < 6; round += 1) {
        // what main pushes after a refresh: a new access token and issue time, the old sign-in time
        const pushed = await commit("PUT", "/api/mcp/servers/refreshsvc/secrets", { origin: fake.origin, oauth: { accessToken: fake.mintAccessToken(), issuedAt: Date.now() + round, signedInAt: staleSignIn } });
        expect(pushed.status).toBe(200);
      }
      expect((await cardsOf(botId))[0].mcpSignIn).toMatchObject({ status: "required" });
      expect((await cardsOf(botId))[0].mcpSignIn.resumed).toBeFalsy();
      expect((await desktopApi("POST", `/api/bots/${botId}/mcp-sign-in-cards/${card.id}/resume`, { threadId: turn.env.MURAGE_THREAD_ID })).status).toBe(409);
      expect((JSON.parse(readFileSync(fakeClaudeDump, "utf8")) as { pid: number }).pid).toBe(turn.dump.pid);
      // an owner sign-in does
      expect((await commit("PUT", "/api/mcp/servers/refreshsvc/secrets", { origin: fake.origin, oauth: { accessToken: fake.mintAccessToken(), issuedAt: Date.now(), signedInAt: Date.now() } })).status).toBe(200);
      expect((await cardsOf(botId))[0].mcpSignIn).toMatchObject({ status: "signed-in", resumed: true });
    });
  });

  it("removing a server dismisses its waiting cards, and a new server under the same name never resumes them (review M2)", async () => {
    await withEndedSignIn("samename", async ({ botId, token }) => {
      expect((await relay(token, "samename", rpc("tools/list", 1))).status).toBe(401);
      expect((await cardsOf(botId))[0].mcpSignIn.origin).toBe(fake.origin);
      expect((await desktopApi("DELETE", "/api/mcp/servers/samename")).status).toBeLessThan(300);
      expect((await cardsOf(botId))[0].mcpSignIn.dismissed).toBe(true);
      expect((await desktopApi("POST", "/api/mcp/servers", { name: "samename", url: fake2.mcpUrl, confirmLocal: "this-computer", auth: "oauth" })).status).toBe(201);
      expect((await commit("PUT", "/api/mcp/servers/samename/secrets", { origin: fake2.origin, oauth: { accessToken: "at_other_server", issuedAt: Date.now(), signedInAt: Date.now() } })).status).toBe(200);
      const [old] = await cardsOf(botId);
      expect(old.mcpSignIn.status).toBe("required");
      expect(old.mcpSignIn.resumed).toBeFalsy();
    });
  });

  it("an edit that changes the link dismisses the waiting cards too, and the new link's sign-in carries none of their scopes (review M2)", async () => {
    await withEndedSignIn("movedsvc", async ({ botId, token }) => {
      expect((await relay(token, "movedsvc", rpc("tools/list", 1))).status).toBe(401);
      expect((await desktopApi("PUT", "/api/mcp/servers/movedsvc", { url: fake2.mcpUrl, confirmLocal: "this-computer", auth: "oauth" })).status).toBe(200);
      expect((await cardsOf(botId))[0].mcpSignIn.dismissed).toBe(true);
    });
  });
});
