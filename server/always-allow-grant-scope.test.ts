// Where an "Always allow" grant is REMEMBERED, over the real HTTP surface.
//
// 0.1.54 wrote the grant only to the task that happened to be open, while
// every path that asks again reads the bot's own defaults: `createTask`
// seeds a new task from `bot.alwaysAllow`, and a room turn's asker IS the
// bot record. The route also refused any thread that was not one of the
// bot's own tasks, so pressing "Always allow" on a card the bot raised in a
// room answered 404 while the client still offered the button — the grant
// vanished and the identical card came back on the next turn, forever.
//
// Every card here except the two older-build ones is raised live by the fake
// ACP engine asking to run `echo hi`, so an engine still holds each request:
// AMEND-13 Rule 81a (Astra a13 r1 item 4) saves a grant only from a live
// request, with or without `answer`.
//
//   1. a grant answered on a ROOM card returns 200 and lands on the bot
//   2. a grant recorded from task A reaches a task created afterwards, and
//      a sibling task that already existed keeps its own list
//
// What a grant COVERS is not this file's subject: auto-approve.test.ts pins
// that the 0.1.54 destructive/sensitive guards still card every one of
// these keys.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const posixOnly = describe.skipIf(process.platform === "win32");

const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");

// the narrow grant a live `echo hi` card offers
const GRANT_KEY = "shell:echo";
// A Fuigo connected-app card: one built before 1.0.3 offered the bare kind,
// which covered every connected-app action; one built now names the action.
// Both are seeded on disk: no test engine mounts connected apps.
const BROAD_THREAD = "grant-broad-thread";
const APP_THREAD = "grant-app-thread";
const APP_KEY = "app-action:GMAIL_FETCH_EMAILS";

let base: string;
let child: ChildProcess;
let home: string;
let stderr = "";
let desktopHeaders: Record<string, string>;

const request = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const api = (method: string, path: string, body?: unknown) => request(method, path, body);
const desktopApi = (method: string, path: string, body?: unknown) => request(method, path, body, desktopHeaders);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function poll<T>(read: () => Promise<T | null>, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(200);
  }
}
const threadMessages = async (threadId: string) => ((await desktopApi("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as any[];
const openCard = async (threadId: string) => (await threadMessages(threadId)).find((m) => m.kind === "options" && m.card?.requestId && !m.card.answered && !m.card.dismissed) ?? null;
/** A bot on the fake engine, nothing else switched on. */
async function makeBot(name: string) {
  const created = await desktopApi("POST", "/api/bots", { name, modelSelection: { instanceId: "asker", model: "fake-model" } });
  expect(created.status).toBe(201);
  expect((await desktopApi("PATCH", `/api/bots/${created.body.bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return created.body.bot as { id: string; threadId: string };
}
/** The live card the bot raised on its own task: an engine still holds it. */
async function liveTaskCard(botId: string, threadId: string) {
  expect((await desktopApi("POST", `/api/bots/${botId}/messages`, { threadId, text: "say hi" })).status).toBe(202);
  const card = await poll(() => openCard(threadId), 20_000);
  expect(card, `no card. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
  return card.card as { requestId: string; allowKey?: string; exactAllowKey?: string };
}
// "Always allow this exact command here" (shared/exact-command.ts), from test 3
let exactBot = "";
let exactThread = "";
let exactKey = "";

/** The durable bot default, read straight off disk — the record `createTask`
 * seeds from and a room turn's asker carries. */
function storedBot(id: string): { alwaysAllow?: string[]; tasks?: { threadId: string; alwaysAllow?: string[] }[] } {
  const bots = JSON.parse(readFileSync(join(home, ".murage", "bots.json"), "utf8")) as Array<{ id: string }>;
  return bots.find((entry) => entry.id === id) as never;
}

const bot = (id: string, name: string, threadId: string) => ({
  id,
  threadId,
  name,
  title: "",
  description: "",
  notifications: true,
  color: "blue",
  unread: false,
  modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
  resumeCursors: {},
  createdAt: 1,
});

/** One unanswered permission card, the shape the request.opened fold writes
 * (server/index.ts): a requestId, the tool, and the narrow allowKey. */
const cardFile = (cardId: string, from: { botId: string; name: string }, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    activeLeafId: cardId,
    messages: [
      {
        id: cardId,
        at: 3,
        parentId: null,
        role: "bot",
        kind: "options",
        card: {
          title: "Approval needed",
          subtitle: "echo hi",
          options: ["Allow", "Deny"],
          requestId: `${cardId}-request`,
          tool: "shell",
          allowKey: GRANT_KEY,
          ...extra,
        },
        from: { ...from, color: "purple" },
      },
    ],
  });

posixOnly("an always-allow grant is remembered for the bot", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    home = mkdtempSync(join(tmpdir(), "murage-grant-scope-e2e-"));
    const data = join(home, ".murage");
    mkdirSync(data, { recursive: true });
    chmodSync(FAKE_CLI, 0o755);
    writeFileSync(join(data, "config.json"), JSON.stringify({
      instances: {
        asker: {
          driver: "grokAgent",
          environment: { FAKE_ACP_MODE: "permission" },
          config: { cli: FAKE_CLI, fullAuto: false },
        },
      },
    }));
    writeFileSync(
      join(data, "bots.json"),
      JSON.stringify([
        bot("grant-broad", "Grant broad", BROAD_THREAD),
        bot("grant-app", "Grant app", APP_THREAD),
      ]),
    );
    writeFileSync(
      join(data, `messages-${BROAD_THREAD}.json`),
      cardFile("broad-card", { botId: "grant-broad", name: "Grant broad" }, { tool: "other", allowKey: "other" }),
    );
    writeFileSync(
      join(data, `messages-${APP_THREAD}.json`),
      cardFile("app-card", { botId: "grant-app", name: "Grant app" }, { tool: "other", allowKey: APP_KEY }),
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
    child.stderr!.on("data", (chunk) => (stderr += chunk));
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
    desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it(
    "takes the grant from a card the bot raised in a room, and keeps it on the bot",
    async () => {
      // A room card's thread is the ROOM's, never one of the bot's tasks.
      // 0.1.54 answered this with 404 "No such thread for this bot." while
      // the client happily rendered the button, so the same card returned
      // every turn.
      const owner = await makeBot("Grant owner");
      const peer = await makeBot("Grant peer");
      // the outsider is deliberately NOT a member
      const outsiderBot = await makeBot("Grant outsider");
      const group = await desktopApi("POST", "/api/groups", { name: "Grant room", memberIds: [owner.id, peer.id], setup: { bulletin: "Fixture only", defaultResponder: { kind: "member", botId: owner.id } } });
      expect(group.status, JSON.stringify(group.body)).toBe(201);
      const room = group.body.group as { id: string; threadId: string };
      expect((await desktopApi("POST", `/api/groups/${room.id}/messages`, { text: "say hi" })).status).toBe(202);
      // the card the bot raised while answering in the room, still held by its engine
      const card = await poll(() => openCard(room.threadId), 20_000);
      expect(card, `no room card. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
      expect(card.from?.botId).toBe(owner.id);
      expect(card.card.allowKey).toBe(GRANT_KEY);

      const granted = await desktopApi("POST", `/api/bots/${owner.id}/always-allow`, { answer: true,
        allowKey: GRANT_KEY,
        threadId: room.threadId,
        requestId: card.card.requestId,
      });
      expect(granted.status, `grant refused: ${JSON.stringify(granted.body)}`).toBe(200);
      expect(granted.body.bot.alwaysAllow).toContain(GRANT_KEY);
      // the durable default is the record a room turn's asker carries
      expect(storedBot(owner.id).alwaysAllow).toContain(GRANT_KEY);

      // A room transcript is shared. Another member — or, as here, a bot
      // that is not even in the room — cannot be granted anything by a card
      // it did not raise.
      const outsider = await desktopApi("POST", `/api/bots/${outsiderBot.id}/always-allow`, { answer: true,
        allowKey: GRANT_KEY,
        threadId: room.threadId,
        requestId: card.card.requestId,
      });
      expect(outsider.status).not.toBe(200);
      expect(storedBot(outsiderBot.id).alwaysAllow ?? []).not.toContain(GRANT_KEY);
      const member = await desktopApi("POST", `/api/bots/${peer.id}/always-allow`, { answer: true,
        allowKey: GRANT_KEY,
        threadId: room.threadId,
        requestId: card.card.requestId,
      });
      expect(member.status).not.toBe(200);
      expect(storedBot(peer.id).alwaysAllow ?? []).not.toContain(GRANT_KEY);
      expect((await desktopApi("POST", `/api/threads/${room.threadId}/respond`, { requestId: card.card.requestId, behavior: "allow" })).status).toBe(200);
    },
    60_000,
  );

  it(
    "carries a grant into a task made afterwards, and leaves a sibling task alone",
    async () => {
      // Its own bot: the room grant above puts the key on that bot's
      // defaults, and a task made afterwards would inherit it, which is the
      // very thing this test exists to prove, so it must start clean.
      const tasksBot = await makeBot("Grant tasks");
      // a task that already exists when the grant is pressed keeps its own list
      const sibling = await desktopApi("POST", `/api/bots/${tasksBot.id}/tasks`, { title: "Sibling" });
      expect(sibling.status).toBe(201);
      const siblingThread = sibling.body.task.threadId as string;

      const card = await liveTaskCard(tasksBot.id, tasksBot.threadId);
      const granted = await desktopApi("POST", `/api/bots/${tasksBot.id}/always-allow`, { answer: true,
        allowKey: GRANT_KEY,
        threadId: tasksBot.threadId,
        requestId: card.requestId,
      });
      expect(granted.status, `grant refused: ${JSON.stringify(granted.body)}`).toBe(200);

      const stored = storedBot(tasksBot.id);
      // the task the grant was answered on has it
      expect(stored.tasks?.find((task) => task.threadId === tasksBot.threadId)?.alwaysAllow).toContain(GRANT_KEY);
      // the bot default has it, which is what a NEW task is seeded from
      expect(stored.alwaysAllow).toContain(GRANT_KEY);
      // and the sibling that already existed is untouched (preserveTaskSettings)
      expect(stored.tasks?.find((task) => task.threadId === siblingThread)?.alwaysAllow ?? []).not.toContain(GRANT_KEY);
      expect((await desktopApi("POST", `/api/threads/${tasksBot.threadId}/respond`, { requestId: card.requestId, behavior: "allow" })).status).toBe(200);

      const later = await desktopApi("POST", `/api/bots/${tasksBot.id}/tasks`, { title: "Later" });
      expect(later.status).toBe(201);
      const laterThread = later.body.task.threadId as string;
      expect(
        storedBot(tasksBot.id).tasks?.find((task) => task.threadId === laterThread)?.alwaysAllow,
        "a task created after the grant asked about it all over again",
      ).toContain(GRANT_KEY);
    },
    60_000,
  );

  it(
    "remembers the exact command a card offered, and nothing the card did not offer",
    async () => {
      const created = await makeBot("Grant exact");
      exactBot = created.id;
      exactThread = created.threadId;
      const card = await liveTaskCard(exactBot, exactThread);
      exactKey = card.exactAllowKey as string;
      expect(exactKey).toMatch(/^exact:/);
      const parts = JSON.parse(exactKey.slice("exact:".length)) as string[];
      const other = `exact:${JSON.stringify([...parts.slice(0, -1), "npm publish"])}`;
      const refused = await desktopApi("POST", `/api/bots/${exactBot}/always-allow`, { answer: true, allowKey: other, threadId: exactThread, requestId: card.requestId });
      expect(refused.status).toBe(409);
      // from a phone or the browser door the route does not exist
      const remote = await request("POST", `/api/bots/${exactBot}/always-allow`, { answer: true, allowKey: exactKey, threadId: exactThread, requestId: card.requestId }, { "x-murage-companion": "1" });
      expect(remote.status).toBe(404);
      expect(storedBot(exactBot).alwaysAllow ?? []).not.toContain(exactKey);

      const granted = await desktopApi("POST", `/api/bots/${exactBot}/always-allow`, { answer: true, allowKey: exactKey, threadId: exactThread, requestId: card.requestId });
      expect(granted.status, `grant refused: ${JSON.stringify(granted.body)}`).toBe(200);
      const stored = storedBot(exactBot);
      expect(stored.alwaysAllow).toContain(exactKey);
      expect(stored.tasks?.find((task) => task.threadId === exactThread)?.alwaysAllow).toContain(exactKey);
      expect((await desktopApi("POST", `/api/threads/${exactThread}/respond`, { requestId: card.requestId, behavior: "allow" })).status).toBe(200);
    },
    60_000,
  );

  it(
    "removes a remembered grant from the bot and every task, from the desktop only",
    async () => {
      expect(exactKey, "the exact grant test above did not run").toMatch(/^exact:/);
      const later = await desktopApi("POST", `/api/bots/${exactBot}/tasks`, { title: "Later" });
      expect(later.status).toBe(201);
      const laterThread = later.body.task.threadId as string;
      expect(storedBot(exactBot).tasks?.find((task) => task.threadId === laterThread)?.alwaysAllow).toContain(exactKey);

      for (const headers of [{}, { "x-murage-companion": "1" }] as Record<string, string>[]) {
        const remote = await request("POST", `/api/bots/${exactBot}/always-allow/remove`, { key: exactKey }, headers);
        expect(remote.status).toBe(404);
      }
      expect(storedBot(exactBot).alwaysAllow).toContain(exactKey);

      expect((await desktopApi("POST", `/api/bots/${exactBot}/always-allow/remove`, {})).status).toBe(400);
      const removed = await desktopApi("POST", `/api/bots/${exactBot}/always-allow/remove`, { key: exactKey });
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      expect(removed.body.bot.alwaysAllow).not.toContain(exactKey);
      const stored = storedBot(exactBot);
      expect(stored.alwaysAllow ?? []).not.toContain(exactKey);
      for (const task of stored.tasks ?? []) expect(task.alwaysAllow ?? []).not.toContain(exactKey);
    },
    60_000,
  );

  it(
    "never stores a grant over every connected-app action, even from a card an older build rendered",
    async () => {
      const broad = await desktopApi("POST", "/api/bots/grant-broad/always-allow", { answer: true, allowKey: "other", threadId: BROAD_THREAD, requestId: "broad-card-request" });
      expect(broad.status).toBe(400);
      expect(storedBot("grant-broad").alwaysAllow ?? []).not.toContain("other");
      // nor through the settings patch, which keeps the one named action
      const patched = await desktopApi("PATCH", "/api/bots/grant-broad", { alwaysAllow: ["other", "mcp__murage_connectors__APPS_MULTI_EXECUTE_TOOL", APP_KEY] });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      expect(storedBot("grant-broad").alwaysAllow).toEqual([APP_KEY]);

      // A card naming one action passes every filter above and matches its
      // offer; this seeded one is refused only because no engine still holds
      // it (Rule 81a, Astra a13 r1 item 4), so nothing is saved.
      const orphan = await desktopApi("POST", "/api/bots/grant-app/always-allow", { answer: true, allowKey: APP_KEY, threadId: APP_THREAD, requestId: "app-card-request" });
      expect(orphan.status, JSON.stringify(orphan.body)).toBe(409);
      expect(orphan.body.error).toBe("This request is no longer waiting.");
      expect(storedBot("grant-app").alwaysAllow ?? []).toEqual([]);
    },
    60_000,
  );
});
