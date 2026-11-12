// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// APPROVE-ALL (design rev 3): Approve all over real HTTP with the fake ACP agent asking. The desktop app approves
// the ordinary cards it previewed and leaves the stop line for one-by-one; the phone signs the exact ticked set
// once; a paired browser is refused; a batch is used once; a card that changed is refused, not answered; every
// bulk yes is audited as user-approved-bulk.
//
// HEADLESS ONLY: the data directory is a throwaway temp HOME and the port is
// probed from the fixture band, clear of the live app's 8799.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APPROVE_ALL_THREAD, approvalBatchDigest, approvalDigest } from "../shared/approval-digest.ts";
import { proofMessage } from "./approval-fresh-auth.ts";
import { makeTestHome, removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { assertSafeToWipe } from "./testing/safe-wipe.mjs";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
/** Outside its folder: the stop line holds under Full access. */
const DELETE_OUTSIDE = "rm -rf ~/Documents/old";
/** Not positively read-only, so the engine path rates it risky (not low) and a phone Allow needs a fresh proof; no stop line. */
const BUILD = "npm run build";
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

// the device door writes all three: its marker, the door token and the launch proof (server/owner-app.ts)
const companion = { "x-murage-companion": "1", "x-murage-door-token": COMPANION_TOKEN, "x-murage-companion-token": COMPANION_TOKEN };
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
const POINT = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
const DEVICE = randomUUID();
const appWithKey = { ...companion, "x-murage-approval-device": DEVICE, "x-murage-approval-class": "app", "x-murage-approval-key": POINT };
const appNoKey = { ...companion, "x-murage-approval-device": DEVICE, "x-murage-approval-class": "app" };
const pairedBrowser = { ...companion, "x-murage-approval-device": DEVICE, "x-murage-approval-class": "browser" };
const signFor = (threadId: string, requestId: string, ch: { nonce: string; digest: string; decision: "allow" | "allow-task"; expiresAt: number }) =>
  sign("sha256", Buffer.from(proofMessage({ threadId, requestId, ...ch }), "utf8"), { key: privateKey, dsaEncoding: "der" }).toString("base64url");

/** A bot in Ask mode waiting on an ordinary card: rated low (echoer, echo hi) or not low (builder, BUILD). */
async function askedBot(name: string, instanceId: "echoer" | "builder" = "echoer") {
  const created = await desktopApi("POST", "/api/bots", { name, modelSelection: { instanceId, model: "fake-model" } });
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

describe.skipIf(process.platform === "win32")("Approve all in Inbox > Approvals", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1], 18_799, 200);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLI, 0o755);
    home = makeTestHome("murage-approve-all-");
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
          builder: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_COMMAND: BUILD },
            config: { cli: FAKE_CLI, fullAuto: false },
          },
        },
      }),
    );
    // 30a1b3b2ce: this disposable server launches only fake ACP children.
    child = spawn(process.execPath, ["--import", "data:text/javascript,globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;", join(SERVER_DIR, "index.ts")], {
      windowsHide: true,
      cwd: join(SERVER_DIR, ".."),
      env: {
        NODE_ENV: "test",
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

  const preview = (headers: Record<string, string>) => request("POST", "/api/inbox/approve-all/preview", {}, headers);
  /** The Inbox projection follows the card a moment later: preview until every named card is listed. */
  const previewWith = async (ids: string[], headers: Record<string, string>) => (await poll(async () => {
    const shown = await preview(headers);
    const listed = new Set([...(shown.body?.eligible ?? []), ...(shown.body?.excluded ?? [])].map((c: any) => c.requestId));
    return shown.status === 200 && ids.every((id) => listed.has(id)) ? shown : null;
  }, 20_000))!;
  const apply = (body: object, headers: Record<string, string>) => request("POST", "/api/inbox/approve-all/apply", body, headers);
  const decisions = async () => ((await desktopApi("GET", "/api/decisions?limit=500")).body?.decisions ?? []) as any[];

  it("the desktop approves the ordinary cards it previewed, once each, and leaves the stop line", async () => {
    const one = await askedBot("Bulk one");
    const two = await askedBot("Bulk two");
    const stop = await stoppedBot("Bulk stop");
    const shown = await previewWith([one.requestId, two.requestId, stop.requestId], desktopHeaders);
    expect(shown.status).toBe(200);
    const ids = (shown.body.eligible as any[]).map((c) => c.requestId);
    expect(ids).toEqual(expect.arrayContaining([one.requestId, two.requestId]));
    expect(ids).not.toContain(stop.requestId);
    expect((shown.body.excluded as any[]).find((c) => c.requestId === stop.requestId)?.reasonKey).toBe("delete");
    // the preview digest is the live card's
    const first = (shown.body.eligible as any[]).find((c) => c.requestId === one.requestId);
    expect(first.digest).toBe(await approvalDigest(one.bot.threadId, one.requestId, await cardById(one.bot.threadId, one.requestId)));
    expect(first.digest).toBe(await approvalDigest(one.bot.threadId, one.requestId, first.card));
    // a stop-line id the preview left out cannot be ticked in
    expect((await apply({ batchId: shown.body.batchId, requestIds: [one.requestId, stop.requestId] }, desktopHeaders)).body.code).toBe("bad_selection");
    const done = await apply({ batchId: shown.body.batchId, requestIds: [one.requestId, two.requestId] }, desktopHeaders);
    expect(done.status).toBe(200);
    expect(done.body.approved).toBe(2);
    expect((await cardById(one.bot.threadId, one.requestId)).answered).toBe("allow");
    expect((await cardById(two.bot.threadId, two.requestId)).answered).toBe("allow");
    expect((await cardById(stop.bot.threadId, stop.requestId)).answered).toBeUndefined();
    // used once
    expect((await apply({ batchId: shown.body.batchId, requestIds: [one.requestId] }, desktopHeaders)).body.code).toBe("batch_used");
    // audited as a bulk yes, never as user-approved
    // the audit log is written fire-and-forget: wait for both rows
    const rows = (await poll(async () => {
      const mine = (await decisions()).filter((r: any) => r.requestId === one.requestId || r.requestId === two.requestId);
      return mine.filter((r: any) => r.decision === "user-approved-bulk").length >= 2 ? mine : null;
    }, 10_000)) ?? [];
    expect(rows.filter((r: any) => r.decision === "user-approved-bulk")).toHaveLength(2);
    expect(rows.some((r: any) => r.decision === "user-approved")).toBe(false);
    expect(rows.find((r: any) => r.decision === "user-approved-bulk")).toMatchObject({ batchId: shown.body.batchId, batchSize: 2 });
    await desktopApi("POST", `/api/threads/${stop.bot.threadId}/respond`, { requestId: stop.requestId, behavior: "deny" });
  }, 240_000);

  it("a card answered after preview is skipped, not counted, and the rest still apply", async () => {
    const one = await askedBot("Bulk late one");
    const two = await askedBot("Bulk late two");
    const shown = await previewWith([one.requestId, two.requestId], desktopHeaders);
    expect((await desktopApi("POST", `/api/threads/${one.bot.threadId}/respond`, { requestId: one.requestId, behavior: "deny" })).status).toBe(200);
    const done = await apply({ batchId: shown.body.batchId, requestIds: [one.requestId, two.requestId] }, desktopHeaders);
    expect(done.body.approved).toBe(1);
    expect(done.body.results.find((r: any) => r.requestId === one.requestId)).toMatchObject({ result: "skipped", reason: "not-open" });
    expect((await cardById(one.bot.threadId, one.requestId)).answered).toBe("deny");
  }, 180_000);

  it("the phone signs exactly the ticked set once; a paired browser and a keyless app are refused", async () => {
    // card one needs a fresh proof on a single phone Allow, so the cross-use check below reaches the fresh-auth gate
    const one = await askedBot("Bulk phone one", "builder");
    const two = await askedBot("Bulk phone two");
    expect((await preview(pairedBrowser)).body.code).toBe("approve_on_computer");
    expect((await preview(appNoKey)).body.code).toBe("fresh_auth_unattested");
    // the same device headers without the door's own token are a loopback caller, not the phone. The suite's fetch
    // wrapper (server/testing/setup.ts) stamps the door token on any loopback /api/ request that lacks one, so these
    // two say x-test-bare-loopback to leave the request truly without it.
    const { "x-murage-door-token": _door, ...noDoor } = appWithKey;
    const doorless = await preview({ ...noDoor, "x-test-bare-loopback": "1" });
    expect([403, 404], JSON.stringify(doorless.body)).toContain(doorless.status);
    expect(doorless.body?.batchId).toBeUndefined();
    if (doorless.status === 403) expect(doorless.body.code).toBe("approve_needs_owner");
    const bare = await preview({ "x-murage-approval-device": DEVICE, "x-murage-approval-class": "app", "x-murage-approval-key": POINT, "x-test-bare-loopback": "1" });
    expect([403, 404], JSON.stringify(bare.body)).toContain(bare.status);
    expect(bare.body?.batchId).toBeUndefined();
    expect((await preview(companion)).status).toBe(403);
    const shown = await previewWith([one.requestId, two.requestId], appWithKey);
    expect(shown.status).toBe(200);
    const ticked = (shown.body.eligible as any[]).filter((c) => c.requestId === one.requestId || c.requestId === two.requestId);
    expect(ticked).toHaveLength(2);
    const requestIds = ticked.map((c) => c.requestId);
    // another surface cannot use this batch
    expect((await apply({ batchId: shown.body.batchId, requestIds }, desktopHeaders)).body.code).toBe("batch_unknown");
    const challenged = await apply({ batchId: shown.body.batchId, requestIds }, appWithKey);
    expect(challenged.status).toBe(403);
    expect(challenged.body.code).toBe("fresh_auth");
    const ch = challenged.body.challenge;
    // the phone recomputes the digest over what it shows
    expect(ch.digest).toBe(await approvalBatchDigest(shown.body.batchId, DEVICE, ticked.map((c) => [c.threadId, c.requestId, c.digest] as const)));
    // a proof over the batch never answers a single card. Card one is not low, so a single phone Allow on it needs a fresh
    // proof: first confirm the gate asks for one, then that the batch's signed proof does not pass it.
    // the LIVE card is not rated low (preview never sends lowRisk, so the preview's copy could not show it)
    expect((await cardById(one.bot.threadId, one.requestId)).lowRisk).not.toBe(true);
    // the phone is told its own device id, which its batch digest covers
    expect(shown.body.deviceId).toBe(DEVICE);
    const needsProof = await request("POST", `/api/threads/${one.bot.threadId}/respond`, { requestId: one.requestId, behavior: "allow" }, appWithKey);
    expect(needsProof.status, JSON.stringify(needsProof.body)).toBe(403);
    expect(needsProof.body.code).toBe("fresh_auth");
    const asCard = await request("POST", `/api/threads/${one.bot.threadId}/respond`, { requestId: one.requestId, behavior: "allow", freshAuth: { nonce: ch.nonce, signature: signFor(APPROVE_ALL_THREAD, shown.body.batchId, ch) } }, appWithKey);
    expect(asCard.body.ok).not.toBe(true);
    expect(asCard.status).toBe(403);
    expect(asCard.body.code).toBe("fresh_auth_failed");
    expect((await cardById(one.bot.threadId, one.requestId)).answered).toBeUndefined();
    // the respond route refuses the reserved thread id
    expect((await request("POST", `/api/threads/${APPROVE_ALL_THREAD}/respond`, { requestId: shown.body.batchId, behavior: "allow" }, desktopHeaders)).status).toBe(404);
    const fresh = (await apply({ batchId: shown.body.batchId, requestIds }, appWithKey)).body.challenge;
    // a proof for a different tick set does not apply this one
    const fewer = await apply({ batchId: shown.body.batchId, requestIds: [one.requestId], freshAuth: { nonce: fresh.nonce, signature: signFor(APPROVE_ALL_THREAD, shown.body.batchId, fresh) } }, appWithKey);
    expect(fewer.body.ok).not.toBe(true);
    const last = (await apply({ batchId: shown.body.batchId, requestIds }, appWithKey)).body.challenge;
    const done = await apply({ batchId: shown.body.batchId, requestIds, freshAuth: { nonce: last.nonce, signature: signFor(APPROVE_ALL_THREAD, shown.body.batchId, last) } }, appWithKey);
    expect(done.body).toMatchObject({ ok: true, approved: 2 });
    expect((await apply({ batchId: shown.body.batchId, requestIds, freshAuth: { nonce: last.nonce, signature: signFor(APPROVE_ALL_THREAD, shown.body.batchId, last) } }, appWithKey)).body.code).toBe("batch_used");
  }, 240_000);

  it("the bot respond route answers by the same rules as the thread route (BOT-RESPOND-ROUTE-UNIFY)", async () => {
    const one = await askedBot("Bot route one", "builder");
    const other = await askedBot("Bot route other");
    const botRespond = (botId: string, body: object, headers: Record<string, string>) => request("POST", `/api/bots/${botId}/respond`, body, headers);
    // another bot's thread is not this bot's to answer
    expect((await botRespond(one.bot.id, { threadId: other.bot.threadId, requestId: other.requestId, behavior: "allow" }, desktopHeaders)).status).toBe(404);
    expect((await cardById(other.bot.threadId, other.requestId)).answered).toBeUndefined();
    // a request nothing is waiting on gets the thread route's own answer
    const nothing = await botRespond(one.bot.id, { threadId: one.bot.threadId, requestId: "not-a-request", behavior: "allow" }, desktopHeaders);
    const nothingThread = await request("POST", `/api/threads/${one.bot.threadId}/respond`, { requestId: "not-a-request", behavior: "allow" }, desktopHeaders);
    expect([nothing.status, nothing.body?.outcome, nothing.body?.error]).toEqual([nothingThread.status, nothingThread.body?.outcome, nothingThread.body?.error]);
    // the phone app needs a fresh proof on a card that is not low, on both routes alike
    const viaBot = await botRespond(one.bot.id, { threadId: one.bot.threadId, requestId: one.requestId, behavior: "allow" }, appWithKey);
    const viaThread = await request("POST", `/api/threads/${one.bot.threadId}/respond`, { requestId: one.requestId, behavior: "allow" }, appWithKey);
    expect(viaBot.status, JSON.stringify(viaBot.body)).toBe(403);
    expect(viaBot.body.code).toBe("fresh_auth");
    expect([viaThread.status, viaThread.body?.code]).toEqual([403, "fresh_auth"]);
    expect((await cardById(one.bot.threadId, one.requestId)).answered).toBeUndefined();
    // the desktop's Allow lands once
    const allowed = await botRespond(one.bot.id, { threadId: one.bot.threadId, requestId: one.requestId, behavior: "allow" }, desktopHeaders);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect((await cardById(one.bot.threadId, one.requestId)).answered).toBe("allow");
    await desktopApi("POST", `/api/threads/${other.bot.threadId}/respond`, { requestId: other.requestId, behavior: "deny" });
  }, 240_000);

  it("only the desktop app and the owner phone app show the button; the caution choice is one server pref they share", async () => {
    const surface = (headers: Record<string, string>) => request("POST", "/api/inbox/approve-all/surface", {}, headers);
    const caution = (dismissed: unknown, headers: Record<string, string>) => request("POST", "/api/inbox/approve-all/caution", { dismissed }, headers);
    expect((await surface(desktopHeaders)).body).toEqual({ show: true, app: "desktop", cautionDismissed: false });
    expect((await surface(appWithKey)).body).toEqual({ show: true, app: "phone", cautionDismissed: false });
    for (const headers of [pairedBrowser, appNoKey, companion, {}]) expect((await surface(headers)).body).toEqual({ show: false });
    // a browser or a keyless app cannot change it
    expect((await caution(true, pairedBrowser)).status).toBe(403);
    expect((await caution(true, appNoKey)).status).toBe(403);
    expect((await caution("yes", desktopHeaders)).status).toBe(400);
    // dismissed on the phone holds on the desktop, and Settings brings it back
    expect((await caution(true, appWithKey)).body).toEqual({ cautionDismissed: true });
    expect((await surface(desktopHeaders)).body.cautionDismissed).toBe(true);
    expect((await caution(false, desktopHeaders)).body).toEqual({ cautionDismissed: false });
    expect((await surface(appWithKey)).body.cautionDismissed).toBe(false);
  }, 60_000);

  it("Today's Calm | Detailed choice: the desktop and the keyed phone app save it over real HTTP; a browser and a keyless app only read it", async () => {
    const read = (headers: Record<string, string>) => request("GET", "/api/owner-prefs/today-view", undefined, headers);
    const save = (view: unknown, headers: Record<string, string>) => request("POST", "/api/owner-prefs/today-view", { view }, headers);
    expect((await read(desktopHeaders)).body).toEqual({ view: "calm", canSave: true });
    expect((await save("Detailed", desktopHeaders)).status).toBe(400);
    expect((await save("detailed", pairedBrowser)).status).toBe(403);
    expect((await save("detailed", appNoKey)).status).toBe(403);
    expect((await read(pairedBrowser)).body).toEqual({ view: "calm", canSave: false });
    expect((await save("detailed", appWithKey)).body).toEqual({ view: "detailed", canSave: true });
    expect((await read(desktopHeaders)).body).toEqual({ view: "detailed", canSave: true });
    expect((await read(appNoKey)).body).toEqual({ view: "detailed", canSave: false });
    expect((await request("POST", "/api/inbox/approve-all/surface", {}, desktopHeaders)).body.cautionDismissed).toBe(false);
  }, 60_000);

  it("the preview reads the page on screen: a later page and a snoozed card are previewed, never Approvals page 0 (RESIDUALS-1018-B row 6)", async () => {
    const one = await askedBot("Screen one");
    const two = await askedBot("Screen two");
    const mine = new Set([one.bot.threadId, two.bot.threadId]);
    const inbox = async (q: Record<string, string>) => (await desktopApi("GET", `/api/inbox?${new URLSearchParams({ view: "approvals", query: "", ...q })}`)).body;
    const rowKey = (item: any) => `${item.link.threadId}:${item.link.messageId}`;
    const keyOf = (card: any) => `${card.threadId}:${card.messageId}`;
    const previewOf = (screen: unknown) => request("POST", "/api/inbox/approve-all/preview", { screen }, desktopHeaders);
    // the Inbox projection follows the cards a moment later
    const all = await poll(async () => {
      const page = await inbox({ pageSize: "100" });
      return (page?.items ?? []).filter((item: any) => item.kind === "request" && mine.has(item.link?.threadId)).length === 2 ? page : null;
    }, 20_000);
    expect(all, "both cards reach Approvals").not.toBeNull();
    // page 2 of a one-row list: the preview lists exactly the row that page shows (the base previewed page 0 of 100)
    const second = ((await inbox({ page: "1", pageSize: "1" })).items as any[]).filter((item) => item.kind === "request");
    expect(second).toHaveLength(1);
    const paged = await previewOf({ view: "approvals", query: "", page: 1, pageSize: 1, includeSnoozed: false });
    expect(paged.status, JSON.stringify(paged.body)).toBe(200);
    expect((paged.body.eligible as any[]).length + (paged.body.excluded as any[]).length).toBe(1);
    expect((paged.body.eligible as any[]).map(keyOf).every((key) => key === rowKey(second[0]))).toBe(true);
    // Show snoozed: a snoozed ok card is in the preview of the list that shows it, and only there
    const target = (all!.items as any[]).find((item) => item.kind === "request" && item.link.threadId === one.bot.threadId);
    const snoozed = await desktopApi("POST", "/api/inbox/state", { id: target.id, version: target.version, snoozedUntil: Date.now() + 3_600_000 });
    expect(snoozed.status, JSON.stringify(snoozed.body)).toBe(200);
    const plain = await previewOf({ view: "approvals", query: "", page: 0, pageSize: 25, includeSnoozed: false });
    expect((plain.body.eligible as any[]).map(keyOf)).not.toContain(rowKey(target));
    expect((plain.body.eligible as any[]).map((card) => card.requestId)).toContain(two.requestId);
    const withSnoozed = await previewOf({ view: "approvals", query: "", page: 0, pageSize: 25, includeSnoozed: true });
    expect((withSnoozed.body.eligible as any[]).map(keyOf)).toContain(rowKey(target));
    // Needs you reads the same way
    const needsYou = await previewOf({ view: "decisions", query: "", page: 0, pageSize: 25, includeSnoozed: true });
    expect((needsYou.body.eligible as any[]).map(keyOf)).toContain(rowKey(target));
    // only the two lists that offer the button, and a well formed query; an empty body is still Approvals page 0
    for (const bad of [{ view: "routines", query: "", page: 0, pageSize: 25, includeSnoozed: false }, { view: "approvals", page: -1 },
      { view: "approvals", query: "", page: 0, pageSize: 500, includeSnoozed: false }, { view: "approvals", query: "", page: 0, pageSize: 25, includeSnoozed: "yes" }, "approvals"]) {
      const refused = await previewOf(bad);
      expect(refused.status, JSON.stringify(bad)).toBe(400);
      expect(refused.body.batchId).toBeUndefined();
    }
    expect((await request("POST", "/api/inbox/approve-all/preview", {}, desktopHeaders)).status).toBe(200);
    for (const asked of [one, two]) await desktopApi("POST", `/api/threads/${asked.bot.threadId}/respond`, { requestId: asked.requestId, behavior: "deny" });
  }, 240_000);
});
