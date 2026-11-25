// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MAIN-RULING 2026-11-23T00:58:16Z redact-marker (Sean's Mac, 1.0.21): a bot reply saved as the bare marker (the owner-only check at the
// write was false: a non-owner-marked turn, a live paired channel run, or a lookup that threw) read «redacted» in the bubble and the sidebar,
// because the transcript read swapped it for the held-back sentence for the owner alone and the chats preview never did. Already-saved
// replies repair on load, for every reader. The write side is FOLD-9 in engine-swap-fold.test.ts.
// Owners: lane cause22-redact-marker owns the read mapping (transcript-page.ts sanitizeBotDisplayMessage, thread-summary.ts previewSnippet)
// and these witnesses; the rows are seeded as the pre-fix write stored them. Real server, real routes.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { REPLY_WITHHELD } from "./owner-display.ts";

const COMPANION_TOKEN = "c".repeat(64);
const MARK = "«redacted»";
let fixture: VerificationServer;
let desktopSecret = "";
let threadId = "";
let botId = "";
// M4: a second conversation whose summary a later write rebuilds from the saved marker reply (thread-summary.ts syncThreadSummary)
let refillThreadId = "";

type Caller = "desktop" | "door";
const BARE = { "x-test-bare-loopback": "1" };
const callers = (): Record<Caller, Record<string, string>> => ({
  desktop: { ...BARE, "x-murage-surface": "desktop", "x-murage-surface-secret": desktopSecret },
  // a reader with no owner proof (companion-authority.ts DOOR_FORWARD_HEADER): the shared projection
  door: { "x-murage-door-token": COMPANION_TOKEN },
});
async function get(path: string, who: Caller): Promise<{ status: number; body: any }> {
  const response = await fetch(`${fixture.info.url}${path}`, { headers: callers()[who] });
  return { status: response.status, body: await response.json() };
}
const desktopSecretNow = async () => String((await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret);

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { env: { MURAGE_COMPANION_TOKEN: COMPANION_TOKEN } });
  desktopSecret = await desktopSecretNow();
  const made: { id: string; threadId: string }[] = [];
  for (const name of ["Desk Helper", "Shelf Helper"]) {
    const created = await fetch(`${fixture.info.url}/api/bots`, { method: "POST", headers: { ...callers().desktop, "content-type": "application/json" }, body: JSON.stringify({ name }) });
    expect(created.status).toBe(201);
    made.push(((await created.json()) as { bot: { id: string; threadId: string } }).bot);
  }
  [{ id: botId, threadId }, { threadId: refillThreadId }] = made as [{ id: string; threadId: string }, { id: string; threadId: string }];
  await fixture.stop();
  // what the pre-fix write left: the owner's question, the reply stored as the bare marker (the leaf), and its preview
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  try {
    const rows = [
      { id: "line-ask", at: 1_700_000_000_001, role: "user", kind: "text", text: "Summarise the weekly report.", parentId: null, origin: "desktop" },
      { id: "line-marker", at: 1_700_000_000_002, role: "bot", kind: "text", text: MARK, parentId: "line-ask" },
    ];
    const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES (?,?,?,?,?,?,?)");
    for (const thread of [threadId, refillThreadId]) {
      for (const row of rows) insert.run(thread, row.id, row.at, row.role, row.kind, row.text, JSON.stringify(row));
      db.prepare("INSERT INTO thread_state(thread_id,active_leaf_id) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id=excluded.active_leaf_id").run(thread, "line-marker");
    }
    db.prepare("INSERT INTO thread_summary(thread_id,last_at,last_role,last_from,snippet) VALUES(?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET last_at=excluded.last_at,last_role=excluded.last_role,last_from=excluded.last_from,snippet=excluded.snippet")
      .run(threadId, 1_700_000_000_002, "bot", null, MARK);
    // the second conversation has no summary row: the next write to the thread builds it from the saved rows
    db.prepare("DELETE FROM thread_summary WHERE thread_id=?").run(refillThreadId);
  } finally { db.close(); }
  await fixture.restart();
  desktopSecret = await desktopSecretNow();
}, 120_000);
afterAll(async () => { await fixture?.close(); });

const markerRow = (body: { messages?: Array<{ id: string; text?: string }> }) => body.messages?.find(message => message.id === "line-marker")?.text;

it("M1 transcript page: a reply saved as the bare marker reads as the held-back sentence for a reader without owner proof, and for the owner", async () => {
  for (const who of ["door", "desktop"] as const) {
    const page = await get(`/api/threads/${threadId}/messages?limit=10`, who);
    expect(page.status, who).toBe(200);
    expect(markerRow(page.body), who).toBe(REPLY_WITHHELD);
  }
});

it("M2 sidebar line of the roster: the saved marker reply is the held-back sentence for a reader without owner proof", async () => {
  const roster = await get("/api/bots?view=sidebar", "door");
  expect(roster.status).toBe(200);
  const line = (roster.body as { bots: Array<{ id: string; sidebarLine?: unknown }> }).bots.find(bot => bot.id === botId)?.sidebarLine;
  expect(line).toBeDefined();
  expect(JSON.stringify(line)).not.toContain(MARK);
  expect(JSON.stringify(line)).toContain(REPLY_WITHHELD);
});

it("M3 chats preview (GET /api/chats): an already-saved summary that is only the marker previews as the held-back sentence", async () => {
  const chats = await get("/api/chats", "desktop");
  expect(chats.status).toBe(200);
  const row = [...(chats.body.chats ?? []), ...(chats.body.pinned ?? [])].find((chat: { threadId: string }) => chat.threadId === threadId);
  expect(row?.lastRole).toBe("bot");
  expect(row?.snippet).toBe(REPLY_WITHHELD);
});

it("M4 summary write (a reaction rewrites the row: branch-store.ts afterUpdate -> syncThreadSummary): a summary built from a saved marker reply stores the held-back sentence", async () => {
  const react = await fetch(`${fixture.info.url}/api/threads/${refillThreadId}/messages/line-marker/reactions`, { method: "POST", headers: { ...callers().desktop, "content-type": "application/json" }, body: JSON.stringify({ emoji: "+1" }) });
  expect(react.status).toBe(200);
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try {
    const stored = db.prepare("SELECT last_role, snippet FROM thread_summary WHERE thread_id=?").get(refillThreadId) as { last_role: string; snippet: string } | undefined;
    expect(stored).toEqual({ last_role: "bot", snippet: REPLY_WITHHELD });
  } finally { db.close(); }
});
