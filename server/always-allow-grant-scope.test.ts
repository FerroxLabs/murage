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
// Two assertions, both against a booted server with fixtures on disk (the
// cards are seeded rather than driven out of an engine, the way this
// suite's sibling room fixtures in index.test.ts are, so the test is about
// the grant and not about a turn):
//
//   1. a grant answered on a ROOM card returns 200 and lands on the bot
//   2. a grant recorded from task A reaches a task created afterwards, and
//      a sibling task that already existed keeps its own list
//
// What a grant COVERS is not this file's subject: auto-approve.test.ts pins
// that the 0.1.54 destructive/sensitive guards still card every one of
// these keys.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const posixOnly = describe.skipIf(process.platform === "win32");

const GRANT_KEY = "shell:echo";
const ROOM_THREAD = "grant-room-thread";
const OWNER_THREAD = "grant-owner-thread";
const OUTSIDER_THREAD = "grant-outsider-thread";
// Test 2 uses a bot of its own: the room grant in test 1 already puts the key
// on that bot's defaults, and a task made afterwards would inherit it —
// which is the very thing test 2 exists to prove, so it must start clean.
const TASKS_THREAD = "grant-tasks-thread";

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
const cardFile = (cardId: string, from: { botId: string; name: string }) =>
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
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: {} }));
    writeFileSync(
      join(data, "bots.json"),
      JSON.stringify([
        bot("grant-owner", "Grant owner", OWNER_THREAD),
        bot("grant-outsider", "Grant outsider", OUTSIDER_THREAD),
        bot("grant-tasks", "Grant tasks", TASKS_THREAD),
      ]),
    );
    writeFileSync(
      join(data, "groups.json"),
      JSON.stringify([
        {
          id: "grant-room",
          threadId: ROOM_THREAD,
          name: "Grant room",
          // the outsider is deliberately NOT a member
          memberIds: ["grant-owner"],
          defaultResponder: { kind: "member", botId: "grant-owner" },
          bulletin: "",
          unread: false,
          createdAt: 3,
        },
      ]),
    );
    // the card the bot raised while answering in the room
    writeFileSync(
      join(data, `messages-${ROOM_THREAD}.json`),
      cardFile("room-card", { botId: "grant-owner", name: "Grant owner" }),
    );
    // and one on its own first task, for the inheritance case
    writeFileSync(
      join(data, `messages-${TASKS_THREAD}.json`),
      cardFile("own-card", { botId: "grant-tasks", name: "Grant tasks" }),
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
      const granted = await desktopApi("POST", "/api/bots/grant-owner/always-allow", {
        allowKey: GRANT_KEY,
        threadId: ROOM_THREAD,
      });
      expect(granted.status, `grant refused: ${JSON.stringify(granted.body)}`).toBe(200);
      expect(granted.body.bot.alwaysAllow).toContain(GRANT_KEY);
      // the durable default is the record a room turn's asker carries
      expect(storedBot("grant-owner").alwaysAllow).toContain(GRANT_KEY);

      // A room transcript is shared. Another member — or, as here, a bot
      // that is not even in the room — cannot be granted anything by a card
      // it did not raise.
      const outsider = await desktopApi("POST", "/api/bots/grant-outsider/always-allow", {
        allowKey: GRANT_KEY,
        threadId: ROOM_THREAD,
      });
      expect(outsider.status).not.toBe(200);
      expect(storedBot("grant-outsider").alwaysAllow ?? []).not.toContain(GRANT_KEY);
    },
    60_000,
  );

  it(
    "carries a grant into a task made afterwards, and leaves a sibling task alone",
    async () => {
      // a task that already exists when the grant is pressed keeps its own list
      const sibling = await desktopApi("POST", "/api/bots/grant-tasks/tasks", { title: "Sibling" });
      expect(sibling.status).toBe(201);
      const siblingThread = sibling.body.task.threadId as string;

      const granted = await desktopApi("POST", "/api/bots/grant-tasks/always-allow", {
        allowKey: GRANT_KEY,
        threadId: TASKS_THREAD,
      });
      expect(granted.status, `grant refused: ${JSON.stringify(granted.body)}`).toBe(200);

      const stored = storedBot("grant-tasks");
      // the task the grant was answered on has it
      expect(stored.tasks?.find((task) => task.threadId === TASKS_THREAD)?.alwaysAllow).toContain(GRANT_KEY);
      // the bot default has it, which is what a NEW task is seeded from
      expect(stored.alwaysAllow).toContain(GRANT_KEY);
      // and the sibling that already existed is untouched (preserveTaskSettings)
      expect(stored.tasks?.find((task) => task.threadId === siblingThread)?.alwaysAllow ?? []).not.toContain(GRANT_KEY);

      const later = await desktopApi("POST", "/api/bots/grant-tasks/tasks", { title: "Later" });
      expect(later.status).toBe(201);
      const laterThread = later.body.task.threadId as string;
      expect(
        storedBot("grant-tasks").tasks?.find((task) => task.threadId === laterThread)?.alwaysAllow,
        "a task created after the grant asked about it all over again",
      ).toContain(GRANT_KEY);
    },
    60_000,
  );
});
