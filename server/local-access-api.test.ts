// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane S1b: the local-access gaps left after the conversation gate, on a real
// server (fake engine, throwaway data folder, its own port). Every case asserts
// that the data is absent from the BODY, not only that the status is a 404:
//  - an archived room looks missing to the phone and the browser door, until
//    the owner unarchives it (audit C1);
//  - a saved image is shown to a remote caller only while a conversation that
//    caller can see owns it (audit C4);
//  - a script's scoped grant reaches one bot and nothing else (audit C9 and
//    the mcp-access.token finding).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const posixOnly = describe.skipIf(process.platform === "win32");
const COMPANION_TOKEN = "c".repeat(64);
const door = { "x-murage-door-token": COMPANION_TOKEN };
const phone = { "x-murage-companion": "1", "x-murage-companion-token": COMPANION_TOKEN };
/** The suite stamps the door secret on every loopback fetch; this says "nobody". */
const bare = { "x-test-bare-loopback": "1" };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

let fixture: VerificationServer;
let desktop: Record<string, string>;
const url = (path: string) => `${fixture.info.url}${path}`;

async function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const response = await fetch(url(path), {
    method,
    signal: AbortSignal.timeout(10000),
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString("utf8");
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body: json, text, bytes };
}

async function newBot(name: string): Promise<{ id: string; threadId: string }> {
  const made = await call("POST", "/api/bots", desktop, { name });
  expect(made.status).toBe(201);
  return (made.body as { bot: { id: string; threadId: string } }).bot;
}

posixOnly("local access: archived rooms, saved images and script grants", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { env: { MURAGE_COMPANION_TOKEN: COMPANION_TOKEN } });
    const secret = (await (await fetch(url("/api/desktop-secret"))).json() as { secret: string }).secret;
    desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("an archived room is missing to the phone and the door in the list, transcript, export and image routes, and comes back when unarchived", async () => {
    const member = await newBot("Roomie");
    const made = await call("POST", "/api/groups", desktop, { name: "Quiet room", memberIds: [member.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: member.id } } });
    expect(made.status, made.text).toBeLessThan(300);
    const room = (made.body as { group: { id: string; threadId: string } }).group;
    const canary = "ARCHIVED_ROOM_CANARY";
    await call("POST", `/api/groups/${room.id}/messages`, desktop, { text: `note ${canary}` });
    const seen = async (headers: Record<string, string>) => {
      const list = await call("GET", "/api/bots?messages=50", { ...bare, ...headers });
      const messages = await call("GET", `/api/threads/${room.threadId}/messages`, { ...bare, ...headers });
      const exported = await call("GET", `/api/threads/${room.threadId}/export`, { ...bare, ...headers });
      return { list, messages, exported };
    };
    for (const headers of [door, phone]) {
      const open = await seen(headers);
      expect(open.list.text).toContain(canary);
      expect(open.messages.status).toBe(200);
    }
    // the room is archived once its turn is over
    let archived = 409;
    for (const started = Date.now(); archived === 409 && Date.now() - started < 30000; await new Promise(resolve => setTimeout(resolve, 200))) {
      archived = (await call("PATCH", `/api/groups/${room.id}`, desktop, { hidden: true })).status;
    }
    expect(archived).toBeLessThan(300);
    for (const headers of [door, phone]) {
      const closed = await seen(headers);
      expect(closed.list.status).toBe(200);
      expect(closed.list.text).not.toContain(canary);
      expect(closed.list.text).not.toContain(room.id);
      expect(closed.messages.status).toBe(404);
      expect(closed.messages.text).not.toContain(canary);
      expect(closed.exported.status).toBe(404);
      expect(closed.exported.text).not.toContain(canary);
      expect((await call("GET", `/api/search?q=${canary}`, { ...bare, ...headers })).text).not.toContain(canary);
      expect((await call("POST", `/api/groups/${room.id}/messages`, { ...bare, ...headers }, { text: "hello" })).status).toBe(404);
    }
    // the desktop still opens it
    expect((await seen(desktop)).list.text).toContain(canary);
    expect((await call("PATCH", `/api/groups/${room.id}`, desktop, { hidden: false })).status).toBeLessThan(300);
    expect((await seen(door)).messages.text).toContain(canary);
  }, 60000);

  it("a saved image is shown to the phone only while a conversation it can see owns it; the body never carries the pixels otherwise", async () => {
    const bot = await newBot("Pictures");
    const saved = await fetch(url("/api/attachments"), { method: "POST", headers: { "content-type": "image/png", ...desktop }, body: PNG });
    expect(saved.status).toBe(201);
    const name = (((await saved.json()) as { path: string }).path).split(/[\\/]/).pop()!;
    await call("POST", `/api/bots/${bot.id}/messages`, desktop, { text: `look ![pic](/api/attachments/${name})` });
    const fetchAs = (headers: Record<string, string>) => call("GET", `/api/attachments/${name}`, { ...bare, ...headers });
    // a visible bot owns it: every proven caller sees it
    for (const headers of [desktop, door, phone]) {
      const shown = await fetchAs(headers);
      expect(shown.status).toBe(200);
      expect(shown.bytes.equals(PNG)).toBe(true);
    }
    // no proof at all learns nothing
    const nobody = await fetchAs({});
    expect(nobody.status).toBe(404);
    expect(nobody.bytes.includes(PNG)).toBe(false);
    // hide the bot: the desktop still sees it, a remote caller gets the missing-image answer
    await call("PATCH", `/api/bots/${bot.id}`, desktop, { hidden: true });
    expect((await fetchAs(desktop)).bytes.equals(PNG)).toBe(true);
    for (const headers of [door, phone]) {
      const hidden = await fetchAs(headers);
      expect(hidden.status).toBe(404);
      expect(hidden.body).toEqual({ error: "no such attachment" });
      expect(hidden.bytes.includes(PNG)).toBe(false);
      // a resized request is the same route
      expect((await call("GET", `/api/attachments/${name}?w=64`, { ...bare, ...headers })).status).toBe(404);
    }
    // unhide: it is back
    await call("PATCH", `/api/bots/${bot.id}`, desktop, { hidden: false });
    expect((await fetchAs(door)).bytes.equals(PNG)).toBe(true);
  }, 60000);

  it("archiving a room tells a connected phone to drop it, and the desktop stream is not told (S1b R4)", async () => {
    const member = await newBot("StreamRoomie");
    const made = await call("POST", "/api/groups", desktop, { name: "Stream room", memberIds: [member.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: member.id } } });
    const room = (made.body as { group: { id: string } }).group;
    const open = async (headers: Record<string, string>) => {
      const abort = new AbortController();
      const response = await fetch(url("/api/events"), { headers: { accept: "text/event-stream", ...headers }, signal: abort.signal });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let seen = "";
      const pump = (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) return; seen += decoder.decode(value); } } catch { /* aborted */ } })();
      return { frames: () => seen, close: async () => { abort.abort(); await pump; } };
    };
    const waitFor = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await new Promise(r => setTimeout(r, 50)); };
    const phoneStream = await open({ ...bare, ...phone });
    const desktopStream = await open(desktop);
    try {
      expect((await call("PATCH", `/api/groups/${room.id}`, desktop, { hidden: true })).status).toBe(200);
      const removal = `"kind":"group.deleted","groupId":"${room.id}"`;
      await waitFor(() => phoneStream.frames().includes(removal));
      expect(phoneStream.frames()).toContain(removal);
      // The archived room's own group frame stays off the phone's stream.
      expect(phoneStream.frames()).not.toContain(`"id":"${room.id}","name":"Stream room"`);
      // the desktop keeps showing archived rooms: it gets the group frame and no removal
      await waitFor(() => desktopStream.frames().includes(`"group":{"id":"${room.id}"`));
      expect(desktopStream.frames()).not.toContain(removal);
    } finally {
      await phoneStream.close();
      await desktopStream.close();
    }
  }, 60000);

  it("the grant list never names a hidden bot to the phone or the door (S1c review)", async () => {
    const bot = await newBot("GrantListBot");
    const made = await call("POST", "/api/mcp-grants", desktop, { botId: bot.id });
    expect(made.status, made.text).toBe(201);
    expect((await call("GET", "/api/mcp-grants", { ...bare, ...phone })).text).toContain("GrantListBot");
    await call("PATCH", `/api/bots/${bot.id}`, desktop, { hidden: true });
    expect((await call("GET", "/api/mcp-grants", { ...bare, ...phone })).text).not.toContain("GrantListBot");
    expect((await call("GET", "/api/mcp-grants", desktop)).text).toContain("GrantListBot");
  }, 60000);

  it("an image nothing mentions yet is shown only to the surface that uploaded it", async () => {
    const fromPhone = await fetch(url("/api/attachments"), { method: "POST", headers: { "content-type": "image/png", ...bare, ...phone }, body: PNG });
    expect(fromPhone.status).toBe(201);
    const mine = (((await fromPhone.json()) as { path: string }).path).split(/[\\/]/).pop()!;
    const fromDesktop = await fetch(url("/api/attachments"), { method: "POST", headers: { "content-type": "image/png", ...desktop }, body: Buffer.concat([PNG, Buffer.from("\u0000")]) });
    const theirs = (((await fromDesktop.json()) as { path: string }).path).split(/[\\/]/).pop()!;
    expect(mine).not.toBe(theirs);
    expect((await call("GET", `/api/attachments/${mine}`, { ...bare, ...phone })).status).toBe(200);
    const other = await call("GET", `/api/attachments/${theirs}`, { ...bare, ...phone });
    expect(other.status).toBe(404);
    expect(other.bytes.includes(PNG)).toBe(false);
    expect((await call("GET", `/api/attachments/${theirs}`, desktop)).status).toBe(200);
  });

  it("a script's grant reaches one bot: its transcript, and sends only when allowed; the fleet, other bots, rooms, search and settings stay missing", async () => {
    const mine = await newBot("GrantedBot");
    const other = await newBot("OtherBotCanary");
    const room = ((await call("POST", "/api/groups", desktop, { name: "RoomCanary", memberIds: [other.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: other.id } } })).body as { group: { id: string; threadId: string } }).group;
    await call("POST", `/api/bots/${other.id}/messages`, desktop, { text: "private OTHER_TRANSCRIPT_CANARY" });
    await call("POST", `/api/bots/${mine.id}/messages`, desktop, { text: "my GRANTED_TRANSCRIPT_MARK" });

    // only the owner's surfaces make or list a grant
    expect((await call("POST", "/api/mcp-grants", { ...bare, ...door }, { botId: mine.id })).status).toBe(404);
    expect((await call("POST", "/api/mcp-grants", bare, { botId: mine.id })).status).toBe(404);
    const hiddenBot = await newBot("HiddenOne");
    await call("PATCH", `/api/bots/${hiddenBot.id}`, desktop, { hidden: true });
    expect((await call("POST", "/api/mcp-grants", desktop, { botId: hiddenBot.id })).status).toBe(404);
    expect((await call("POST", "/api/mcp-grants", desktop, { botId: "no-such-bot" })).status).toBe(404);

    const readOnly = await call("POST", "/api/mcp-grants", desktop, { botId: mine.id });
    expect(readOnly.status, readOnly.text).toBe(201);
    const readToken = (readOnly.body as { token: string }).token;
    expect(readToken).toMatch(/^mcpg_[a-f0-9]{64}$/);
    // the file in the data folder holds a hash, never the token
    const stored = readFileSync(join(fixture.info.dataDir, "mcp-grants.json"), "utf8");
    expect(stored).not.toContain(readToken);
    expect(stored).not.toContain(readToken.slice(5));
    expect((await call("GET", "/api/mcp-grants", desktop)).text).not.toContain(readToken);

    const as = (token: string) => ({ ...bare, authorization: `Bearer ${token}` });
    const list = await call("GET", "/api/bots?messages=50", as(readToken));
    expect(list.status).toBe(200);
    expect(list.text).toContain("GRANTED_TRANSCRIPT_MARK");
    for (const absent of ["OtherBotCanary", "OTHER_TRANSCRIPT_CANARY", "RoomCanary", other.id, room.id]) expect(list.text, absent).not.toContain(absent);
    expect((list.body as { groups: unknown[] }).groups).toEqual([]);
    expect((await call("GET", `/api/threads/${mine.threadId}/messages`, as(readToken))).text).toContain("GRANTED_TRANSCRIPT_MARK");
    for (const path of [`/api/threads/${other.threadId}/messages`, `/api/threads/${room.threadId}/messages`, `/api/threads/${other.threadId}/export`]) {
      const refused = await call("GET", path, as(readToken));
      expect(refused.status, path).toBe(404);
      expect(refused.text, path).not.toContain("OTHER_TRANSCRIPT_CANARY");
    }
    for (const path of ["/api/search?q=CANARY", "/api/events", "/api/config", "/api/instances", "/api/inbox", "/api/routines", "/api/mcp-grants", "/api/decisions"]) {
      const refused = await call("GET", path, as(readToken));
      expect(refused.status, path).toBe(404);
      expect(refused.body, path).toEqual({ error: "no such route" });
    }
    // read-only: no send, no interrupt, and never another bot
    expect((await call("POST", `/api/bots/${mine.id}/messages`, as(readToken), { text: "hello" })).status).toBe(404);
    expect((await call("POST", `/api/bots/${mine.id}/interrupt`, as(readToken), {})).status).toBe(404);
    expect((await call("POST", `/api/bots/${other.id}/messages`, as(readToken), { text: "hello" })).status).toBe(404);
    expect((await call("PATCH", `/api/bots/${mine.id}`, as(readToken), { name: "Renamed" })).status).toBe(404);
    expect((await call("POST", "/api/bots", as(readToken), { name: "Made by a script" })).status).toBe(404);
    expect((await call("GET", "/api/bots?messages=0", as(`mcpg_${"0".repeat(64)}`))).status).toBe(404);

    // a grant that may send reaches only its own bot, and the words are unproven
    const sender = await call("POST", "/api/mcp-grants", desktop, { botId: mine.id, send: true });
    const sendToken = (sender.body as { token: string; id: string }).token;
    const sendId = (sender.body as { id: string }).id;
    expect((await call("POST", `/api/bots/${mine.id}/messages`, as(sendToken), { text: "from a script" })).status).toBeLessThan(300);
    const after = await call("GET", `/api/threads/${mine.threadId}/messages`, desktop);
    expect(after.text).toContain("from a script");
    expect((await call("POST", `/api/bots/${other.id}/messages`, as(sendToken), { text: "nope" })).status).toBe(404);
    expect((await call("GET", `/api/threads/${other.threadId}/messages`, desktop)).text).not.toContain("nope");

    // switching it off ends it; hiding the bot ends it too
    expect((await call("DELETE", `/api/mcp-grants/${sendId}`, desktop)).status).toBe(200);
    expect((await call("GET", "/api/bots?messages=0", as(sendToken))).status).toBe(404);
    await call("PATCH", `/api/bots/${mine.id}`, desktop, { hidden: true });
    const gone = await call("GET", `/api/threads/${mine.threadId}/messages`, as(readToken));
    expect(gone.status).toBe(404);
    expect(gone.text).not.toContain("GRANTED_TRANSCRIPT_MARK");
  }, 90000);
});
