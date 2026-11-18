// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIM-UI2-CLI2 (Rev 3.3 U4/V3): ONE real apply of the chat-scoped Approve all through the real server and respondToCard,
// with the fake ACP agent raising the card (same rig as approve-all-http.test.ts). HEADLESS ONLY: throwaway HOME, probed port.
import { sessionBoundAcpPermissionEnvironment } from "./testing/acp-permission-fixture.ts";
import { fixtureDisplayApi } from "./testing/display-fixture.ts";
import { fixturePlatformEnv, stopFixtureServer } from "./testing/platform-fixtures.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvalDigest } from "../shared/approval-digest.ts";
import { makeTestHome, removeTempDir } from "./testing/cleanup.ts";
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

const request = fixtureDisplayApi(() => join(home, ".murage", "messages.db"), async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
});
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


/** A bot in Ask mode waiting on an ordinary card: rated low (echoer, echo hi) or not low (builder, BUILD). */
async function askedBot(name: string, instanceId: "echoer" | "builder" | "multi" = "echoer") {
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


describe("Approve all in the chat (thread scope), real apply", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1], 19_299, 200);
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
            environment: sessionBoundAcpPermissionEnvironment({ FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_COMMAND: DELETE_OUTSIDE }),
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          echoer: {
            driver: "grokAgent",
            environment: sessionBoundAcpPermissionEnvironment({ FAKE_ACP_MODE: "permission" }),
            config: { cli: FAKE_CLI, fullAuto: false },
          },
          multi: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "fuigo-script", FAKE_ACP_MCP_CONNECT: "1", FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_AFTER_LIST: "1", FAKE_ACP_SCRIPT: JSON.stringify([1, 2, 3].map((n) => ({
              at: n * 50, request: { id: 9100 + n, method: "session/request_permission", params: {
                toolCall: { toolCallId: `bulk-${n}`, kind: "execute", title: `echo card-${n}`, rawInput: { command: `echo card-${n}` } },
                options: [{ optionId: "allow-once", kind: "allow_once", name: "Allow" }, { optionId: "deny", kind: "reject_once", name: "Deny" }],
              } },
            }))) },
            config: { cli: FAKE_CLI, fullAuto: false },
          },
          builder: {
            driver: "grokAgent",
            environment: sessionBoundAcpPermissionEnvironment({ FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_COMMAND: BUILD }),
            config: { cli: FAKE_CLI, fullAuto: false },
          },
        },
      }),
    );
    // This disposable server launches only fake ACP children, matching approve-all-http.test.ts.
    child = spawn(process.execPath, ["--import", "data:text/javascript,globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;", join(SERVER_DIR, "index.ts")], {
      windowsHide: true,
      cwd: join(SERVER_DIR, ".."),
      env: { ...fixturePlatformEnv(), NODE_ENV: "test",
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        MURAGE_PORT: String(port),
        MURAGE_WEBHOOK_PORT: String(port + 1),
        MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
        MURAGE_COMPANION_TOKEN: COMPANION_TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
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
    await stopFixtureServer(child);
    await removeTempDir(home);
  });

  const apply = (body: object, headers: Record<string, string>) => request("POST", "/api/inbox/approve-all/apply", body, headers);
  const decisions = async () => ((await desktopApi("GET", "/api/decisions?limit=500")).body?.decisions ?? []) as any[];


  const thread = (threadId: string, requestIds: string[]) => ({ thread: { threadId, requestIds } });

  it("the chat's Approve all: a thread preview of the card the real engine raised, one apply, the card answered through respondToCard and audited as bulk", async () => {
    const one = await askedBot("Thread bulk one");
    const other = await askedBot("Thread bulk other");
    expect(one.card.approvalScope).toBeNull(); // absent in the live event, normalized by the current journal
    // the preview is the thread's own: a forged id of the other thread is closed, never eligible
    const shown = await request("POST", "/api/inbox/approve-all/preview", thread(one.bot.threadId, [one.requestId, other.requestId]), desktopHeaders);
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({ scope: "thread", threadId: one.bot.threadId, later: [], excluded: [] });
    expect((shown.body.eligible as any[]).map((c) => c.requestId)).toEqual([one.requestId]);
    expect((shown.body.closed as any[]).map((c) => c.requestId)).toEqual([other.requestId]);
    expect(shown.body.eligible[0].digest).toBe(await approvalDigest(one.bot.threadId, one.requestId, await cardById(one.bot.threadId, one.requestId)));
    // the other thread's card cannot be ticked into this thread's batch
    expect((await apply({ batchId: shown.body.batchId, requestIds: [one.requestId, other.requestId] }, desktopHeaders)).body.code).toBe("bad_selection");
    const done = await apply({ batchId: shown.body.batchId, requestIds: [one.requestId] }, desktopHeaders);
    expect(done.status, stderr.slice(-800)).toBe(200);
    expect(done.body.approved).toBe(1);
    // MAIN RULING 1115-SOURCE-PINS (C): a settled card stores the behavior ("allow"), as approve-all-http.test.ts pins
    expect((await cardById(one.bot.threadId, one.requestId)).answered).toBe("allow");
    expect((await cardById(other.bot.threadId, other.requestId)).answered).toBeUndefined();
    expect((await apply({ batchId: shown.body.batchId, requestIds: [one.requestId] }, desktopHeaders)).body.code).toBe("batch_used");
    const rows = (await poll(async () => {
      const mine = (await decisions()).filter((r: any) => r.requestId === one.requestId);
      return mine.some((r: any) => r.decision === "user-approved-bulk") ? mine : null;
    }, 10_000)) ?? [];
    expect(rows.find((r: any) => r.decision === "user-approved-bulk")).toMatchObject({ batchId: shown.body.batchId, batchSize: 1 });
    expect(rows.some((r: any) => r.decision === "user-approved")).toBe(false);
    await desktopApi("POST", `/api/threads/${other.bot.threadId}/respond`, { requestId: other.requestId, behavior: "deny" });
  }, 240_000);
  for (const changed of [false, true]) it(`M3: real multi-card apply loop, middle card changed=${changed}`, async () => {
    const { bot } = await askedBot(`Multi ${changed}`, "multi");
    const cards = await poll(async () => {
      const rows = (await threadMessages(bot.threadId)).filter((m) => m.card?.requestId && m.card.answered === undefined);
      return rows.length === 3 ? rows : null;
    }, 60_000);
    expect(cards, stderr.slice(-1500)).not.toBeNull();
    const requestIds = cards!.map((m) => m.card.requestId as string);
    const shown = await desktopApi("POST", "/api/inbox/approve-all/preview", thread(bot.threadId, requestIds));
    expect(shown.status).toBe(200);
    expect(shown.body.scope).toBe("thread");
    expect(shown.body.eligible.map((c: any) => c.requestId)).toEqual(requestIds);
    if (changed) {
      expect((await desktopApi("POST", `/api/threads/${bot.threadId}/respond`, { requestId: requestIds[1], behavior: "deny" })).status).toBe(200);
    }
    const done = await apply({ batchId: shown.body.batchId, requestIds }, desktopHeaders);
    expect(done.status).toBe(200);
    expect(done.body.results.map((r: any) => r.result)).toEqual(changed ? ["approved", "skipped", "not-applied"] : ["approved", "approved", "approved"]);
    expect(done.body.approved).toBe(changed ? 1 : 3);
    if (changed) {
      expect(done.body.results[1].reason).toBe("not-open");
      expect(done.body.results[2].reason).toBe("batch-changed");
    }
    const answered = await Promise.all(requestIds.map((id) => cardById(bot.threadId, id)));
    // MAIN RULING 1115-SOURCE-PINS C: settled cards store the allow behavior, retaining all three per-card results.
    expect(answered.map((c) => c.answered)).toEqual(changed ? ["allow", "deny", undefined] : ["allow", "allow", "allow"]);
    const audit = (await decisions()).filter((r) => r.batchId === shown.body.batchId);
    expect(audit.filter((r) => r.decision === "user-approved-bulk").map((r) => r.requestId).sort()).toEqual((changed ? requestIds.slice(0, 1) : requestIds).sort());
    expect((await apply({ batchId: shown.body.batchId, requestIds }, desktopHeaders)).body.code).toBe("batch_used");
    await desktopApi("POST", `/api/bots/${bot.id}/stop`, { threadId: bot.threadId });
  }, 240_000);

});
