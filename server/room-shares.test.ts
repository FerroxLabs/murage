// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// CROSS-CHAT-READ-1019 T50-T57, T60 (T58 paired DM is its own 1.0.19 lane; T59 is the real-engine run on a data copy).
import { mkdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, transaction } from "./database.ts";
import { setExecutionStore } from "./execution-audience.ts";
import { bindHumanThread, linkHumanBinding, observeVerifiedHuman, resolveHumanBinding } from "./human-principals.ts";
import { appendMessage, readMessage } from "./message-db.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { captureMessage } from "./memory/capture.ts";
import { setMemoryCaptureRoster } from "./memory/capture-scope.ts";
import { ensureScope, reconcileMemoryRoster } from "./memory/policy.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { askOwnerToShare, shareAskRowText, shareSources, declineRoomShare, dropRoomShares, recoverRoomShares, roomShare, shareCard, shareDigest, shareMounts, shareRoomExcerpts,
  SHARE_ASKED_LINE, SHARE_DRAFTS, SHARE_TTL_MS, SHARE_UNAVAILABLE, type ShareDeps } from "./room-shares.ts";
import { dropUnprovenShare, type BotRecord, type GroupRecord, type Message, type MessageOrigin, type Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { routePolicy } from "./route-policy.ts";

const NOW = 1_790_000_000_000;
const TOKEN = "ZEBRA-CANARY-71";
let roster: { bots: BotRecord[]; groups: GroupRecord[] };
let serial = 0;
const written: { threadId: string; line: Omit<Message, "id" | "at">; refs: unknown }[] = [];
const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const proxy = readFileSync(new URL("./drivers/agents-proxy.ts", import.meta.url), "utf8");
const groupView = readFileSync(new URL("../src/components/GroupView.tsx", import.meta.url), "utf8");
const card = readFileSync(new URL("../src/components/RoomShareCard.tsx", import.meta.url), "utf8");
const cardState = readFileSync(new URL("../src/components/room-share-card-state.ts", import.meta.url), "utf8");

function say(threadId: string, text: string, extra: Partial<Message> = {}): Message {
  const message = { id: `m${++serial}`, role: "user", kind: "text", text, at: NOW + serial, origin: "desktop", ...extra } as Message;
  appendMessage(threadId, message); return message;
}
const deps: ShareDeps = {
  message: (threadId, messageId) => readMessage(threadId, messageId),
  append: (threadId, line, stableId, within, refs) => {
    const message = { ...line, id: stableId, at: NOW + ++serial } as Message;
    appendMessage(threadId, message); within(); written.push({ threadId, line, refs }); return message;
  },
};
const run = <T,>(operation: () => T) => transaction(() => operation());
function ask(query = "zebra canary", threadId = "room", botId = "dax", now = NOW) {
  const result = askOwnerToShare(database(), roster, { botId, threadId, query, from: "both" }, now);
  if (!result.ok || !result.share?.excerpts.length) throw new Error(`no draft: ${JSON.stringify(result)}`);
  return result;
}
function release(id: string, origin: MessageOrigin = "desktop", override: Record<string, unknown> = {}, now = NOW) {
  const share = roomShare(database(), id)!;
  return shareRoomExcerpts(database(), roster, deps, { id, origin, nonce: share.nonce, digest: shareDigest(share), keep: share.excerpts.map(e => e.messageId), ...override }, run, now);
}
function person(thread: string) {
  const binding = observeVerifiedHuman({ platform: "slack", connectionId: "fixture", authorityId: "team", userId: `${thread}-guest` });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: binding, expectedRevision: 1, as: "person" });
  bindHumanThread(thread, resolveHumanBinding(binding));
}
function exclude(...threads: string[]) {
  database().prepare("INSERT OR REPLACE INTO memory_scope_bindings VALUES('memory-owner-settings',?,'system','owner-settings',0,'granted',?)")
    .run(ensureScope("conversation", "direct"), JSON.stringify({ excludedThreadIds: threads }));
}

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  serial = 0; written.length = 0;
  roster = {
    bots: [
      { id: "dax", name: "Dax", threadId: "direct", section: "Ops", tasks: [
        { threadId: "task" }, { threadId: "desk", channelProjectDesk: { groupId: "venue" } },
      ] },
      { id: "finch", name: "Finch", threadId: "finch-direct", section: "Ops" },
    ],
    groups: [
      { id: "venue", name: "Venue", threadId: "room", section: "Ops", memberIds: ["dax", "finch"], tasks: [{ threadId: "room-task" }] },
      { id: "other", name: "Other", threadId: "other-room", section: "Ops", memberIds: ["dax"], tasks: [] },
    ],
  } as unknown as typeof roster;
  setExecutionStore({ ...roster, bot: (id: string) => roster.bots.find(bot => bot.id === id), group: (id: string) => roster.groups.find(group => group.id === id) } as Store);
  setMemoryCaptureRoster(() => roster); setMemoryMode("active"); reconcileMemoryRoster(roster);
  say("direct", `the ${TOKEN} plan is zebra canary`);
  say("direct", "nothing to see");
});
afterEach(() => { setExecutionStore(undefined as never); closeDatabase(); });

it("T50 listed on the room thread, a room task and the bot's desk; not with a person, archived, pair, memory-off or a non-member", () => {
  expect(shareMounts(database(), roster, "dax", "room")?.id).toBe("venue");
  expect(shareMounts(database(), roster, "dax", "room-task")?.id).toBe("venue");
  expect(shareMounts(database(), roster, "dax", "desk")?.id).toBe("venue");
  expect(shareMounts(database(), roster, "dax", "direct")).toBeNull();
  expect(shareMounts(database(), roster, "ghost", "room")).toBeNull();
  roster.groups[0]!.hidden = true; expect(shareMounts(database(), roster, "dax", "room")).toBeNull(); roster.groups[0]!.hidden = false;
  roster.groups[0]!.dm = true; expect(shareMounts(database(), roster, "dax", "room")).toBeNull(); roster.groups[0]!.dm = false;
  exclude("room"); expect(shareMounts(database(), roster, "dax", "room")).toBeNull(); exclude();
  expect(shareMounts(database(), roster, "dax", "room")?.id).toBe("venue");
  person("room-task"); expect(shareMounts(database(), roster, "dax", "room-task")).toBeNull();
  // index.ts: the room turn and the desk/direct turn mount it from the predicate; the proxy lists it only on that env
  expect(index).toMatch(/roomShareListed = roomOwnerAudience && Boolean\(shareMounts\(database\(\)/);
  expect(index).toMatch(/venuePostListed && venuePost \? venuePost\.request\.postTo : null,\s*Boolean\(shareMounts\(database\(\)/);
  expect(index).toContain('MURAGE_ROOM_SHARE: "1"');
  expect(proxy).toContain('process.env.MURAGE_ROOM_SHARE === "1"');
});

it("T51 the ask freezes a row the bot never reads; the tool text, the room row and capture carry none of the excerpt", () => {
  const result = ask();
  expect(result.toolText).toBe(SHARE_ASKED_LINE);
  // no search oracle: a miss gives the bot the same line and the same room row
  const miss = askOwnerToShare(database(), roster, { botId: "dax", threadId: "room", query: "no such words here", from: "both" }, NOW);
  expect(miss).toMatchObject({ ok: true, toolText: SHARE_ASKED_LINE }); expect(miss.ok && miss.share?.excerpts).toEqual([]);
  expect(result.toolText).not.toContain(TOKEN);
  const row = database().prepare("SELECT * FROM room_shares WHERE id=?").get(result.share!.id) as Record<string, unknown>;
  expect(row.status).toBe("pending"); expect(String(row.excerpts)).toContain(TOKEN);
  // the room row text is the query only (index.ts postShareAsk), and the internal route returns only { text }
  expect(index).toMatch(/text: shareAskRowText\(bot\?\.name \?\? "A bot"\), roomShareId: share\.id/);
  expect(shareAskRowText("Dax")).not.toContain("zebra");
  expect(index).toMatch(/return \{ status: 200, body: \{ text: result\.toolText \} \};/);
  expect(index).toContain('path === "/api/internal/room-share/ask"');
  // a bot or any non-Murage writer cannot forge the request mark or the share mark
  expect(dropUnprovenShare({ role: "bot", kind: "text", roomShareId: "x" } as never)).not.toHaveProperty("roomShareId");
  expect(dropUnprovenShare({ role: "user", kind: "text", origin: "unproven", copyOf: {}, sharedFrom: {} } as never)).not.toHaveProperty("sharedFrom");
  expect(dropUnprovenShare({ role: "bot", kind: "text", murageLine: true, roomShareId: "x" } as never)).toHaveProperty("roomShareId");
  expect(written).toHaveLength(0);
});

it("T52 Share only from an owner desktop or companion session with the draft's proof; anything else leaves the row pending", () => {
  const { share } = ask();
  for (const origin of ["unproven", "channel", "paired", "bot", "routine"] as MessageOrigin[]) {
    expect(release(share!.id, origin)).toMatchObject({ ok: false, status: 403 });
  }
  expect(release(share!.id, "desktop", { digest: "0".repeat(64) })).toMatchObject({ ok: false, status: 409 });
  expect(release(share!.id, "desktop", { nonce: "replayed" })).toMatchObject({ ok: false, status: 409 });
  expect(roomShare(database(), share!.id)!.status).toBe("pending");
  expect(declineRoomShare(database(), share!.id, "unproven")).toBe(false);
  const proof = { nonce: roomShare(database(), share!.id)!.nonce, digest: shareDigest(roomShare(database(), share!.id)!) };
  expect(release(share!.id, "companion")).toMatchObject({ ok: true, status: "shared" });
  // a replayed proof after the release finds the row closed
  expect(shareRoomExcerpts(database(), roster, deps, { id: share!.id, origin: "desktop", ...proof, keep: share!.excerpts.map(e => e.messageId) }, run, NOW))
    .toMatchObject({ ok: false, status: 409 });
  expect(written).toHaveLength(1);
  // the owner routes gate on the request's proven origin
  expect(index).toMatch(/\/api\\\/room-shares\\\/\(\[\\w-\]\+\)/);
  expect(index).toMatch(/const origin = requestOrigin\(req, url\);\s*if \(origin !== "desktop" && origin !== "companion"\) return json\(res, 403/);
});

it("T53 Share writes ONE owner line with copyOf and prefix refs; no bot turn is queued after the commit", () => {
  const { share } = ask();
  const outcome = release(share!.id);
  expect(outcome).toMatchObject({ ok: true, status: "shared" });
  expect(written).toHaveLength(1);
  const [{ threadId, line, refs }] = written;
  expect(threadId).toBe("room");
  expect(line).toMatchObject({ role: "user", kind: "text", origin: "desktop", copyOf: { threadId: "direct" }, sharedFrom: { botId: "dax", shareId: share!.id } });
  expect(line.text).toContain(TOKEN);
  expect(refs).toEqual([{ kind: "prefix", threadId: "direct", shown: share!.excerpts.map(e => e.messageId) }]);
  expect(dropUnprovenShare(line as never)).toHaveProperty("sharedFrom");
  const row = roomShare(database(), share!.id)!;
  expect(row.status).toBe("shared"); expect(row.excerpts).toEqual([]);
  expect(index).toMatch(/if \(share\) broadcastGroup\(share\.roomId\);\n  return \{ status: 200, body: \{ status: outcome\.status \} \};/);
  expect(index).toMatch(/operation => transaction\(\(\) => operation\(\)\)/);
});

it("T54 subset only; a line gone or changed drops out; all gone is unavailable; expiry, restart and the draft cap", () => {
  say("direct", "second zebra canary line");
  const { share } = ask();
  expect(share!.excerpts).toHaveLength(2);
  expect(release(share!.id, "desktop", { keep: ["foreign"] })).toMatchObject({ ok: false, status: 400 });
  expect(release(share!.id, "desktop", { keep: [] })).toMatchObject({ ok: false, status: 400 });
  const [first, second] = share!.excerpts;
  const live = { ...deps, message: (t: string, id: string) => id === first!.messageId ? { ...readMessage(t, id)!, text: "edited" } : readMessage(t, id) };
  const proof = roomShare(database(), share!.id)!;
  expect(shareRoomExcerpts(database(), roster, live, { id: share!.id, origin: "desktop", nonce: proof.nonce, digest: shareDigest(proof), keep: [first!.messageId, second!.messageId] }, run, NOW))
    .toMatchObject({ ok: true, status: "shared" });
  expect(written[0]!.line.copyOf).toEqual({ threadId: "direct", messageIds: [second!.messageId] });
  const gone = ask("nothing to see");
  const none = { ...deps, message: () => null };
  const p2 = roomShare(database(), gone.share!.id)!;
  expect(shareRoomExcerpts(database(), roster, none, { id: p2.id, origin: "desktop", nonce: p2.nonce, digest: shareDigest(p2), keep: p2.excerpts.map(e => e.messageId) }, run, NOW))
    .toMatchObject({ ok: true, status: "unavailable" });
  const late = ask("nothing to see");
  expect(release(late.share!.id, "desktop", {}, NOW + SHARE_TTL_MS + 1)).toMatchObject({ ok: false, status: 409 });
  expect(roomShare(database(), late.share!.id)!.status).toBe("unavailable");
  for (let n = 0; n < SHARE_DRAFTS; n++) ask("nothing to see");
  expect(askOwnerToShare(database(), roster, { botId: "dax", threadId: "room", query: "nothing to see", from: "both" }, NOW)).toMatchObject({ ok: false });
  recoverRoomShares(database(), () => false);
  expect(Number((database().prepare("SELECT COUNT(*) AS n FROM room_shares WHERE status='pending'").get() as { n: number }).n)).toBe(0);
  ask("nothing to see");
  dropRoomShares(database(), { roomId: "venue" });
  expect(Number((database().prepare("SELECT COUNT(*) AS n FROM room_shares WHERE status='pending'").get() as { n: number }).n)).toBe(0);
  expect(index).toMatch(/dropRoomShares\(database\(\), \{ roomId: group\.id \}\)/);
  expect(index).toMatch(/if \(deleted\) dropRoomShares\(database\(\), \{ botId: bot\.id \}\)/);
});

it("T55 boot recovery: an interrupted Share with its line is shared, without it back to pending then discarded; no second line", () => {
  const a = ask().share!, b = ask("nothing to see").share!;
  database().prepare("UPDATE room_shares SET status='sharing' WHERE id IN (?,?)").run(a.id, b.id);
  recoverRoomShares(database(), (_thread, stableId) => stableId === a.stableId);
  expect(roomShare(database(), a.id)!.status).toBe("shared");
  expect(roomShare(database(), b.id)!.status).toBe("unavailable");
  expect(written).toHaveLength(0);
  // 18a: the probe goes through venuePostStored, the one counted by-id read, which is the stored line or null
  expect(index).toMatch(/bootRoomShares\(database\(\), \(threadId, stableId\) => Boolean\(venuePostStored\(threadId, stableId\)\), guardedWriter\)/);
  expect(index).toMatch(/function venuePostStored\(threadId: string, messageId: string\): Message \| null \{ return store\.messageById\(threadId, messageId\) \?\? null; \}/);
});

it("T56 neither the share line nor the request row becomes a memory source of the room", () => {
  const { share } = ask();
  release(share!.id);
  const line = { ...written[0]!.line, id: share!.stableId, at: NOW } as Message;
  captureMessage(database(), "room", line);
  captureMessage(database(), "room", { id: "req", at: NOW, role: "bot", kind: "text", text: "Dax asks", roomShareId: share!.id, murageLine: true } as Message);
  const sources = database().prepare("SELECT COUNT(*) AS n FROM memory_sources WHERE thread_id='room'").get() as { n: number };
  expect(Number(sources.n)).toBe(0);
});

it("T57 a person granted the room unmounts the tool on the next turn; the shared line keeps its note", () => {
  expect(shareMounts(database(), roster, "dax", "room")).not.toBeNull();
  person("room");
  expect(shareMounts(database(), roster, "dax", "room")).toBeNull();
  expect(askOwnerToShare(database(), roster, { botId: "dax", threadId: "room", query: "zebra", from: "both" }, NOW)).toEqual({ ok: false, error: SHARE_UNAVAILABLE });
  expect(groupView).toMatch(/m\.sharedFrom && <div[^>]*>\{t\("roomShare\.sharedFrom", \{ name: /);
});

it("T60 the composer entry reaches the same picker and the same Share route", () => {
  expect(index).toMatch(/\/api\\\/groups\\\/\(\[\\w-\]\+\)\\\/room-shares\$/);
  expect(index).toMatch(/askOwnerToShare\(database\(\), shareRoster\(\), \{ botId: body\.botId, threadId, query: body\.query, from: body\.from \}\)/);
  expect(card).toContain("/room-shares`, { method: \"POST\"");
  expect(cardState).toContain("/api/room-shares/${encodeURIComponent(card.id)}/${action}");
  expect(groupView).toContain("<RoomShareAsk group={group} members={members} />");
  // the card body for the owner carries the exact excerpts and the proof
  const { share } = ask();
  const view = shareCard(share!, "Dax", () => "Your chat with Dax");
  expect(view.excerpts.map(e => e.text).join(" ")).toContain(TOKEN);
  expect(view.digest).toBe(shareDigest(share!));
});

it("review r1: the active task is filtered like every task; Share rechecks the origin turn's room and each source; companion routes", () => {
  // the desk as the active task (bot.threadId) is never a source
  say("desk", "zebra canary on the desk");
  roster.bots[0]!.threadId = "desk";
  expect(shareSources(database(), roster, roster.bots[0]!, roster.groups[0]!, "my-chats")).not.toContain("desk");
  roster.bots[0]!.threadId = "direct";
  // a source made memory-off after the ask drops out at Share
  const a = ask().share!;
  exclude("direct");
  expect(release(a.id)).toMatchObject({ ok: true, status: "unavailable" });
  expect(written).toHaveLength(0);
  exclude();
  // an ask from the desk task is re-checked at Share: an archived desk ends it
  const b = ask("zebra canary", "desk").share!;
  expect(b.originThreadId).toBe("desk");
  (roster.bots[0]!.tasks![1] as { channelProjectDesk: { archivedAt?: number } }).channelProjectDesk.archivedAt = NOW;
  expect(release(b.id)).toMatchObject({ ok: true, status: "unavailable" });
  expect(routePolicy("GET", "/api/room-shares/rshare-1")?.class).toBe("companion");
  expect(routePolicy("POST", "/api/room-shares/rshare-1/share")?.class).toBe("companion");
  expect(routePolicy("POST", "/api/room-shares/rshare-1/decline")?.class).toBe("companion");
  expect(routePolicy("POST", "/api/groups/venue/room-shares")?.class).toBe("companion");
});

it("MurageMain cut (R4): Share queues NO automatic bot reply; the bot reads the shared line on its next turn, and the owner's card says so", () => {
  const start = index.indexOf("function serveShareRelease(");
  expect(start).toBeGreaterThan(0);
  const release = index.slice(start, index.indexOf("\n}\n", start));
  expect(release).toContain("shareRoomExcerpts(");
  for (const turn of ["runGroupMemberTurn", "groupQueues", "setTimeout", "queueGroup", "dispatch"]) expect(release).not.toContain(turn);
  for (const gone of ["queueShareReply", "shareReplyStops", "SHARE_REPLY_RETRIES", "SHARE_REPLY_RETRY_MS", "did not answer the share"]) expect(index).not.toContain(gone);
  const en = JSON.parse(readFileSync(new URL("../src/locales/en.json", import.meta.url), "utf8")) as Record<string, string>;
  expect(en["roomShare.shared"]).toBe("Shared. {name} will use it in its next reply.");
  expect(card).toMatch(/t\("roomShare\.shared", \{ name: card\.botName \}\)/);
});
