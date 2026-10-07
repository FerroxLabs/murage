// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// SOCKET TEST: supervisor/build-box only. The real server, the phone's door.
//
// SPEC-X 16.1 item 12: a phone that starts cold while a bot is shared in
// `all` mode sees the bot's rows, and `sharedWith` never reaches it: not in
// the snapshot, not in a live `bot` frame, not in a replayed one. The phone
// can open a work thread (12.1) and cannot read or change sharing.
//
// The phone talks through the real device door (companion/src/proxy.ts), so
// the harness sees exactly the headers the door sends. The browser door is
// asked with the headers its own code builds (companion/src/browser.ts): it
// gets no rows.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { createProxyHandler } from "../companion/src/proxy.ts";
import { forwardedHeaders } from "../companion/src/browser.ts";
import { launchProofHeaders, needsLaunchProof } from "../companion/src/routes.ts";

const TOKEN = "c".repeat(64);
const DEVICE_BEARER = "murage_phone_bearer";
let fixture: VerificationServer;
let door: Server;
let doorUrl = "";
let desktop: Record<string, string>;
type Caller = Record<string, string> | "phone" | "browser";
/** Where a caller's request goes, and with which headers: the phone through
 * the device door; the browser with the browser door's own headers. */
const route = (method: string, path: string, caller: Caller): { url: string; headers: Record<string, string> } => {
  if (caller === "phone") return { url: doorUrl + path, headers: { authorization: `Bearer ${DEVICE_BEARER}` } };
  if (caller === "browser") {
    const bare = path.split("?")[0];
    return { url: fixture.info.url + path, headers: { ...forwardedHeaders({ headers: {} } as IncomingMessage), ...launchProofHeaders(method, bare, TOKEN), ...(needsLaunchProof(method, bare) ? { "x-murage-companion-token": TOKEN } : {}) } };
  }
  return { url: fixture.info.url + path, headers: caller };
};
const call = async (method: string, path: string, caller: Caller, body?: unknown) => {
  const target = route(method, path, caller);
  const response = await fetch(target.url, { method, headers: { "content-type": "application/json", ...target.headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};

/** Read an SSE stream until `until` holds for the frames so far, or time out. */
async function frames(path: string, caller: Caller, until: (frames: any[]) => boolean, timeout = 15000): Promise<any[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const seen: any[] = [];
  const target = route("GET", path, caller);
  try {
    const response = await fetch(target.url, { headers: target.headers, signal: controller.signal });
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = "";
    while (!until(seen)) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = block.split("\n").find(line => line.startsWith("data: "));
        if (data) seen.push({ raw: block, ...JSON.parse(data.slice(6)) });
      }
    }
  } catch (error) { if (!controller.signal.aborted) throw error; }
  finally { clearTimeout(timer); controller.abort(); }
  return seen;
}

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { portRange: { from: 47600, span: 300 }, env: { MURAGE_COMPANION_TOKEN: TOKEN } });
  const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  door = createServer(createProxyHandler({
    harnessPort: Number(new URL(fixture.info.url).port),
    companionToken: TOKEN,
    authenticate: token => token === DEVICE_BEARER ? { id: "phone-1", cloudDesktopAccess: false } : null,
    redeem: () => ({ error: "not used here" }),
    serverName: () => "Test computer",
  }));
  await new Promise<void>(resolve => door.listen(0, "127.0.0.1", () => resolve()));
  doorUrl = `http://127.0.0.1:${(door.address() as { port: number }).port}`;
}, 30000);
afterAll(async () => { await new Promise(resolve => door ? door.close(resolve) : resolve(undefined)); await fixture?.close(); });

it("SOCKET 16.1 #12: a cold-start phone in all mode sees rows, never sharedWith, in the snapshot, live frames and replay", async () => {
  for (const bot of (await call("GET", "/api/bots?messages=0", desktop)).body.bots) await call("PATCH", `/api/bots/${bot.id}`, desktop, { hidden: true });
  const make = async (name: string, section: string) => {
    const made = await call("POST", "/api/bots", desktop, { name }); expect(made.status).toBe(201);
    expect((await call("PATCH", `/api/bots/${made.body.bot.id}`, desktop, { section })).status).toBe(200);
    return made.body.bot as { id: string; threadId: string };
  };
  const iris = await make("Iris", "Design"); await make("Sam", "Sales"); await make("Tia", "Support");
  const shared = await call("PATCH", `/api/bots/${iris.id}/sharing`, desktop, { mode: "all" });
  expect(shared.status).toBe(200);

  // the desktop wire bot carries both fields
  const onDesk = (await call("GET", "/api/bots?messages=0", desktop)).body.bots.find((b: any) => b.id === iris.id);
  expect(onDesk.sharedWith).toEqual({ mode: "all", teams: [] });
  expect(onDesk.partitionedAt).toBeTypeOf("number");

  // cold start on the phone: before any work thread exists
  const hello = await frames("/api/events", "phone", seen => seen.some(frame => frame.kind === "hello"));
  const cursor = hello.find(frame => frame.kind === "hello").cursor as string;
  const snapshot = await call("GET", "/api/bots?messages=0", "phone");
  expect(snapshot.status).toBe(200);
  expect(snapshot.text).not.toContain("sharedWith");
  expect(snapshot.text).not.toContain("partitionedAt");
  const onPhone = snapshot.body.bots.find((b: any) => b.id === iris.id);
  expect(onPhone.shared).toBe(true);
  expect(onPhone.sharedRows.map((row: any) => [row.teamName, row.threadId])).toEqual([["Sales", null], ["Support", null]]);
  // no team was named in sharing yet, so nothing minted an identity on a read
  expect(onPhone.sharedRows.map((row: any) => row.teamId)).toEqual([null, null]);

  // the browser door is not the owner phone: the same reads carry no rows
  const inBrowser = await call("GET", "/api/bots?messages=0", "browser");
  expect(inBrowser.status).toBe(200);
  expect(inBrowser.text).not.toContain("sharedWith");
  expect(inBrowser.body.bots.find((b: any) => b.id === iris.id)).toMatchObject({ shared: true, sharedRows: [] });

  // a live bot frame while the phone listens
  const live = frames("/api/events", "phone", seen => seen.some(frame => frame.kind === "bot" && frame.bot?.id === iris.id && frame.bot.name === "Iris R"));
  await new Promise(resolve => setTimeout(resolve, 500));
  expect((await call("PATCH", `/api/bots/${iris.id}`, desktop, { name: "Iris R" })).status).toBe(200);
  const liveFrame = (await live).find(frame => frame.kind === "bot" && frame.bot?.id === iris.id && frame.bot.name === "Iris R");
  expect(liveFrame).toBeDefined();
  expect(liveFrame.raw).not.toContain("sharedWith");
  expect(liveFrame.raw).not.toContain("partitionedAt");
  expect(liveFrame.bot.sharedRows.map((row: any) => row.teamName)).toEqual(["Sales", "Support"]);

  // the same frame replayed to a phone that reconnects with its cursor
  const replay = await frames(`/api/events?since=${encodeURIComponent(cursor)}`, "phone", seen => seen.some(frame => frame.kind === "bot" && frame.bot?.id === iris.id && frame.bot.name === "Iris R"));
  const replayed = replay.filter(frame => frame.kind === "bot" && frame.bot?.id === iris.id);
  expect(replayed.length).toBeGreaterThan(0);
  for (const frame of replayed) { expect(frame.raw).not.toContain("sharedWith"); expect(frame.raw).not.toContain("partitionedAt"); }
  // the desktop's own stream still carries the owner-only field
  const deskReplay = await frames(`/api/events?since=${encodeURIComponent(cursor)}&surface=desktop&surfaceSecret=${desktop["x-murage-surface-secret"]}`, {}, seen => seen.some(frame => frame.kind === "bot" && frame.bot?.id === iris.id && frame.bot.name === "Iris R"));
  expect(deskReplay.find(frame => frame.kind === "bot" && frame.bot?.id === iris.id).bot.sharedWith).toEqual({ mode: "all", teams: [] });

  // the phone opens the Sales work thread and its row now names it
  const sales = onPhone.sharedRows.find((row: any) => row.teamName === "Sales");
  const opened = await call("POST", `/api/bots/${iris.id}/work-threads`, "phone", { teamName: sales.teamName });
  expect(opened.status).toBe(200);
  const after = (await call("GET", "/api/bots?messages=0", "phone")).body.bots.find((b: any) => b.id === iris.id);
  const salesRow = after.sharedRows.find((row: any) => row.teamName === "Sales");
  expect(salesRow.teamId).toMatch(/^[\w-]+$/);
  expect(salesRow.threadId).toBe(opened.body.threadId);
  expect(after.tasks.find((task: any) => task.threadId === opened.body.threadId)).toMatchObject({ title: "Iris R · work for Sales", sharedWork: { teamId: salesRow.teamId, teamName: "Sales" } });
  expect((await call("POST", `/api/bots/${iris.id}/work-threads`, "phone", { teamId: salesRow.teamId })).body.threadId).toBe(opened.body.threadId);

  // the phone cannot read or change sharing, notes, skills or copies
  for (const [method, path] of [["GET", "sharing"], ["PATCH", "sharing"], ["POST", "sharing/skills"], ["POST", "sharing/copy"], ["GET", "general-notes"], ["PUT", "general-notes"]])
    expect((await call(method, `/api/bots/${iris.id}/${path}`, "phone", method === "GET" ? undefined : {})).status, `${method} ${path}`).not.toBe(200);

  // a caller that proved nothing learns the bot is shared, and gets no rows
  const unproven = await call("GET", "/api/bots?messages=0", {});
  expect(unproven.text).not.toContain("sharedWith");
  expect(unproven.body.bots.find((b: any) => b.id === iris.id)).toMatchObject({ shared: true, sharedRows: [] });
  expect((await call("POST", `/api/bots/${iris.id}/work-threads`, {}, { teamId: salesRow.teamId })).status).not.toBe(200);
}, 120000);
