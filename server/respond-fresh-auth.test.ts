// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SEC-006: the fresh-auth gate on both respond routes, over real HTTP with the
// fake ACP agent asking. An app device signs the harness challenge for a
// high-risk Allow; a browser pairing cannot allow one at all; deny, a low-rated
// Allow and the desktop app are never gated.
//
// HEADLESS ONLY: the data directory is a throwaway temp HOME and the port is
// probed from the fixture band, clear of the live app's 8799.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvalDigest } from "../shared/approval-digest.ts";
import { proofMessage } from "./approval-fresh-auth.ts";
import { makeTestHome, removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { assertSafeToWipe } from "./testing/safe-wipe.mjs";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
/** Outside its folder: the stop line holds under Full access. */
const DELETE_OUTSIDE = "rm -rf ~/Documents/old";
/** The launch credential shared by the harness and its companion. */
const COMPANION_TOKEN = "c".repeat(64); // the suite's launch secret (server/testing/setup.ts)

let base: string;
let desktopHeaders: Record<string, string>;
let child: ChildProcess;
let home: string;
let stderr = "";

const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const desktopApi = (method: string, path: string, body?: unknown) => request(method, path, body, desktopHeaders);
const threadMessages = async (threadId: string) => ((await desktopApi("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as any[];
const cardById = async (threadId: string, requestId: string) => (await threadMessages(threadId)).find((m) => m.card?.requestId === requestId)?.card;
const liveCard = async (threadId: string) =>
  (await threadMessages(threadId)).find((m) => m.card?.requestId && m.card?.answered === undefined && !m.card?.dismissed) ?? null;

async function poll<T>(read: () => Promise<T | null>, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function waitIdle(botId: string, threadId: string, ms = 60_000) {
  return poll(async () => {
    const bot = (await desktopApi("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === botId);
    const task = bot?.tasks?.find((t: any) => t.threadId === threadId);
    return task && !task.busy ? task : null;
  }, ms);
}

const companion = { "x-murage-companion": "1", "x-murage-companion-token": COMPANION_TOKEN };
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
const POINT = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
const DEVICE = randomUUID();
const appWithKey = { ...companion, "x-murage-approval-device": DEVICE, "x-murage-approval-class": "app", "x-murage-approval-key": POINT };
const appNoKey = { ...companion, "x-murage-approval-device": DEVICE, "x-murage-approval-class": "app" };
const pairedBrowser = { ...companion, "x-murage-approval-device": DEVICE, "x-murage-approval-class": "browser" };
const signFor = (threadId: string, requestId: string, ch: { nonce: string; digest: string; decision: "allow" | "allow-task"; expiresAt: number }) =>
  sign("sha256", Buffer.from(proofMessage({ threadId, requestId, ...ch }), "utf8"), { key: privateKey, dsaEncoding: "der" }).toString("base64url");

/** A bot in Ask mode waiting on a card the engine path rated low (the default command, echo hi). */
async function askedBot(name: string) {
  const created = await desktopApi("POST", "/api/bots", { name, modelSelection: { instanceId: "echoer", model: "fake-model" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  expect((await desktopApi("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { autoApprove: false })).status).toBe(200);
  expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "say hi" })).status).toBe(202);
  const card = await poll(() => liveCard(bot.threadId), 60_000);
  expect(card, `Ask mode raised no card. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
  return { bot, requestId: card.card.requestId as string, card: card.card };
}

/** A Full access bot stopped at the stop line, waiting on its card. */
async function stoppedBot(name: string) {
  const created = await desktopApi("POST", "/api/bots", { name, modelSelection: { instanceId: "deleter", model: "fake-model" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  expect((await desktopApi("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { fullAccess: true, acknowledgeFullAccess: true })).status).toBe(200);
  expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "tidy my documents" })).status).toBe(202);
  const card = await poll(() => liveCard(bot.threadId), 60_000);
  expect(card, `the stop line raised no card. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
  expect(card.card.taskAllowKey).toBeTruthy();
  return { bot, requestId: card.card.requestId as string };
}

describe.skipIf(process.platform === "win32")("a high-risk Allow from a phone needs a device-signed proof", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1], 18_799, 200);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLI, 0o755);
    home = makeTestHome("murage-respond-fresh-auth-");
    // A disposable home: OS temp, or the checkout's .murage-scratch on Linux.
    expect(() => assertSafeToWipe(home)).not.toThrow();
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(
      join(home, ".murage", "config.json"),
      JSON.stringify({
        instances: {
          deleter: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_COMMAND: DELETE_OUTSIDE },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          echoer: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "permission" },
            config: { cli: FAKE_CLI, fullAuto: false },
          },
        },
      }),
    );
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        MURAGE_PORT: String(port),
        MURAGE_WEBHOOK_PORT: String(port + 1),
        MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
        MURAGE_COMPANION_TOKEN: COMPANION_TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 150_000; // generous: a loaded machine booted this in over 100 s
    for (;;) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    const proof = await request("GET", "/api/desktop-secret");
    expect(proof.status).toBe(200);
    desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  }, 180_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("an app device must sign the challenge for a stop-line card, and the proof works once", async () => {
    const { bot, requestId } = await stoppedBot("Fresh auth deleter");
    const respond = (body: object, headers: Record<string, string>) => request("POST", `/api/threads/${bot.threadId}/respond`, { requestId, ...body }, headers);
    const first = await respond({ behavior: "allow" }, appWithKey);
    expect(first.status).toBe(403);
    expect(first.body.code).toBe("fresh_auth");
    const ch = first.body.challenge;
    // the digest is the live card's, the same one the page computes
    expect(ch.digest).toBe(await approvalDigest(bot.threadId, requestId, await cardById(bot.threadId, requestId)));
    // and the card a companion reads digests to the same value (nothing is stripped on the phone path)
    const seenByPhone = ((await request("GET", `/api/threads/${bot.threadId}/messages?limit=200`, undefined, appWithKey)).body.messages as any[]).find((m) => m.card?.requestId === requestId)?.card;
    expect(await approvalDigest(bot.threadId, requestId, seenByPhone)).toBe(ch.digest);
    // a wrong signature burns the nonce
    const wrong = await respond({ behavior: "allow", freshAuth: { nonce: ch.nonce, signature: "AAAAAAAA" } }, appWithKey);
    expect(wrong.body.code).toBe("fresh_auth_failed");
    const again = (await respond({ behavior: "allow" }, appWithKey)).body.challenge;
    const ok = await respond({ behavior: "allow", freshAuth: { nonce: again.nonce, signature: signFor(bot.threadId, requestId, again) } }, appWithKey);
    expect(ok.body).toMatchObject({ ok: true, outcome: "allowed-once" });
    expect(await waitIdle(bot.id, bot.threadId)).not.toBeNull();
  }, 90_000);

  it("Allow for this task signs its own decision", async () => {
    const { bot, requestId } = await stoppedBot("Fresh auth task deleter");
    const respond = (body: object) => request("POST", `/api/threads/${bot.threadId}/respond`, { requestId, ...body }, appWithKey);
    const ch = (await respond({ behavior: "allow", allowForTask: true })).body.challenge;
    expect(ch.decision).toBe("allow-task");
    const asPlainAllow = signFor(bot.threadId, requestId, { ...ch, decision: "allow" });
    expect((await respond({ behavior: "allow", allowForTask: true, freshAuth: { nonce: ch.nonce, signature: asPlainAllow } })).body.code).toBe("fresh_auth_failed");
    const next = (await respond({ behavior: "allow", allowForTask: true })).body.challenge;
    expect((await respond({ behavior: "allow", allowForTask: true, freshAuth: { nonce: next.nonce, signature: signFor(bot.threadId, requestId, next) } })).body).toMatchObject({ ok: true });
    expect(await waitIdle(bot.id, bot.threadId)).not.toBeNull();
  }, 90_000);

  it("an app device without a key, or a companion with no approval headers, is told to approve on the computer; deny still works", async () => {
    const { bot, requestId } = await stoppedBot("Fresh auth no key");
    for (const headers of [appNoKey, companion]) {
      const tried = await request("POST", `/api/threads/${bot.threadId}/respond`, { requestId, behavior: "allow" }, headers);
      expect(tried).toMatchObject({ status: 403, body: { code: headers === appNoKey ? "fresh_auth_unattested" : "fresh_auth_unavailable" } });
    }
    // the bots route is gated the same way (the companion doors only forward the threads route, so this is harness-level)
    expect((await request("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.threadId, requestId, behavior: "allow" }, appNoKey)).status).toBe(403);
    expect((await request("POST", `/api/threads/${bot.threadId}/respond`, { requestId, behavior: "deny" }, appNoKey)).body).toMatchObject({ ok: true, outcome: "rejected" });
    expect(await waitIdle(bot.id, bot.threadId)).not.toBeNull();
  }, 90_000);

  it("a refused Allow records no answer, so the card is not marked answered on desktop", async () => {
    const { bot, requestId } = await stoppedBot("Fresh auth refused");
    await request("POST", `/api/threads/${bot.threadId}/respond`, { requestId, behavior: "allow" }, companion);
    expect((await cardById(bot.threadId, requestId))?.answered).toBeUndefined();
    await request("POST", `/api/threads/${bot.threadId}/respond`, { requestId, behavior: "deny" });
    expect(await waitIdle(bot.id, bot.threadId)).not.toBeNull();
  }, 90_000);

  it("a browser pairing cannot allow a high-risk card, however it asks, but can deny it", async () => {
    const { bot, requestId } = await stoppedBot("Fresh auth browser high");
    const route = `/api/threads/${bot.threadId}/respond`;
    expect((await cardById(bot.threadId, requestId)).lowRisk).toBeUndefined();
    // the stamp is advisory: a forged lowRisk in the body, or a request that claims it, changes nothing server-side
    expect((await request("POST", route, { requestId, behavior: "allow", lowRisk: true, card: { lowRisk: true } }, pairedBrowser)).body.code).toBe("approve_on_computer");
    for (const body of [{ behavior: "allow" }, { behavior: "allow", allowForTask: true }, { behavior: "answer", message: "go ahead" }]) {
      const tried = await request("POST", route, { requestId, ...body }, pairedBrowser);
      expect(tried, JSON.stringify(body)).toMatchObject({ status: 403, body: { code: "approve_on_computer", error: "Approve this on your computer or in the Murage app." } });
    }
    // a forged proof buys nothing from a browser pairing
    expect((await request("POST", route, { requestId, behavior: "allow", freshAuth: { nonce: "n".repeat(43), signature: "AAAAAAAA" } }, pairedBrowser)).body.code).toBe("approve_on_computer");
    expect((await cardById(bot.threadId, requestId))?.answered).toBeUndefined();
    expect((await request("POST", route, { requestId, behavior: "deny" }, pairedBrowser)).body).toMatchObject({ ok: true, outcome: "rejected" });
    expect(await waitIdle(bot.id, bot.threadId)).not.toBeNull();
  }, 90_000);

  it("deny is never gated, for an app device with or without a key and for a browser pairing", async () => {
    for (const [label, headers] of [["app with key", appWithKey], ["app no key", appNoKey], ["browser", pairedBrowser]] as const) {
      const { bot, requestId } = await stoppedBot(`Fresh auth deny ${label}`);
      expect((await request("POST", `/api/threads/${bot.threadId}/respond`, { requestId, behavior: "deny" }, headers)).body, label).toMatchObject({ ok: true, outcome: "rejected" });
      expect(await waitIdle(bot.id, bot.threadId)).not.toBeNull();
    }
  }, 150_000);

  it("a low-rated Allow still works from an app device and from a browser pairing, with no proof", async () => {
    for (const [label, headers] of [["browser", pairedBrowser], ["app", appWithKey]] as const) {
      const { bot, requestId, card } = await askedBot(`Fresh auth low ${label}`);
      expect(card.lowRisk, label).toBe(true);
      const tried = await request("POST", `/api/threads/${bot.threadId}/respond`, { requestId, behavior: "allow" }, headers);
      expect(tried.body, label).toMatchObject({ ok: true, outcome: "allowed-once" });
      expect(await waitIdle(bot.id, bot.threadId)).not.toBeNull();
    }
  }, 150_000);

  it("the desktop app answers a high-risk card with no proof, as before", async () => {
    const { bot, requestId } = await stoppedBot("Fresh auth desktop");
    expect((await desktopApi("POST", `/api/threads/${bot.threadId}/respond`, { requestId, behavior: "allow" })).body).toMatchObject({ ok: true, outcome: "allowed-once" });
    expect(await waitIdle(bot.id, bot.threadId)).not.toBeNull();
    // the bots route, same desktop proof. Neither door forwards this route
    // (it is harness-direct only, P17), so no app or browser pairing reaches it.
    const two = await stoppedBot("Fresh auth desktop bots route");
    expect((await desktopApi("POST", `/api/bots/${two.bot.id}/respond`, { threadId: two.bot.threadId, requestId: two.requestId, behavior: "allow" })).body).toMatchObject({ ok: true, outcome: "allowed-once" });
    expect(await waitIdle(two.bot.id, two.bot.threadId)).not.toBeNull();
  }, 120_000);

  it("approval headers without the launch proof prove nothing", async () => {
    const { bot, requestId } = await stoppedBot("Fresh auth forged");
    const forged = { "x-murage-companion": "1", "x-murage-approval-device": DEVICE, "x-murage-approval-class": "app", "x-murage-approval-key": POINT };
    expect((await request("POST", `/api/threads/${bot.threadId}/respond`, { requestId, behavior: "allow" }, forged)).status).toBe(403);
    await request("POST", `/api/threads/${bot.threadId}/respond`, { requestId, behavior: "deny" });
    expect(await waitIdle(bot.id, bot.threadId)).not.toBeNull();
  }, 90_000);
});
