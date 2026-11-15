// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIM-UI2-SRV (Rev 3.3 U1, U2, U6 S1 / S4 / S5 / S10): the thread-scoped preview over real HTTP. The store is seeded in
// this process (a real Store on the suite's throwaway data dir), closed, and then a real server boots on the same dir.
// HEADLESS ONLY: the data directory is the suite's throwaway; the port is probed from the fixture band.
import { openFixtureApproval } from "./testing/approval-card.ts";
import { database } from "./database.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flushCoalesced } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { closeDatabase } from "./database.ts";
import { Store } from "./store.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const COMPANION_TOKEN = "c".repeat(64);
const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

let base: string;
let child: ChildProcess;
let stderr = "";
let desktopHeaders: Record<string, string>;
let chat: string;
let hidden: string;
let other: string;
let revoked: string;
let revokedId: string;

const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};
const companion = { "x-murage-companion": "1", "x-murage-door-token": COMPANION_TOKEN, "x-murage-companion-token": COMPANION_TOKEN };
const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
const POINT = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
const DEVICE = randomUUID();
const appWithKey = { ...companion, "x-murage-approval-device": DEVICE, "x-murage-approval-class": "app", "x-murage-approval-key": POINT };
const appNoKey = { ...companion, "x-murage-approval-device": DEVICE, "x-murage-approval-class": "app" };
const pairedBrowser = { ...companion, "x-murage-approval-device": DEVICE, "x-murage-approval-class": "browser" };
const OWNER = { reason: "no-grant", unattended: false, automated: false, keys: [], origin: "owner", noLimits: { n2: false, initiator: "owner" } };
const thread = (threadId: string, requestIds: string[]) => ({ thread: { threadId, requestIds } });
const PREVIEW = "/api/inbox/approve-all/preview";

describe.skipIf(process.platform === "win32")("thread-scoped Approve all preview over HTTP", () => {
  beforeAll(async () => {
    const seed = new Store(selection);
    const bot = seed.createBot();
    const hiddenBot = seed.createBot();
    const otherBot = seed.createBot();
    seed.patchBot(hiddenBot.id, { hidden: true });
    const revokedBot = seed.createBot();
    chat = bot.threadId; hidden = hiddenBot.threadId; other = otherBot.threadId; revoked = revokedBot.threadId; revokedId = revokedBot.id;
    // bots only: a card on disk at start is retired (orphaned) by the boot sweep, so the cards are written once the server is up
    void seed;
    flushCoalesced();
    closeDatabase();
    const port = await freePortBlock([0, 1], 18_999, 200);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      windowsHide: true,
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: process.env.HOME ?? "", USERPROFILE: process.env.USERPROFILE ?? "", MURAGE_DATA_DIR: DATA_DIR,
        MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1),
        MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_COMPANION_TOKEN: COMPANION_TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe"],
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
    // the running server reads these through the card index (a second writer on the same WAL database)
    const live = new Store(selection);
    let at = 1_700_000_000_000;
    const card = (threadId: string, requestId: string) => live.appendMessage(threadId, openFixtureApproval(database(), threadId, {
      id: randomUUID(), role: "bot", kind: "options", text: "May I?", at: at++,
      card: { title: "Approval needed", subtitle: "ls", options: ["Allow", "Deny"], requestId, tool: "bash", cardClass: OWNER },
    }) as never);
    card(chat, "chat-old"); // the OLDEST open card on the machine: far past page 0 of the Inbox
    card(hidden, "hid-1");
    for (let i = 0; i < 120; i++) card(other, `other-${i}`);
    card(revoked, "rev-1");
    flushCoalesced();
  }, 180_000);

  afterAll(async () => { await waitForExit(child, { signal: "SIGTERM" }); });

  it("S1: the chat card is previewed from the thread's own cards although 120 newer cards fill the Inbox page", async () => {
    const shown = await request("POST", PREVIEW, thread(chat, ["chat-old"]), desktopHeaders);
    expect(shown.status, stderr.slice(-800)).toBe(200);
    expect(shown.body).toMatchObject({ scope: "thread", threadId: chat, later: [], excluded: [], closed: [] });
    expect(shown.body.eligible.map((c: any) => c.requestId)).toEqual(["chat-old"]);
    expect(shown.body.eligible[0].threadId).toBe(chat);
    expect(typeof shown.body.batchId).toBe("string");
    // S9: the Inbox screen path still previews its own page (oldest card is NOT on page 0)
    const screen = await request("POST", PREVIEW, {}, desktopHeaders);
    expect(screen.status).toBe(200);
    expect(screen.body.eligible.map((c: any) => c.requestId)).not.toContain("chat-old");
  });

  it("S3: a forged id from another thread is closed, never eligible", async () => {
    const shown = await request("POST", PREVIEW, thread(chat, ["chat-old", "other-3"]), desktopHeaders);
    expect(shown.status).toBe(200);
    expect(shown.body.eligible.map((c: any) => c.requestId)).toEqual(["chat-old"]);
    expect(shown.body.closed).toEqual([{ threadId: chat, requestId: "other-3", messageId: null }]);
  });

  it("S4: a thread the companion door cannot see and an unknown thread answer the same 404; the desktop sees the hidden one", async () => {
    const hid = await request("POST", PREVIEW, thread(hidden, ["hid-1"]), appWithKey);
    const unknown = await request("POST", PREVIEW, thread("no-such-thread", ["hid-1"]), appWithKey);
    expect(hid.status).toBe(404);
    expect(hid.body).toEqual({ error: expect.any(String), code: "thread_unknown" });
    expect(unknown).toEqual(hid);
    const desk = await request("POST", PREVIEW, thread(hidden, ["hid-1"]), desktopHeaders);
    expect(desk.status).toBe(200);
    expect(desk.body.eligible.map((c: any) => c.requestId)).toEqual(["hid-1"]);
    const visible = await request("POST", PREVIEW, thread(chat, ["chat-old"]), appWithKey);
    expect(visible.status).toBe(200);
    expect(visible.body.deviceId).toBe(DEVICE);
  });

  it("S5: both scopes, a bad threadId and bad requestIds are 400 bad_scope", async () => {
    const screen = { view: "approvals", query: "", page: 0, pageSize: 100, includeSnoozed: false };
    for (const body of [
      { screen, ...thread(chat, ["chat-old"]) },
      thread("bad id", ["chat-old"]),
      thread(chat, []),
      thread(chat, ["a", "a"]),
      { thread: { threadId: chat } },
      { thread: "x" },
    ]) {
      const refused = await request("POST", PREVIEW, body, desktopHeaders);
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe("bad_scope");
    }
    expect((await request("POST", PREVIEW, thread(chat, Array.from({ length: 201 }, (_, i) => `r${i}`)), desktopHeaders)).status).toBe(400);
    // group threads (group:<id>) are legal ids: unknown group is a 404, not a 400
    expect((await request("POST", PREVIEW, thread("group:nothing", ["a"]), desktopHeaders)).status).toBe(404);
  });

  it("S13: thread access revoked between preview and apply: 409 batch_unknown before any proof or answer, and the card stays open", async () => {
    const shown = await request("POST", PREVIEW, thread(revoked, ["rev-1"]), appWithKey);
    expect(shown.status).toBe(200);
    expect(shown.body.eligible.map((c: any) => c.requestId)).toEqual(["rev-1"]);
    expect((await request("PATCH", `/api/bots/${revokedId}`, { hidden: true }, desktopHeaders)).status).toBe(200);
    const apply = await request("POST", "/api/inbox/approve-all/apply", { batchId: shown.body.batchId, requestIds: ["rev-1"] }, appWithKey);
    expect(apply.status).toBe(409);
    expect(apply.body.code).toBe("batch_unknown");
    const again = await request("POST", PREVIEW, thread(revoked, ["rev-1"]), desktopHeaders);
    expect(again.body.eligible.map((c: any) => c.requestId)).toEqual(["rev-1"]);
  });

  it("S10: a browser, a paired browser, a keyless app and a loopback caller are refused with the same body as the screen path", async () => {
    for (const headers of [{}, pairedBrowser, appNoKey]) {
      const screen = await request("POST", PREVIEW, {}, headers);
      const refused = await request("POST", PREVIEW, thread(chat, ["chat-old"]), headers);
      expect(refused.status).toBe(403);
      expect(refused).toEqual(screen);
    }
  });
});
