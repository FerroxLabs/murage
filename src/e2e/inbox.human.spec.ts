import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { inboxRequest, initializeInbox, type InboxAccess } from "../../server/inbox.ts";
import type { InboxQuery, InboxStateUpdate } from "../../shared/inbox.ts";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

let vite: ViteDevServer, origin: string, root: string, db: DatabaseSync;
/** Engines here and signed out of (GET /api/setup), and what was turned off. */
let signedOut: Array<{ id: string; name: string; signInCommand?: string }> = [];
const turnedOff: string[] = [];
const proof = "inbox-fixture-proof";
const scope: InboxAccess = { owner: true, threads: [{ threadId: "old-task", label: "Research bot", botId: "research" }] };
function source(id: string, kind: string, content: Record<string, unknown>, thread = "old-task", at = Date.now()) {
  const json = JSON.stringify({ id, role: "bot", kind, at, ...content });
  db.prepare("INSERT OR REPLACE INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,'bot',?,NULL,?)").run(thread, id, at, kind, json);
}
test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "murage-inbox-browser-"));
  db = new DatabaseSync(join(root, "messages.db"));
  db.exec("CREATE TABLE messages(thread_id TEXT,id TEXT,at INTEGER,role TEXT,kind TEXT,text TEXT,json TEXT,PRIMARY KEY(thread_id,id))");
  initializeInbox(db);
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  vite = await createServer({ configFile: false, root: repo, envFile: false, cacheDir: join(root, "vite-cache"),
    resolve: { alias: { "@": join(repo, "src") } }, server: { host: "127.0.0.1", watch: null, hmr: false }, plugins: [react(), tailwindcss(), {
      name: "inbox-http-fixture",
      resolveId(id) { if (id === "/__inbox.js") return "\0inbox-fixture"; },
      load(id) { if (id !== "\0inbox-fixture") return; return `import React from 'react';import {createRoot} from 'react-dom/client';import {Inbox} from '/src/components/Inbox.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(Inbox,{onOpen:link=>{window.inboxOpened=link;}}));`; },
      configureServer(server) { server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://fixture");
        if (url.pathname === "/__inbox") { res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__inbox.js"></script>'); return; }
        if (url.pathname === "/api/desktop-secret") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ secret: proof })); return; }
        if (url.pathname === "/api/setup") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ steps: [], conversationLive: false, next: null, signedOutAgents: signedOut })); return;
        }
        const engine = /^\/api\/instances\/([\w.-]+)$/.exec(url.pathname);
        if (engine && req.method === "PATCH") {
          let body = ""; for await (const chunk of req) body += String(chunk);
          if (JSON.parse(body).enabled === false) { turnedOff.push(engine[1]); signedOut = signedOut.filter(row => row.id !== engine[1]); }
          res.setHeader("content-type", "application/json"); res.end("{}"); return;
        }
        // what the harness's connector-cards/:id/dismiss writes: the card's own "Not now"
        const dismiss = /^\/api\/bots\/([\w-]+)\/connector-cards\/([\w-]+)\/dismiss$/.exec(url.pathname);
        if (dismiss && req.method === "POST") {
          let body = ""; for await (const chunk of req) body += String(chunk);
          const { threadId } = JSON.parse(body);
          const row = db.prepare("SELECT json FROM messages WHERE thread_id=? AND id=?").get(threadId, dismiss[2]) as { json: string } | undefined;
          if (!row || dismiss[1] !== "research") { res.statusCode = 404; res.end("{}"); return; }
          const message = JSON.parse(row.json);
          db.prepare("UPDATE messages SET json=? WHERE thread_id=? AND id=?").run(JSON.stringify({ ...message, connector: { ...message.connector, dismissed: true } }), threadId, dismiss[2]);
          res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ dismissed: true })); return;
        }
        if (!url.pathname.startsWith("/api/inbox")) return next();
        let encoded = "";
        for await (const chunk of req) { encoded += String(chunk); if (encoded.length > 16_384) { res.statusCode = 413; res.end(); return; } }
        try {
          const query: InboxQuery = { view: (url.searchParams.get("view") ?? "needs-you") as InboxQuery["view"], query: url.searchParams.get("query") ?? "", page: Number(url.searchParams.get("page") ?? 0), pageSize: Number(url.searchParams.get("pageSize") ?? 25), includeSnoozed: url.searchParams.get("includeSnoozed") === "true" };
          const response = inboxRequest(db, { method: req.method ?? "GET", path: url.pathname, query, body: encoded ? JSON.parse(encoded) as InboxStateUpdate : undefined }, { ...scope, owner: req.headers["x-murage-surface"] === "desktop" && req.headers["x-murage-surface-secret"] === proof });
          res.statusCode = response.status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(response.body));
        } catch { res.statusCode = 500; res.end(JSON.stringify({ error: "Fixture request failed" })); }
      }); },
    }] });
  await vite.listen(0); const address = vite.httpServer!.address();
  if (!address || typeof address === "string") throw Error("Inbox fixture did not bind");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await vite?.close(); db?.close(); if (root) safeWipeSync(root); });
test.beforeEach(() => {
  db.exec("DELETE FROM messages WHERE thread_id IN ('old-task','not-permitted'); DELETE FROM inbox_item_state WHERE json_extract(source_key,'$[0]')='old-task';");
  source("approval", "options", { card: { requestId: "approval-request", title: "SECRET_CARD_CONTENT", subtitle: "PRIVATE_COMMAND", tool: "Bash", options: ["Allow", "Deny"] } });
  source("credential", "secret", { secret: { requestKey: "connection-key", label: "SECRET_CREDENTIAL_LABEL", description: "SECRET_CREDENTIAL_BODY" } });
  source("private", "options", { card: { requestId: "private-request" } }, "not-permitted");
  source("quiet", "routine.run", { routineRun: { runId: "quiet", status: "completed" } });
  for (let i = 0; i < 28; i++) source(`report-${i}`, "routine.run", { routineRun: { runId: `run-${i}`, status: "completed", routineName: `Daily research ${i}`, summary: `Found ${i + 1} relevant updates.` } }, "old-task", 1_800_000_000_000 + i);
});

for (const skin of ["light", "dark"]) for (const width of [390, 1440]) {
  test(`persistent source actions and exact report links at ${width}px ${skin}`, async ({ page, request }, testInfo) => {
    expect((await request.get(origin + "/api/inbox")).status()).toBe(404);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin + "/__inbox");
    await page.evaluate(skin => document.documentElement.dataset.skin = skin, skin);
    await expect(page.getByRole("button", { name: "Needs you (2)", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Approval requested", exact: true })).toBeVisible();
    await expect(page.getByText(/SECRET_CARD_CONTENT|PRIVATE_COMMAND|SECRET_CREDENTIAL/)).toHaveCount(0);
    const card = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Approval requested", exact: true }) });
    await card.getByRole("button", { name: "Mark read", exact: true }).click();
    await expect(card.getByText("Read", { exact: true })).toBeVisible();
    await expect(card.getByText("Pending", { exact: true })).toBeVisible();
    await page.reload();
    await page.evaluate(skin => document.documentElement.dataset.skin = skin, skin);
    await expect(card.getByText("Read", { exact: true })).toBeVisible();
    expect(JSON.parse(String(db.prepare("SELECT json FROM messages WHERE id='approval'").get()!.json)).card.answered).toBeUndefined();
    await card.getByRole("button", { name: "Snooze 1 hour", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Approval requested", exact: true })).toHaveCount(0);
    await page.getByRole("checkbox", { name: "Show snoozed items" }).check();
    await expect(card.getByRole("button", { name: "Return to Inbox" })).toBeVisible();
    await card.getByRole("button", { name: "Return to Inbox" }).click();
    await expect(card.getByRole("button", { name: "Snooze 1 hour" })).toBeVisible();
    await card.getByRole("button", { name: "Open request" }).click();
    expect(await page.evaluate(() => (window as unknown as { inboxOpened: unknown }).inboxOpened)).toEqual({ threadId: "old-task", messageId: "approval" });
    await page.getByRole("button", { name: "Results", exact: true }).click();
    await expect(page.getByRole("listitem")).toHaveCount(25);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByRole("listitem")).toHaveCount(3);
    await page.getByRole("searchbox", { name: "Search Inbox" }).fill("Daily research 27");
    await page.getByRole("searchbox", { name: "Search Inbox" }).press("Enter");
    await expect(page.getByRole("listitem")).toHaveCount(1);
    await page.getByRole("button", { name: "Open report", exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { inboxOpened: unknown }).inboxOpened)).toEqual({ threadId: "old-task", messageId: "report-27", runId: "run-27" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.dataset.skin)).toBe(skin);
    await page.screenshot({ path: testInfo.outputPath(`inbox-${width}-${skin}.png`), fullPage: true });
  });
}

test("old requests to connect an app can be dismissed, one or all, and an engine the owner does not use can be turned off", async ({ page }) => {
  const days = 24 * 60 * 60 * 1000;
  for (const [id, slug] of [["connect-1", "trustpilot"], ["connect-2", "gmail"], ["connect-3", "slack"]]) {
    source(id, "connector", { connector: { resumeKey: `resume-${id}`, slug, status: "required", label: slug, description: "Connect it" } }, "old-task", Date.now() - 5 * days);
  }
  signedOut = [{ id: "opencode", name: "OpenCode", signInCommand: "opencode auth login" }];
  await page.goto(origin + "/__inbox");
  await page.getByRole("button", { name: /^Connections/ }).click();
  const requests = page.getByRole("listitem").filter({ hasText: "Connection setup" });
  await expect(requests).toHaveCount(3);

  // one
  await requests.first().getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(requests).toHaveCount(2);
  // the rest
  await page.getByRole("button", { name: "Dismiss all 2 connection requests" }).click();
  await expect(requests).toHaveCount(0);
  const dismissed = db.prepare("SELECT json FROM messages WHERE thread_id='old-task' AND kind='connector'").all() as Array<{ json: string }>;
  expect(dismissed.map(row => JSON.parse(row.json).connector.dismissed)).toEqual([true, true, true]);

  // an engine: asked first, then turned off, and its row goes
  const engine = page.getByRole("listitem").filter({ hasText: "OpenCode is here, and nobody is signed in to it." });
  await engine.getByRole("button", { name: "I don't use OpenCode" }).click();
  await expect(engine.getByText(/Turn off OpenCode\? Bots stop using it/)).toBeVisible();
  expect(turnedOff).toEqual([]);
  await engine.getByRole("button", { name: "Turn it off" }).click();
  await expect.poll(() => turnedOff).toEqual(["opencode"]);
  await expect(page.getByText("OpenCode is here, and nobody is signed in to it.")).toHaveCount(0, { timeout: 15_000 });
  signedOut = [];

  // a failed sign-in owes nothing: cleared, and gone until it fails again
  source("sign-in-failed", "activity", { tool: { name: "Setup needed", ok: false, authRequired: true, errorDetails: "Not signed in" } }, "old-task", Date.now() - 5 * 60 * 60 * 1000);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const failure = page.getByRole("listitem").filter({ hasText: "Sign in needed" });
  await expect(failure).toHaveCount(1);
  await failure.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(failure).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: /^Connections/ }).click();
  await expect(page.getByRole("heading", { name: "Sign in needed" })).toHaveCount(0);
});
