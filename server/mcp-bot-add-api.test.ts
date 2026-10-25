// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Item 118 against the real harness (design MCP-118-175 118-2, 118-3, 118-4): a
// bot's turn files a server switched off through POST /api/internal/mcp-servers,
// the owner sees a Turn on card and one credential card per key, the value goes
// through the desktop shell's commit route and never into config.json, and every
// way to turn it on refuses while a key is pending. Boots node server/index.ts on
// a throwaway home (testing/index-harness.ts). Every value here is fake.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BASE, DESKTOP_HEADERS, MCP_COMMIT_TOKEN, api, desktopApi, home, startInternalFixtureTurn, stopFixtureTurn } from "./testing/index-harness.ts";
import { BOT_MCP_NAMES_ONLY } from "./mcp-bot-add.ts";
import { MCP_CARD_STALE } from "../shared/credential-request.ts";

const FAKE_VALUE = "fake-notes-value-118";
const FAKE_HEADER = "fake-header-value-118";

const commit = (method: string, path: string, body?: unknown) => fetch(`${BASE}${path}`, {
  method, headers: { ...DESKTOP_HEADERS, authorization: `Bearer ${MCP_COMMIT_TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
}).then(async (res) => ({ status: res.status, body: await res.json() as any }));
const internal = (token: string, path: string, body: unknown) => fetch(`${BASE}${path}`, {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
}).then(async (res) => ({ status: res.status, body: await res.json() as any }));
const configText = () => readFileSync(join(home, ".murage", "config.json"), "utf8");
const storedEntry = (name: string) => JSON.parse(configText()).mcpServers?.[name];
const messagesOf = async (botId: string) =>
  ((await desktopApi("GET", "/api/bots?messages=200")).body.bots.find((bot: { id: string }) => bot.id === botId)?.messages ?? []) as any[];

async function withBotTurn<T>(run: (ctx: { botId: string; botName: string; token: string; threadId: string }) => Promise<T>): Promise<T> {
  const bot = (await desktopApi("POST", "/api/bots", { name: "Filing fixture" })).body.bot;
  let turn: Awaited<ReturnType<typeof startInternalFixtureTurn>> | undefined;
  try {
    turn = await startInternalFixtureTurn(bot.id, undefined, "__fixture_hold_authority__");
    return await run({ botId: bot.id, botName: bot.name, token: turn.env.MURAGE_COMMS_TOKEN!, threadId: turn.env.MURAGE_THREAD_ID! });
  } finally {
    if (turn) await stopFixtureTurn(bot.id, turn);
    await desktopApi("DELETE", `/api/bots/${bot.id}`);
  }
}

describe("a bot files a command server switched off", () => {
  it("stores it off with the key pending, shows the cards, refuses every Turn on until the key is saved, and keeps the value out of config.json", async () => {
    await withBotTurn(async ({ botId, botName, token, threadId }) => {
      // names only, whatever the run keeps
      const valued = await internal(token, "/api/internal/mcp-servers", { server: { name: "notes", command: "npx", env: { NOTES_TOKEN: FAKE_VALUE } } });
      expect(valued.status).toBe(400);
      expect(valued.body.error).toContain(BOT_MCP_NAMES_ONLY);
      expect((await internal(token, "/api/internal/mcp-servers", { server: { name: "notes", command: "npx", args: ["--token=fake-arg-value"] } })).status).toBe(400);
      expect((await internal(token, "/api/internal/mcp-servers", { server: { name: "notes", command: "npx", enabled: true } })).status).toBe(400);
      expect(configText()).not.toContain(FAKE_VALUE);
      expect(storedEntry("notes")).toBeUndefined();

      const filed = await internal(token, "/api/internal/mcp-servers", { server: { name: "notes", command: "npx", args: ["-y", "@x/notes-mcp"], env_keys: ["NOTES_TOKEN"] } });
      expect(filed.status, JSON.stringify(filed.body)).toBe(201);
      expect(filed.body).toEqual({ name: "notes", pendingKeys: ["NOTES_TOKEN"] });
      expect((await internal(token, "/api/internal/mcp-servers", { server: { name: "notes", command: "npx" } })).status).toBe(409);
      const stored = storedEntry("notes");
      expect(stored).toMatchObject({ command: "npx", env: {}, pendingEnv: ["NOTES_TOKEN"], enabled: false, disabledReason: `Added by ${botName}; turn on to use it` });
      const rev = stored.rev as string;
      expect(rev).toMatch(/^[0-9a-f]{12}$/);

      const messages = await messagesOf(botId);
      expect(messages.some((m) => m.kind === "activity" && m.tool?.name === `${botName} added MCP server notes (off)`)).toBe(true);
      const enableCard = messages.find((m) => m.kind === "options" && m.card?.kind === "mcpEnable");
      expect(enableCard.card).toMatchObject({ title: "Turn on notes?", mcpEnable: { name: "notes", rev, command: "npx", args: ["-y", "@x/notes-mcp"], pendingKeys: ["NOTES_TOKEN"] } });
      const keyCard = messages.find((m) => m.kind === "secret" && m.secret?.target === `mcp:notes:NOTES_TOKEN:${rev}`);
      expect(keyCard).toBeTruthy();

      // request_credential: only a declared key, only at the current revision
      expect((await internal(token, "/api/internal/request-credential", { credentialId: `mcp:notes:OTHER_KEY:${rev}` })).status).toBe(400);
      expect((await internal(token, "/api/internal/request-credential", { credentialId: "mcp:notes:NOTES_TOKEN:0123456789ab" })).status).toBe(400);
      const again = await internal(token, "/api/internal/request-credential", { credentialId: `mcp:notes:NOTES_TOKEN:${rev}` });
      expect(again).toMatchObject({ status: 200, body: { messageId: keyCard.id } });

      // every Turn on refuses while the key is pending
      expect(await desktopApi("PATCH", "/api/mcp/servers/notes", { enabled: true })).toMatchObject({ status: 409, body: { code: "needs-key" } });
      expect(await desktopApi("POST", `/api/bots/${botId}/mcp-enable-cards/${enableCard.id}/enable`, { threadId })).toMatchObject({ status: 409, body: { code: "needs-key" } });
      expect(storedEntry("notes").enabled).toBe(false);
      // a save that never reached the store resumes nothing
      expect((await desktopApi("POST", `/api/bots/${botId}/secret-cards/${keyCard.id}/provided`, { threadId })).status).toBe(409);

      // the desktop shell holds the value; the card's save moves the key to held
      expect((await commit("PUT", "/api/mcp/servers/notes/secrets", { env: { NOTES_TOKEN: FAKE_VALUE } })).status).toBe(200);
      expect(await desktopApi("POST", `/api/bots/${botId}/secret-cards/${keyCard.id}/provided`, { threadId })).toMatchObject({ status: 200, body: { provided: true } });
      expect(storedEntry("notes")).toMatchObject({ env: { NOTES_TOKEN: true }, rev, enabled: false });
      expect(storedEntry("notes").pendingEnv).toBeUndefined();
      expect(configText()).not.toContain(FAKE_VALUE);

      const enabled = await desktopApi("POST", `/api/bots/${botId}/mcp-enable-cards/${enableCard.id}/enable`, { threadId });
      expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
      expect(storedEntry("notes").enabled).toBe(true);
      expect(configText()).not.toContain(FAKE_VALUE);
      expect(JSON.stringify((await desktopApi("GET", "/api/bots?messages=200")).body)).not.toContain(FAKE_VALUE);
      expect(JSON.stringify((await desktopApi("GET", "/api/mcp/servers")).body)).not.toContain(FAKE_VALUE);
    });
    await desktopApi("DELETE", "/api/mcp/servers/notes");
  });

  it("an edit closes the old revision's cards, and a save on a closed card stores nothing", async () => {
    await withBotTurn(async ({ botId, token, threadId }) => {
      expect((await internal(token, "/api/internal/mcp-servers", { server: { name: "drafts", command: "npx", args: ["-y", "drafts"], env_keys: ["DRAFTS_KEY"] } })).status).toBe(201);
      const rev = storedEntry("drafts").rev as string;
      const edit = await desktopApi("PUT", "/api/mcp/servers/drafts", { command: "npx", args: ["-y", "drafts-two"], env: {} });
      expect(edit.status, JSON.stringify(edit.body)).toBe(200);
      const after = storedEntry("drafts");
      expect(after.rev).not.toBe(rev);
      expect(after.pendingEnv).toEqual(["DRAFTS_KEY"]);
      const messages = await messagesOf(botId);
      const keyCard = messages.find((m) => m.kind === "secret" && m.secret?.target === `mcp:drafts:DRAFTS_KEY:${rev}`);
      const enableCard = messages.find((m) => m.kind === "options" && m.card?.kind === "mcpEnable" && m.card.mcpEnable?.name === "drafts");
      expect(keyCard.secret).toMatchObject({ dismissed: true, error: MCP_CARD_STALE });
      expect(enableCard.card).toMatchObject({ dismissed: true, mcpEnable: { error: MCP_CARD_STALE } });
      // the old card saves nothing, in the dev fallback and through the shell
      expect((await desktopApi("POST", `/api/bots/${botId}/secret-cards/${keyCard.id}/value`, { threadId, value: FAKE_VALUE })).status).toBe(409);
      expect((await desktopApi("POST", `/api/bots/${botId}/secret-cards/${keyCard.id}/provided`, { threadId })).status).toBe(409);
      expect(await desktopApi("POST", `/api/bots/${botId}/mcp-enable-cards/${enableCard.id}/enable`, { threadId })).toMatchObject({ status: 409 });
      expect(configText()).not.toContain(FAKE_VALUE);
      expect(storedEntry("drafts")).toMatchObject({ enabled: false, pendingEnv: ["DRAFTS_KEY"] });
      // the request for the old revision is refused; the current one gets a new card
      expect((await internal(token, "/api/internal/request-credential", { credentialId: `mcp:drafts:DRAFTS_KEY:${rev}` })).status).toBe(400);
      expect((await internal(token, "/api/internal/request-credential", { credentialId: `mcp:drafts:DRAFTS_KEY:${after.rev}` })).status).toBe(201);
    });
    await desktopApi("DELETE", "/api/mcp/servers/drafts");
  });
});

describe("a key saved in Settings clears the pending slot", () => {
  it("lets the switch turn on after the value goes in through the Settings route, with the card dismissed", async () => {
    await withBotTurn(async ({ token }) => {
      expect((await internal(token, "/api/internal/mcp-servers", { server: { name: "settings-path", command: "npx", args: ["-y", "sp"], env_keys: ["SP_TOKEN"] } })).status).toBe(201);
      expect(await desktopApi("PATCH", "/api/mcp/servers/settings-path", { enabled: true })).toMatchObject({ status: 409, body: { code: "needs-key" } });
      expect((await commit("PUT", "/api/mcp/servers/settings-path/secrets", { env: { SP_TOKEN: FAKE_VALUE } })).status).toBe(200);
      expect(storedEntry("settings-path").pendingEnv).toBeUndefined();
      expect(storedEntry("settings-path")).toMatchObject({ env: { SP_TOKEN: true }, enabled: false });
      expect((await desktopApi("PATCH", "/api/mcp/servers/settings-path", { enabled: true })).status).toBe(200);
      expect(configText()).not.toContain(FAKE_VALUE);
    });
    await desktopApi("DELETE", "/api/mcp/servers/settings-path");
  });
});

describe("a bot files a link server", () => {
  it("is turned on only when its header is held for the entry's own origin", async () => {
    await withBotTurn(async ({ botId, token, threadId }) => {
      const filed = await internal(token, "/api/internal/mcp-servers", { server: { name: "linky", url: "https://mcp.example.com/mcp", transport: "http", auth: "header", header_keys: ["x-api-key"] } });
      expect(filed.status, JSON.stringify(filed.body)).toBe(201);
      expect((await internal(token, "/api/internal/mcp-servers", { server: { name: "linky2", url: "https://mcp.example.com/mcp?key=fake" } })).status).toBe(400);
      const rev = storedEntry("linky").rev as string;
      const messages = await messagesOf(botId);
      const keyCard = messages.find((m) => m.kind === "secret" && m.secret?.target === `mcp:linky:x-api-key:${rev}`);
      const enableCard = messages.find((m) => m.kind === "options" && m.card?.mcpEnable?.name === "linky");
      expect(enableCard.card.mcpEnable).toMatchObject({ kind: "remote", url: "https://mcp.example.com/mcp", transport: "http" });
      // a value issued for another address is not this server's
      expect((await commit("PUT", "/api/mcp/servers/linky/secrets", { origin: "https://elsewhere.example.net", headers: { "x-api-key": FAKE_HEADER } })).status).not.toBe(200);
      expect((await desktopApi("POST", `/api/bots/${botId}/secret-cards/${keyCard.id}/provided`, { threadId })).status).toBe(409);
      expect(await desktopApi("PATCH", "/api/mcp/servers/linky", { enabled: true })).toMatchObject({ status: 409, body: { code: "needs-key" } });
      expect((await commit("PUT", "/api/mcp/servers/linky/secrets", { origin: "https://mcp.example.com", headers: { "x-api-key": FAKE_HEADER } })).status).toBe(200);
      expect((await desktopApi("POST", `/api/bots/${botId}/secret-cards/${keyCard.id}/provided`, { threadId })).status).toBe(200);
      expect(storedEntry("linky")).toMatchObject({ headers: { "x-api-key": true }, enabled: false });
      expect((await desktopApi("PATCH", "/api/mcp/servers/linky", { enabled: true })).status).toBe(200);
      expect(storedEntry("linky").enabled).toBe(true);
      expect(configText()).not.toContain(FAKE_HEADER);
    });
    await desktopApi("DELETE", "/api/mcp/servers/linky");
  });
});

describe("a bot cannot reach the owner's routes", () => {
  it("the Turn on card route and the MCP routes refuse a turn's capability", async () => {
    await withBotTurn(async ({ botId, token, threadId }) => {
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const patch = await fetch(`${BASE}/api/mcp/servers/notes`, { method: "PATCH", headers, body: JSON.stringify({ enabled: true }) });
      expect([403, 404]).toContain(patch.status);
      const card = await fetch(`${BASE}/api/bots/${botId}/mcp-enable-cards/x/enable`, { method: "POST", headers, body: JSON.stringify({ threadId }) });
      expect([403, 404]).toContain(card.status);
      expect((await api("POST", `/api/bots/${botId}/mcp-enable-cards/x/enable`, { threadId })).status).not.toBe(200);
    });
  });
});
