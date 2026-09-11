import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
import { freePortBlock } from "../../server/testing/ports";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

// A real insecure origin, mapped only inside this Chromium process. No OS
// DNS, tailnet, live harness, engine, or user data is involved. Unlike deleting
// randomUUID on localhost, this exercises the browser's actual API exposure.
test.use({ launchOptions: { args: ["--host-resolver-rules=MAP murage-http.test 127.0.0.1", "--no-proxy-server"] } });

let server: ViteDevServer;
let origin: string;
let cache: string;
let rejectFirst = false;
const requests: Array<{ path: string; text?: string; sendId?: string; threadId?: string; unread?: boolean; mode?: string }> = [];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const bot = { id: "bot-a", name: "Fixture bot", color: "blue", threadId: "thread-a", modelSelection: { instanceId: "fixture", model: "fixture" }, tasks: [], messages: [], description: "", title: "" };
const group = { id: "room-a", name: "Fixture room", threadId: "thread-room", memberIds: [bot.id], messages: [], defaultResponderId: bot.id };

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-http-send-vite-"));
  server = await createServer({
    configFile: false, root, envFile: false, cacheDir: cache,
    resolve: { alias: { "@": `${root}/src` } },
    server: {
      host: "127.0.0.1", strictPort: true, allowedHosts: ["murage-http.test"], watch: null, hmr: false,
    },
    plugins: [{
      name: "http-send-fixture",
      resolveId(id) { if (id === "/__send.js") return "\0http-send-fixture"; },
      load(id) {
        if (id !== "\0http-send-fixture") return;
        return `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { StoreProvider, useStore } from '/src/state/store.tsx';
          import { Composer } from '/src/components/Composer.tsx';
          function Probe() {
            const { state, dispatch } = useStore();
            const [task, setTask] = React.useState('A');
            const bot = state.bots[0], savedGroup = state.groups[0];
            const group = savedGroup && {...savedGroup, threadId: task === 'A' ? savedGroup.threadId : 'thread-room-b'};
            if (!bot || !group) return React.createElement('output', {}, 'loading');
            const room = new URL(location.href).searchParams.get('target') === 'room';
            return React.createElement(React.Fragment, {},
              React.createElement('output', {}, 'ready'),
              React.createElement('button', {onClick:()=>setTask('A')}, 'Task A'),
              React.createElement('button', {onClick:()=>setTask('B')}, 'Task B'),
              React.createElement('button', { onClick: () => dispatch({ type: 'markUnread', botId: bot.id }) }, 'Mark bot unread'),
              React.createElement('button', { onClick: () => dispatch({ type: 'select', id: bot.id }) }, 'Select bot'),
              React.createElement('button', { onClick: () => dispatch({ type: 'select', id: group.id }) }, 'Select room'),
              React.createElement('button', { onClick: () => dispatch(room
                ? { type: 'sendGroup', groupId: group.id, text: 'Direct fixture send' }
                : { type: 'send', botId: bot.id, text: 'Direct fixture send' }) }, 'Direct send'),
              React.createElement(Composer, room ? {key: task, group, members: [bot]} : {bot}));
          }
          createRoot(document.getElementById('root')).render(React.createElement(StoreProvider, {}, React.createElement(Probe)));
        `;
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          const path = new URL(req.url ?? "/", "http://fixture").pathname;
          const json = (body: unknown, status = 200) => {
            res.statusCode = status;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(body));
          };
          if (path === "/__send") {
            res.setHeader("content-type", "text/html");
            res.end('<div id="root"></div><script type="module" src="/__send.js"></script>');
          } else if (path === "/api/desktop-secret") json({ error: "Not found" }, 404);
          else if (path === "/api/events") { res.statusCode = 204; res.end(); }
          else if (path === "/api/bots") json({ bots: [{ ...bot, unread: true }], groups: [{ ...group, unread: true }] });
          else if (path === "/api/config") json({ surface: "remote", features: {}, rooms: { turnTimeoutMinutes: 5 } });
          else if (path === "/api/instances") json({ instances: [] });
          else if (path === "/api/routines") json({ routines: [], runs: [] });
          else if (path === "/api/webhooks") json({ webhooks: [], attempts: [] });
          else if (/^\/api\/(bots|groups)\/[^/]+\/read$/.test(path) && req.method === "POST") {
            let body = "";
            req.on("data", (chunk) => { body += chunk; });
            req.on("end", () => {
              const payload = JSON.parse(body || "{}");
              requests.push({ path, ...payload });
              json(path.includes("/bots/") ? { bot: { ...bot, unread: payload.unread ?? false } } : { group: { ...group, unread: payload.unread ?? false } });
            });
          } else if (/^\/api\/(bots|groups)\/[^/]+\/messages$/.test(path) && req.method === "POST") {
            let body = "";
            req.on("data", (chunk) => { body += chunk; });
            req.on("end", () => {
              const payload = JSON.parse(body);
              requests.push({ path, ...payload });
              if (rejectFirst && requests.length === 1) return json({ error: "Fixture transient failure" }, 503);
              json({ threadId: payload.threadId, message: { id: payload.sendId, at: Date.now(), role: "user", kind: "text", text: payload.text } });
            });
          } else if (path.startsWith("/api/")) json({ error: "Unexpected fixture route" }, 404);
          else next();
        });
      },
    }],
  });
  await server.listen(await freePortBlock([0]));
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("fixture has no TCP address");
  origin = `http://murage-http.test:${address.port}`;
});

test.afterAll(async () => { await server?.close(); if (cache) safeWipeSync(cache); });
test.beforeEach(() => { requests.length = 0; rejectFirst = false; });

test("room goal intent follows its draft through task switching and reload", async ({ page }) => {
  await page.goto(`${origin}/__send?target=room`);
  await expect(page.locator("output")).toHaveText("ready");
  const goal = page.getByRole("button", { name: "Finish together", exact: true });
  await page.getByRole("textbox").fill("Goal for task A");
  await goal.click();
  await expect(goal).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Task B", exact: true }).click();
  await expect(page.getByRole("textbox")).toHaveValue("");
  await expect(goal).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("textbox").fill("Chat for task B");
  await page.getByRole("button", { name: "Task A", exact: true }).click();
  await expect(page.getByRole("textbox")).toHaveValue("Goal for task A");
  await expect(goal).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(page.getByRole("textbox")).toHaveValue("Goal for task A");
  await expect(goal).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({ text: "Goal for task A", mode: "goal", threadId: "thread-room" });
  await expect(goal).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Task B", exact: true }).click();
  await expect(page.getByRole("textbox")).toHaveValue("Chat for task B");
  await expect(goal).toHaveAttribute("aria-pressed", "false");
});

for (const [button, path, body] of [
  ["Mark bot unread", "/api/bots/bot-a/read", { unread: true }],
  ["Select bot", "/api/bots/bot-a/read", {}],
  ["Select room", "/api/groups/room-a/read", {}],
] as const) {
  test(`remote ${button} uses the narrow read-state route`, async ({ page }) => {
    await page.goto(`${origin}/__send`);
    await expect(page.locator("output")).toHaveText("ready");
    await page.getByRole("button", { name: button, exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0]).toEqual({ path, ...body });
  });
}

for (const target of ["bot", "room"]) {
  for (const via of ["composer", "dispatch"]) {
    test(`HTTP ${target} send through ${via} generates a valid request ID`, async ({ page }) => {
      await page.goto(`${origin}/__send?target=${target}`);
      await expect(page.locator("output")).toHaveText("ready");
      expect(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID, random: typeof crypto.getRandomValues }))).toEqual({ secure: false, uuid: "undefined", random: "function" });
      if (via === "composer") {
        await page.getByRole("textbox").fill("Composer fixture send");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
      } else await page.getByRole("button", { name: "Direct send", exact: true }).click();
      await expect.poll(() => requests.length).toBe(1);
      expect(requests[0]).toMatchObject({
        path: target === "bot" ? "/api/bots/bot-a/messages" : "/api/groups/room-a/messages",
        threadId: target === "bot" ? bot.threadId : group.threadId,
        text: via === "composer" ? "Composer fixture send" : "Direct fixture send",
        sendId: expect.stringMatching(UUID_V4),
      });
    });
  }

  test(`HTTP ${target} retry preserves the original send ID`, async ({ page }) => {
    rejectFirst = true;
    await page.goto(`${origin}/__send?target=${target}`);
    await expect(page.locator("output")).toHaveText("ready");
    const input = page.getByRole("textbox");
    await input.fill("Keep this message");
    if (target === "room") await page.getByRole("button", { name: "Finish together", exact: true }).click();
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    await expect(input).toHaveValue("Keep this message");
    if (target === "room") {
      expect(requests[0].mode).toBe("goal");
      await expect(page.getByRole("button", { name: "Finish together", exact: true })).toHaveAttribute("aria-pressed", "true");
    }
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[0].sendId).toMatch(UUID_V4);
    expect(requests[1]).toEqual(requests[0]);
    await expect(input).toHaveValue("");
    if (target === "room") await expect(page.getByRole("button", { name: "Finish together", exact: true })).toHaveAttribute("aria-pressed", "false");
  });
}
