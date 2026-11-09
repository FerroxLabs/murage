// secret-scan: fixture (fake paths, policy test rows)
// NEEDSYOU-INLINE-APPROVE (1.0.18, Sean: "Now you are making the user do 2 clicks to get an approval"; on Today
// "still needs an Approve button on that card": the last three tests).
// The real Needs you door (Inbox in door mode) over the real Inbox projection: an approval row says what it
// approves and answers with ONE click, posting exactly what the open card's own Allow once / Deny post, and the
// row leaves at once. A card the open view would not settle with one plain press keeps Open only. A failed
// answer shows its reason on the row.
import { test, expect } from "./page-error-guard";
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
import { bulkEligibility, bulkKindKey } from "../../server/approve-all.ts";

let vite: ViteDevServer, origin: string, root: string, db: DatabaseSync;
/** An ordinary card of the owner's own turn, as the server stamps it at open (shared/fold-scopes.ts CardClass). */
const ORDINARY = { reason: "no-grant", unattended: false, origin: "owner" };
const proof = "needs-inline-proof";
const scope: InboxAccess = { owner: true, threads: [{ threadId: "sable-task", label: "Sable · Launch prep", botId: "sable" }] };
/** Every POST /respond body, in order. */
let answers: Array<Record<string, unknown>> = [];
/** requestIds whose /respond fails, with this reason. */
let failing = new Map<string, string>();
/** APPROVALS-SIMPLE-1018: Approve all's caution pref, the ids each apply answered, and preview rows to leave out. */
let cautionDismissed = true;
let applied: string[][] = [];
let previewDrop = new Set<string>();
/** A preview the test holds open until it calls release (Astra r2 High: a loading preview over a Refresh). */
let previewHold: { wait: Promise<void>; release: () => void } | null = null;
function holdPreview() {
  let release = () => {};
  const wait = new Promise<void>((done) => { release = done; });
  previewHold = { wait, release };
  return previewHold;
}
/** The caution's "Don't show again" save, held open by a test (Opus r2 High: the list moves during that POST), and how
 *  many times it was posted. */
let cautionHold: { wait: Promise<void>; release: () => void } | null = null;
let cautionPosts = 0;
function holdCaution() {
  let release = () => {};
  const wait = new Promise<void>((done) => { release = done; });
  cautionHold = { wait, release };
  return cautionHold;
}
/** Every card row (open ones only unless `all`). */
function openCards(all = false): Array<{ id: string; card: Record<string, unknown>; message: Record<string, unknown> }> {
  const rows = db.prepare("SELECT id, json FROM messages WHERE thread_id='sable-task'").all() as Array<{ id: string; json: string }>;
  return rows.map(({ id, json }) => { const message = JSON.parse(json) as Record<string, unknown>; return { id, card: message.card as Record<string, unknown>, message }; })
    .filter(({ card }) => card && (all || card.answered === undefined));
}

function card(id: string, at: number, content: Record<string, unknown>) {
  const json = JSON.stringify({ id, role: "bot", kind: "options", at, card: content });
  db.prepare("INSERT OR REPLACE INTO messages(thread_id,id,at,role,kind,text,json) VALUES('sable-task',?,?,'bot','options',NULL,?)").run(id, at, json);
}
async function body(req: AsyncIterable<unknown>): Promise<string> { let text = ""; for await (const chunk of req) text += String(chunk); return text; }

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "murage-needs-inline-"));
  db = new DatabaseSync(join(root, "messages.db"));
  db.exec("CREATE TABLE messages(thread_id TEXT,id TEXT,at INTEGER,role TEXT,kind TEXT,text TEXT,json TEXT,PRIMARY KEY(thread_id,id))");
  initializeInbox(db);
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  vite = await createServer({ configFile: false, root: repo, envFile: false, cacheDir: join(root, "vite-cache"),
    resolve: { alias: { "@": join(repo, "src") } }, server: { host: "127.0.0.1", watch: null, hmr: false }, plugins: [react(), tailwindcss(), {
      name: "needs-inline-fixture",
      resolveId(id) { if (id === "/__needs.js") return "\0needs-fixture"; if (id === "/__today.js") return "\0today-fixture"; },
      load(id) {
        if (id === "\0today-fixture") return `import React from 'react';import {createRoot} from 'react-dom/client';import {TodayQuickHarness} from '/src/e2e/today-quick-harness.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(TodayQuickHarness));`;
        if (id !== "\0needs-fixture") return; return `import React from 'react';import {createRoot} from 'react-dom/client';import {Inbox} from '/src/components/Inbox.tsx';import '/src/styles.css';const view=new URLSearchParams(location.search).get('view')||'decisions';createRoot(document.getElementById('root')).render(React.createElement(Inbox,{door:true,initialView:view,onOpen:link=>{window.opened=link;}}));`; },
      configureServer(server) { server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://fixture");
        const json = (status: number, value: unknown) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
        if (url.pathname === "/__needs") { res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__needs.js"></script>'); return; }
        if (url.pathname === "/__today") { res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__today.js"></script>'); return; }
        if (url.pathname === "/api/desktop-secret") return json(200, { secret: proof });
        if (url.pathname === "/api/config") return json(200, { surface: "desktop", computer: true });
        if (url.pathname === "/api/setup") return json(200, { steps: [], conversationLive: false, next: null, signedOutAgents: [] });
        const messages = /^\/api\/threads\/sable-task\/messages$/.exec(url.pathname);
        if (messages && req.method === "GET") {
          const row = db.prepare("SELECT json FROM messages WHERE thread_id='sable-task' AND id=?").get(url.searchParams.get("around")) as { json: string } | undefined;
          return json(200, { messages: row ? [JSON.parse(row.json)] : [] });
        }
        if (url.pathname === "/api/threads/sable-task/respond" && req.method === "POST") {
          const sent = JSON.parse(await body(req)) as Record<string, unknown>;
          answers.push(sent);
          const reason = failing.get(String(sent.requestId));
          if (reason) return json(409, { error: reason });
          const row = db.prepare("SELECT id, json FROM messages WHERE thread_id='sable-task' AND json_extract(json,'$.card.requestId')=?").get(String(sent.requestId)) as { id: string; json: string } | undefined;
          if (!row) return json(404, { error: "No such request" });
          const message = JSON.parse(row.json);
          db.prepare("UPDATE messages SET json=? WHERE thread_id='sable-task' AND id=?").run(JSON.stringify({ ...message, card: { ...message.card, answered: String(sent.behavior) } }), row.id);
          return json(200, { ok: true });
        }
        // Approve all: this surface shows it (the button keeps its own 2-or-more rule)
        if (url.pathname === "/api/inbox/approve-all/surface") return json(200, { show: true, app: "desktop", cautionDismissed });
        if (url.pathname === "/api/inbox/approve-all/caution") { cautionPosts += 1; if (cautionHold) await cautionHold.wait; return json(200, { cautionDismissed: true }); }
        // The preview lists the ok cards (less any a test drops, as if the list moved); apply answers the ids it is given.
        if (url.pathname === "/api/inbox/approve-all/preview") {
          if (previewHold) await previewHold.wait;
          const eligible = openCards().filter(({ card }) => bulkEligibility(card, String(card.requestId)).ok && !previewDrop.has(String(card.requestId)))
            .map(({ id, card }) => ({ threadId: "sable-task", requestId: card.requestId, messageId: id, botId: "sable", kindLine: bulkKindKey(String(card.tool)), ...(card.wants ? { wants: card.wants } : {}), digest: "", card: {} }));
          return json(200, { batchId: eligible.length ? "aab-fixture" : null, eligible, excluded: [], more: 0 });
        }
        if (url.pathname === "/api/inbox/approve-all/apply" && req.method === "POST") {
          const sent = JSON.parse(await body(req)) as { requestIds: string[] };
          applied.push(sent.requestIds);
          for (const { id, card, message } of openCards()) if (sent.requestIds.includes(String(card.requestId))) {
            db.prepare("UPDATE messages SET json=? WHERE thread_id='sable-task' AND id=?").run(JSON.stringify({ ...message, card: { ...card, answered: "allow" } }), id);
          }
          return json(200, { approved: sent.requestIds.length, results: sent.requestIds.map((requestId) => ({ threadId: "sable-task", requestId, result: "approved" })) });
        }
        if (!url.pathname.startsWith("/api/inbox")) return next();
        const encoded = await body(req);
        try {
          const query: InboxQuery = { view: (url.searchParams.get("view") ?? "decisions") as InboxQuery["view"], query: url.searchParams.get("query") ?? "", page: Number(url.searchParams.get("page") ?? 0), pageSize: Number(url.searchParams.get("pageSize") ?? 25), includeSnoozed: url.searchParams.get("includeSnoozed") === "true" };
          const response = inboxRequest(db, { method: req.method ?? "GET", path: url.pathname, query, body: encoded ? JSON.parse(encoded) as InboxStateUpdate : undefined }, { ...scope, owner: req.headers["x-murage-surface"] === "desktop" && req.headers["x-murage-surface-secret"] === proof });
          // the server's per-row stamp (server/index.ts withBulkStamp): the same bulkEligibility, and the plain kind
          const page = response.body as { items?: Array<{ kind: string; link?: { messageId: string } }> };
          if (Array.isArray(page?.items)) page.items = page.items.map((item) => {
            if (item.kind !== "request" || !item.link) return item;
            const found = openCards(true).find(({ id }) => id === item.link!.messageId)?.card;
            if (!found) return { ...item, bulk: "not-open" };
            const verdict = bulkEligibility(found, String(found.requestId));
            return { ...item, bulk: verdict.ok ? "ok" : verdict.reasonKey, ...(found.tool ? { toolKind: bulkKindKey(String(found.tool)) } : {}) };
          });
          json(response.status, response.body);
        } catch { json(500, { error: "Fixture request failed" }); }
      }); },
    }] });
  await vite.listen(0); const address = vite.httpServer!.address();
  if (!address || typeof address === "string") throw Error("Needs you fixture did not bind");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await vite?.close(); db?.close(); if (root) safeWipeSync(root); });
test.beforeEach(() => {
  answers = []; failing = new Map(); cautionDismissed = true; applied = []; previewDrop = new Set(); previewHold?.release(); previewHold = null; cautionHold?.release(); cautionHold = null; cautionPosts = 0;
  db.exec("DELETE FROM messages WHERE thread_id='sable-task'; DELETE FROM inbox_item_state WHERE json_extract(source_key,'$[0]')='sable-task';");
  const t0 = Date.now() - 60 * 60_000;
  // APPROVALS-SIMPLE-1018: each approval carries the bot's own `wants` (Claude's Bash description) and the class the
  // server stamps at open; rows are found by those words, because no command is on the first screen any more.
  card("push", t0, { requestId: "req-push", title: "Approval needed", subtitle: "git push origin main", wants: "Push main to GitHub", options: ["Allow", "Deny"], tool: "Bash", lowRisk: true, cardClass: ORDINARY });
  card("deploy", t0 + 1_000, { requestId: "req-deploy", title: "Approval needed", subtitle: "fly deploy --app launch-site", wants: "Deploy the launch site", options: ["Allow", "Deny"], tool: "Bash", lowRisk: true, cardClass: ORDINARY });
  card("delete", t0 + 2_000, { requestId: "req-delete", title: "Approval needed", subtitle: "rm -rf ~/Documents/old-drafts", wants: "Remove the old drafts folder", options: ["Allow", "Deny"], tool: "Bash", lowRisk: true, taskAllowKey: "stop:delete:/Users/ada/Documents", cardClass: { ...ORDINARY, reason: "stop-line", stop: { kind: "delete" } } });
  card("ask", t0 + 3_000, { requestId: "req-ask", title: "Question needs an answer", subtitle: "Post the launch thread now?", options: ["Yes", "Not yet"],
    questions: [{ id: "q1", question: "Post the launch thread now?", options: [{ label: "Yes" }, { label: "Not yet" }], multiSelect: false, allowOther: true }] });
  card("pick", t0 + 4_000, { requestId: "req-pick", title: "Question needs an answer", subtitle: "Which list?", options: ["A", "B", "C"],
    questions: [{ id: "q1", question: "Which list should get the email?", options: [{ label: "Customers" }, { label: "Press" }, { label: "Everyone" }], multiSelect: false, allowOther: false }] });
});

const row = (page: import("@playwright/test").Page, text: string) => page.locator("[data-needs-row]").filter({ hasText: text });
const approveAll = (page: import("@playwright/test").Page) => page.locator("button[data-approve-all]");

test("an approval row says what it approves and answers in one click, the same way the open card does", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(origin + "/__needs");
  const push = row(page, "Sable wants to push main to GitHub");
  await expect(push).toHaveCount(1);
  // WHAT the bot wants, in its words, never a blind "Approval requested", and no command on the first screen
  await expect(page.locator("[data-needs-row]").filter({ hasText: "Approval requested" })).toHaveCount(0);
  await expect(push).not.toContainText("git push origin main");
  await expect(push).toContainText("Runs a command · Sable · waiting since");
  await expect(page.locator("[data-needs-whole]")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("needs-inline-rows.png"), fullPage: true });

  // ONE click on the collapsed row
  const approve = push.getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toBeVisible();
  await expect(push.getByRole("group", { name: /push main to GitHub/ })).toBeVisible();
  await approve.click();
  await expect(push).toHaveCount(0);
  expect(answers).toEqual([{ requestId: "req-push", behavior: "allow" }]);

  // Show details opens the card with its command; its own Allow once posts the very same body.
  const deploy = row(page, "deploy the launch site");
  await deploy.getByRole("button", { name: "Show details", exact: true }).click();
  await expect(deploy).toContainText("fly deploy --app launch-site");
  await expect(deploy.getByRole("button", { name: "Hide details", exact: true })).toBeVisible();
  await deploy.getByRole("button", { name: "Allow once" }).click();
  await expect.poll(() => answers.length).toBe(2);
  const { requestId: _a, ...inline } = answers[0]!;
  const { requestId: _b, ...fromCard } = answers[1]!;
  expect(inline).toEqual(fromCard);
});

test("Deny answers in one click with the open card's Deny body", async ({ page }) => {
  await page.goto(origin + "/__needs?view=approvals");
  const deploy = row(page, "deploy the launch site");
  await deploy.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(deploy).toHaveCount(0);
  expect(answers).toEqual([{ requestId: "req-deploy", behavior: "deny", message: "Denied by the user." }]);
});

test("a scoped card and a several-option question keep Open only; a two-option question answers in one click", async ({ page }) => {
  await page.goto(origin + "/__needs");
  const del = row(page, "remove the old drafts folder");
  await expect(del).toHaveCount(1);
  await expect(del.getByRole("button")).toHaveText(["Show details"]);
  // Approve all is on offer (push and deploy), so the row it leaves out says why, in a few words
  await expect(del).toContainText("one at a time: deletes something");
  const pick = row(page, "Which list should get the email?");
  await expect(pick.getByRole("button")).toHaveText(["Show details"]);
  const ask = row(page, "Post the launch thread now?");
  await ask.getByRole("button", { name: "Not yet", exact: true }).click();
  await expect(ask).toHaveCount(0);
  expect(answers).toEqual([{ requestId: "req-ask", behavior: "answer", answers: [{ id: "q1", selected: ["Not yet"] }] }]);
});

test("a failed one-click answer keeps the row and says why, on the row", async ({ page }) => {
  failing.set("req-push", "This request was already answered on your phone.");
  await page.goto(origin + "/__needs");
  const push = row(page, "push main to GitHub");
  await push.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(push.getByRole("alert")).toContainText("This request was already answered on your phone.");
  await expect(push).toHaveCount(1);
});

test("keyboard: Tab reaches Approve on a row, Enter answers it, and focus lands on the next row's Show details, never on an answer", async ({ page }) => {
  await page.goto(origin + "/__needs");
  const push = row(page, "push main to GitHub");
  const approve = push.getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toBeVisible();
  // Tab from the row's avatar side reaches Approve before Open.
  await push.locator("p").first().evaluate((line) => { line.setAttribute("tabindex", "-1"); (line as HTMLElement).focus(); });
  await page.keyboard.press("Tab");
  await expect(approve).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(push).toHaveCount(0);
  expect(answers).toEqual([{ requestId: "req-push", behavior: "allow" }]);
  await expect(row(page, "deploy the launch site").getByRole("button", { name: "Show details", exact: true })).toBeFocused();
  // A second Enter opens that card; it does not approve it.
  await page.keyboard.press("Enter");
  await expect(row(page, "deploy the launch site").getByRole("button", { name: "Allow once" })).toBeVisible();
  expect(answers).toHaveLength(1);
});

// Sean's two real cards (11-06 screenshot). Petra's Bash call carried a description; Moss's did not. Both are reader
// holds whose open-time hard read came back clear (cardClass rule "unreadable", server/approvals-simple-1018.test.ts).
const PETRA_COMMAND = [
  "cat >> ~/.helper/ops/trustpilot-log.md <<'EOF'",
  "| 2026-11-06 06:35 ICT | 4.2 | 36 | no new reviews. Run executed by Petra (Kessler delegation, 6 Nov). ... NOTHING POSTED, NOTHING HELD. |",
  "EOF",
  "python3 -I ~/.helper/ops/trustpilot-state-stamp.py --ts 2026-11-06T06:35+07:00 --note \"No new reviews. ...\" --method \"WebFetch public profile recency page 1. Business app not opened.\" --score 4.2 --count 36; tail -1 ~/.helper/ops/trustpilot-log.md | cut -c1-60",
].join("\n");
const READER_HOLD = { ...ORDINARY, reason: "always-ask", rule: "unreadable" };
function seanRows() {
  db.exec("DELETE FROM messages WHERE thread_id='sable-task'");
  const at = Date.now() - 30 * 60_000;
  card("petra", at, { requestId: "req-petra", title: "Approval needed", subtitle: PETRA_COMMAND, wants: "Append today's Trustpilot check to the ops log", options: ["Allow", "Deny"], tool: "Bash", lowRisk: true, held: "Auto mode couldn't answer this one.", cardClass: READER_HOLD });
  card("moss", at + 1_000, { requestId: "req-moss", title: "Approval needed", subtitle: "python3 -I /tmp/moss-count-20261106.py", options: ["Allow", "Deny"], tool: "Bash", lowRisk: true, held: "Auto mode couldn't answer this one.", cardClass: READER_HOLD });
}

test("Sean's rows: what each bot wants in words, the kind in grey, no command, and Approve on each row, on Needs you and on Today", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  for (const [path, rows] of [["/__needs", "[data-needs-row]"], ["/__today", "[data-today-row]"]] as const) {
    seanRows(); answers = [];
    await page.goto(origin + path);
    const petra = page.locator(rows).filter({ hasText: "wants to append today's Trustpilot check to the ops log" });
    const moss = page.locator(rows).filter({ hasText: "wants to run a command" });
    await expect(petra).toHaveCount(1);
    await expect(moss).toHaveCount(1);
    for (const bit of ["cat >>", "EOF", "python3", "trustpilot-state-stamp", "moss-count"]) await expect(page.locator(rows).filter({ hasText: bit })).toHaveCount(0);
    await expect(page.locator("[data-needs-whole]")).toHaveCount(0);
    // the line wraps: nothing on it is cut by CSS
    await expect(petra.locator(".truncate").filter({ hasText: "Trustpilot" })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`sean-rows${path.replace("/__", "-")}.png`), fullPage: true });
    await petra.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(petra).toHaveCount(0);
    await moss.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(moss).toHaveCount(0);
    expect(answers).toEqual([{ requestId: "req-petra", behavior: "allow" }, { requestId: "req-moss", behavior: "allow" }]);
  }
});

test("Approve all names its count, shows only at 2 or more, and approves exactly the rows on screen with no sheet", async ({ page }) => {
  seanRows();
  card("push", Date.now() - 20 * 60_000, { requestId: "req-push", title: "Approval needed", subtitle: "git push origin main", wants: "Push main to GitHub", options: ["Allow", "Deny"], tool: "Bash", lowRisk: true, cardClass: ORDINARY });
  card("keys", Date.now() - 10 * 60_000, { requestId: "req-keys", title: "Approval needed", subtitle: "cat ~/.ssh/id_ed25519", wants: "Read the deploy key", options: ["Allow", "Deny"], tool: "Bash", lowRisk: true, cardClass: { ...ORDINARY, reason: "sensitive-guard" } });
  await page.goto(origin + "/__needs");
  await expect(row(page, "push main to GitHub")).toHaveCount(1);
  // Petra, Moss and push qualify; the key read stays one at a time and says why
  await expect(approveAll(page)).toHaveText("Approve all 3");
  await expect(row(page, "read the deploy key")).toContainText("one at a time: reads keys or passwords");
  await approveAll(page).click();
  await expect(page.locator("[data-approve-all-line]")).toContainText("Approved 3.");
  // Exactly the three ready rows, in screen order is not the contract: the set is.
  expect(applied.map(ids => [...ids].sort())).toEqual([["req-moss", "req-petra", "req-push"]]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row(page, "read the deploy key")).toHaveCount(1);
  // one left that it would answer: no button, never "Approve 0" or "Approve all 1"
  await expect(approveAll(page)).toHaveCount(0);
  await expect(page.getByText(/Approve( all)? [01]\b/)).toHaveCount(0);
});

test("Sean's repro: the caution is open, the list goes to 0, Refresh closes it and the button goes", async ({ page }) => {
  cautionDismissed = false;
  seanRows();
  await page.goto(origin + "/__needs");
  await expect(approveAll(page)).toHaveText("Approve all 2");
  await approveAll(page).click();
  await expect(page.getByRole("group", { name: "Before you approve them all" })).toBeVisible();
  // both answered somewhere else, then Refresh
  db.exec("DELETE FROM messages WHERE thread_id='sable-task'");
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(row(page, "Trustpilot")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(approveAll(page)).toHaveCount(0);
  expect(applied).toEqual([]);
});

test("the list moved under the press: nothing is applied and it says so", async ({ page }) => {
  seanRows();
  previewDrop = new Set(["req-moss"]);
  await page.goto(origin + "/__needs");
  await expect(approveAll(page)).toHaveText("Approve all 2");
  await approveAll(page).click();
  await expect(page.locator("[data-approve-all-line]")).toHaveText("The list changed. Press Approve all again.");
  expect(applied).toEqual([]);
  // a row added after that line closes it (3b)
  card("push", Date.now(), { requestId: "req-push", title: "Approval needed", subtitle: "git push origin main", wants: "Push main to GitHub", options: ["Allow", "Deny"], tool: "Bash", lowRisk: true, cardClass: ORDINARY });
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.locator("[data-approve-all-line]")).toHaveCount(0);
  await expect(approveAll(page)).toHaveText("Approve all 3");
});

test("Astra r2 High: a preview still loading when Refresh is pressed never applies, even over the same list", async ({ page }) => {
  seanRows();
  await page.goto(origin + "/__needs");
  await expect(approveAll(page)).toHaveText("Approve all 2");
  const hold = holdPreview();
  await approveAll(page).click();
  await expect(approveAll(page)).toHaveText("Approving 2…");
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(approveAll(page)).toHaveText("Approve all 2");
  hold.release();
  await page.waitForTimeout(500);
  expect(applied).toEqual([]);
  await expect(page.locator("[data-approve-all-line]")).toHaveCount(0);
  await expect(approveAll(page)).toHaveText("Approve all 2");
});

test("Opus r2 High: a row that arrives while Don't show this again is saving is never approved, and it says the list changed", async ({ page }) => {
  cautionDismissed = false;
  seanRows();
  await page.goto(origin + "/__needs");
  await expect(approveAll(page)).toHaveText("Approve all 2");
  await approveAll(page).click();
  const caution = page.getByRole("group", { name: "Before you approve them all" });
  await expect(caution).toBeVisible();
  await caution.getByRole("checkbox", { name: "Don't show this again" }).check();
  const hold = holdCaution();
  await caution.getByRole("button", { name: "Got it" }).click();
  await expect.poll(() => cautionPosts).toBe(1);
  // a third ready row arrives during the save, and the 5 s beat puts it on screen (no Refresh press)
  card("push", Date.now(), { requestId: "req-push", title: "Approval needed", subtitle: "git push origin main", wants: "Push main to GitHub", options: ["Allow", "Deny"], tool: "Bash", lowRisk: true, cardClass: ORDINARY });
  await expect(row(page, "push main to GitHub")).toHaveCount(1, { timeout: 12_000 });
  hold.release();
  await expect(page.locator("[data-approve-all-line]")).toHaveText("The list changed. Press Approve all again.");
  await page.waitForTimeout(500);
  expect(applied).toEqual([]);
  // never a dead end (Astra): the line keeps the button, with the new count, without a Refresh
  await expect(approveAll(page)).toHaveText("Approve all 3");
  await expect(approveAll(page)).toBeEnabled();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.locator("[data-approve-all-line]")).toHaveCount(0);
  await expect(approveAll(page)).toHaveText("Approve all 3");
});

test("a double Got it saves once and approves once, exactly the rows on screen at the press", async ({ page }) => {
  cautionDismissed = false;
  seanRows();
  await page.goto(origin + "/__needs");
  await expect(approveAll(page)).toHaveText("Approve all 2");
  await approveAll(page).click();
  const caution = page.getByRole("group", { name: "Before you approve them all" });
  await caution.getByRole("checkbox", { name: "Don't show this again" }).check();
  const hold = holdCaution();
  // two clicks in one task, before React can re-render
  await caution.getByRole("button", { name: "Got it" }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await page.waitForTimeout(300);
  hold.release();
  await expect(page.locator("[data-approve-all-line]")).toContainText("Approved 2.");
  expect(cautionPosts).toBe(1);
  expect(applied.map(ids => [...ids].sort())).toEqual([["req-moss", "req-petra"]]);
});

// Today's Needs you block (a different, first-paint component): the same one-click answer, loaded on first use.
const todayRow = (page: import("@playwright/test").Page, text: string) => page.locator("[data-today-row]").filter({ hasText: text });

test("Today: an approval row says what it approves and Approve answers in one click with the open card's body", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(origin + "/__today");
  const push = todayRow(page, "wants to push main to GitHub");
  await expect(push).toHaveCount(1);
  await expect(page.locator("[data-today-row]").filter({ hasText: "Approval requested" })).toHaveCount(0);
  await expect(push).not.toContainText("git push origin main");
  await expect(push.getByRole("group", { name: /push main to GitHub/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("today-inline-rows.png"), fullPage: true });
  await push.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(push).toHaveCount(0);
  expect(answers).toEqual([{ requestId: "req-push", behavior: "allow" }]);
});

test("Today: Deny sends the Deny body; a scoped card and a several-option question keep Open only", async ({ page }) => {
  await page.goto(origin + "/__today");
  const del = todayRow(page, "remove the old drafts folder");
  await expect(del).toHaveCount(1);
  await expect(del.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await expect(todayRow(page, "Which list should get the email?").getByRole("button", { name: /Customers|Press|Everyone/ })).toHaveCount(0);
  const deploy = todayRow(page, "deploy the launch site");
  await deploy.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(deploy).toHaveCount(0);
  expect(answers).toEqual([{ requestId: "req-deploy", behavior: "deny", message: "Denied by the user." }]);
});

test("Today: a failed answer keeps the row and says why on it; the row's own button still opens it", async ({ page }) => {
  failing.set("req-push", "This request was already answered on your phone.");
  await page.goto(origin + "/__today");
  const push = todayRow(page, "push main to GitHub");
  await push.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(push.getByRole("alert")).toContainText("This request was already answered on your phone.");
  await expect(push).toHaveCount(1);
  await push.locator("button[data-line]").click();
  await expect.poll(() => page.evaluate(() => (window as { opened?: string }).opened)).toBeTruthy();
});
