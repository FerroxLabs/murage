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
