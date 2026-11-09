// secret-scan: fixture (fake paths, policy test rows)
// FUNCTION-SWEEP-1018 (Sean: "You need to check all these functions"): one fixture for the two click-every-control specs,
// Needs you and Today. The real Inbox projection (server/inbox.ts) over a scratch messages.db, the real Inbox in door
// mode, and the real Today Needs block. /respond and Approve all's preview and apply are small stand-ins that write the
// same rows the real routes would. Test-only.
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

const proof = "function-sweep-proof";
const scope: InboxAccess = { owner: true, threads: [{ threadId: "sable-task", label: "Sable · Launch prep", botId: "sable" }, { threadId: "orion-task", label: "Orion · Research", botId: "orion" }] };

export interface SweepFixture {
  origin: string;
  db: DatabaseSync;
  /** every POST body, by route, in order */
  calls: Array<{ path: string; body: Record<string, unknown> }>;
  /** requestIds whose /respond fails, with this reason */
  failing: Map<string, string>;
  card(thread: "sable-task" | "orion-task", id: string, at: number, content: Record<string, unknown>): void;
  /** answer a card the way another window would, behind the page's back */
  answer(requestId: string, behavior?: string): void;
  reset(): void;
  close(): Promise<void>;
}

async function body(req: AsyncIterable<unknown>): Promise<string> { let text = ""; for await (const chunk of req) text += String(chunk); return text; }

export async function startSweepFixture(): Promise<SweepFixture> {
  const root = mkdtempSync(join(tmpdir(), "murage-function-sweep-"));
  const db = new DatabaseSync(join(root, "messages.db"));
  db.exec("CREATE TABLE messages(thread_id TEXT,id TEXT,at INTEGER,role TEXT,kind TEXT,text TEXT,json TEXT,PRIMARY KEY(thread_id,id))");
  initializeInbox(db);
  const calls: SweepFixture["calls"] = [];
  const failing = new Map<string, string>();
  const card: SweepFixture["card"] = (thread, id, at, given) => {
    // APPROVALS-SIMPLE-1018: an approval carries what the server stamps at open, the bot's own `wants` (here the bot
    // described its call in so many words, so rows are still found by them) and its class (an owner's ordinary turn,
    // or the stop line for a scoped delete).
    const content = given.tool && !given.questions ? {
      ...(typeof given.subtitle === "string" ? { wants: `Run ${given.subtitle}` } : {}),
      cardClass: given.taskAllowKey ? { reason: "stop-line", stop: { kind: "delete" }, unattended: false, origin: "owner" } : { reason: "no-grant", unattended: false, origin: "owner" },
      ...given,
    } : given;
    const json = JSON.stringify({ id, role: "bot", kind: "options", at, card: content });
    db.prepare("INSERT OR REPLACE INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,'bot','options',NULL,?)").run(thread, id, at, json);
  };
  const find = (requestId: string) => db.prepare("SELECT thread_id, id, json FROM messages WHERE json_extract(json,'$.card.requestId')=?").get(requestId) as { thread_id: string; id: string; json: string } | undefined;
  const answer: SweepFixture["answer"] = (requestId, behavior = "allow") => {
    const row = find(requestId);
    if (!row) throw Error(`no card ${requestId}`);
    const message = JSON.parse(row.json);
    db.prepare("UPDATE messages SET json=? WHERE thread_id=? AND id=?").run(JSON.stringify({ ...message, card: { ...message.card, answered: behavior } }), row.thread_id, row.id);
  };
  // What Approve all would sign now: every unanswered plain tool approval (no scoped Allow).
  const eligible = () => (db.prepare("SELECT thread_id, json FROM messages ORDER BY at").all() as Array<{ thread_id: string; json: string }>)
    .map(row => ({ thread: row.thread_id, message: JSON.parse(row.json) }))
    .filter(({ message }) => message.card?.tool && !message.card.answered && !message.card.taskAllowKey)
    .map(({ thread, message }) => ({ threadId: thread, requestId: message.card.requestId, messageId: message.id, ...(message.card.wants ? { wants: message.card.wants } : {}), botId: thread === "sable-task" ? "sable" : "orion", kindLine: "command", digest: `d-${message.card.requestId}`, card: { tool: message.card.tool, subtitle: message.card.subtitle } }));
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const page = (script: string) => `<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="${script}"></script>`;
  const vite: ViteDevServer = await createServer({ configFile: false, root: repo, envFile: false, cacheDir: join(root, "vite-cache"),
    resolve: { alias: { "@": join(repo, "src") } }, server: { host: "127.0.0.1", watch: null, hmr: false }, plugins: [react(), tailwindcss(), {
      name: "function-sweep-fixture",
      resolveId(id) { if (id === "/__sweep-needs.js") return "\0sweep-needs"; if (id === "/__sweep-today.js") return "\0sweep-today"; },
      load(id) {
        if (id === "\0sweep-needs") return `import React from 'react';import {createRoot} from 'react-dom/client';import {SweepNeedsHarness} from '/src/e2e/function-sweep-harness.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(SweepNeedsHarness));`;
        if (id === "\0sweep-today") return `import React from 'react';import {createRoot} from 'react-dom/client';import {SweepTodayHarness} from '/src/e2e/function-sweep-harness.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(SweepTodayHarness));`;
      },
      configureServer(server) { server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://fixture");
        const json = (status: number, value: unknown) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
        if (url.pathname === "/__needs") { res.setHeader("content-type", "text/html"); res.end(page("/__sweep-needs.js")); return; }
        if (url.pathname === "/__today") { res.setHeader("content-type", "text/html"); res.end(page("/__sweep-today.js")); return; }
        if (url.pathname === "/api/desktop-secret") return json(200, { secret: proof });
        if (url.pathname === "/api/config") return json(200, { surface: "desktop", computer: true });
        if (url.pathname === "/api/setup") return json(200, { steps: [], conversationLive: false, next: null, signedOutAgents: [] });
        const messages = /^\/api\/threads\/([a-z-]+)\/messages$/.exec(url.pathname);
        if (messages && req.method === "GET") {
          const row = db.prepare("SELECT json FROM messages WHERE thread_id=? AND id=?").get(messages[1]!, url.searchParams.get("around")) as { json: string } | undefined;
          return json(200, { messages: row ? [JSON.parse(row.json)] : [] });
        }
        const respond = /^\/api\/threads\/([a-z-]+)\/respond$/.exec(url.pathname);
        if (respond && req.method === "POST") {
          const sent = JSON.parse(await body(req)) as Record<string, unknown>;
          calls.push({ path: url.pathname, body: sent });
          const reason = failing.get(String(sent.requestId));
          if (reason) return json(409, { error: reason });
          if (!find(String(sent.requestId))) return json(404, { error: "No such request" });
          answer(String(sent.requestId), String(sent.behavior ?? "answer"));
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/inbox/approve-all/surface") return json(200, { show: true, app: "desktop", cautionDismissed: false });
        if (url.pathname === "/api/inbox/approve-all/caution") { calls.push({ path: url.pathname, body: JSON.parse(await body(req) || "{}") }); return json(200, { cautionDismissed: true }); }
        if (url.pathname === "/api/inbox/approve-all/preview") { await body(req); calls.push({ path: url.pathname, body: {} }); const cards = eligible(); return json(200, { batchId: cards.length ? "batch-1" : null, eligible: cards, excluded: [], more: 0 }); }
        if (url.pathname === "/api/inbox/approve-all/apply") {
          const sent = JSON.parse(await body(req)) as { requestIds: string[] };
          calls.push({ path: url.pathname, body: sent });
          const results = sent.requestIds.map(requestId => { const row = find(requestId); const open = row && !JSON.parse(row.json).card.answered; if (open) answer(requestId); return { threadId: row?.thread_id ?? "", requestId, result: open ? "approved" : "skipped" }; });
          return json(200, { approved: results.filter(r => r.result === "approved").length, results });
        }
        if (!url.pathname.startsWith("/api/inbox")) return next();
        const encoded = await body(req);
        if (req.method === "POST") calls.push({ path: url.pathname, body: encoded ? JSON.parse(encoded) : {} });
        try {
          const query: InboxQuery = { view: (url.searchParams.get("view") ?? "decisions") as InboxQuery["view"], query: url.searchParams.get("query") ?? "", page: Number(url.searchParams.get("page") ?? 0), pageSize: Number(url.searchParams.get("pageSize") ?? 25), includeSnoozed: url.searchParams.get("includeSnoozed") === "true" };
          const response = inboxRequest(db, { method: req.method ?? "GET", path: url.pathname, query, body: encoded ? JSON.parse(encoded) as InboxStateUpdate : undefined }, { ...scope, owner: req.headers["x-murage-surface"] === "desktop" && req.headers["x-murage-surface-secret"] === proof });
          // the server's per-row stamp (server/index.ts withBulkStamp): the real bulkEligibility, and the plain kind
          const listed = response.body as { items?: Array<{ kind: string; link?: { threadId: string; messageId: string } }> };
          if (Array.isArray(listed?.items)) listed.items = listed.items.map((item) => {
            if (item.kind !== "request" || !item.link) return item;
            const row = db.prepare("SELECT json FROM messages WHERE thread_id=? AND id=?").get(item.link.threadId, item.link.messageId) as { json: string } | undefined;
            const found = row ? JSON.parse(row.json).card as Record<string, unknown> : undefined;
            if (!found) return { ...item, bulk: "not-open" };
            const verdict = bulkEligibility(found, String(found.requestId));
            return { ...item, bulk: verdict.ok ? "ok" : verdict.reasonKey, ...(found.tool ? { toolKind: bulkKindKey(String(found.tool)) } : {}) };
          });
          json(response.status, response.body);
        } catch { json(500, { error: "Fixture request failed" }); }
      }); },
    }] });
  await vite.listen(0); const address = vite.httpServer!.address();
  if (!address || typeof address === "string") throw Error("Function sweep fixture did not bind");
  return {
    origin: `http://127.0.0.1:${address.port}`, db, calls, failing, card, answer,
    reset() {
      calls.length = 0; failing.clear();
      db.exec("DELETE FROM messages; DELETE FROM inbox_item_state;");
    },
    async close() { await vite.close(); db.close(); safeWipeSync(root); },
  };
}

/** The fixture's standard morning: three plain approvals (two bots), one scoped approval, two questions. */
export function seedMorning(fixture: SweepFixture): void {
  const t0 = Date.now() - 60 * 60_000;
  fixture.card("sable-task", "push", t0, { requestId: "req-push", title: "Approval needed", subtitle: "git push origin main", options: ["Allow", "Deny"], tool: "Bash", lowRisk: true });
  fixture.card("sable-task", "deploy", t0 + 1_000, { requestId: "req-deploy", title: "Approval needed", subtitle: "fly deploy --app launch-site", options: ["Allow", "Deny"], tool: "Bash", lowRisk: true });
  fixture.card("orion-task", "fetch", t0 + 2_000, { requestId: "req-fetch", title: "Approval needed", subtitle: "curl https://example.com/report.csv", options: ["Allow", "Deny"], tool: "Bash", lowRisk: true });
  fixture.card("sable-task", "delete", t0 + 3_000, { requestId: "req-delete", title: "Approval needed", subtitle: "rm -rf ~/Documents/old-drafts", options: ["Allow", "Deny"], tool: "Bash", lowRisk: true, taskAllowKey: "stop:delete:/Users/ada/Documents" });
  fixture.card("orion-task", "ask", t0 + 4_000, { requestId: "req-ask", title: "Question needs an answer", subtitle: "Post the launch thread now?", options: ["Yes", "Not yet"],
    questions: [{ id: "q1", question: "Post the launch thread now?", options: [{ label: "Yes" }, { label: "Not yet" }], multiSelect: false, allowOther: true }] });
  fixture.card("sable-task", "pick", t0 + 5_000, { requestId: "req-pick", title: "Question needs an answer", subtitle: "Which list?", options: ["A", "B", "C"],
    questions: [{ id: "q1", question: "Which list should get the email?", options: [{ label: "Customers" }, { label: "Press" }, { label: "Everyone" }], multiSelect: false, allowOther: false }] });
}
