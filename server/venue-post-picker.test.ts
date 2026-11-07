// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// VENUE-POST-1017 section 6 and 8, gate tier: the Post in… picker route (owner surfaces only), T34' (the post's lineage row on the
// unloaded path; an owner forget of the shown 1:1 line withholds the post from every bot audience), T37 (a routine turn never lists
// venue_post) and T30 (real engine). Fails on base: no venue-post.ts, no picker route, no VENUE_POST_PICKER_OWNER_ONLY.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { appendMessage } from "./message-db.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { captureSource } from "./memory/capture.ts";
import { setMemoryCaptureRoster } from "./memory/capture-scope.ts";
import { denyLookup } from "./memory/deny-read.ts";
import { forgetMemory } from "./memory/forget.ts";
import { ensureScope, reconcileMemoryRoster } from "./memory/policy.ts";
import { setMemoryMode } from "./memory/repository.ts";
import type { BotRecord, GroupRecord, Message } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { venuePostLineage, venuePostMounts, venuePostRow, VENUE_POST_PICKER_OWNER_ONLY } from "./venue-post.ts";

const NOW = 1_790_000_000_000;
let roster: { bots: BotRecord[]; groups: GroupRecord[] };
const lineageRow = (thread: string, id: string) => database().prepare(
  "SELECT l.lsn FROM memory_line_lineage l JOIN memory_thread_no t ON t.no=l.thread_no WHERE t.thread_id=? AND l.message_id=?").get(thread, id);

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  roster = {
    bots: [{ id: "dax", name: "Dax", color: "blue", threadId: "direct", section: "Ops", tasks: [] }],
    groups: [{ id: "venue", name: "Launch week", threadId: "room", section: "Ops", memberIds: ["dax"], tasks: [] }],
  } as unknown as typeof roster;
  setMemoryCaptureRoster(() => roster); setMemoryMode("active"); reconcileMemoryRoster(roster);
});
afterEach(() => { closeDatabase(); });

it("the picker route answers only the owner's surfaces and lists through postableVenues (presentation; the send re-checks)", () => {
  const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
  const at = source.indexOf("/postable-venues$/");
  expect(at).toBeGreaterThan(-1);
  const route = source.slice(at, at + 1200);
  expect(route).toMatch(/method === "GET"/);
  expect(route).toMatch(/if \(!isOwnerOrigin\(requestOrigin\(req, url\)\)\) return json\(res, 403, \{ error: VENUE_POST_PICKER_OWNER_ONLY \}\)/);
  expect(route).toMatch(/postableVenues\(database\(\), \{ bots: store\.bots, groups: store\.groups \}, bot, threadId\)/);
  expect(VENUE_POST_PICKER_OWNER_ONLY).not.toMatch(/[—–]/);
});

it("T34' the posted row's lineage row exists on the unloaded path, and an owner forget of the shown 1:1 line withholds the post from bots", () => {
  const request = { id: "o1", role: "user", kind: "text", text: "Post the launch notes in Launch week", at: NOW, origin: "desktop", postTo: { venueId: "venue" } } as Message;
  appendMessage("direct", request);
  const post = { ...venuePostRow(roster.bots[0]!, "direct", "Launch notes: we ship Friday"), id: "p1", at: NOW + 1 } as Message;
  appendMessage("room", post, undefined, undefined, venuePostLineage("direct", "dax", undefined, [request.id]));
  expect(lineageRow("room", "p1")).toBeTruthy();
  const page = { threadId: "room", lines: [{ messageId: "p1", author: "generated" as const }] };
  const botReader = { audience: { owner: false, scopeIds: [ensureScope("room", "venue")] } };
  expect(denyLookup(database(), page, botReader).get("p1")?.state).toBe("shown");
  captureSource(database(), { id: "message:direct:o1", threadId: "direct", messageId: "o1", kind: "text", speaker: "owner", outcome: "recorded", text: request.text! });
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "message:direct:o1" });
  expect(denyLookup(database(), page, botReader).get("p1")?.state).not.toBe("shown");
  expect(denyLookup(database(), page, { audience: { owner: false, scopeIds: [] } }).get("p1")?.state).not.toBe("shown");
});

it("T37 a routine turn never lists venue_post, even on a line that carries a pick", () => {
  const line = { id: "o2", role: "user", kind: "text", text: "post it", at: NOW, origin: "desktop", postTo: { venueId: "venue" } } as Message;
  const base = { botId: "dax", surfacesForOwner: true, directOwnerAudience: true, origin: "desktop", automationThread: false,
    bot: roster.bots[0]!, threadId: "direct", agentsMcp: true, message: line } as Parameters<typeof venuePostMounts>[0];
  expect(venuePostMounts(base)).not.toBeNull();
  expect(venuePostMounts({ ...base, automationSource: { kind: "routine", routineId: "r1" } })).toBeNull();
  expect(venuePostMounts({ ...base, automationThread: true })).toBeNull();
  // the turn launcher drops the pick for any automation source before the mount ever sees it
  const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
  expect(source).toMatch(/opts\?\.postTo && !opts\.automationSource && !dlg \? \{ postTo: opts\.postTo/);
});

// T30 needs a signed-in Fuigo (then Claude, Codex, Grok, pi) and a network. The gate container runs with no network
// (testlane.sh --network none), so no engine is reachable there: the real-engine run is the packaged qualification step.
const engineReachable = process.env.MURAGE_T30_REAL_ENGINE === "fuigo";
it.skipIf(!engineReachable)("T30 real engine (Fuigo first): Post in… at Auto shows the card, at Full access the line lands with the note", () => {
  expect(process.env.MURAGE_T30_RESULT).toBe("card-at-auto,line-at-full");
});
