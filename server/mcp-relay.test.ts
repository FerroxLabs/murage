// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { bindHumanThread, humanTask, linkHumanBinding, observeVerifiedHuman, resolveHumanBinding, threadHumanPrincipal } from "./human-principals.ts";
import { internalRouteRefusal } from "./internal-route-authority.ts";
import { requiredInternalKind } from "./internal-capabilities.ts";
import {
  MCP_REMOTE_OWNER_ONLY,
  MCP_REMOTE_RESTRICTED_BOT,
  mcpRemoteAudienceRefusal,
  mcpRemoteBotRefusal,
  ownServersAllowedFor,
  relayAudienceRefusal,
  relayTurnIsOwner,
  relayFailure,
  relayMcpCall,
  relayTimeoutFor,
  rewriteInitializeCapabilities,
  safeProtocolVersion,
  safeSessionId,
  statusForReason,
  tokenWaitFor,
  validateRelayBody,
  type RelayContext,
} from "./mcp-relay.ts";
import type { StoredRemoteMcpServer } from "./mcp-registry.ts";
import { clearAllMcpServerSecrets, setMcpServerSecrets } from "./mcp-secrets.ts";
import { RemoteSseSessions } from "./remote-mcp-sse-sessions.ts";
import { LIMITS } from "../shared/remote-mcp-url.mjs";
import { startFakeRemoteMcp, type FakeRemoteMcp } from "./testing/fake-remote-mcp.ts";

let fake: FakeRemoteMcp | undefined;
const sessions = new RemoteSseSessions();
afterEach(async () => {
  clearAllMcpServerSecrets();
  sessions.closeAll();
  await fake?.close();
  fake = undefined;
});

const serverFor = (over: Partial<StoredRemoteMcpServer> = {}): StoredRemoteMcpServer => ({ url: fake!.mcpUrl, auth: "none", headers: {}, enabled: true, local: "this-computer", ...over });
const context = (message: Record<string, unknown>, over: Partial<RelayContext> = {}): RelayContext => ({
  name: "svc", server: over.server ?? serverFor(), message, generation: "gen-1", postTokenRejected: () => false, sseSessions: sessions, tokenWaitMs: 400, ...over,
});
const rpc = (method: string, id: number | undefined, params?: unknown) => ({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) });

describe("validateRelayBody", () => {
  it("takes exactly one JSON-RPC message", () => {
    expect(validateRelayBody(rpc("tools/list", 1))).toMatchObject({ ok: true });
    expect(validateRelayBody(rpc("notifications/initialized", undefined))).toMatchObject({ ok: true });
    expect(validateRelayBody({ jsonrpc: "2.0", id: 4, result: {} })).toMatchObject({ ok: true });
    expect(validateRelayBody({ jsonrpc: "2.0", id: "x", error: { code: -1 } })).toMatchObject({ ok: true });
    for (const bad of [null, [], [rpc("a", 1)], "x", 3, {}, { jsonrpc: "1.0", method: "x" }, { jsonrpc: "2.0" }, { jsonrpc: "2.0", method: "" }, { jsonrpc: "2.0", method: "x".repeat(201) },
      { jsonrpc: "2.0", id: {}, method: "x" }, { jsonrpc: "2.0", result: {} }, { jsonrpc: "2.0", method: 5 }]) {
      expect([JSON.stringify(bad), validateRelayBody(bad).ok]).toEqual([JSON.stringify(bad), false]);
    }
  });
});

describe("small rules", () => {
  it("rewrites initialize capabilities on the harness side too", () => {
    expect(rewriteInitializeCapabilities(rpc("initialize", 1, { capabilities: { sampling: {} }, protocolVersion: "x" }))).toMatchObject({ params: { capabilities: {}, protocolVersion: "x" } });
  });
  it("timeouts: initialize 30 s, tool call 10 minutes, the rest 2 minutes", () => {
    expect(relayTimeoutFor(rpc("initialize", 1))).toBe(30_000);
    expect(relayTimeoutFor(rpc("tools/call", 1))).toBe(600_000);
    expect(relayTimeoutFor(rpc("tools/list", 1))).toBe(120_000);
  });
  it("T11-1: the token wait on initialize ends before the proxy's initialize limit, whatever the first request cost", () => {
    const initialize = rpc("initialize", 1);
    // clearly shorter than the proxy's 30 s, with room left for the one retry
    expect(tokenWaitFor(initialize, undefined, 0)).toBeLessThanOrEqual(20_000);
    expect(tokenWaitFor(initialize, 60_000, 0)).toBeLessThanOrEqual(20_000);
    for (const elapsed of [0, 1_000, 10_000, 24_000, 26_000]) {
      const wait = tokenWaitFor(initialize, undefined, elapsed);
      expect(elapsed + wait + 4_000, `elapsed ${elapsed}`).toBeLessThanOrEqual(LIMITS.initializeRelayMs);
    }
    // a slow first request leaves no wait at all
    expect(tokenWaitFor(initialize, undefined, 29_000)).toBe(0);
    // an explicit short wait is kept; every other method keeps the long wait
    expect(tokenWaitFor(initialize, 400, 0)).toBe(400);
    expect(tokenWaitFor(rpc("tools/call", 1), undefined, 0)).toBe(30_000);
    expect(tokenWaitFor(rpc("tools/list", 1), 3_000, 0)).toBe(3_000);
  });
  it("session ids and protocol versions are plain printable text", () => {
    expect(safeSessionId("abc-123_XYZ")).toBe("abc-123_XYZ");
    expect(safeSessionId(["abc", "def"])).toBe("abc");
    for (const bad of [undefined, "", "with space", "new\nline", "x".repeat(257), "é"]) expect(safeSessionId(bad)).toBeUndefined();
    expect(safeProtocolVersion("2025-06-18")).toBe("2025-06-18");
    for (const bad of [undefined, "", "latest", "2025-6-18", "2025-06-18; x"]) expect(safeProtocolVersion(bad)).toBeUndefined();
  });
  it("a failure is a code and its fixed sentence, with a status that says who to blame", () => {
    expect(relayFailure("sign-in-ended", "cloud.comfy.org")).toEqual({ status: 401, body: { code: "sign-in-ended", error: "Your sign-in to cloud.comfy.org has ended. Sign in again." } });
    expect(statusForReason("needs-key")).toBe(401);
    expect(statusForReason("blocked-address")).toBe(403);
    expect(statusForReason("server-error")).toBe(502);
    expect(statusForReason("no-answer")).toBe(502);
  });
  it("the audience and the bot gates use fixed sentences", () => {
    expect(mcpRemoteAudienceRefusal("t", () => true)).toBeNull();
    expect(mcpRemoteAudienceRefusal("t", () => false)).toBe(MCP_REMOTE_OWNER_ONLY);
    expect(mcpRemoteAudienceRefusal("t", () => { throw new Error("unreadable"); })).toBe(MCP_REMOTE_OWNER_ONLY);
    expect(MCP_REMOTE_OWNER_ONLY).toBe("Your own MCP servers belong to the owner, so this conversation cannot use them.");
    expect(mcpRemoteBotRefusal({}, "unrestricted")).toBeNull();
    expect(mcpRemoteBotRefusal({}, "restricted")).toBe(MCP_REMOTE_RESTRICTED_BOT);
    expect(mcpRemoteBotRefusal({ hidden: true }, "unrestricted")).toBe(MCP_REMOTE_RESTRICTED_BOT);
    for (const text of [MCP_REMOTE_OWNER_ONLY, MCP_REMOTE_RESTRICTED_BOT]) {
      expect(text).not.toMatch(/[–—]/);
      expect(text).not.toMatch(/\b(safe|safely|safety|unsafe|composio|price)\b/i);
    }
  });
});

describe("the capability kind an internal path needs", () => {
  it("maps the link relay to its own kind and leaves every other path where it was", () => {
    expect(requiredInternalKind("/api/internal/mcp-remote/comfy")).toBe("mcp");
    expect(requiredInternalKind("/api/internal/connectors/mcp")).toBe("connectors");
    expect(requiredInternalKind("/api/internal/memory/save")).toBe("memory");
    for (const path of ["/api/internal/computer-control", "/api/internal/computer-activity", "/api/internal/headless-browser", "/api/internal/unified-browser", "/api/internal/host-computer"]) expect(requiredInternalKind(path)).toBe("computer");
    for (const path of ["/api/internal/agents", "/api/internal/ask-bot", "/api/internal/mcp-remote", "/api/internal/mcp-remotes/x", "/api/internal/unknown"]) expect(requiredInternalKind(path)).toBe("agents");
  });
});

describe("M1: the relay agrees with the mount gates about whose turn this is", () => {
  it("needs the turn's own recorded owner audience, and a claim that was not marked non-owner", () => {
    expect(relayTurnIsOwner({ ownerAudience: true }, {})).toBe(true);
    expect(relayTurnIsOwner({ ownerAudience: false }, {})).toBe(false);
    expect(relayTurnIsOwner({}, {})).toBe(false);
    expect(relayTurnIsOwner(undefined, {})).toBe(false);
    expect(relayTurnIsOwner({ ownerAudience: true }, { notOwnerAudience: true })).toBe(false);
  });
  it("a turn begun with ownerAudience false gets the owner-only sentence even in the owner's own thread", () => {
    expect(mcpRemoteAudienceRefusal("owner-thread", () => true && relayTurnIsOwner({ ownerAudience: false }, {}))).toBe(MCP_REMOTE_OWNER_ONLY);
    expect(mcpRemoteAudienceRefusal("owner-thread", () => true && relayTurnIsOwner({ ownerAudience: true }, {}))).toBeNull();
  });
});

describe("L-b: the relay route's audience decision is one named rule, and index.ts calls it", () => {
  it("refuses an owner thread whose turn was begun for words that were not the owner's, a claim marked non-owner, a thread that is not the owner's, and a thread that cannot be read", () => {
    const ownerThread = () => true;
    expect(relayAudienceRefusal({ threadId: "t" }, { ownerAudience: true }, ownerThread)).toBeNull();
    expect(relayAudienceRefusal({ threadId: "t" }, { ownerAudience: false }, ownerThread)).toBe(MCP_REMOTE_OWNER_ONLY);
    expect(relayAudienceRefusal({ threadId: "t" }, undefined, ownerThread)).toBe(MCP_REMOTE_OWNER_ONLY);
    expect(relayAudienceRefusal({ threadId: "t", notOwnerAudience: true }, { ownerAudience: true }, ownerThread)).toBe(MCP_REMOTE_OWNER_ONLY);
    expect(relayAudienceRefusal({ threadId: "t" }, { ownerAudience: true }, () => false)).toBe(MCP_REMOTE_OWNER_ONLY);
    expect(relayAudienceRefusal({ threadId: "t" }, { ownerAudience: true }, () => { throw new Error("unreadable"); })).toBe(MCP_REMOTE_OWNER_ONLY);
  });
  it("the relay route hands the rule the turn's own record and claim, and does not spell the check out by itself", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const start = source.indexOf("const mcpRemoteMatch = ");
    expect(start).toBeGreaterThan(0);
    const route = source.slice(start, source.indexOf("relayMcpCall({", start));
    expect(route).toContain("relayAudienceRefusal(internalClaim, internalOwner, (threadId) => turnAudienceIsOwner(threadId, {}))");
    expect(route.indexOf("relayAudienceRefusal(")).toBeLessThan(route.indexOf("readInternalBody"));
    expect(route).not.toContain("relayTurnIsOwner(");
    // internalOwner is the record for this claim's own generation, checked earlier on every internal route
    expect(source).toContain("if (!internalOwner || internalOwner.generation !== internalClaim.generation) return json(res, 401");
  });
});

describe("L-c: the mount predicate for the owner's own servers", () => {
  it("a hidden bot and a restricted bot get none; an ordinary bot does", () => {
    expect(ownServersAllowedFor({ id: "b1" })).toBe(true);
    expect(ownServersAllowedFor({ id: "b1", hidden: false })).toBe(true);
    expect(ownServersAllowedFor({ id: "b1", hidden: true })).toBe(false);
    // an access policy that cannot be read counts as restricted
    expect(ownServersAllowedFor({ id: "b1", connectedAppAccess: { junk: true } } as never)).toBe(false);
    expect(ownServersAllowedFor({ id: "b1", hidden: true, connectedAppAccess: { junk: true } } as never)).toBe(false);
  });
  it("both mount sites in index.ts gate on it, and index.ts does not keep a copy of its own", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const mounts = source.split("\n").filter((line) => line.includes("instance.adapter.capabilities.customMcp === true"));
    expect(mounts).toHaveLength(2);
    for (const line of mounts) expect(line).toContain("&& ownServersAllowedFor(bot)");
    expect(source).not.toMatch(/function ownServersAllowedFor/);
  });
});

describe("index.ts spells the same mapping as requiredInternalKind", () => {
  it("names the mcp-remote prefix on the line the watchdog test reads, and keeps the computer list literal", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain('path.startsWith("/api/internal/mcp-remote/") ? "mcp"');
    expect(source).toContain('["/api/internal/computer-control", "/api/internal/computer-activity",');
    const line = source.split("\n").find((candidate) => candidate.includes('path.startsWith("/api/internal/mcp-remote/")'))!;
    for (const path of ["/api/internal/computer-control", "/api/internal/host-computer", "/api/internal/unified-browser"]) expect(line).toContain(path);
  });
});

describe("the audience and channel gates, against real threads", () => {
  it("the owner passes; a contact, a teammate working for a contact and an unproven caller are refused with the owner-only sentence; a channel person cannot reach the route", async () => {
    const { Store } = await import("./store.ts");
    const { DATA_DIR } = await import("./config.ts");
    const { closeDatabase } = await import("./database.ts");
    const { mkdirSync, rmSync } = await import("node:fs");
    const { ownerMemoryTicket } = await import("./memory/authority.ts");
    const { turnAudienceIsOwner } = await import("./owner-audience.ts");
    closeDatabase();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
    const bot = store.createBot();
    const helper = store.createBot();
    const bindingId = observeVerifiedHuman({ platform: "slack", connectionId: "fixture-connection", authorityId: "TEAM", userId: "U-CONTACT" });
    linkHumanBinding(ownerMemoryTicket(), { bindingId, expectedRevision: 1, as: "person" });
    const contactTask = store.createTask(bot.id, "Channel conversation", false)!;
    bindHumanThread(contactTask.threadId, resolveHumanBinding(bindingId));
    const delegated = humanTask(store, helper.id, threadHumanPrincipal(contactTask.threadId))!;
    const isOwner = (audience = {}) => (threadId: string) => turnAudienceIsOwner(threadId, audience);
    expect(mcpRemoteAudienceRefusal(bot.threadId, isOwner())).toBeNull();
    expect(mcpRemoteAudienceRefusal(contactTask.threadId, isOwner())).toBe(MCP_REMOTE_OWNER_ONLY);
    expect(mcpRemoteAudienceRefusal(delegated.threadId, isOwner())).toBe(MCP_REMOTE_OWNER_ONLY);
    expect(mcpRemoteAudienceRefusal(bot.threadId, isOwner({ origin: "unproven" }))).toBe(MCP_REMOTE_OWNER_ONLY);
    expect(internalRouteRefusal({ path: "/api/internal/mcp-remote/comfy", kind: "mcp", principal: threadHumanPrincipal(contactTask.threadId) })).not.toBeNull();
    expect(internalRouteRefusal({ path: "/api/internal/mcp-remote/comfy", kind: "mcp", principal: threadHumanPrincipal(bot.threadId) })).toBeNull();
    closeDatabase();
  });
});

describe("relayMcpCall over streamable HTTP", () => {
  it("passes the initialize answer through with the session id, carries the session and protocol version, and never sends capabilities", async () => {
    fake = await startFakeRemoteMcp({ auth: "none" });
    const init = await relayMcpCall(context(rpc("initialize", 1, { protocolVersion: "2025-06-18", capabilities: { sampling: {}, roots: {} }, clientInfo: { name: "c", version: "1" } })));
    expect(init).toMatchObject({ ok: true, status: 200, contentType: "application/json", sessionId: expect.stringMatching(/^sess-/) });
    if (!init.ok) return;
    expect(JSON.parse(String(init.body))).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18" } });
    expect(JSON.parse(fake.requests.at(-1)!.body).params.capabilities).toEqual({});
    const list = await relayMcpCall(context(rpc("tools/list", 2), { sessionId: init.sessionId, protocolVersion: "2025-06-18" }));
    expect(list).toMatchObject({ ok: true, status: 200 });
    expect(fake.requests.at(-1)!.headers["mcp-session-id"]).toBe(init.sessionId);
    expect(fake.requests.at(-1)!.headers["mcp-protocol-version"]).toBe("2025-06-18");
    const note = await relayMcpCall(context(rpc("notifications/initialized", undefined), { sessionId: init.sessionId }));
    expect(note).toMatchObject({ ok: true, status: 202 });
  });

  it("an SSE framed answer keeps its content type", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", respondWith: "sse" });
    const result = await relayMcpCall(context(rpc("tools/list", 1)));
    expect(result).toMatchObject({ ok: true, contentType: "text/event-stream" });
  });

  it("sends the stored key and the stored bearer, only to the server's own origin", async () => {
    fake = await startFakeRemoteMcp({ auth: "both" });
    setMcpServerSecrets("svc", { origin: fake!.origin, headers: { "x-api-key": "fake-api-key" } });
    const viaKey = await relayMcpCall(context(rpc("tools/list", 1), { server: serverFor({ auth: "header", headers: { "x-api-key": true } }) }));
    expect(viaKey).toMatchObject({ ok: true });
    expect(fake.requests.at(-1)!.headers["x-api-key"]).toBe("fake-api-key");
    clearAllMcpServerSecrets();
    setMcpServerSecrets("svc", { origin: fake!.origin, oauth: { accessToken: fake.mintAccessToken() } });
    expect(await relayMcpCall(context(rpc("tools/list", 2), { server: serverFor({ auth: "oauth" }) }))).toMatchObject({ ok: true });
    expect(fake.requests.at(-1)!.headers.authorization).toMatch(/^Bearer at_/);
  });

  it("a missing key is needs-key before any request, and a masked link with no stored copy is too", async () => {
    fake = await startFakeRemoteMcp({ auth: "api-key" });
    const before = fake.requests.length;
    expect(await relayMcpCall(context(rpc("tools/list", 1), { server: serverFor({ auth: "header", headers: { "x-api-key": true } }) }))).toMatchObject({ ok: false, status: 401, body: { code: "needs-key" } });
    expect(await relayMcpCall(context(rpc("tools/list", 1), { server: serverFor({ url: "http://127.0.0.1:1/s/•••/mcp", urlSecret: true }) }))).toMatchObject({ ok: false, body: { code: "needs-key" } });
    expect(fake.requests.length).toBe(before);
  });

  it("every upstream failure leaves as a code and a fixed sentence, with none of the upstream's words", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", mcpFailStatus: 500 });
    const failed = await relayMcpCall(context(rpc("tools/call", 1, { name: "echo" })));
    expect(failed).toMatchObject({ ok: false, status: 502, body: { code: "server-error" } });
    expect(JSON.stringify(failed)).not.toMatch(/UPSTREAM-BODY-TEXT|UPSTREAM-HEADER-TEXT/);
    fake.options.mcpFailStatus = 418;
    expect(await relayMcpCall(context(rpc("tools/call", 1)))).toMatchObject({ ok: false, body: { code: "wrong-address" } });
    fake.options.mcpFailStatus = undefined;
    fake.options.mcpMovedTo = "https://elsewhere.example/mcp";
    expect(await relayMcpCall(context(rpc("tools/call", 1)))).toMatchObject({ ok: false, body: { code: "moved" } });
  });

  it("refuses to relay when the address class no longer matches what the owner confirmed", async () => {
    fake = await startFakeRemoteMcp({ auth: "none" });
    const before = fake.requests.length;
    expect(await relayMcpCall(context(rpc("tools/list", 1), { server: serverFor({ local: "local-network" }) }))).toMatchObject({ ok: false, status: 403, body: { code: "address-changed" } });
    expect(await relayMcpCall(context(rpc("tools/list", 1), { server: serverFor({ local: undefined }) }))).toMatchObject({ ok: false, body: { code: "address-changed" } });
    expect(fake.requests.length).toBe(before);
  });

  it("a response that is neither JSON nor SSE is wrong-address", async () => {
    fake = await startFakeRemoteMcp({ auth: "none" });
    // The fake answers a GET to /mcp with 405; POST a method it answers as text via the failure path is covered above, so use the 404 path.
    expect(await relayMcpCall(context(rpc("tools/list", 1), { server: serverFor({ url: `${fake.origin}/nope` }) }))).toMatchObject({ ok: false, body: { code: "wrong-address" } });
  });

  it("a cancelled caller aborts the call", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", initializeDelayMs: 2_000 });
    const controller = new AbortController();
    const pending = relayMcpCall(context(rpc("initialize", 1, {}), { signal: controller.signal }));
    setTimeout(() => controller.abort(), 100);
    expect(await pending).toMatchObject({ ok: false, body: { code: "cancelled" } });
  });
});

describe("a 401 on an access token: one report, one wait, one retry", () => {
  it("reports the rejection, takes the token main pushes, and the call succeeds", async () => {
    fake = await startFakeRemoteMcp({ auth: "bearer" });
    setMcpServerSecrets("svc", { origin: fake!.origin, oauth: { accessToken: "at_stale_value_1" } });
    let reported = 0;
    const result = await relayMcpCall(context(rpc("tools/list", 1), {
      server: serverFor({ auth: "oauth" }), tokenWaitMs: 3_000,
      postTokenRejected: () => {
        reported += 1;
        setTimeout(() => setMcpServerSecrets("svc", { origin: fake!.origin, oauth: { accessToken: fake!.mintAccessToken() } }), 50);
        return true;
      },
    }));
    expect(reported).toBe(1);
    expect(result).toMatchObject({ ok: true, status: 200 });
    const authorizations = fake.requests.map((request) => request.headers.authorization).filter(Boolean);
    expect(authorizations).toHaveLength(2);
    expect(authorizations[0]).toBe("Bearer at_stale_value_1");
    expect(authorizations[1]).not.toBe(authorizations[0]);
  });

  it("a token main pushed while this call was in flight is taken at once, with no second refresh", async () => {
    // Two calls rejected together: the first one's report refreshed, and the
    // reactive cool-down drops this call's report. It must not wait for a
    // token newer than the one already pushed (macOS CI, mcp-link step 6).
    fake = await startFakeRemoteMcp({ auth: "bearer" });
    setMcpServerSecrets("svc", { origin: fake!.origin, oauth: { accessToken: "at_stale_value_1" } });
    let reported = 0;
    const pending = relayMcpCall(context(rpc("tools/list", 1), {
      server: serverFor({ auth: "oauth" }), tokenWaitMs: 3_000,
      postTokenRejected: () => { reported += 1; return true; },
    }));
    // the stale request is already on its way; main's push for the other call lands now
    setMcpServerSecrets("svc", { origin: fake!.origin, oauth: { accessToken: fake!.mintAccessToken() } });
    const started = Date.now();
    const result = await pending;
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(reported).toBe(1);
    expect(Date.now() - started).toBeLessThan(2_000);
    const authorizations = fake.requests.map((request) => request.headers.authorization).filter(Boolean);
    expect(authorizations).toHaveLength(2);
    expect(authorizations[0]).toBe("Bearer at_stale_value_1");
    expect(authorizations[1]).not.toBe(authorizations[0]);
  });

  it("no new token in time, or no desktop shell to ask, is sign-in-ended after a single request", async () => {
    fake = await startFakeRemoteMcp({ auth: "bearer" });
    setMcpServerSecrets("svc", { origin: fake!.origin, oauth: { accessToken: "at_stale_value_1" } });
    const waited = await relayMcpCall(context(rpc("tools/list", 1), { server: serverFor({ auth: "oauth" }), postTokenRejected: () => true, tokenWaitMs: 150 }));
    expect(waited).toMatchObject({ ok: false, status: 401, body: { code: "sign-in-ended" } });
    const noShell = await relayMcpCall(context(rpc("tools/list", 1), { server: serverFor({ auth: "oauth" }), postTokenRejected: () => false }));
    expect(noShell).toMatchObject({ ok: false, body: { code: "sign-in-ended" } });
    expect(fake.requests.filter((request) => request.method === "POST")).toHaveLength(2);
  });

  it("a second 401 after a fresh token ends the call: there is no loop", async () => {
    fake = await startFakeRemoteMcp({ auth: "bearer" });
    setMcpServerSecrets("svc", { origin: fake!.origin, oauth: { accessToken: "at_stale_value_1" } });
    let reported = 0;
    const result = await relayMcpCall(context(rpc("tools/list", 1), {
      server: serverFor({ auth: "oauth" }), tokenWaitMs: 3_000,
      postTokenRejected: () => { reported += 1; setTimeout(() => setMcpServerSecrets("svc", { origin: fake!.origin, oauth: { accessToken: "at_also_not_valid_2" } }), 30); return true; },
    }));
    expect(result).toMatchObject({ ok: false, body: { code: "sign-in-ended" } });
    expect(reported).toBe(1);
    expect(fake.requests.filter((request) => request.method === "POST")).toHaveLength(2);
  });

  it("an oauth entry with no token at all asks main once without sending a request", async () => {
    fake = await startFakeRemoteMcp({ auth: "bearer" });
    let reported = 0;
    const result = await relayMcpCall(context(rpc("tools/list", 1), { server: serverFor({ auth: "oauth" }), postTokenRejected: () => { reported += 1; return true; }, tokenWaitMs: 100 }));
    expect(result).toMatchObject({ ok: false, body: { code: "sign-in-ended" } });
    expect(reported).toBe(1);
    expect(fake.requests).toHaveLength(0);
  });

  it("a 403 needs-more-access is not retried", async () => {
    fake = await startFakeRemoteMcp({ auth: "bearer", requireScopeForTool: { tool: "sum", scope: "tools:write" } });
    setMcpServerSecrets("svc", { origin: fake!.origin, oauth: { accessToken: fake.mintAccessToken("tools:call") } });
    let reported = 0;
    const result = await relayMcpCall(context(rpc("tools/call", 1, { name: "sum", arguments: { a: 1, b: 2 } }), { server: serverFor({ auth: "oauth" }), postTokenRejected: () => { reported += 1; return true; } }));
    expect(result).toMatchObject({ ok: false, status: 401, body: { code: "needs-more-access" } });
    expect(reported).toBe(0);
  });

  it("a 403 needs-more-access carries the scope the server asked for, outside the body the engine reads", async () => {
    fake = await startFakeRemoteMcp({ auth: "bearer", requireScopeForTool: { tool: "sum", scope: "tools:write" } });
    setMcpServerSecrets("svc", { origin: fake!.origin, oauth: { accessToken: fake.mintAccessToken("tools:call") } });
    const result = await relayMcpCall(context(rpc("tools/call", 1, { name: "sum", arguments: { a: 1, b: 2 } }), { server: serverFor({ auth: "oauth" }), postTokenRejected: () => true }));
    expect(result).toMatchObject({ ok: false, body: { code: "needs-more-access" }, stepUpScopes: ["tools:write"] });
    expect(JSON.stringify((result as { body: unknown }).body)).not.toContain("tools:write");
  });
});

describe("relayMcpCall over the legacy SSE transport", () => {
  it("opens a harness-held session on initialize and answers on it", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", transport: "sse" });
    const init = await relayMcpCall(context(rpc("initialize", 1, {}), { server: serverFor({ transport: "sse" }) }));
    expect(init).toMatchObject({ ok: true, status: 200, sessionId: expect.any(String) });
    if (!init.ok) return;
    const list = await relayMcpCall(context(rpc("tools/list", 2), { server: serverFor({ transport: "sse" }), sessionId: init.sessionId }));
    expect(list).toMatchObject({ ok: true });
    expect(JSON.parse(String((list as { body: string }).body))).toMatchObject({ id: 2, result: { tools: [{ name: "echo" }, { name: "sum" }] } });
    const note = await relayMcpCall(context(rpc("notifications/initialized", undefined), { server: serverFor({ transport: "sse" }), sessionId: init.sessionId }));
    expect(note).toMatchObject({ ok: true, status: 202 });
  });
  it("an untested link that answers POST with 405 falls back to the stream", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", transport: "sse" });
    const init = await relayMcpCall(context(rpc("initialize", 1, {}), { server: serverFor({ transport: undefined }) }));
    expect(init).toMatchObject({ ok: true, sessionId: expect.any(String) });
  });
  it("T11-2: a 403 insufficient_scope on a stream session carries the step-up scope, like streamable HTTP", async () => {
    fake = await startFakeRemoteMcp({ auth: "bearer", transport: "sse", requireScopeForTool: { tool: "sum", scope: "tools:write" } });
    setMcpServerSecrets("svc", { origin: fake!.origin, oauth: { accessToken: fake.mintAccessToken("tools:call") } });
    let reported = 0;
    const server = serverFor({ auth: "oauth", transport: "sse" });
    const init = await relayMcpCall(context(rpc("initialize", 1, {}), { server, postTokenRejected: () => { reported += 1; return true; } }));
    if (!init.ok) throw new Error("init");
    const result = await relayMcpCall(context(rpc("tools/call", 2, { name: "sum", arguments: { a: 1, b: 2 } }), { server, sessionId: init.sessionId, postTokenRejected: () => { reported += 1; return true; } }));
    expect(result).toMatchObject({ ok: false, status: 401, body: { code: "needs-more-access" }, stepUpScopes: ["tools:write"] });
    expect(JSON.stringify((result as { body: unknown }).body)).not.toContain("tools:write");
    // a scope refusal is not a rejected token: nothing was reported, nothing retried
    expect(reported).toBe(0);
  });
  it("a call with no session, or another turn's session, is refused", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", transport: "sse" });
    expect(await relayMcpCall(context(rpc("tools/list", 1), { server: serverFor({ transport: "sse" }) }))).toMatchObject({ ok: false, body: { code: "session-gone" } });
    const init = await relayMcpCall(context(rpc("initialize", 1, {}), { server: serverFor({ transport: "sse" }) }));
    if (!init.ok) throw new Error("init");
    const other = await relayMcpCall(context(rpc("tools/list", 2), { server: serverFor({ transport: "sse" }), sessionId: init.sessionId, generation: "gen-2" }));
    expect(other).toMatchObject({ ok: false, body: { code: "session-gone" } });
  });
});

describe("N1: an open legacy SSE session does not outlive an edit of the link", () => {
  it("after an edit A to B and a fresh key for B, a call on the old session sends nothing to A and fails", async () => {
    const a = await startFakeRemoteMcp({ auth: "none", transport: "sse" });
    const b = await startFakeRemoteMcp({ auth: "none", transport: "sse" });
    try {
      const atA: StoredRemoteMcpServer = { url: a.mcpUrl, auth: "header", headers: { "x-api-key": true }, enabled: true, local: "this-computer", transport: "sse" };
      setMcpServerSecrets("comfy", { origin: a.origin, headers: { "x-api-key": "KEY-A" } });
      const init = await relayMcpCall(context(rpc("initialize", 1, {}), { name: "comfy", server: atA }));
      expect(init).toMatchObject({ ok: true, sessionId: expect.any(String) });
      if (!init.ok) return;
      // the owner edits the link to B: the saved key is forgotten, and main pushes B's key
      clearAllMcpServerSecrets();
      setMcpServerSecrets("comfy", { origin: b.origin, headers: { "x-api-key": "KEY-B" } });
      const atB: StoredRemoteMcpServer = { ...atA, url: b.mcpUrl };
      const postsBefore = a.requests.filter((request) => request.method === "POST").length;
      const call = await relayMcpCall(context(rpc("tools/list", 2), { name: "comfy", server: atB, sessionId: init.sessionId }));
      expect(call).toMatchObject({ ok: false });
      expect(a.requests.filter((request) => request.method === "POST")).toHaveLength(postsBefore);
      expect(JSON.stringify(a.requests.map((request) => request.headers))).not.toContain("KEY-B");
      expect(b.requests.filter((request) => request.path === "/messages")).toHaveLength(0);
      // the stale session is gone: a fresh initialize opens one at B with B's key
      expect(sessions.has(init.sessionId!)).toBe(false);
      const again = await relayMcpCall(context(rpc("initialize", 3, {}), { name: "comfy", server: atB }));
      expect(again).toMatchObject({ ok: true });
      expect(b.requests.some((request) => request.headers["x-api-key"] === "KEY-B")).toBe(true);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("a session opened under one local confirmation is not used under another", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", transport: "sse" });
    const init = await relayMcpCall(context(rpc("initialize", 1, {}), { server: serverFor({ transport: "sse" }) }));
    if (!init.ok) throw new Error("init");
    const posts = fake.requests.filter((request) => request.path === "/messages").length;
    const call = await relayMcpCall(context(rpc("tools/list", 2), { server: serverFor({ transport: "sse", local: undefined }), sessionId: init.sessionId }));
    expect(call).toMatchObject({ ok: false });
    expect(fake.requests.filter((request) => request.path === "/messages")).toHaveLength(posts);
  });
});

describe("module hygiene", () => {
  it("never logs and carries the license header", () => {
    const source = readFileSync(new URL("./mcp-relay.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/console\./);
    expect(source).toContain("SPDX-License-Identifier: AGPL-3.0-or-later");
  });
});

describe("H2 through the relay and Test: a key follows the origin, not the name", () => {
  it("REV2-1: after an edit to another origin neither Test nor the relay sends the old key there", async () => {
    const { testRemoteServer } = await import("./mcp-remote-api.ts");
    const a = await startFakeRemoteMcp({ auth: "api-key", apiKey: "KEY-FOR-ORIGIN-A" });
    const b = await startFakeRemoteMcp({ auth: "none" });
    try {
      setMcpServerSecrets("comfy", { origin: a.origin, headers: { "x-api-key": "KEY-FOR-ORIGIN-A" } });
      const atA = { url: a.mcpUrl, auth: "header" as const, headers: { "x-api-key": true as const }, enabled: true, local: "this-computer" as const };
      expect(await testRemoteServer("comfy", atA)).toMatchObject({ ok: true });
      const atB = { ...atA, url: b.mcpUrl };
      const tested = await testRemoteServer("comfy", atB);
      expect(tested).toMatchObject({ ok: false, reason: "needs-key" });
      const relayed = await relayMcpCall(context(rpc("tools/list", 1), { name: "comfy", server: atB }));
      expect(relayed).toMatchObject({ ok: false, body: { code: "needs-key" } });
      expect(b.requests).toHaveLength(0);
      expect(JSON.stringify(b.requests)).not.toContain("KEY-FOR-ORIGIN-A");
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("REV2-1: the same for an access token", async () => {
    const a = await startFakeRemoteMcp({ auth: "bearer" });
    const b = await startFakeRemoteMcp({ auth: "none" });
    try {
      setMcpServerSecrets("comfy", { origin: a.origin, oauth: { accessToken: a.mintAccessToken() } });
      const atB = { url: b.mcpUrl, auth: "oauth" as const, headers: {}, enabled: true, local: "this-computer" as const };
      let asked = 0;
      const relayed = await relayMcpCall(context(rpc("tools/list", 1), { name: "comfy", server: atB, postTokenRejected: () => { asked += 1; return false; } }));
      expect(relayed).toMatchObject({ ok: false, body: { code: "sign-in-ended" } });
      expect(asked).toBe(1);
      expect(b.requests).toHaveLength(0);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("REV2-1b: a held full link does not override an edited link", async () => {
    const { testRemoteServer } = await import("./mcp-remote-api.ts");
    const a = await startFakeRemoteMcp({ auth: "none" });
    const b = await startFakeRemoteMcp({ auth: "none" });
    try {
      setMcpServerSecrets("zap", { origin: a.origin, url: `${a.origin}/s/AbCdEf0123456789XyZabcdef/mcp` });
      const result = await testRemoteServer("zap", { url: b.mcpUrl, auth: "none", headers: {}, enabled: true, local: "this-computer" });
      expect(result).toMatchObject({ ok: true });
      expect(a.requests).toHaveLength(0);
      expect(b.requests.length).toBeGreaterThan(0);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
