// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Flux usage tags (1.0.10 USAGE-TAGS, CREDIT-DRAIN-13): x-flux-bot-id, x-flux-feature, x-flux-thread-id on every Flux request,
// validated before they leave. Fakes only: no Flux key, no network.
import { afterEach, describe, expect, it } from "vitest";

import {
  FLUX_CALL_SITES, FLUX_CALL_SITE_FEATURES, claudeCustomHeadersValue, fluxCallHeaders, fluxCallHeadersVia, fluxFetch, fluxMemoryAtSend,
  fluxMemoryContextForTurn, fluxMemorySend, fluxTurnDecision, fuigoConfigOverlay, hermesExtraHeaderLines, opencodeConfigOverlay,
  qwenSettingsJson, setFluxMemorySettings, withFluxCallHeaders, type FluxCallSiteId,
} from "./flux-memory-headers.ts";
import {
  FLUX_FEATURES, assertFluxUsageHeaders, fluxBotIdValue, fluxFeatureForAutomation, fluxThreadIdValue, fluxUsageForTurn, fluxUsageHeaders,
  readServedModel,
} from "./flux-usage-tags.ts";
import { FluxEmailClient } from "./email/flux-email-client.ts";

const FEATURE = "x-flux-feature";
const BOT = "x-flux-bot-id";
const THREAD = "x-flux-thread-id";
const AGREED_BOT = /^[A-Za-z0-9._:-]{1,64}$/;
const AGREED_THREAD = /^[0-9a-f]{32}$/;

/** Every usage header present is the agreed shape. */
function expectWellFormed(headers: Record<string, string>): void {
  expect(FLUX_FEATURES).toContain(headers[FEATURE]);
  if (headers[BOT] !== undefined) expect(headers[BOT]).toMatch(AGREED_BOT);
  if (headers[THREAD] !== undefined) expect(headers[THREAD]).toMatch(AGREED_THREAD);
}

const owner = { botId: "bot-7f3a", audience: "owner" as const, decidedOwner: true };

afterEach(() => setFluxMemorySettings({}));

describe("usage header values", () => {
  it("always carries a feature from the agreed set, and `other` for anything unknown", () => {
    expect(fluxUsageHeaders({ feature: "chat" })).toEqual({ [FEATURE]: "chat" });
    expect(fluxUsageHeaders({ feature: "Chat" as never })[FEATURE]).toBe("other");
    expect(fluxUsageHeaders({ feature: "pip" as never })[FEATURE]).toBe("other");
    expect(fluxUsageHeaders(undefined)).toEqual({ [FEATURE]: "other" });
  });

  it("drops a malformed bot id instead of sending it", () => {
    for (const bad of ["", "has space", "owner@example.com", "x".repeat(65), "bot/1", "bot\n1", "bøt", "bot,1", "<script>"]) {
      expect(fluxBotIdValue(bad)).toBeNull();
      expect(fluxUsageHeaders({ feature: "chat", botId: bad })).not.toHaveProperty(BOT);
    }
    expect(fluxBotIdValue(42)).toBeNull();
    for (const good of ["bot-7f3a", "3f2b8c1e-5d4a-4b6c-9e8f-0a1b2c3d4e5f", "chief", "a.b:c_d-e", "x".repeat(64)]) {
      expect(fluxUsageHeaders({ feature: "chat", botId: good })[BOT]).toBe(good);
    }
  });

  it("never puts conversation content in the thread id: it is an opaque 32-hex tag, stable per thread", () => {
    const threadIds = ["t-1", "please email owner@example.com my card 4111 1111 1111 1111", "project-3f2b8c1e", "x".repeat(400)];
    for (const threadId of threadIds) {
      const value = fluxThreadIdValue(threadId)!;
      expect(value).toMatch(AGREED_THREAD);
      expect(value).not.toContain(threadId.slice(0, 8));
      expect(fluxThreadIdValue(threadId)).toBe(value);
      const headers = fluxUsageHeaders({ feature: "chat", threadId });
      expect(headers[THREAD]).toBe(value);
      expect(Object.values(headers).join(" ")).not.toMatch(/@|example|4111|please/);
    }
    expect(fluxThreadIdValue("t-1")).not.toBe(fluxThreadIdValue("t-2"));
    expect(fluxThreadIdValue("")).toBeNull();
    expect(fluxThreadIdValue("x".repeat(513))).toBeNull();
  });

  it("refuses a hand-built malformed usage header", () => {
    expect(() => assertFluxUsageHeaders({ [FEATURE]: "billing" })).toThrow();
    expect(() => assertFluxUsageHeaders({ [BOT]: "has space" })).toThrow();
    expect(() => assertFluxUsageHeaders({ [THREAD]: "raw-thread-id" })).toThrow();
    expect(() => assertFluxUsageHeaders(fluxUsageHeaders({ feature: "voice", botId: "b1", threadId: "t1" }))).not.toThrow();
  });
});

describe("feature mapping", () => {
  it("maps every direct call site onto the agreed set", () => {
    for (const site of Object.keys(FLUX_CALL_SITES) as FluxCallSiteId[]) expect(FLUX_FEATURES).toContain(FLUX_CALL_SITE_FEATURES[site]);
    expect(FLUX_CALL_SITE_FEATURES).toEqual({
      decider: "other", "browser-checker": "other", "image-generation": "image", "avatar-image": "image", "voice-transcribe": "voice",
      "voice-speech": "voice", "voice-stream": "voice", "memory-extraction": "memory", "pip-reflection": "memory", "composio-broker": "other",
      "voice-host": "voice", "dictation-cleanup": "voice", "web-search": "other",
    });
  });

  it("maps a turn's automation onto chat, routine, app_event or other", () => {
    expect(fluxFeatureForAutomation(undefined)).toBe("chat");
    expect(fluxFeatureForAutomation("schedule")).toBe("routine");
    expect(fluxFeatureForAutomation("manual")).toBe("routine");
    expect(fluxFeatureForAutomation("channel")).toBe("routine");
    expect(fluxFeatureForAutomation("webhook")).toBe("app_event");
    for (const kind of ["message", "delegation", "ask", "room"]) expect(fluxFeatureForAutomation(kind)).toBe("chat");
    expect(fluxFeatureForAutomation("card")).toBe("other");
    expect(fluxFeatureForAutomation("something-new")).toBe("other");
  });

  it("an engine turn with no stamp is chat in the foreground and other in the background", () => {
    expect(fluxUsageForTurn({ threadId: "t", warmIdentity: owner })).toEqual({ feature: "chat", botId: owner.botId, threadId: "t" });
    expect(fluxUsageForTurn({ threadId: "t", background: true }).feature).toBe("other");
    expect(fluxUsageForTurn({ threadId: "t", background: true, usageFeature: "routine" }).feature).toBe("routine");
  });
});

describe("direct Murage calls to Flux", () => {
  it("every call site carries its feature beside the background memory headers", () => {
    for (const site of Object.keys(FLUX_CALL_SITES) as FluxCallSiteId[]) {
      const headers = fluxCallHeaders(site);
      expect(headers[FEATURE]).toBe(FLUX_CALL_SITE_FEATURES[site]);
      expect(headers["x-flux-memory-capture"]).toBe("off");
      expectWellFormed(headers);
    }
  });

  it("carries the bot and conversation when the caller names them, and drops a malformed bot id", () => {
    const headers = fluxCallHeaders("pip-reflection", { usage: { botId: "bot-7f3a", threadId: "t-9" } });
    expect(headers).toMatchObject({ [FEATURE]: "memory", [BOT]: "bot-7f3a", [THREAD]: fluxThreadIdValue("t-9") });
    expect(fluxCallHeaders("pip-reflection", { usage: { botId: "not ok" } })).not.toHaveProperty(BOT);
    expect(fluxCallHeadersVia("voice-host", "own-key")).toEqual({});
    expect(fluxCallHeadersVia("voice-host", "flux")[FEATURE]).toBe("voice");
  });

  it("a caller's own usage headers never survive (fluxFetch, withFluxCallHeaders)", async () => {
    let seen: Headers | undefined;
    const fake = (async (_input: string | URL | Request, init?: RequestInit) => { seen = new Headers(init?.headers); return new Response("{}"); }) as typeof fetch;
    await fluxFetch("composio-broker", "https://api.fluxrouter.ai/composio/x", { headers: { [FEATURE]: "billing", [BOT]: "spoof me" } }, fake);
    expect(seen?.get(FEATURE)).toBe("other");
    expect(seen?.get(BOT)).toBeNull();
    const merged = withFluxCallHeaders("voice-stream", { authorization: "Bearer stub", [THREAD]: "raw" });
    expect(merged[FEATURE]).toBe("voice");
    expect(merged).not.toHaveProperty(THREAD);
  });

  it("an engine overlay on a Cloud home carries the memory headers only (the launcher accepts nothing else)", () => {
    const previous = process.env.MURAGE_CLOUD_ROLE;
    process.env.MURAGE_CLOUD_ROLE = "home";
    try {
      expect(fluxCallHeaders("pip-reflection", { overlay: true, usage: { botId: "b1" } })).not.toHaveProperty(FEATURE);
      // Murage's own HTTP on a home is not an overlay: tagged
      expect(fluxCallHeaders("pip-reflection", { usage: { botId: "b1" } })[FEATURE]).toBe("memory");
    } finally {
      if (previous === undefined) delete process.env.MURAGE_CLOUD_ROLE; else process.env.MURAGE_CLOUD_ROLE = previous;
    }
  });

  it("bot email requests carry the email feature and the bot they are for", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const client = new FluxEmailClient({
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers)) });
        return new Response(JSON.stringify({ id: "m1" }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      apiBase: "https://api.fluxrouter.ai", appBase: "https://fluxrouter.ai",
      credentials: { account: () => null, owner: () => ({ token: "owner-stub", keyId: "k0" }), bot: () => ({ token: "bot-stub", keyId: "k1" }) },
    } as unknown as ConstructorParameters<typeof FluxEmailClient>[0]);
    await client.send("bot-7f3a", "inbox-1", { to: ["someone@example.com"], subject: "s", text: "t" } as never, "idem-1");
    await client.restoreInbox("inbox-1", "bot-7f3a");
    expect(seen).toHaveLength(2);
    for (const request of seen) {
      expect(request.headers[FEATURE]).toBe("email");
      expect(request.headers[BOT]).toBe("bot-7f3a");
      expect(Object.values(request.headers).join(" ")).not.toContain("someone@example.com");
    }
  });
});

describe("engine turns (Claude Code, Fuigo, Grok Build, Hermes, Qwen, OpenCode)", () => {
  const turn = { threadId: "thread-42", warmIdentity: owner };

  it("the turn decision carries bot, feature and conversation, and its signature differs per conversation", () => {
    const decision = fluxTurnDecision(turn, {}, {});
    expect(decision.headers).toMatchObject({ "x-flux-memory-app": "murage", [FEATURE]: "chat", [BOT]: owner.botId, [THREAD]: fluxThreadIdValue("thread-42") });
    expectWellFormed(decision.headers);
    expect(fluxTurnDecision({ ...turn, threadId: "thread-43" }, {}, {}).signature).not.toBe(decision.signature);
    expect(fluxTurnDecision({ ...turn, background: true, usageFeature: "routine" }, {}, {}).headers[FEATURE]).toBe("routine");
    // a malformed bot id is dropped, the rest still goes
    const odd = fluxTurnDecision({ threadId: "t", warmIdentity: { ...owner, botId: "bad id" } }, {}, {});
    expect(odd.headers).not.toHaveProperty(BOT);
    expect(odd.headers[FEATURE]).toBe("chat");
  });

  it("on a Cloud home an engine turn carries the memory decision alone", () => {
    const decision = fluxTurnDecision(turn, {}, { MURAGE_CLOUD_ROLE: "home" });
    for (const name of [FEATURE, BOT, THREAD]) expect(decision.headers).not.toHaveProperty(name);
    expect(decision.headers["x-flux-memory-app"]).toBe("murage");
  });

  it("every engine renderer puts the tags on the wire", () => {
    const headers = fluxTurnDecision(turn, {}, {}).headers;
    // Claude Code: ANTHROPIC_CUSTOM_HEADERS
    const claude = claudeCustomHeadersValue(headers);
    expect(claude).toContain(`${FEATURE}: chat`);
    expect(claude).toContain(`${BOT}: ${owner.botId}`);
    // Fuigo and Grok Build: FUIGO_CONFIG / GROK_CONFIG models.extra_headers
    expect(JSON.parse(fuigoConfigOverlay(headers)).models.extra_headers).toMatchObject({ [FEATURE]: "chat", [BOT]: owner.botId });
    // OpenCode: provider.flux.options.headers
    expect(JSON.parse(opencodeConfigOverlay("flux", headers)).provider.flux.options.headers[THREAD]).toBe(fluxThreadIdValue("thread-42"));
    // Hermes: model.extra_headers
    expect(hermesExtraHeaderLines(headers).join("\n")).toContain(`"${FEATURE}": "chat"`);
    // Qwen: model.generationConfig.customHeaders
    expect(JSON.parse(qwenSettingsJson(headers)).model.generationConfig.customHeaders[BOT]).toBe(owner.botId);
  });

  it("an inherited overlay's stale usage headers are replaced, never kept", () => {
    const stale = JSON.stringify({ models: { extra_headers: { [BOT]: "someone-else", [THREAD]: "f".repeat(32), "x-keep": "1" } } });
    const extra = JSON.parse(fuigoConfigOverlay({ "x-flux-memory-app": "murage" }, stale)).models.extra_headers;
    expect(extra).toEqual({ "x-keep": "1", "x-flux-memory-app": "murage" });
    const staleOc = JSON.stringify({ provider: { flux: { options: { headers: { [FEATURE]: "chat" } } } } });
    expect(JSON.parse(opencodeConfigOverlay("flux", { "x-flux-memory-app": "murage" }, staleOc)).provider.flux.options.headers).toEqual({ "x-flux-memory-app": "murage" });
  });
});

describe("Murage's own HTTP turns (openai-compat against Flux)", () => {
  it("each request write carries the turn's tags beside the memory headers", () => {
    const send = fluxMemorySend(fluxMemoryContextForTurn({ warmIdentity: owner }), { usage: fluxUsageHeaders(fluxUsageForTurn({ threadId: "t", warmIdentity: owner })) });
    const { headers } = fluxMemoryAtSend(send);
    expect(headers).toMatchObject({ "x-flux-memory-app": "murage", [FEATURE]: "chat", [BOT]: owner.botId });
    // a usage record cannot smuggle a memory header past the decision
    const smuggled = fluxMemoryAtSend({ ...send, usage: { ...send.usage, "x-flux-memory-capture": "on" } });
    expect(smuggled.headers["x-flux-memory-capture"]).toBe(smuggled.decision.headers["x-flux-memory-capture"]);
  });

  it("a send with no turn (a one-off helper) still names its feature: other, and no bot or conversation", () => {
    const { headers } = fluxMemoryAtSend(fluxMemorySend());
    expect(headers[FEATURE]).toBe("other");
    expect(headers[BOT]).toBeUndefined();
    expect(headers[THREAD]).toBeUndefined();
  });
});

describe("served model headers", () => {
  const read = (pairs: Record<string, string>) => readServedModel(new Headers(pairs));
  it("reads both model headers, or nothing", () => {
    expect(read({ "x-flux-routed-model": "claude-sonnet-5", "x-flux-original-model": "deepseek-v4" })).toEqual({ routed: "claude-sonnet-5", requested: "deepseek-v4" });
    expect(read({ "x-flux-routed-model": "claude-sonnet-5" })).toBeNull();
    expect(read({ "x-flux-routed-model": "has space", "x-flux-original-model": "deepseek-v4" })).toBeNull();
    expect(read({ "x-flux-routed-model": "x".repeat(200), "x-flux-original-model": "deepseek-v4" })).toBeNull();
    expect(readServedModel(null)).toBeNull();
  });
});
