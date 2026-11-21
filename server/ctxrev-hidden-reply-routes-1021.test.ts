// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// CTXREV H2 A-2 (cause1 r6, Astra BLOCK on a8537e2ff1): the kept reply of an owner turn whose held context an own privacy revoke withdrew
// mid-turn (Sean revokekeep) carries a hide mark (revoke-commit.ts hideReplyLine), and the bot readers honour it. The transcript routes did
// not: a transcript page, an ?around window, a branch page, a switch page and a non-owner export returned its words to any caller the
// conversation routes admit (an MCP door key, a forwarded request with no owner proof).
// Owners: lane cause1-r6 owns the reader gate (index.ts hiddenReplyGate, transcript-page.ts withholdHiddenReply); revokekeep-1020 owns
// the hide mark itself (revoke-commit.ts hideReplyLine).
// Real harness, real routes, real hide mark writer on the server's own file; one witness per read path, each RED with its guard removed.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { hideReplyLine, replyHiddenFromBots } from "./memory/revoke-commit.ts";
import { REPLY_WITHHELD } from "./owner-display.ts";

const COMPANION_TOKEN = "c".repeat(64);
const QUOTE = "locker combination is 31-07-44";
const SHOWN = "The weekly report goes out on Mondays.";
let fixture: VerificationServer;
let desktopSecret = "";
let threadId = "";
// cause1-fix-roster: a second conversation whose branch head IS the kept reply (the sidebar line reads the head), and a script's grant per bot
let leafThreadId = "";
let botId = "";
let leafBotId = "";
const grantToken: Record<string, string> = {};

type Caller = "desktop" | "companion" | "door" | "grant" | "leafGrant";
const BARE = { "x-test-bare-loopback": "1" };
const callers = (): Record<Caller, Record<string, string>> => ({
  desktop: { ...BARE, "x-murage-surface": "desktop", "x-murage-surface-secret": desktopSecret },
  companion: { ...BARE, "x-murage-companion": "1", "x-murage-companion-token": COMPANION_TOKEN },
  // the forwarded door proof alone claims no owner authority (companion-authority.ts DOOR_FORWARD_HEADER); an MCP door key reads the same
  door: { "x-murage-door-token": COMPANION_TOKEN },
  // a script's grant (mcp-grants.ts) opens GET /api/bots for its one bot (mcpGrantAdmits)
  grant: { ...BARE, authorization: `Bearer ${grantToken[botId]}` },
  leafGrant: { ...BARE, authorization: `Bearer ${grantToken[leafBotId]}` },
});
async function get(path: string, who: Caller, method = "GET"): Promise<{ status: number; text: string }> {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: callers()[who] });
  return { status: response.status, text: await response.text() };
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
  [{ id: botId, threadId }, { id: leafBotId, threadId: leafThreadId }] = made as [{ id: string; threadId: string }, { id: string; threadId: string }];
  for (const id of [botId, leafBotId]) {
    const grant = await fetch(`${fixture.info.url}/api/mcp-grants`, { method: "POST", headers: { ...callers().desktop, "content-type": "application/json" }, body: JSON.stringify({ botId: id }) });
    expect(grant.status).toBe(201);
    grantToken[id] = String(((await grant.json()) as { token: string }).token);
  }
  await fixture.stop();
  // the rows a kept owner turn leaves: the owner's question, the kept reply (owner view: withheldFromBots) and an untouched reply after it
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  try {
    const rows = [
      { id: "line-ask", at: 1_700_000_000_001, role: "user", kind: "text", text: "Where did I leave the locker number?", parentId: null },
      { id: "line-kept", at: 1_700_000_000_002, role: "bot", kind: "text", text: `Your ${QUOTE}, as you told me.`, parentId: "line-ask", withheldFromBots: true },
      { id: "line-next", at: 1_700_000_000_003, role: "bot", kind: "text", text: SHOWN, parentId: "line-kept" },
    ];
    const seed = (thread: string, seeded: typeof rows, leaf: string) => {
      const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES (?,?,?,?,?,?,?)");
      for (const row of seeded) insert.run(thread, row.id, row.at, row.role, row.kind, row.text, JSON.stringify(row));
      db.prepare("INSERT INTO thread_state(thread_id,active_leaf_id) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id=excluded.active_leaf_id").run(thread, leaf);
      db.prepare("INSERT OR IGNORE INTO memory_thread_no(thread_id,no) VALUES(?,(SELECT coalesce(max(no),0)+1 FROM memory_thread_no))").run(thread);
      const no = Number((db.prepare("SELECT no FROM memory_thread_no WHERE thread_id=?").get(thread) as { no: number }).no);
      for (const row of seeded) db.prepare("INSERT INTO memory_line_lineage(thread_no,lsn,message_id) VALUES(?,(SELECT coalesce(max(lsn),0)+1 FROM memory_line_lineage),?)").run(no, row.id);
      // the real mark writer, as message-db.ts hideReplay runs it in the kept reply's write
      expect(hideReplyLine(db, thread, "line-kept")).toBe(true);
      expect(replyHiddenFromBots(db, thread, "line-kept")).toBe(true);
    };
    seed(threadId, rows, "line-next");
    expect(replyHiddenFromBots(db, threadId, "line-next")).toBe(false);
    // the second conversation ends on the kept reply: its sidebar line is that reply
    seed(leafThreadId, rows.slice(0, 2), "line-kept");
  } finally { db.close(); }
  await fixture.restart();
  desktopSecret = await desktopSecretNow();
}, 120_000);
afterAll(async () => { await fixture?.close(); });

/** A non-owner answer: the kept reply's words never, its place as the withheld line, the untouched reply whole. */
function withheld(body: string, untouched = true) {
  expect(body).not.toContain(QUOTE);
  expect(body).toContain(REPLY_WITHHELD);
  if (untouched) expect(body).toContain(SHOWN);
}

it("R1 transcript page (guard: index.ts messagePage passes hiddenReply): a non-owner caller gets the withheld line; the owner's desktop and phone get the reply", async () => {
  const door = await get(`/api/threads/${threadId}/messages?limit=10`, "door");
  expect(door.status).toBe(200);
  withheld(door.text);
  // the older page reached by cursor goes through the same gate
  const older = await get(`/api/threads/${threadId}/messages?limit=10&before=line-next`, "door");
  expect(older.status).toBe(200);
  withheld(older.text, false);
  for (const who of ["desktop", "companion"] as const) {
    const owner = await get(`/api/threads/${threadId}/messages?limit=10`, who);
    expect(owner.status, who).toBe(200);
    expect(owner.text, who).toContain(QUOTE);
  }
});

it("R2 ?around window (guard: index.ts messageWindow passes hiddenReply), the search-result read Astra named, limit=1 included", async () => {
  for (const limit of [1, 10]) {
    const door = await get(`/api/threads/${threadId}/messages?around=line-kept&limit=${limit}`, "door");
    expect(door.status, String(limit)).toBe(200);
    withheld(door.text, limit > 1);
  }
  expect((await get(`/api/threads/${threadId}/messages?around=line-kept&limit=1`, "desktop")).text).toContain(QUOTE);
});

it("R3 branch page and switch page (guards: branchFrom and view=switch pass hiddenReply)", async () => {
  const branch = await get(`/api/threads/${threadId}/messages?branchFrom=line-next&limit=10`, "door");
  expect(branch.status).toBe(200);
  withheld(branch.text);
  const switched = await get(`/api/threads/${threadId}/messages?view=switch&limit=10`, "door");
  expect(switched.status).toBe(200);
  withheld(switched.text);
  expect((await get(`/api/threads/${threadId}/messages?view=switch&limit=10`, "desktop")).text).toContain(QUOTE);
});

it("R4 export, both formats (guard: the export's non-owner mapper runs withholdHiddenReply)", async () => {
  for (const format of ["json", "markdown"]) {
    const door = await get(`/api/threads/${threadId}/export?format=${format}`, "door");
    expect(door.status, format).toBe(200);
    withheld(door.text);
  }
  // the owner's own export keeps the reply (Sean revokekeep: the owner sees what the turn answered)
  expect((await get(`/api/threads/${threadId}/export?format=json`, "desktop")).text).toContain(QUOTE);
});

// cause1-fix-roster (Fable + Astra High on c39952008f): the roster is the widest read on the port and was not in the allowlist. GET /api/bots
// (a script's grant: mcp-grants.ts mcpGrantAdmits admits it; the door: scoped listing) carried every bot's page through wirePage with no gate.
it("R5 roster page (guard: index.ts /api/bots passes hiddenReplyGate to pagedPublicBot, grant and listing branches)", async () => {
  for (const query of ["", "?messages=10"]) {
    for (const who of ["grant", "door"] as const) {
      const roster = await get(`/api/bots${query}`, who);
      expect(roster.status, `${who} ${query}`).toBe(200);
      expect(roster.text, `${who} ${query}`).toContain(threadId);
      withheld(roster.text);
    }
    const owner = await get(`/api/bots${query}`, "desktop");
    expect(owner.status).toBe(200);
    expect(owner.text).toContain(QUOTE);
  }
});

it("R6 roster sidebar line and the page's head line (guard: sidebarLineFor withholds the kept head)", async () => {
  for (const who of ["leafGrant", "door"] as const) {
    for (const query of ["?view=sidebar", "?messages=10"]) {
      const roster = await get(`/api/bots${query}`, who);
      expect(roster.status, `${who} ${query}`).toBe(200);
      const bot = (JSON.parse(roster.text) as { bots: { id: string; sidebarLine?: unknown }[] }).bots.find(entry => entry.id === leafBotId);
      expect(bot?.sidebarLine, `${who} ${query}`).toBeDefined();
      expect(roster.text, `${who} ${query}`).not.toContain(QUOTE);
      expect(JSON.stringify(bot!.sidebarLine), `${who} ${query}`).toContain(REPLY_WITHHELD);
    }
  }
  const owner = await get("/api/bots?view=sidebar", "desktop");
  expect(JSON.stringify((JSON.parse(owner.text) as { bots: { id: string; sidebarLine?: unknown }[] }).bots.find(entry => entry.id === leafBotId)?.sidebarLine)).toContain("locker");
});

it("R7 task switch answer (guard: index.ts POST /api/bots/:id/tasks/:taskId passes hiddenReplyGate to pagedPublicBot and switchDeltaBot)", async () => {
  // the route's task id is the task's thread (store.ts switchTask): a switch to the conversation already open answers its page
  const taskId = threadId;
  for (const query of ["", "?messages=10"]) {
    const door = await get(`/api/bots/${botId}/tasks/${taskId}${query}`, "door", "POST");
    expect(door.status, query).toBe(200);
    withheld(door.text);
  }
  expect((await get(`/api/bots/${botId}/tasks/${taskId}?messages=10`, "desktop", "POST")).text).toContain(QUOTE);
});

it("R9 one bot's record (guard: index.ts GET /api/bots/:id passes hiddenReplyGate to sidebarLineFor)", async () => {
  const door = await get(`/api/bots/${leafBotId}`, "door");
  expect(door.status).toBe(200);
  expect(door.text).not.toContain(QUOTE);
  expect(JSON.stringify((JSON.parse(door.text) as { bot: { sidebarLine?: unknown } }).bot.sidebarLine)).toContain(REPLY_WITHHELD);
  expect((await get(`/api/bots/${leafBotId}`, "desktop")).text).toContain("locker");
});

it("R10 reaction answer (guard: index.ts POST .../reactions gates the patched row): a reaction on another's row never reads its words back", async () => {
  const react = async (who: Caller) => {
    const response = await fetch(`${fixture.info.url}/api/threads/${threadId}/messages/line-kept/reactions`, { method: "POST", headers: { ...callers()[who], "content-type": "application/json" }, body: JSON.stringify({ emoji: "+1" }) });
    return { status: response.status, text: await response.text() };
  };
  const door = await react("door");
  expect(door.status).toBe(200);
  expect(door.text).not.toContain(QUOTE);
  expect(door.text).toContain(REPLY_WITHHELD);
  const owner = await react("desktop");
  expect(owner.status).toBe(200);
  expect(owner.text).toContain(QUOTE);
});
