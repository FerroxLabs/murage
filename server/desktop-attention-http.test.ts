// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOTIFY-EVERYWHERE-1019 S1 over real HTTP with the fake ACP agent asking: the attention reads, and the one synchronous
// outside answer path (`outside` on POST /api/threads/:id/respond).
//
// HEADLESS ONLY: the data directory is a throwaway temp HOME and the port is probed from the fixture band.
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
// @ts-expect-error Native ESM has no declaration file.
import { createAttentionMain } from "../electron/attention-main.mjs";
// @ts-expect-error Native ESM has no declaration file.
import { createLocalTransport } from "../electron/attention-transport.mjs";
// @ts-expect-error Native ESM has no declaration file.
import { watchInboxChanges } from "../electron/inbox-watch.mjs";
import { sanitizeDisplayTextUnit } from "./transcript-page.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionBoundAcpPermissionEnvironment } from "./testing/acp-permission-fixture.ts";
import { fixtureDisplayApi } from "./testing/display-fixture.ts";
import { makeTestHome, removeTempDir } from "./testing/cleanup.ts";
import { fixturePlatformEnv, stopFixtureServer } from "./testing/platform-fixtures.ts";
import { assertSafeToWipe } from "./testing/safe-wipe.mjs";
import { freePortBlock } from "./testing/ports.ts";
import { fakeEngineImportArgs, powerBlockTestEnv } from "./testing/power-block-test.ts";

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

// a paired phone app: marker, door token, launch proof and an attested approval key (what the companion door writes)
const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
const POINT = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
const phoneApp = { "x-murage-companion": "1", "x-murage-door-token": COMPANION_TOKEN, "x-murage-companion-token": COMPANION_TOKEN, "x-murage-approval-device": randomUUID(), "x-murage-approval-class": "app", "x-murage-approval-key": POINT };

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
/** What an outside surface was shown for this card, read the way main reads it. */
const attentionCard = async (threadId: string, messageId: string) => (await poll(async () => {
  const read = await desktopApi("GET", `/api/desktop/attention/card?threadId=${encodeURIComponent(threadId)}&messageId=${encodeURIComponent(messageId)}`);
  return read.status === 200 ? read.body : null;
}, 20_000))!;
/** The three values that name the registered approval behind a card, as the attention read gave them. */
type Bound = { approvalId: string; requestRef: string; actionHash: string };
const bindingOf = (record: Bound): Bound => ({ approvalId: record.approvalId, requestRef: record.requestRef, actionHash: record.actionHash });
const outsideBody = (requestId: string, record: Bound & { digest: string }, behavior: "allow" | "deny" = "allow", extra: Record<string, unknown> = {}) => ({ requestId, behavior, ...bindingOf(record), outside: { digest: record.digest, surface: "pill" }, ...extra });

async function startFixture() {
  const port = Number(new URL(base).port);
  stderr = "";
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
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const proof = await request("GET", "/api/desktop-secret");
  expect(proof.status).toBe(200);
  desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
}

describe("outside answers (NOTIFY-EVERYWHERE-1019 S1)", { timeout: 150_000 }, () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1], 19_199, 200);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLI, 0o755);
    home = makeTestHome("murage-outside-");
    expect(() => assertSafeToWipe(home)).not.toThrow();
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ instances: { echoer: { driver: "grokAgent", environment: sessionBoundAcpPermissionEnvironment({ FAKE_ACP_MODE: "permission" }), config: { cli: FAKE_CLI, fullAuto: false } } } }));
    await startFixture();
  }, 180_000);

  afterAll(async () => {
    await stopFixtureServer(child);
    await removeTempDir(home);
  });

  it("the reads are desktop only", async () => {
    expect([403, 404]).toContain((await request("GET", "/api/desktop/attention")).status);
    expect([403, 404]).toContain((await request("GET", "/api/desktop/attention", undefined, phoneApp)).status);
    expect([403, 404]).toContain((await request("GET", "/api/desktop/attention/card?threadId=a&messageId=b", undefined, phoneApp)).status);
    const read = await desktopApi("GET", "/api/desktop/attention");
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ quietHours: { active: false, endsAt: null }, heldDuringQuiet: [] });
    expect(typeof read.body.epoch).toBe("string");
  });

  it("an open card is read with its full display, a digest and a per-surface outsideOk map", async () => {
    const asked = await askedBot("Outside read");
    const record = await attentionCard(asked.bot.threadId, asked.messageId);
    expect(record).toMatchObject({ threadId: asked.bot.threadId, requestId: asked.requestId, display: { botName: "Outside read" } });
    expect(record.display.willRun.length).toBeGreaterThan(0);
    expect(record.digest).toMatch(/^[0-9a-f]{64}$/);
    // the placeholder envelopes: OS banners and the menu are Open only until S0 fills them; our own windows are fine
    expect(record.outsideOk).toMatchObject({ "banner-mac": false, "banner-win": false, "banner-linux": false, menu: false, pill: true, flyout: true });
    const list = await desktopApi("GET", "/api/desktop/attention");
    expect(list.body.open.find((c: any) => c.requestId === asked.requestId)?.digest).toBe(record.digest);
    expect((await desktopApi("GET", `/api/desktop/attention/card?threadId=${asked.bot.threadId}&messageId=nope`)).status).toBe(404);
  });

  it("a paired phone, a paired browser and plain loopback are refused for Allow, Deny and Reply, and nothing is answered", async () => {
    const asked = await askedBot("Outside refused");
    const shown = await attentionCard(asked.bot.threadId, asked.messageId);
    const browser = { ...phoneApp, "x-murage-approval-class": "browser" };
    for (const headers of [phoneApp, browser, {}]) {
      for (const behavior of ["allow", "deny"] as const) {
        const res = await request("POST", `/api/threads/${asked.bot.threadId}/respond`, outsideBody(asked.requestId, shown, behavior), headers);
        expect(res.status, `${JSON.stringify(headers).slice(0, 40)} ${behavior}`).toBe(403);
      }
      expect((await request("POST", `/api/threads/${asked.bot.threadId}/respond`, outsideBody(asked.requestId, shown, "deny", { message: "no" }), headers)).status).toBe(403);
    }
    expect((await cardById(asked.bot.threadId, asked.requestId)).answered).toBeUndefined();
  });

  it("refuses the wrong shape: allowForTask, skip, answer, a message on allow, extra fields, an unknown surface", async () => {
    const asked = await askedBot("Outside shape");
    const shown = await attentionCard(asked.bot.threadId, asked.messageId), { digest } = shown;
    const post = (body: unknown) => desktopApi("POST", `/api/threads/${asked.bot.threadId}/respond`, body);
    for (const extra of [{ allowForTask: true }, { message: "hello" }, { reviewedSha256: "x" }]) expect((await post(outsideBody(asked.requestId, shown, "allow", extra))).status).toBe(400);
    expect((await post({ requestId: asked.requestId, behavior: "skip", ...bindingOf(shown), outside: { digest, surface: "pill" } })).status).toBe(400);
    expect((await post({ requestId: asked.requestId, behavior: "answer", ...bindingOf(shown), outside: { digest, surface: "pill" } })).status).toBe(400);
    expect((await post({ requestId: asked.requestId, behavior: "allow", ...bindingOf(shown), outside: { digest, surface: "toaster" } })).status).toBe(400);
    expect((await post(outsideBody(asked.requestId, shown, "deny", { message: "   " }))).status).toBe(400);
    expect((await cardById(asked.bot.threadId, asked.requestId)).answered).toBeUndefined();
  });

  it("a changed digest is a 409 and answers nothing; a surface that does not fit is refused", async () => {
    const asked = await askedBot("Outside digest");
    const shown = await attentionCard(asked.bot.threadId, asked.messageId), { digest } = shown;
    const post = (body: unknown) => desktopApi("POST", `/api/threads/${asked.bot.threadId}/respond`, body);
    expect((await post(outsideBody(asked.requestId, { ...shown, digest: "0".repeat(64) }))).body.code).toBe("card_changed");
    expect((await post({ requestId: asked.requestId, behavior: "allow", ...bindingOf(shown), outside: { digest, surface: "banner-mac" } })).body.code).toBe("outside_refused");
    expect((await cardById(asked.bot.threadId, asked.requestId)).answered).toBeUndefined();
  });

  it("the reads name the registered approval behind an answerable card: the card read and the open list agree", async () => {
    const asked = await askedBot("Outside bound");
    const shown = await attentionCard(asked.bot.threadId, asked.messageId);
    for (const field of ["approvalId", "requestRef", "actionHash"] as const) expect(typeof shown[field] === "string" && shown[field].length > 0, field).toBe(true);
    const listed = (await desktopApi("GET", "/api/desktop/attention")).body.open.find((c: any) => c.requestId === asked.requestId);
    expect(bindingOf(listed)).toEqual(bindingOf(shown));
    expect(listed.outsideOk.pill).toBe(true);
  });

  it("an answer that does not name the approval is a 400, and one that names another approval, request or action is a 409: nothing is answered", async () => {
    const asked = await askedBot("Outside binding");
    const shown = await attentionCard(asked.bot.threadId, asked.messageId);
    const post = (body: unknown) => desktopApi("POST", `/api/threads/${asked.bot.threadId}/respond`, body);
    for (const behavior of ["allow", "deny"] as const) {
      const unbound = await post({ requestId: asked.requestId, behavior, outside: { digest: shown.digest, surface: "pill" } });
      expect([unbound.status, unbound.body.code], behavior).toEqual([400, "bad_outside_body"]);
      for (const field of ["approvalId", "requestRef", "actionHash"] as const) {
        const missing: Record<string, unknown> = outsideBody(asked.requestId, shown, behavior); delete missing[field];
        expect((await post(missing)).status, `${behavior} without ${field}`).toBe(400);
        const other = await post(outsideBody(asked.requestId, { ...shown, [field]: `${shown[field]}x` }, behavior));
        expect([other.status, other.body.code], `${behavior} other ${field}`).toEqual([409, "binding_changed"]);
      }
    }
    expect((await cardById(asked.bot.threadId, asked.requestId)).answered).toBeUndefined();
    // the same card, named exactly, is still answerable afterwards: a refusal spends nothing
    expect((await post(outsideBody(asked.requestId, shown, "deny"))).status).toBe(200);
    expect((await cardById(asked.bot.threadId, asked.requestId)).answered).toBe("deny");
  });

  it("an answer bound to an earlier card of the same conversation never answers the card that is waiting now", async () => {
    const first = await askedBot("Outside earlier");
    const before = await attentionCard(first.bot.threadId, first.messageId);
    const url = `/api/threads/${first.bot.threadId}/respond`;
    expect((await desktopApi("POST", url, outsideBody(first.requestId, before, "deny"))).status).toBe(200);
    // a replay of the settled card is refused on the card check
    const replay = await desktopApi("POST", url, outsideBody(first.requestId, before));
    expect([404, 409]).toContain(replay.status);
    expect((await desktopApi("POST", `/api/bots/${first.bot.id}/messages`, { threadId: first.bot.threadId, text: "say hi again" })).status).toBe(202);
    const next = await poll(async () => { const live = await liveCard(first.bot.threadId); return live && live.id !== first.messageId ? live : null; }, 60_000);
    expect(next, `no second card. stderr: ${stderr.slice(-800)}`).not.toBeNull();
    const now = await attentionCard(first.bot.threadId, next.id);
    expect(now.approvalId).not.toBe(before.approvalId);
    // the new card's request id and digest with the EARLIER card's approval: refused on the binding, and the new card stays open
    const crossed = await desktopApi("POST", url, { ...outsideBody(next.card.requestId, now), ...bindingOf(before) });
    expect([crossed.status, crossed.body.code]).toEqual([409, "binding_changed"]);
    expect((await cardById(first.bot.threadId, next.card.requestId)).answered).toBeUndefined();
    expect((await desktopApi("POST", url, outsideBody(next.card.requestId, now))).status).toBe(200);
  });

  it("the desktop Allow answers once as the in-app Allow does, and a repeat answers nothing more", async () => {
    const asked = await askedBot("Outside allow");
    const shown = await attentionCard(asked.bot.threadId, asked.messageId);
    const done = await desktopApi("POST", `/api/threads/${asked.bot.threadId}/respond`, outsideBody(asked.requestId, shown));
    expect(done.status, `body ${JSON.stringify(done.body)} stderr ${stderr.slice(-800)}`).toBe(200);
    expect((await cardById(asked.bot.threadId, asked.requestId)).answered).toBe("allow");
    const again = await desktopApi("POST", `/api/threads/${asked.bot.threadId}/respond`, outsideBody(asked.requestId, shown));
    expect([404, 409]).toContain(again.status);
  });

  it("Reply is a deny with the owner's words", async () => {
    const asked = await askedBot("Outside reply");
    const shown = await attentionCard(asked.bot.threadId, asked.messageId);
    const done = await desktopApi("POST", `/api/threads/${asked.bot.threadId}/respond`, outsideBody(asked.requestId, shown, "deny", { message: "Not today, thanks" }));
    expect(done.status).toBe(200);
    expect((await cardById(asked.bot.threadId, asked.requestId)).answered).toBe("deny");
  });

  it("two outside answers, and an outside plus an in-app answer, at once deliver exactly one decision", async () => {
    for (const rival of ["outside", "in-app"] as const) {
      const asked = await askedBot(`Outside race ${rival}`);
      const shown = await attentionCard(asked.bot.threadId, asked.messageId);
      const url = `/api/threads/${asked.bot.threadId}/respond`;
      const results = await Promise.all([
        desktopApi("POST", url, outsideBody(asked.requestId, shown, "allow")),
        rival === "outside" ? desktopApi("POST", url, outsideBody(asked.requestId, shown, "deny")) : desktopApi("POST", url, { requestId: asked.requestId, behavior: "deny" }),
      ]);
      const settled = (await cardById(asked.bot.threadId, asked.requestId)).answered;
      expect(["allow", "deny"]).toContain(settled);
      // one decision reached the engine: every reply that says it was answered says the SAME thing, the one the card settled on
      const said = results.filter((r) => r.status === 200 && r.body?.outcome !== "unavailable").map((r) => r.body.outcome);
      expect(said.length, JSON.stringify(results.map((r) => [r.status, r.body]))).toBeGreaterThan(0);
      for (const outcome of said) expect(outcome).toBe(settled === "allow" ? "allowed-once" : "rejected");
    }
  });

  it("with details hidden nothing can be answered outside, and the reads carry no card text", async () => {
    const asked = await askedBot("Outside hidden");
    const shown = await attentionCard(asked.bot.threadId, asked.messageId);
    const saved = await desktopApi("PUT", "/api/config", { notifications: { previewContent: false } });
    expect(saved.status).toBe(200);
    try {
      const res = await desktopApi("POST", `/api/threads/${asked.bot.threadId}/respond`, outsideBody(asked.requestId, shown));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("previews_off");
      const record = await attentionCard(asked.bot.threadId, asked.messageId);
      expect(record.display).toBeUndefined();
      expect(record.digest).toBeUndefined();
      expect(Object.values(record.outsideOk).some(Boolean)).toBe(false);
      const tray = await desktopApi("GET", "/api/desktop/tray");
      expect(JSON.stringify(tray.body.items)).not.toContain("Outside hidden");
      expect(tray.body.items.every((i: any) => i.quick === false && !i.display)).toBe(true);
      expect((await cardById(asked.bot.threadId, asked.requestId)).answered).toBeUndefined();
    } finally {
      await desktopApi("PUT", "/api/config", { notifications: { previewContent: true } });
    }
  });

  it("R7: recovery lists only eligible Ask cards and rechecks a live Inbox snooze", async () => {
    const asked = await askedBot("Recovery fixture");
    const listPath = "/api/desktop/attention?recover=1";
    const cardPath = `/api/desktop/attention/card?threadId=${encodeURIComponent(asked.bot.threadId)}&messageId=${encodeURIComponent(asked.messageId)}`;
    const read = () => desktopApi("GET", cardPath + "&recover=1");
    const base = await desktopApi("GET", cardPath);
    const defaultList = await desktopApi("GET", "/api/desktop/attention");
    const listing = await desktopApi("GET", listPath);
    expect(listing.body.mode).toBe("recover");
    expect(listing.body.items).toContainEqual(expect.objectContaining({ messageId: asked.messageId, requestId: asked.requestId }));
    expect(listing.body).not.toHaveProperty("quietStartsInMs");
    expect(await read()).toMatchObject({ status: 200, body: { notifyOk: true, quietStartsInMs: null, epoch: listing.body.epoch, words: { botName: "Recovery fixture" } } });
    const inbox = await desktopApi("GET", "/api/inbox?view=decisions");
    const item = inbox.body.items.find((row: any) => row.link.messageId === asked.messageId);
    expect(item).toBeDefined();
    const snooze = async (snoozedUntil: number | null) => {
      expect((await desktopApi("POST", "/api/inbox/state", { id: item.id, version: item.version, snoozedUntil })).status).toBe(200);
    };
    async function suppressed() {
      expect((await desktopApi("GET", listPath)).body.items).not.toContainEqual(expect.objectContaining({ requestId: asked.requestId }));
      expect((await read()).body.notifyOk).toBe(false);
    }
    try {
      await snooze(Date.now() + 60_000);
      await suppressed();
      await snooze(null);
      expect((await read()).body.notifyOk).toBe(true);
      expect((await desktopApi("PATCH", `/api/bots/${asked.bot.id}`, { notifications: false })).status).toBe(200);
      await suppressed();
      expect((await desktopApi("PATCH", `/api/bots/${asked.bot.id}`, { notifications: true })).status).toBe(200);
      expect((await desktopApi("PUT", "/api/config", { notifications: { attention: false } })).status).toBe(200);
      await suppressed();
      const utc = (ms: number) => new Date(ms).toISOString().slice(11, 16);
      const now = Date.now();
      const quiet = { enabled: true, start: utc(now - 60_000), end: utc(now + 600_000), timeZone: "UTC" };
      expect((await desktopApi("PUT", "/api/config", { notifications: { attention: true, quietHours: quiet } })).status).toBe(200);
      await suppressed();
      expect((await read()).body.quietStartsInMs).toBe(0);
      expect((await desktopApi("PUT", "/api/config", { notifications: { quietHours: { ...quiet, enabled: false }, previewContent: false } })).status).toBe(200);
      expect((await read()).body).not.toHaveProperty("words");
    } finally {
      await desktopApi("PUT", "/api/config", { notifications: { attention: true, previewContent: true, quietHours: { enabled: false, start: "22:00", end: "07:00", timeZone: "UTC" } } });
    }
    expect(await desktopApi("GET", cardPath)).toEqual(base);
    expect(await desktopApi("GET", "/api/desktop/attention")).toEqual(defaultList);
  });

  it("quiet hours hold what they drop (ids only) until the desktop acks the list", async () => {
    const quiet = { enabled: true, start: "00:01", end: "00:00", timeZone: "UTC" };
    expect((await desktopApi("PUT", "/api/config", { notifications: { quietHours: quiet } })).status).toBe(200);
    try {
      const asked = await askedBot("Outside quiet");
      const held = await poll(async () => {
        const read = await desktopApi("GET", "/api/desktop/attention");
        return read.body.heldDuringQuiet.find((h: any) => h.requestId === asked.requestId) ?? null;
      }, 20_000);
      expect(held).toMatchObject({ kind: "approval", threadId: asked.bot.threadId, requestId: asked.requestId });
      expect(JSON.stringify(held)).not.toMatch(/Outside quiet|echo/);
      expect((await request("POST", "/api/desktop/attention/held/ack", {}, phoneApp)).status).not.toBe(200);
      expect((await desktopApi("POST", "/api/desktop/attention/held/ack", {})).status).toBe(200);
      expect((await desktopApi("GET", "/api/desktop/attention")).body.heldDuringQuiet).toEqual([]);
      const read = await desktopApi("GET", "/api/desktop/attention");
      expect(read.body.quietHours.active).toBe(true);
      expect(typeof read.body.quietHours.endsAt).toBe("number");
    } finally {
      await desktopApi("PUT", "/api/config", { notifications: { quietHours: { ...quiet, enabled: false } } });
    }
  });
  it("R7: the real recovery route filters before limiting and projects oversized cards on the OS path", async () => {
    const bot = async (name: string) => {
      const response = await desktopApi("POST", "/api/bots", { name, modelSelection: { instanceId: "echoer", model: "fake-model" } });
      expect(response.status).toBe(201);
      return response.body.bot as { id: string; threadId: string };
    };
    const samples = await Promise.all(["Recovery bulk", "Recovery multibyte", "Recovery escaped", "Recovery redacted"].map(bot));
    const eligible = samples[0]!;
    const muted = await bot("Muted fixture");
    expect((await desktopApi("PATCH", `/api/bots/${muted.id}`, { notifications: false })).status).toBe(200);
    const ascii = "x".repeat(1024), emoji = "🧩".repeat(512), escaped = '"\\\u0001'.repeat(342).slice(0, 1024);
    const credential = ["sk", "fixture".repeat(4)].join("-");
    const willRun = "x".repeat(66_000);
    const titles = [ascii, emoji, escaped, credential];
    const stamp = Date.now();
    await stopFixtureServer(child);
    await startFixture();
    const db = new DatabaseSync(join(home, ".murage", "messages.db"));
    try {
      // Historical rows predate the display sanitizer and keep their stored text.
      db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
      const add = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,json) VALUES(?,?,?,'bot',?,?)");
      const head = db.prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id=?");
      const setHead = db.prepare("INSERT INTO thread_state(thread_id,active_leaf_id) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id=excluded.active_leaf_id");
      const row = (threadId: string, id: string, at: number, entry: object, kind = "options") => {
        const parentId = head.get(threadId)?.active_leaf_id ?? null;
        add.run(threadId, id, at, kind, JSON.stringify({ id, at, parentId, role: "bot", kind, ...entry }));
        setHead.run(threadId, id);
      };
      for (const [i, sample] of samples.entries()) {
        row(sample.threadId, `eligible-${i}`, stamp + titles.length - i, { from: { botId: sample.id }, card: { title: titles[i], subtitle: willRun, requestId: `request-${i}` } });
      }
      for (let i = 0; i < 60; i++) {
        row(muted.threadId, `muted-${i}`, stamp + 100 + i, { from: { botId: muted.id }, card: { title: "Muted", subtitle: "Review", requestId: `muted-request-${i}` } });
      }
      for (const [id, state] of [["answered", { answered: "no" }], ["expired", { expired: true }], ["dismissed", { dismissed: true }]] as const) {
        row(eligible.threadId, id, stamp + 200, { from: { botId: eligible.id }, card: { title: id, subtitle: "Review", requestId: id, ...state } });
      }
      row(eligible.threadId, "connection", stamp + 300, { connector: { slug: "fixture", status: "pending", resumeKey: "connection" } }, "connector");
      db.exec("COMMIT");
    } finally { db.close(); }
    const listPath = "/api/desktop/attention?recover=1";
    expect((await request("GET", listPath, undefined, phoneApp)).status).not.toBe(200);
    const listing = await desktopApi("GET", listPath);
    expect(listing.body.mode).toBe("recover");
    const sampleThreads = new Set([...samples, muted].map(bot => bot.threadId));
    const selected = listing.body.items.filter((item: { threadId: string }) => sampleThreads.has(item.threadId));
    expect(selected.map((item: { messageId: string }) => item.messageId)).toEqual(titles.map((_, i) => `eligible-${i}`));
    const transport = createLocalTransport({ origin: base, secret: desktopHeaders["x-murage-surface-secret"], identity: () => "fixture" });
    const posts: string[] = [];
    let focused = true;
    const main = createAttentionMain({
      isAppFocused: () => focused, prefsTrusted: () => true, prefs: () => ({ origin: "upgrade", surfaces: { notify: true } }),
      presence: { rev: 0, refresh: async () => ({ rev: 0, locked: false }) },
      transportFor: () => transport, createNotice: (options: { body: string }) => Object.assign(new EventEmitter(), {
        show: () => posts.push(options.body), close() {},
      }),
    });
    try {
      focused = false;
      main.focusChanged();
      expect(await poll(async () => posts[0] ?? null, 10_000)).toBe(ascii);
      expect(posts).toEqual([ascii]);
    } finally { main.stopRecovery(); }
    for (let i = 0; i < titles.length; i++) {
      const query = `/api/desktop/attention/card?threadId=${samples[i]!.threadId}&messageId=eligible-${i}`;
      const response = await fetch(base + query + "&recover=1", { headers: desktopHeaders });
      const body = await response.text();
      expect(response.status, `recover variant ${i}`).toBe(200);
      expect(Buffer.byteLength(body)).toBeLessThan(2048);
      const parsed = JSON.parse(body);
      expect(parsed).toMatchObject({ requestId: `request-${i}`, notifyOk: true, epoch: listing.body.epoch });
      expect(parsed).not.toHaveProperty("display");
      expect(parsed).not.toHaveProperty("outsideOk");
      if (i === 3) {
        const [botName, title] = sanitizeDisplayTextUnit(["Recovery redacted", credential]);
        expect(title).not.toEqual(credential);
        expect(parsed.words).toEqual({ botName, title });
      }
    }
    for (const id of ["answered", "expired", "dismissed"]) {
      const closed = await desktopApi("GET", `/api/desktop/attention/card?threadId=${eligible.threadId}&messageId=${id}&recover=1`);
      expect(closed.status).toBe(404);
    }
    const legacy = await desktopApi("GET", `/api/desktop/attention/card?threadId=${eligible.threadId}&messageId=eligible-0`);
    expect(legacy.body.display.willRun).toBe(willRun);

  });

  it("R8: a real mute reaches the tray watcher before recovery submits", async () => {
    const asked = await askedBot("Mute during recovery");
    let focused = true, reads = 0, lists = 0, connected = false, mutedFrame = false;
    let candidateRead = "";
    let finishPresence: (() => void) | undefined;
    const opened: string[] = [];
    const notices: EventEmitter[] = [];
    const transport = createLocalTransport({
      origin: base, secret: desktopHeaders["x-murage-surface-secret"], identity: () => "fixture",
      async fetchImpl(url: string, init: RequestInit) {
        const path = new URL(url);
        const response = await fetch(url, init);
        if (path.pathname.endsWith("/card")) candidateRead = path.searchParams.get("messageId") ?? "";
        else lists++;
        return response;
      },
    });
    const main = createAttentionMain({
      isAppFocused: () => focused, prefsTrusted: () => true, prefs: () => ({ origin: "upgrade", surfaces: { notify: true } }),
      presence: { rev: 0, async refresh() {
        if (++reads === 2) await new Promise<void>(resolve => { finishPresence = resolve; });
        return { rev: 0, locked: false };
      } },
      transportFor: () => transport,
      openRecovered(target: { messageId: string }) { opened.push(target.messageId); },
      createNotice() {
        const notice = new EventEmitter();
        return Object.assign(notice, {
          show() { notices.push(notice); },
          close() {},
        });
      },
    });
    const stop = watchInboxChanges((change: { connected?: boolean }) => { connected ||= change.connected === true; }, {
      ready: () => true, url: () => base + "/api/events?screens=off", headers: () => desktopHeaders,
      onFrame(frame: { kind: string; botId?: string }) {
        main.watcherFrame(frame);
        if (frame.kind === "bot" && frame.botId === asked.bot.id) mutedFrame = true;
      },
    });
    try {
      expect(await poll(async () => connected || null, 10_000)).toBe(true);
      focused = false;
      main.focusChanged();
      expect(await poll(async () => finishPresence ? true : null, 10_000)).toBe(true);
      expect(candidateRead).toBe(asked.messageId);
      mutedFrame = false;
      expect((await desktopApi("PATCH", `/api/bots/${asked.bot.id}`, { notifications: false })).status).toBe(200);
      expect(await poll(async () => mutedFrame || null, 10_000)).toBe(true);
      finishPresence?.();
      expect(await poll(async () => lists >= 2 ? true : null, 10_000)).toBe(true);
      notices.at(-1)?.emit("click");
      expect(opened).not.toContain(asked.messageId);
      const before = notices.length;
      expect((await desktopApi("PATCH", `/api/bots/${asked.bot.id}`, { notifications: true })).status).toBe(200);
      focused = true;
      main.focusChanged();
      focused = false;
      main.focusChanged();
      expect(await poll(async () => notices.length > before ? true : null, 10_000)).toBe(true);
      notices.at(-1)?.emit("click");
      expect(opened.at(-1)).toBe(asked.messageId);
    } finally {
      finishPresence?.();
      stop();
      main.stopRecovery();
    }
  });

});
