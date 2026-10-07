// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The link-server relay against the real harness: the mount a turn is handed,
// and the internal route behind it. Boots node server/index.ts on a throwaway
// home (testing/index-harness.ts), with a fake remote MCP server in this process.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BASE, MCP_COMMIT_TOKEN as COMMIT_TOKEN, DESKTOP_HEADERS, api, desktopApi, startInternalFixtureTurn, stopFixtureTurn } from "./testing/index-harness.ts";
import { startFakeRemoteMcp, type FakeRemoteMcp } from "./testing/fake-remote-mcp.ts";

let fake: FakeRemoteMcp;
beforeAll(async () => {
  fake = await startFakeRemoteMcp({ auth: "api-key", apiKey: "the-real-api-key-9", unauthorized: "api-key-only", prm: false });
});
afterAll(async () => {
  await fake?.close();
});

const commit = (method: string, path: string, body?: unknown) => fetch(`${BASE}${path}`, {
  method, headers: { ...DESKTOP_HEADERS, authorization: `Bearer ${COMMIT_TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
}).then(async (res) => ({ status: res.status, body: await res.json() as any }));
const relay = (token: string | undefined, name: string, message: object, extra: Record<string, string> = {}) => fetch(`${BASE}/api/internal/mcp-remote/${name}`, {
  method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body: JSON.stringify(message),
}).then(async (res) => ({ status: res.status, headers: res.headers, text: await res.text() }));
const rpc = (method: string, id: number, params?: unknown) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

async function addLinkServer(name: string, extra: Record<string, unknown> = {}) {
  const created = await desktopApi("POST", "/api/mcp/servers", { name, url: fake.mcpUrl, confirmLocal: "this-computer", auth: "header", headers: { "x-api-key": true }, ...extra });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await desktopApi("PATCH", `/api/mcp/servers/${name}`, { enabled: true })).status).toBe(200);
  expect((await commit("PUT", `/api/mcp/servers/${name}/secrets`, { origin: fake.origin, headers: { "x-api-key": "the-real-api-key-9" } })).status).toBe(200);
}
async function removeLinkServer(name: string) {
  expect((await desktopApi("DELETE", `/api/mcp/servers/${name}`)).status).toBe(200);
}

describe("a turn is handed the proxy, and the proxy's token reaches the relay", () => {
  it("mounts the link server with its name in argv only, the owner's command server as configured, and no secret in the dump", async () => {
    await addLinkServer("linksvc");
    expect((await desktopApi("POST", "/api/mcp/servers", { name: "notes", command: "npx", args: ["-y", "@x/notes-mcp"], env: { NOTES_TOKEN: "tok-notes-e2e" }, enabled: true })).status).toBe(201);
    expect((await desktopApi("PATCH", "/api/mcp/servers/notes", { enabled: true })).status).toBe(200);
    const bot = (await desktopApi("POST", "/api/bots", { name: "Link mount fixture" })).body.bot;
    let turn: Awaited<ReturnType<typeof startInternalFixtureTurn>> | undefined;
    try {
      turn = await startInternalFixtureTurn(bot.id, undefined, "__fixture_hold_authority__");
      const servers = turn.dump.mcpConfig.mcpServers as Record<string, { command: string; args: string[]; env: Record<string, string> }>;
      const mounted = servers.linksvc!;
      expect(mounted.args.slice(1)).toEqual(["--server", "linksvc"]);
      expect(mounted.args[0]).toMatch(/remote-mcp-proxy\.(ts|js)$/);
      expect(Object.keys(mounted.env).sort()).toEqual(["ELECTRON_RUN_AS_NODE", "MURAGE_HARNESS_URL", "MURAGE_MCP_TOKEN"]);
      expect(mounted.env.MURAGE_MCP_TOKEN).toMatch(/^[a-f0-9]{48}$/);
      expect(mounted.env.MURAGE_HARNESS_URL).toBe(BASE);
      expect(servers.notes).toMatchObject({ command: "npx", env: { NOTES_TOKEN: "tok-notes-e2e" } });
      // the link server's own credential and link never reach the engine
      const dumped = JSON.stringify(turn.dump);
      expect(dumped).not.toContain("the-real-api-key-9");
      expect(dumped).not.toContain(fake.mcpUrl);
      expect(dumped).not.toContain(String(fake.port));
      // the token is a different capability from the agents one
      expect(mounted.env.MURAGE_MCP_TOKEN).not.toBe(turn.env.MURAGE_COMMS_TOKEN);
    } finally {
      if (turn) await stopFixtureTurn(bot.id, turn);
      await removeLinkServer("linksvc");
      await desktopApi("DELETE", "/api/mcp/servers/notes");
    }
  });

  it("does not mount a disabled link server", async () => {
    const created = await desktopApi("POST", "/api/mcp/servers", { name: "sleeper", url: fake.mcpUrl, confirmLocal: "this-computer", auth: "none" });
    expect(created.status).toBe(201);
    const bot = (await desktopApi("POST", "/api/bots", { name: "Link disabled fixture" })).body.bot;
    let turn: Awaited<ReturnType<typeof startInternalFixtureTurn>> | undefined;
    try {
      turn = await startInternalFixtureTurn(bot.id, undefined, "__fixture_hold_authority__");
      expect(turn.dump.mcpConfig.mcpServers).not.toHaveProperty("sleeper");
    } finally {
      if (turn) await stopFixtureTurn(bot.id, turn);
      await removeLinkServer("sleeper");
    }
  });
});

describe("a room turn is offered the owner's servers only to the owner's audience (MCP-LINK S9, D12)", () => {
  it("mounts command and link servers for the owner's words and neither for words nobody proved were the owner's", async () => {
    await addLinkServer("roomsvc");
    expect((await desktopApi("POST", "/api/mcp/servers", { name: "roomnotes", command: "npx", args: ["-y", "@x/notes-mcp"], enabled: true })).status).toBe(201);
    expect((await desktopApi("PATCH", "/api/mcp/servers/roomnotes", { enabled: true })).status).toBe(200);
    const bot = (await desktopApi("POST", "/api/bots", { name: "Room mount fixture" })).body.bot;
    const room = (await desktopApi("POST", "/api/groups", { name: "Room mount", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).body.group;
    try {
      // words the desktop proved: the owner's
      const owner = await startInternalFixtureTurn(bot.id, room.id, "__fixture_hold_authority__", desktopApi);
      const ownerServers = owner.dump.mcpConfig.mcpServers as Record<string, unknown>;
      expect(ownerServers).toHaveProperty("roomsvc");
      expect(ownerServers).toHaveProperty("roomnotes");
      await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId });
      await new Promise((resolve) => setTimeout(resolve, 500));
      // a plain local caller's words are not proven to be the owner's
      const stranger = await startInternalFixtureTurn(bot.id, room.id, "__fixture_hold_authority__", api);
      const strangerServers = stranger.dump.mcpConfig.mcpServers as Record<string, unknown>;
      expect(strangerServers).not.toHaveProperty("roomsvc");
      expect(strangerServers).not.toHaveProperty("roomnotes");
      expect(strangerServers).toHaveProperty("agents");
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId });
      await desktopApi("DELETE", `/api/groups/${room.id}`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
      await removeLinkServer("roomsvc");
      await desktopApi("DELETE", "/api/mcp/servers/roomnotes");
    }
  });
});

describe("POST /api/internal/mcp-remote/<name>", () => {
  it("relays with the stored key, passes the answer and session id back, and refuses everyone who is not this turn", async () => {
    await addLinkServer("relaysvc");
    const bot = (await desktopApi("POST", "/api/bots", { name: "Link relay fixture" })).body.bot;
    let turn: Awaited<ReturnType<typeof startInternalFixtureTurn>> | undefined;
    try {
      turn = await startInternalFixtureTurn(bot.id, undefined, "__fixture_hold_authority__");
      const token = (turn.dump.mcpConfig.mcpServers as Record<string, { env: Record<string, string> }>).relaysvc!.env.MURAGE_MCP_TOKEN!;
      const before = fake.requests.length;
      const init = await relay(token, "relaysvc", rpc("initialize", 1, { protocolVersion: "2025-06-18", capabilities: { sampling: {}, roots: {} }, clientInfo: { name: "c", version: "1" } }));
      expect(init.status).toBe(200);
      expect(JSON.parse(init.text)).toMatchObject({ id: 1, result: { serverInfo: { name: "fake-remote-mcp" } } });
      const session = init.headers.get("mcp-session-id")!;
      expect(session).toMatch(/^sess-/);
      const sent = fake.requests.slice(before).filter((request) => request.method === "POST");
      expect(sent[0]!.headers["x-api-key"]).toBe("the-real-api-key-9");
      expect(JSON.parse(sent[0]!.body).params.capabilities).toEqual({});
      // the turn's own token never goes upstream
      expect(JSON.stringify(sent.map((request) => request.headers))).not.toContain(token);
      const list = await relay(token, "relaysvc", rpc("tools/list", 2), { "mcp-session-id": session });
      expect(JSON.parse(list.text)).toMatchObject({ result: { tools: [{ name: "echo" }, { name: "sum" }] } });

      // a batch, junk, and a method other than POST
      expect((await relay(token, "relaysvc", [rpc("tools/list", 3)] as unknown as object)).status).toBe(400);
      expect((await relay(token, "relaysvc", { hello: "world" })).status).toBe(400);
      expect((await fetch(`${BASE}/api/internal/mcp-remote/relaysvc`, { method: "GET", headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
      // a name that is not a link server
      expect((await relay(token, "nosuch", rpc("tools/list", 4))).status).toBe(404);
      expect((await relay(token, "Bad..Name", rpc("tools/list", 4))).status).toBeGreaterThanOrEqual(400);

      // no token, a made-up token, and another kind of capability
      expect((await relay(undefined, "relaysvc", rpc("tools/list", 5))).status).toBe(401);
      expect((await relay("f".repeat(48), "relaysvc", rpc("tools/list", 5))).status).toBe(401);
      const wrongKind = await relay(turn.env.MURAGE_COMMS_TOKEN, "relaysvc", rpc("tools/list", 5));
      expect(wrongKind.status).toBe(403);
      expect(JSON.parse(wrongKind.text).error).toBe("capability cannot access this service");

      // the turn ends: its token stops working at once
      await stopFixtureTurn(bot.id, turn);
      turn = undefined;
      expect((await relay(token, "relaysvc", rpc("tools/list", 6))).status).toBe(401);
    } finally {
      if (turn) await stopFixtureTurn(bot.id, turn);
      await removeLinkServer("relaysvc");
    }
  });

  it("a removed or disabled server answers 404, and a key that was cleared is needs-key without any request upstream", async () => {
    await addLinkServer("fadesvc");
    const bot = (await desktopApi("POST", "/api/bots", { name: "Link fade fixture" })).body.bot;
    let turn: Awaited<ReturnType<typeof startInternalFixtureTurn>> | undefined;
    try {
      turn = await startInternalFixtureTurn(bot.id, undefined, "__fixture_hold_authority__");
      const token = (turn.dump.mcpConfig.mcpServers as Record<string, { env: Record<string, string> }>).fadesvc!.env.MURAGE_MCP_TOKEN!;
      expect((await relay(token, "fadesvc", rpc("tools/list", 1))).status).toBe(200);
      const before = fake.requests.length;
      expect((await commit("DELETE", "/api/mcp/servers/fadesvc/secrets")).status).toBe(200);
      const cleared = await relay(token, "fadesvc", rpc("tools/list", 2));
      expect(cleared.status).toBe(401);
      expect(JSON.parse(cleared.text)).toEqual({ code: "needs-key", error: "This server needs an API key." });
      expect(fake.requests.length).toBe(before);
      expect((await desktopApi("PATCH", "/api/mcp/servers/fadesvc", { enabled: false })).status).toBe(200);
      expect((await relay(token, "fadesvc", rpc("tools/list", 3))).status).toBe(404);
    } finally {
      if (turn) await stopFixtureTurn(bot.id, turn);
      await removeLinkServer("fadesvc");
    }
  });

  it("a wrong key is key-rejected in the relay's own words, with nothing of the upstream's", async () => {
    await addLinkServer("wrongkey");
    expect((await commit("PUT", "/api/mcp/servers/wrongkey/secrets", { origin: fake.origin, headers: { "x-api-key": "not-the-key" } })).status).toBe(200);
    const bot = (await desktopApi("POST", "/api/bots", { name: "Link wrong key fixture" })).body.bot;
    let turn: Awaited<ReturnType<typeof startInternalFixtureTurn>> | undefined;
    try {
      turn = await startInternalFixtureTurn(bot.id, undefined, "__fixture_hold_authority__");
      const token = (turn.dump.mcpConfig.mcpServers as Record<string, { env: Record<string, string> }>).wrongkey!.env.MURAGE_MCP_TOKEN!;
      const rejected = await relay(token, "wrongkey", rpc("tools/list", 1));
      expect(rejected.status).toBe(401);
      expect(JSON.parse(rejected.text)).toEqual({ code: "key-rejected", error: "127.0.0.1 did not accept this API key. Check it and try again." });
      expect(rejected.text).not.toContain("Provide an X-API-Key");
    } finally {
      if (turn) await stopFixtureTurn(bot.id, turn);
      await removeLinkServer("wrongkey");
    }
  });

  it("H1: a restricted bot is not handed the owner's command or link servers at all (a hidden bot cannot start a fixture turn: its mount predicate is unit-tested in mcp-relay.test.ts, L-c)", async () => {
    await addLinkServer("restrictedsvc");
    expect((await desktopApi("POST", "/api/mcp/servers", { name: "restrictednotes", command: "npx", args: ["-y", "@x/notes-mcp"], enabled: true })).status).toBe(201);
    expect((await desktopApi("PATCH", "/api/mcp/servers/restrictednotes", { enabled: true })).status).toBe(200);
    const bot = (await desktopApi("POST", "/api/bots", { name: "Link restricted fixture" })).body.bot;
    let turn: Awaited<ReturnType<typeof startInternalFixtureTurn>> | undefined;
    try {
      // unrestricted: both are mounted
      turn = await startInternalFixtureTurn(bot.id, undefined, "__fixture_hold_authority__");
      expect(Object.keys(turn.dump.mcpConfig.mcpServers)).toEqual(expect.arrayContaining(["restrictedsvc", "restrictednotes"]));
      await stopFixtureTurn(bot.id, turn);
      turn = undefined;
      const view = await desktopApi("GET", `/api/bots/${bot.id}/access`);
      const configured = await desktopApi("PUT", `/api/bots/${bot.id}/access`, { action: "configure", revision: view.body.policy.revision, mode: "restricted", allowWrites: false, grants: [] });
      expect(configured.status, JSON.stringify(configured.body)).toBe(200);
      turn = await startInternalFixtureTurn(bot.id, undefined, "__fixture_hold_authority__");
      const servers = turn.dump.mcpConfig.mcpServers as Record<string, unknown>;
      expect(servers).not.toHaveProperty("restrictedsvc");
      expect(servers).not.toHaveProperty("restrictednotes");
      expect(servers).toHaveProperty("agents");
      expect(JSON.stringify(turn.dump)).not.toContain("MURAGE_MCP_TOKEN");
    } finally {
      if (turn) await stopFixtureTurn(bot.id, turn);
      await removeLinkServer("restrictedsvc");
      await desktopApi("DELETE", "/api/mcp/servers/restrictednotes");
    }
  });

  it("M1: a 1:1 turn started by words nobody proved were the owner's is not handed the owner's servers, nor any capability that could reach the relay", async () => {
    await addLinkServer("strangersvc");
    const bot = (await desktopApi("POST", "/api/bots", { name: "Link stranger fixture" })).body.bot;
    let turn: Awaited<ReturnType<typeof startInternalFixtureTurn>> | undefined;
    try {
      turn = await startInternalFixtureTurn(bot.id, undefined, "__fixture_hold_authority__", api);
      expect(turn.dump.mcpConfig.mcpServers).not.toHaveProperty("strangersvc");
      // The relay's own audience rule (relayAudienceRefusal, unit-tested against
      // the route's source in mcp-relay.test.ts) needs an mcp capability to be
      // reached at all, and such a turn is never minted one: no mount carries it.
      expect(JSON.stringify(turn.dump)).not.toContain("MURAGE_MCP_TOKEN");
      // (its agents token is refused by the capability kind, before any audience rule)
      const wrongKind = await relay(turn.env.MURAGE_COMMS_TOKEN, "strangersvc", rpc("tools/list", 1));
      expect(wrongKind.status).toBe(403);
      expect(JSON.parse(wrongKind.text).error).toBe("capability cannot access this service");
    } finally {
      if (turn) await stopFixtureTurn(bot.id, turn);
      await removeLinkServer("strangersvc");
    }
  });

  it("H2: editing the link to another origin makes the saved key unusable, and a removed server's key does not come back under the same name", async () => {
    const other = await startFakeRemoteMcp({ auth: "none" });
    await addLinkServer("moving");
    try {
      const listing = async () => (await desktopApi("GET", "/api/mcp/servers")).body.servers.find((entry: { name: string }) => entry.name === "moving");
      expect((await listing()).status).toBe("ready");
      // edit the link to the other origin: the saved key is forgotten
      const edited = await desktopApi("PUT", "/api/mcp/servers/moving", { url: other.mcpUrl, confirmLocal: "this-computer", auth: "header", headers: { "x-api-key": true } });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect((await listing()).status).toBe("needs-key");
      const tested = await desktopApi("POST", "/api/mcp/servers/moving/test");
      expect(tested.body).toMatchObject({ ok: false, reason: "needs-key" });
      expect(other.requests).toHaveLength(0);
      // a push stamped with another origin is refused as stale
      expect((await commit("PUT", "/api/mcp/servers/moving/secrets", { origin: fake.origin, headers: { "x-api-key": "the-real-api-key-9" } })).status).toBe(409);
      // a push that names no origin is refused (NEXT-T11 L-d), and one for this origin is accepted
      const unnamed = await commit("PUT", "/api/mcp/servers/moving/secrets", { headers: { "x-api-key": "fresh-key-for-other" } });
      expect([unnamed.status, unnamed.body]).toEqual([400, { error: "Name the address these secrets were issued for." }]);
      expect((await listing()).status).toBe("needs-key");
      expect((await commit("PUT", "/api/mcp/servers/moving/secrets", { origin: other.origin, headers: { "x-api-key": "fresh-key-for-other" } })).status).toBe(200);
      expect((await listing()).status).toBe("ready");
      // removing and re-adding under the same name starts empty
      expect((await desktopApi("DELETE", "/api/mcp/servers/moving")).status).toBe(200);
      const again = await desktopApi("POST", "/api/mcp/servers", { name: "moving", url: other.mcpUrl, confirmLocal: "this-computer", auth: "header", headers: { "x-api-key": true } });
      expect(again.status).toBe(201);
      expect((await listing()).status).toBe("needs-key");
      // an edit that keeps the link keeps the key
      expect((await commit("PUT", "/api/mcp/servers/moving/secrets", { origin: other.origin, headers: { "x-api-key": "k-again" } })).status).toBe(200);
      expect((await desktopApi("PUT", "/api/mcp/servers/moving", { url: other.mcpUrl, confirmLocal: "this-computer", auth: "header", headers: { "x-api-key": true } })).status).toBe(200);
      expect((await listing()).status).toBe("ready");
    } finally {
      await desktopApi("DELETE", "/api/mcp/servers/moving");
      await other.close();
    }
  });

  it("N1: a legacy SSE session opened before an edit of the link is closed by the edit, and never carries the new key to the old server", async () => {
    const a = await startFakeRemoteMcp({ auth: "none", transport: "sse" });
    const b = await startFakeRemoteMcp({ auth: "none", transport: "sse" });
    const bot = (await desktopApi("POST", "/api/bots", { name: "Link SSE edit fixture" })).body.bot;
    let turn: Awaited<ReturnType<typeof startInternalFixtureTurn>> | undefined;
    try {
      expect((await desktopApi("POST", "/api/mcp/servers", { name: "legacyedit", url: a.mcpUrl, confirmLocal: "this-computer", auth: "header", headers: { "x-api-key": true } })).status).toBe(201);
      expect((await desktopApi("PATCH", "/api/mcp/servers/legacyedit", { enabled: true })).status).toBe(200);
      expect((await commit("PUT", "/api/mcp/servers/legacyedit/secrets", { origin: a.origin, headers: { "x-api-key": "KEY-A" } })).status).toBe(200);
      turn = await startInternalFixtureTurn(bot.id, undefined, "__fixture_hold_authority__");
      const token = (turn.dump.mcpConfig.mcpServers as Record<string, { env: Record<string, string> }>).legacyedit!.env.MURAGE_MCP_TOKEN!;
      const init = await relay(token, "legacyedit", rpc("initialize", 1, { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "c", version: "1" } }));
      expect(init.status, init.text).toBe(200);
      const session = init.headers.get("mcp-session-id")!;
      expect(session).toBeTruthy();
      expect(a.requests.some((request) => request.path === "/messages" && request.headers["x-api-key"] === "KEY-A")).toBe(true);

      // an edit that keeps the link still closes the server's sessions
      expect((await desktopApi("PUT", "/api/mcp/servers/legacyedit", { url: a.mcpUrl, confirmLocal: "this-computer", auth: "header", headers: { "x-api-key": true } })).status).toBe(200);
      const aPosts = () => a.requests.filter((request) => request.path === "/messages").length;
      let before = aPosts();
      expect((await relay(token, "legacyedit", rpc("tools/list", 2), { "mcp-session-id": session })).status).not.toBe(200);
      expect(aPosts()).toBe(before);

      // a new session, then the owner moves the link to B and main pushes B's key
      const reopened = await relay(token, "legacyedit", rpc("initialize", 3, { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "c", version: "1" } }));
      expect(reopened.status, reopened.text).toBe(200);
      const second = reopened.headers.get("mcp-session-id")!;
      const edited = await desktopApi("PUT", "/api/mcp/servers/legacyedit", { url: b.mcpUrl, confirmLocal: "this-computer", auth: "header", headers: { "x-api-key": true } });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect((await commit("PUT", "/api/mcp/servers/legacyedit/secrets", { origin: b.origin, headers: { "x-api-key": "KEY-B" } })).status).toBe(200);
      before = aPosts();
      expect((await relay(token, "legacyedit", rpc("tools/list", 4), { "mcp-session-id": second })).status).not.toBe(200);
      expect(aPosts()).toBe(before);
      expect(JSON.stringify(a.requests.map((request) => request.headers))).not.toContain("KEY-B");
      // the entry itself works at B with B's key
      const atB = await relay(token, "legacyedit", rpc("initialize", 5, { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "c", version: "1" } }));
      expect(atB.status, atB.text).toBe(200);
      expect(b.requests.some((request) => request.path === "/messages" && request.headers["x-api-key"] === "KEY-B")).toBe(true);

      // switching the server off and on again closes its sessions
      const third = atB.headers.get("mcp-session-id")!;
      const bPosts = () => b.requests.filter((request) => request.path === "/messages").length;
      expect((await desktopApi("PATCH", "/api/mcp/servers/legacyedit", { enabled: false })).status).toBe(200);
      expect((await desktopApi("PATCH", "/api/mcp/servers/legacyedit", { enabled: true })).status).toBe(200);
      const beforeToggle = bPosts();
      expect((await relay(token, "legacyedit", rpc("tools/list", 8), { "mcp-session-id": third })).status).not.toBe(200);
      expect(bPosts()).toBe(beforeToggle);

      // removing the server closes its session too: re-added under the same
      // name and link, the old session is not picked up again
      const fourth = (await relay(token, "legacyedit", rpc("initialize", 9, { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "c", version: "1" } }))).headers.get("mcp-session-id")!;
      expect(fourth).toBeTruthy();
      expect((await desktopApi("DELETE", "/api/mcp/servers/legacyedit")).status).toBe(200);
      expect((await relay(token, "legacyedit", rpc("tools/list", 6), { "mcp-session-id": fourth })).status).toBe(404);
      expect((await desktopApi("POST", "/api/mcp/servers", { name: "legacyedit", url: b.mcpUrl, confirmLocal: "this-computer", auth: "header", headers: { "x-api-key": true } })).status).toBe(201);
      expect((await desktopApi("PATCH", "/api/mcp/servers/legacyedit", { enabled: true })).status).toBe(200);
      expect((await commit("PUT", "/api/mcp/servers/legacyedit/secrets", { origin: b.origin, headers: { "x-api-key": "KEY-B2" } })).status).toBe(200);
      const beforeB = bPosts();
      expect((await relay(token, "legacyedit", rpc("tools/list", 7), { "mcp-session-id": fourth })).status).not.toBe(200);
      expect(bPosts()).toBe(beforeB);
    } finally {
      if (turn) await stopFixtureTurn(bot.id, turn);
      await desktopApi("DELETE", "/api/mcp/servers/legacyedit");
      await a.close();
      await b.close();
    }
  });

  it("an access token the server rejects, with no desktop shell to refresh it, is sign-in-ended after one request", async () => {
    const oauthFake = await startFakeRemoteMcp({ auth: "bearer" });
    try {
      const created = await desktopApi("POST", "/api/mcp/servers", { name: "oauthsvc", url: oauthFake.mcpUrl, confirmLocal: "this-computer", auth: "oauth" });
      expect(created.status).toBe(201);
      expect((await desktopApi("PATCH", "/api/mcp/servers/oauthsvc", { enabled: true })).status).toBe(200);
      expect((await commit("PUT", "/api/mcp/servers/oauthsvc/secrets", { origin: oauthFake.origin, oauth: { accessToken: "at_stale_value_1" } })).status).toBe(200);
      const bot = (await desktopApi("POST", "/api/bots", { name: "Link oauth fixture" })).body.bot;
      let turn: Awaited<ReturnType<typeof startInternalFixtureTurn>> | undefined;
      try {
        turn = await startInternalFixtureTurn(bot.id, undefined, "__fixture_hold_authority__");
        const token = (turn.dump.mcpConfig.mcpServers as Record<string, { env: Record<string, string> }>).oauthsvc!.env.MURAGE_MCP_TOKEN!;
        const ended = await relay(token, "oauthsvc", rpc("tools/list", 1));
        expect(ended.status).toBe(401);
        expect(JSON.parse(ended.text)).toMatchObject({ code: "sign-in-ended" });
        expect(oauthFake.requests.filter((request) => request.method === "POST")).toHaveLength(1);
        // a fresh token pushed from outside makes the next call work
        expect((await commit("PUT", "/api/mcp/servers/oauthsvc/secrets", { origin: oauthFake.origin, oauth: { accessToken: oauthFake.mintAccessToken() } })).status).toBe(200);
        expect((await relay(token, "oauthsvc", rpc("tools/list", 2))).status).toBe(200);
      } finally {
        if (turn) await stopFixtureTurn(bot.id, turn);
      }
    } finally {
      await desktopApi("DELETE", "/api/mcp/servers/oauthsvc");
      await oauthFake.close();
    }
  });
});

describe("the harness keeps its own surface closed around the relay", () => {
  it("the relay route is not reachable as a desktop or plain caller", async () => {
    expect((await api("POST", "/api/internal/mcp-remote/anything", rpc("tools/list", 1))).status).toBe(401);
    expect((await desktopApi("POST", "/api/internal/mcp-remote/anything", rpc("tools/list", 1))).status).toBe(401);
  });
});
