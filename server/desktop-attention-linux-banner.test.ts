// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOTIFY-EVERYWHERE-1019 S4c against the real server over real HTTP: attention read -> Linux banner -> token mint -> D-Bus callback ->
// POST -> the server's live checks. Owners: the Linux banner client (electron/linux-notify.mjs) = o1019-nfy-native-linux; the server
// binding fields and the answerOutside check = o1019-nfy-native-mac; the banner-linux envelope and its flip = MAIN + the S0 operator.
// Real here: the server, the fake ACP agent's card, the local transport, the action authority and the Linux banner client. Fake: the
// session bus (no notification daemon in a headless container). The mint mapping repeats mintBanner in electron/main.mjs.
//
// HEADLESS ONLY: the data directory is a throwaway temp HOME and the port is probed from the fixture band.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionBoundAcpPermissionEnvironment } from "./testing/acp-permission-fixture.ts";
import { fixtureDisplayApi } from "./testing/display-fixture.ts";
import { makeTestHome, removeTempDir } from "./testing/cleanup.ts";
import { fixturePlatformEnv, stopFixtureServer } from "./testing/platform-fixtures.ts";
import { assertSafeToWipe } from "./testing/safe-wipe.mjs";
import { freePortBlock } from "./testing/ports.ts";
import { fakeEngineImportArgs, powerBlockTestEnv } from "./testing/power-block-test.ts";

import { EventEmitter } from "node:events";
// @ts-expect-error Native ESM has no declaration file.
import { createAttentionActions } from "../electron/attention-actions.mjs";
// @ts-expect-error Native ESM has no declaration file.
import { createLocalTransport } from "../electron/attention-transport.mjs";
// @ts-expect-error Native ESM has no declaration file.
import { createLinuxBanners } from "../electron/linux-notify.mjs";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const COMPANION_TOKEN = "c".repeat(64); // the suite's launch secret (server/testing/setup.ts)

let base: string;
let desktopHeaders: Record<string, string>;
let child: ChildProcess;
let home: string;
let stderr = "";

const wireRequest = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const displayRequest = fixtureDisplayApi(() => join(home, ".murage", "messages.db"), wireRequest);
// Outside answers have their own native-id grammar; only in-app answers use display handles.
const request: typeof wireRequest = (method, path, body, headers) =>
  (body && typeof body === "object" && "outside" in body ? wireRequest : displayRequest)(method, path, body, headers);
const desktopApi = (method: string, path: string, body?: unknown) => request(method, path, body, desktopHeaders);
const threadMessages = async (threadId: string) => ((await desktopApi("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as any[];
const cardById = async (threadId: string, requestId: string) => (await threadMessages(threadId)).find((m) => m.card?.requestId === requestId)?.card;
const liveCard = async (threadId: string) => (await threadMessages(threadId)).find((m) => m.card?.requestId && m.card?.answered === undefined && !m.card?.dismissed) ?? null;
async function poll<T>(read: () => Promise<T | null>, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}


/** A bot in Ask mode waiting on an ordinary card. */
async function askedBot(name: string) {
  const created = await desktopApi("POST", "/api/bots", { name, modelSelection: { instanceId: "echoer", model: "fake-model" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  expect((await desktopApi("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { autoApprove: false })).status).toBe(200);
  expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "say hi" })).status).toBe(202);
  const card = await poll(() => liveCard(bot.threadId), 60_000);
  expect(card, `Ask mode raised no card. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
  return { bot, requestId: card.card.requestId as string, messageId: card.id as string };
}
const SURFACE = "banner-linux";
const BINDING = ["approvalId", "requestRef", "actionHash"] as const;
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

/** The desktop side as main wires it, with a fake session bus in place of the notification daemon. `flipped` stands in for the day the
 *  banner-linux envelope is filled: it marks that one surface answerable in what the DESKTOP reads. The server is never told. */
function desktop({ flipped }: { flipped: boolean }) {
  const sent: { url: string; method: string; body: any; status: number }[] = [];
  const posted: any[][] = [], closed: number[] = [], opened: any[] = [], refusals: string[] = [];
  let connections = 0;
  const fetchImpl = async (url: string, init: any = {}) => {
    const res = await fetch(url, init);
    sent.push({ url: url.slice(base.length), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined, status: res.status });
    return res;
  };
  const real = createLocalTransport({ origin: base, secret: desktopHeaders["x-murage-surface-secret"], fetchImpl: fetchImpl as typeof fetch, identity: () => "port|run|owner" });
  const transport = !flipped ? real : { ...real, readCard: async (entry: any, guard: () => void) => { const card: any = await real.readCard(entry, guard); return { ...card, outsideOk: { ...card.outsideOk, [SURFACE]: true } }; } };
  const actions = createAttentionActions({ lock: { locked: () => false }, onRefuse: (_entry: unknown, reason: string) => { refusals.push(reason); } });
  const iface: any = new EventEmitter();
  iface.GetCapabilities = async () => ["actions", "body", "body-markup"];
  iface.GetServerInformation = async () => ["gnome-shell", "GNOME", "46.0", "1.2"];
  iface.Notify = async (...args: any[]) => { posted.push(args); return posted.length; };
  iface.CloseNotification = async (id: number) => { closed.push(id); };
  const names: any = new EventEmitter();
  names.GetNameOwner = async () => ":1.42";
  const minted: any[] = [];
  const banners = createLinuxBanners({
    platform: "linux",
    loadBus: () => { connections += 1; const bus: any = new EventEmitter(); bus.getProxyObject = async (name: string) => ({ getInterface: () => (name === "org.freedesktop.DBus" ? names : iface) }); bus.disconnect = () => {}; return bus; },
    mint: ({ entry, surface, surfaceId, digest, transport: captured, identity }: any) => {
      const spec = { approvalId: entry.frame.approvalId, requestRef: entry.frame.requestRef, actionHash: entry.frame.actionHash, home: entry.home, epoch: entry.epoch, threadId: entry.frame.threadId, messageId: entry.frame.messageId, requestId: entry.frame.requestId, digest, surface, surfaceId, identity, transport: captured };
      minted.push(spec);
      return actions.mint(spec);
    },
    act: (token: string, action: string, text?: string) => actions.act(token, action, text),
    open: (route: unknown) => { opened.push(route); },
  });
  /** Read the card the way main does, then offer it to the banner. */
  const show = async (asked: { bot: { id: string; threadId: string }; requestId: string; messageId: string }) => {
    const entry = { home: "local", epoch: "e1", frame: { kind: "approval", botId: asked.bot.id, threadId: asked.bot.threadId, messageId: asked.messageId, requestId: asked.requestId } };
    const record: any = await transport.readCard({ threadId: asked.bot.threadId, messageId: asked.messageId }, () => {});
    const ids = await banners.show({ entry, record, actionsOn: true, transport, identity: transport.current() } as any);
    return { ids, record };
  };
  return { show, banners, iface, sent, posted, closed, opened, refusals, minted, connections: () => connections, posts: () => sent.filter((row) => row.method === "POST") };
}

describe("Linux banner against the live server (NOTIFY-EVERYWHERE-1019 S4c)", { timeout: 150_000 }, () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1], 19_199, 200);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLI, 0o755);
    home = makeTestHome("murage-linux-banner-");
    expect(() => assertSafeToWipe(home)).not.toThrow();
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ instances: { echoer: { driver: "grokAgent", environment: sessionBoundAcpPermissionEnvironment({ FAKE_ACP_MODE: "permission" }), config: { cli: FAKE_CLI, fullAuto: false } } } }));
    child = spawn(process.execPath, [...fakeEngineImportArgs(), join(SERVER_DIR, "index.ts")], {
      windowsHide: true,
      cwd: join(SERVER_DIR, ".."),
      env: { ...fixturePlatformEnv(), ...powerBlockTestEnv(), ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_COMPANION_TOKEN: COMPANION_TOKEN },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 150_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    const proof = await request("GET", "/api/desktop-secret");
    expect(proof.status).toBe(200);
    desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  }, 180_000);

  afterAll(async () => {
    await stopFixtureServer(child);
    await removeTempDir(home);
  });


  it("as shipped: the server names the approval, keeps banner-linux closed, and the Linux banner posts nothing answerable", async () => {
    const asked = await askedBot("Linux shipped");
    const d = desktop({ flipped: false });
    const { ids, record } = await d.show(asked);
    for (const field of BINDING) expect(typeof record[field] === "string" && record[field].length > 0, field).toBe(true);
    expect(record.outsideOk.pill).toBe(true);
    expect(record.outsideOk[SURFACE]).toBe(false);
    expect(ids).toBeNull();
    expect(d.posted).toEqual([]);
    expect(d.minted).toEqual([]);
    expect(d.connections()).toBe(0);
    expect((await cardById(asked.bot.threadId, asked.requestId)).answered).toBeUndefined();
  });

  it("read, mint, callback and POST carry the server's own binding; the live server still refuses banner-linux and nothing is answered", async () => {
    const asked = await askedBot("Linux chain");
    const d = desktop({ flipped: true });
    const { ids, record } = await d.show(asked);
    expect(ids).toHaveLength(1);
    expect(d.posted).toHaveLength(1);
    expect(d.posted[0][4].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")).toBe(record.display.willRun);
    expect(d.posted[0][5]).toEqual(["default", "Open", "allow", "Allow", "deny", "Deny", "open", "Open"]);
    // the token is minted for exactly the approval, request and action the server named in its read
    expect(d.minted).toHaveLength(1);
    for (const field of BINDING) expect(d.minted[0][field], field).toBe(record[field]);
    expect(d.minted[0]).toMatchObject({ surface: SURFACE, requestId: asked.requestId, digest: record.digest });
    // the owner presses Allow on the banner
    d.iface.emit("ActionInvoked", 1, "allow");
    const answer = await poll(async () => d.posts()[0] ?? null, 20_000);
    expect(answer, "the callback reached the server").not.toBeNull();
    await settle();
    expect(d.posts()).toHaveLength(1);
    expect(answer!.url).toBe(`/api/threads/${asked.bot.threadId}/respond`);
    expect(answer!.body).toEqual({ approvalId: record.approvalId, requestRef: record.requestRef, actionHash: record.actionHash, requestId: asked.requestId, behavior: "allow", outside: { digest: record.digest, surface: SURFACE } });
    // the server's own envelope for banner-linux is still closed: refused there, whatever the desktop believed
    expect(answer!.status).toBe(409);
    expect(d.refusals).toEqual(["server-409"]);
    expect((await cardById(asked.bot.threadId, asked.requestId)).answered).toBeUndefined();
    // a refused answer opens the card in the app and withdraws the banner; the token is spent
    await poll(async () => (d.closed.length ? true : null), 5_000);
    expect(d.opened).toEqual([{ botId: asked.bot.id, threadId: asked.bot.threadId, messageId: asked.messageId }]);
    expect(d.closed).toEqual([1]);
    expect(d.banners.size()).toBe(0);
    d.iface.emit("ActionInvoked", 1, "allow");
    await settle();
    expect(d.posts()).toHaveLength(1);
  });

  it("the binding the Linux banner posted is the one the live registry holds: changed it is refused, exact it answers", async () => {
    const asked = await askedBot("Linux registry");
    const d = desktop({ flipped: true });
    await d.show(asked);
    d.iface.emit("ActionInvoked", 1, "deny");
    const answer = await poll(async () => d.posts()[0] ?? null, 20_000);
    expect(answer!.status).toBe(409);
    expect((await cardById(asked.bot.threadId, asked.requestId)).answered).toBeUndefined();
    // The same body on a surface whose envelope is open reaches the binding check (step 4b) against the live registry.
    const body = { ...answer!.body, outside: { ...answer!.body.outside, surface: "pill" } };
    const post = (sentBody: unknown) => desktopApi("POST", `/api/threads/${asked.bot.threadId}/respond`, sentBody);
    for (const field of BINDING) {
      const other = await post({ ...body, [field]: `${body[field]}x` });
      expect([other.status, other.body.code], field).toEqual([409, "binding_changed"]);
    }
    expect((await cardById(asked.bot.threadId, asked.requestId)).answered).toBeUndefined();
    expect((await post(body)).status).toBe(200);
    expect((await cardById(asked.bot.threadId, asked.requestId)).answered).toBe("deny");
    // settled: the card read is a 404 now, so a second banner for it is impossible
    expect((await desktopApi("GET", `/api/desktop/attention/card?threadId=${asked.bot.threadId}&messageId=${asked.messageId}`)).status).toBe(404);
  });
});
