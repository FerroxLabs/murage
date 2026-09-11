// Auto mode must not follow a turn that nobody started.
//
// The unit tests in auto-approve.test.ts pin the RULE; these pin the
// WIRING, which is the part that silently rots. Both of these pass if the
// unattended mark is never set, or set on the wrong key, or never read —
// so they are written to fail in exactly those cases:
//
//   1. a webhook delivery to a bot with auto mode ON must still produce an
//      approval card, not a silent auto-approval
//   2. and so must the turn that bot hands to a teammate — the gate has to
//      survive the peer-comms hop, or it protects the bot that read the
//      payload and releases the one that acts on it
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse } from "./testing/sse.ts";


const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
let base: string;
let desktopHeaders: Record<string, string>;
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess;
let home: string;
let stderr = "";

const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const api = (method: string, path: string, body?: unknown) => request(method, path, body);
const desktopApi = (method: string, path: string, body?: unknown) => request(method, path, body, desktopHeaders);
const makeBot = async (instanceId: string) => {
  const created = await api("POST", "/api/bots", { modelSelection: { instanceId, model: "fake-model" } });
  expect(created.status).toBe(201);
  return created.body.bot;
};

/** Poll a THREAD for a live permission card. A webhook runs in its own
 * detached task, so the card never appears on the bot's open conversation —
 * looking there is how you convince yourself this works when it doesn't. */
async function waitForCard(threadId: string, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { body } = await api("GET", `/api/threads/${threadId}/messages`);
    const card = (body.messages ?? []).find(
      (m: { kind: string; card?: { requestId?: string } }) => m.kind === "options" && m.card?.requestId,
    );
    if (card) return card;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** Delete a bot once its stopped threads have settled; a run that is still
 * tearing down answers 409 with the control that stops it. */
async function deleteBotWhenIdle(botId: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const result = await desktopApi("DELETE", `/api/bots/${botId}`);
    if (result.status !== 409 || Date.now() > deadline) return result;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** The detached task a webhook delivery created. */
async function waitForRunThread(runId: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { body } = await api("GET", "/api/routines");
    const run = (body.runs ?? []).find((r: { id: string }) => r.id === runId);
    if (run?.threadId) return run.threadId as string;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

posixOnly("unattended turns keep asking", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-unattended-"));
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(
      join(home, ".murage", "config.json"),
      JSON.stringify({
        instances: {
          // asks the client for permission mid-turn, which is exactly the
          // moment auto mode would normally answer on the human's behalf
          grok: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "permission" },
            config: { cli: FAKE_CLI, fullAuto: false },
          },
          // hands its work to a teammate, so the gate has to cross the hop
          delegator: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "delegate-peer" },
            config: { cli: FAKE_CLI, fullAuto: false },
          },
          // asks a teammate synchronously — the other comms path, and the
          // likelier one: a webhook bot pulling someone in for an answer
          asker: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "ask-peer" },
            config: { cli: FAKE_CLI, fullAuto: false },
          },
        },
      }),
    );
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home,
        USERPROFILE: home,
        MURAGE_PORT: String(port),
        MURAGE_WEBHOOK_PORT: String(port + 1),
        MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    const proof = await api("GET", "/api/desktop-secret");
    expect(proof.status).toBe(200);
    expect(proof.body.secret).toMatch(/^[a-f0-9]{64}$/);
    desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
    expect((await api("GET", "/api/config")).body.surface).toBe("remote");
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("keeps approval cards while applying private or disabled attention notifications", async () => {
    const events = await openSse(`${base}/api/events`);
    const bots: string[] = [], hooks: string[] = [], threads: Array<{ botId: string; threadId: string }> = [];
    const cleanupFailures: string[] = [];
    try {
      expect((await desktopApi("PATCH", "/api/config", { notifications: { attention: true, completion: true, failures: true, previewContent: false } })).status).toBe(200);
      const first = await makeBot("grok"); bots.push(first.id);
      await desktopApi("PATCH", `/api/bots/${first.id}`, { name: "Private identity canary", notifications: true, autoApprove: false });
      const trigger = async (botId: string) => {
        const hook = await desktopApi("POST", "/api/webhooks", { name: "Notification fixture", prompt: "Request permission", botId });
        expect(hook.status).toBe(201); hooks.push(hook.body.webhook.id);
        const delivered = await fetch(hook.body.credential.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "notification-check" }) });
        expect(delivered.status).toBe(202);
        const result = await delivered.json() as { runId: string };
        const threadId = await waitForRunThread(result.runId);
        expect(threadId).toBeTruthy();
        const card = await waitForCard(threadId!);
        expect(card?.card?.answered).toBeUndefined();
        expect(card?.card?.requestId).toBeTruthy();
        threads.push({ botId, threadId: threadId! });
        return threadId;
      };
      const firstThread = await trigger(first.id);
      const notice = await events.until(frame => frame.kind === "notify" && frame.notification.botId === first.id);
      expect(notice.notification).toMatchObject({ title: "Murage", botName: "", privatePreview: true, threadId: firstThread });
      expect(JSON.stringify(notice.notification)).not.toContain("Private identity canary");
      expect(notice.notification.avatarUrl).toBeUndefined();
      expect((await desktopApi("PATCH", "/api/config", { notifications: { attention: false } })).status).toBe(200);
      const second = await makeBot("grok"); bots.push(second.id);
      await desktopApi("PATCH", `/api/bots/${second.id}`, { notifications: true, autoApprove: false });
      await trigger(second.id);
      // A later frame on the same ordered SSE stream is a deterministic barrier
      // for any notification emitted while the permission card was produced.
      await desktopApi("PATCH", "/api/config", { profile: { name: "notification-delivery-barrier" } });
      await events.until(frame => frame.kind === "config" && frame.profile?.name === "notification-delivery-barrier");
      expect(events.frames.filter(frame => frame.kind === "notify" && frame.notification.botId === second.id)).toEqual([]);
      expect((await api("GET", "/api/config")).body.notifications).toMatchObject({ attention: false, previewContent: false });
    } finally {
      events.close();
      // Each webhook turn runs in its own thread beside the bot's chat, and a
      // bot with more than one thread refuses an untargeted Stop (independent
      // threads, 05cce991). Stop the webhook threads by name and make sure the
      // bots are really gone: a leaked busy bot becomes bots[0] for the next
      // test and turns its settings edit into a "choose a thread" refusal.
      // Cleanup records problems instead of throwing, so every step still runs
      // and a failure in the test body is never masked by a cleanup failure.
      for (const { botId, threadId } of threads) {
        const stopped = await api("POST", `/api/bots/${botId}/interrupt`, { threadId });
        if (stopped.status !== 200) cleanupFailures.push(`stop ${botId}/${threadId}: ${stopped.status}`);
      }
      for (const id of hooks) await desktopApi("DELETE", `/api/webhooks/${id}`);
      for (const id of bots) {
        const deleted = await deleteBotWhenIdle(id);
        if (deleted.status !== 200) cleanupFailures.push(`delete bot ${id}: ${deleted.status}`);
      }
      await desktopApi("PATCH", "/api/config", { notifications: { attention: true, completion: true, failures: true, previewContent: true }, profile: { name: "" } });
    }
    // Reached only when the body passed: a leaked busy bot would break the next test.
    expect(cleanupFailures).toEqual([]);
  }, 60_000);

  it(
    "still asks a human when a webhook starts the turn, even with auto mode on",
    async () => {
      const bots = await api("GET", "/api/bots");
      const bot = bots.body.bots[0];
      // auto mode ON: an attended turn would sail straight through
      expect(
        (
          await desktopApi("PATCH", `/api/bots/${bot.id}`, {
            autoApprove: true,
            modelSelection: { instanceId: "grok", model: "fake-model" },
          })
        ).status,
      ).toBe(200);

      const hook = await desktopApi("POST", "/api/webhooks", {
        name: "Nightly build",
        prompt: "Handle the incoming build event",
        botId: bot.id,
        runOn: "ember",
      });
      expect(hook.status).toBe(201);

      const delivered = await fetch(hook.body.credential.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "failed" }),
      });
      expect(delivered.status).toBe(202);
      const { runId } = (await delivered.json()) as { runId: string };

      const threadId = await waitForRunThread(runId);
      expect(threadId, "the webhook never started a task").toBeTruthy();

      // the request must reach a person: a card with a live requestId
      const card = await waitForCard(threadId!);
      expect(card, "a webhook turn auto-approved instead of asking").not.toBeNull();
      expect(card.card.requestId).toBeTruthy();
      // and it must not already be answered
      expect(card.card.answered).toBeUndefined();
    },
    60_000,
  );

  it(
    "keeps asking after the work is handed to a teammate",
    async () => {
      // A runs the webhook and delegates; B does the acting. Without the
      // mark crossing the hop, the gate protects the bot that READ the
      // payload and releases the bot that ACTS on it.
      const teammate = await makeBot("grok");
      expect((await desktopApi("PATCH", `/api/bots/${teammate.id}`, { name: "Teammate", autoApprove: true })).status).toBe(200);

      const delegator = await makeBot("delegator");
      expect((await desktopApi("PATCH", `/api/bots/${delegator.id}`, {
        name: "Delegator",
        autoApprove: true,
        modelSelection: { instanceId: "delegator", model: "fake-model" },
      })).status).toBe(200);

      const hook = await desktopApi("POST", "/api/webhooks", {
        name: "Handoff",
        prompt: "Ask the Teammate to handle this",
        botId: delegator.id,
        runOn: "ember",
      });
      expect(hook.status).toBe(201);

      const delivered = await fetch(hook.body.credential.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: "handoff" }),
      });
      expect(delivered.status).toBe(202);

      // the teammate's turn runs on ITS own thread, unattended by inheritance
      const deadline = Date.now() + 40_000;
      let card: { card?: { requestId?: string; answered?: string } } | null = null;
      while (Date.now() < deadline && !card) {
        const { body } = await api("GET", "/api/bots");
        const peer = body.bots.find((b: { id: string }) => b.id === teammate.id);
        card =
          peer?.messages?.find(
            (m: { kind: string; card?: { requestId?: string } }) => m.kind === "options" && m.card?.requestId,
          ) ?? null;
        if (!card) await new Promise((r) => setTimeout(r, 300));
      }
      expect(card, "the delegated turn auto-approved — the gate did not cross the hop").not.toBeNull();
      expect(card!.card!.answered).toBeUndefined();
    },
    90_000,
  );

  it(
    "keeps asking when the teammate is pulled in synchronously",
    async () => {
      // ask_bot rather than delegate_bot. Same hole, different door, and
      // this is the ordinary shape: a webhook bot asking someone a question
      // mid-turn. The fake asks whichever peer list_bots returns first, so
      // everything else is hidden to make the target deterministic.
      const existing = await api("GET", "/api/bots");
      for (const b of existing.body.bots) expect((await desktopApi("PATCH", `/api/bots/${b.id}`, { hidden: true })).status).toBe(200);

      const target = await makeBot("grok");
      expect((await desktopApi("PATCH", `/api/bots/${target.id}`, {
        name: "Answerer",
        autoApprove: true,
        modelSelection: { instanceId: "grok", model: "fake-model" },
      })).status).toBe(200);

      const asker = await makeBot("asker");
      expect((await desktopApi("PATCH", `/api/bots/${asker.id}`, {
        name: "Asker",
        autoApprove: true,
        hidden: true, // keep it out of its own peer list's way
        modelSelection: { instanceId: "asker", model: "fake-model" },
      })).status).toBe(200);

      const hook = await desktopApi("POST", "/api/webhooks", {
        name: "Ask a teammate",
        prompt: "Ask the Answerer what to do about this",
        botId: asker.id,
        runOn: "ember",
      });
      expect(hook.status).toBe(201);
      const delivered = await fetch(hook.body.credential.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: "ask" }),
      });
      expect(delivered.status).toBe(202);

      const deadline = Date.now() + 40_000;
      let card: { card?: { requestId?: string; answered?: string } } | null = null;
      while (Date.now() < deadline && !card) {
        const { body } = await api("GET", "/api/bots");
        const peer = body.bots.find((b: { id: string }) => b.id === target.id);
        card =
          peer?.messages?.find(
            (m: { kind: string; card?: { requestId?: string } }) => m.kind === "options" && m.card?.requestId,
          ) ?? null;
        if (!card) await new Promise((r) => setTimeout(r, 300));
      }
      expect(card, "the asked teammate auto-approved — ask_bot did not carry the gate").not.toBeNull();
      expect(card!.card!.answered).toBeUndefined();
    },
    90_000,
  );
});
