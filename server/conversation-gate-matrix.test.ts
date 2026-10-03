// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

/** Every conversation route against every kind of caller, at the real harness
 * boundary. Before the gate, a request with no proof was served what a phone
 * sees: every visible transcript, the search index and the live stream, plus
 * sends and interrupts. */
const COMPANION_TOKEN = "c".repeat(64);
const WRONG_TOKEN = "d".repeat(64);
let fixture: VerificationServer;
let desktopSecret = "";
let botId = "";
let threadId = "";
let groupId = "";
let hiddenId = "";
let hiddenThread = "";
let botToken = "";

const NO_ROUTE = { error: "no such route" };

type Caller = "none" | "marker-only" | "wrong-desktop-secret" | "wrong-companion-token" | "companion-marker-only" | "bot-token" | "desktop" | "companion";
const callers = (): Record<Caller, Record<string, string>> => ({
  none: {},
  "marker-only": { "x-murage-surface": "desktop" },
  "wrong-desktop-secret": { "x-murage-surface": "desktop", "x-murage-surface-secret": "f".repeat(64) },
  "wrong-companion-token": { "x-murage-companion": "1", "x-murage-companion-token": WRONG_TOKEN },
  "companion-marker-only": { "x-murage-companion": "1" },
  "bot-token": { authorization: `Bearer ${botToken}` },
  desktop: { "x-murage-surface": "desktop", "x-murage-surface-secret": desktopSecret },
  companion: { "x-murage-companion": "1", "x-murage-companion-token": COMPANION_TOKEN },
});
const DENIED: Caller[] = ["none", "marker-only", "wrong-desktop-secret", "wrong-companion-token", "companion-marker-only", "bot-token"];
const ADMITTED: Caller[] = ["desktop", "companion"];

async function call(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const controller = new AbortController();
  const response = await fetch(`${fixture.info.url}${path}`, {
    method, signal: controller.signal,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // The live stream never ends on its own: status and headers are the answer.
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    controller.abort();
    return { status: response.status, body: null as Record<string, any> | null };
  }
  return { status: response.status, body: await response.json().catch(() => null) as Record<string, any> | null };
}

const desktopCall = (method: string, path: string, body?: unknown) => call(method, path, callers().desktop, body);

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { env: { MURAGE_COMPANION_TOKEN: COMPANION_TOKEN } });
  const secret = await call("GET", "/api/desktop-secret", {});
  expect(secret.status).toBe(200);
  desktopSecret = String(secret.body!.secret);
  const first = await desktopCall("POST", "/api/bots", { name: "Gate fixture A" });
  const second = await desktopCall("POST", "/api/bots", { name: "Gate fixture B" });
  const hidden = await desktopCall("POST", "/api/bots", { name: "Gate fixture hidden" });
  expect([first.status, second.status, hidden.status]).toEqual([201, 201, 201]);
  botId = first.body!.bot.id; threadId = first.body!.bot.threadId;
  hiddenId = hidden.body!.bot.id; hiddenThread = hidden.body!.bot.threadId;
  const room = await desktopCall("POST", "/api/groups", { name: "Gate room", memberIds: [botId, second.body!.bot.id], setup: { bulletin: "Fixture only", defaultResponder: { kind: "mentions" } } });
  expect(room.status).toBe(201);
  groupId = room.body!.group.id;
  expect((await desktopCall("PATCH", `/api/bots/${hiddenId}`, { hidden: true })).status).toBe(200);
  // A real bot capability token, from a live fixture turn.
  rmSync(fixture.fixtureDumpPath, { force: true });
  expect((await desktopCall("POST", `/api/bots/${botId}/messages`, { text: "__fixture_hold_authority__", threadId })).status).toBe(202);
  for (const deadline = Date.now() + 15_000; !botToken && Date.now() < deadline;) {
    try { botToken = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN; }
    catch { await new Promise((resolve) => setTimeout(resolve, 150)); }
  }
  expect(botToken).toMatch(/^[a-f0-9]{48}$/);
});

afterAll(async () => { await fixture?.close(); });

const ROUTES: Array<[string, string, () => string, unknown?]> = [
  ["GET", "bot list", () => "/api/bots"],
  ["GET", "bot list, no messages", () => "/api/bots?messages=0"],
  ["POST", "create a bot", () => "/api/bots", { name: "Gate matrix bot" }],
  ["GET", "a bot's transcript", () => `/api/threads/${threadId}/messages?limit=5`],
  ["GET", "a transcript export", () => `/api/threads/${threadId}/export?format=markdown`],
  ["GET", "search", () => "/api/search?q=fixture"],
  ["GET", "the live event stream", () => "/api/events"],
  ["POST", "send to a bot", () => `/api/bots/${botId}/messages`, { text: "matrix send", threadId }],
  ["POST", "stop a bot", () => `/api/bots/${botId}/interrupt`, {}],
  ["POST", "send to a room", () => `/api/groups/${groupId}/messages`, { text: "matrix room send" }],
  ["POST", "stop a room", () => `/api/groups/${groupId}/interrupt`, {}],
  ["POST", "answer a card", () => `/api/threads/${threadId}/respond`, { requestId: "none", behavior: "deny" }],
];

describe("conversation routes by caller", () => {
  describe.each(ROUTES)("%s %s", (method, _label, path, body) => {
    it.each(DENIED)("answers a caller with %s as an unknown route", async (who) => {
      const result = await call(method, path(), callers()[who], body);
      expect(result.status).toBe(404);
      expect(result.body).toEqual(NO_ROUTE);
    });
    it.each(ADMITTED)("lets the %s through", async (who) => {
      const result = await call(method, path(), callers()[who], body);
      expect(result.body).not.toEqual(NO_ROUTE);
      expect([200, 201, 202, 400, 404, 409]).toContain(result.status);
      if (method === "GET") expect(result.status).toBe(200);
    });
  });

  it("takes the desktop proof in the query form the event stream needs", async () => {
    const query = `surface=desktop&surfaceSecret=${desktopSecret}`;
    expect((await call("GET", `/api/events?${query}`, {})).status).toBe(200);
    expect((await call("GET", `/api/events?surface=desktop&surfaceSecret=${"f".repeat(64)}`, {})).status).toBe(404);
    expect((await call("GET", "/api/events?surface=desktop", {})).status).toBe(404);
  });

  it("does not let a bot's capability token read or steer a conversation, and still serves the bot its own routes", async () => {
    const token = { authorization: `Bearer ${botToken}`, "content-type": "application/json" };
    for (const [method, path, body] of [
      ["GET", "/api/bots", undefined], ["GET", `/api/threads/${threadId}/messages`, undefined], ["GET", "/api/search?q=a", undefined],
      ["POST", `/api/bots/${botId}/messages`, { text: "from a bot shell" }], ["POST", `/api/bots/${botId}/interrupt`, {}],
    ] as const) {
      const result = await call(method, path, token, body);
      expect([method, path, result.status, result.body]).toEqual([method, path, 404, NO_ROUTE]);
    }
    const own = await call("GET", `/api/internal/agents?self=${botId}`, token);
    expect(own.body).not.toEqual(NO_ROUTE);
  });

  it("holds the paired phone to what its sidebar shows: a hidden bot cannot be read, messaged or stopped", async () => {
    const phone = callers().companion;
    for (const [method, path, missingPath, body] of [
      ["GET", `/api/threads/${hiddenThread}/messages`, "/api/threads/no-such-thread/messages", undefined],
      ["GET", `/api/threads/${hiddenThread}/export?format=markdown`, "/api/threads/no-such-thread/export?format=markdown", undefined],
      ["POST", `/api/bots/${hiddenId}/messages`, "/api/bots/no-such-bot/messages", { text: "phone to hidden", threadId: hiddenThread }],
      ["POST", `/api/bots/${hiddenId}/interrupt`, "/api/bots/no-such-bot/interrupt", {}],
    ] as const) {
      // a hidden bot answers exactly as a bot that does not exist
      const result = await call(method, path, phone, body);
      const missing = await call(method, missingPath, phone, body);
      expect([method, path, result.status], JSON.stringify(result.body)).toEqual([method, path, 404]);
      expect(result.body, `${method} ${path}`).toEqual(missing.body);
    }
    const list = await call("GET", "/api/bots?messages=0", phone);
    expect(list.body!.bots.map((bot: { id: string }) => bot.id)).not.toContain(hiddenId);
    // The desktop still reaches the same bot.
    expect((await desktopCall("POST", `/api/bots/${hiddenId}/messages`, { text: "desktop to hidden", threadId: hiddenThread })).status).toBe(202);
    expect((await desktopCall("POST", `/api/bots/${hiddenId}/interrupt`, {})).status).toBe(200);
  });

  it("leaves routes outside the conversation family alone", async () => {
    expect((await call("GET", "/api/health", {})).status).toBe(200);
    expect((await call("GET", "/api/instances", {})).body).not.toEqual(NO_ROUTE);
  });
});
