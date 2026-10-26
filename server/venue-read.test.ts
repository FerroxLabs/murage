// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// T16-T33: the test runner installs an isolated HOME before importing config.
import { mkdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { setExecutionStore } from "./execution-audience.ts";
import { bindHumanThread, linkHumanBinding, observeVerifiedHuman, resolveHumanBinding } from "./human-principals.ts";
import { InternalCapabilities, requiredInternalKind } from "./internal-capabilities.ts";
import { appendMessage } from "./message-db.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { captureSource } from "./memory/capture.ts";
import { setMemoryCaptureRoster } from "./memory/capture-scope.ts";
import { forgetMemory } from "./memory/forget.ts";
import { ensureScope, reconcileMemoryRoster } from "./memory/policy.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { fixedCopy } from "./bot-read.ts";
import { ROOM_REPLY_CHECKING } from "./room-context.ts";
import { registerProjectMemoryTools, venueToolHandlers, VENUE_LINKED_LINE, type VenueLine } from "./project-memory-tools.ts";
import { channelToProjectRows } from "./project-settings.ts";
import { turnRequestByGeneration } from "./project-tool-routing.ts";
import type { BotRecord, GroupRecord, Message, Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { forgetAllVenueReadTurns, recordVenueReadTurn, serveVenueRead, setVenueReadLive,
  venueReadMounts, venueReadTurns, venueThreads, VENUE_NOT_AVAILABLE as L2, VENUE_READ_LIMIT as L3, VENUE_READ_UNAVAILABLE as L1 } from "./venue-read.ts";

const NOW = 1_790_000_000_000;
const claim = { botId: "dax", threadId: "direct", generation: "turn" };
let roster: { bots: BotRecord[]; groups: GroupRecord[] };
let surfaces: Map<string, boolean>;
let notOwner: Set<string>;
const shown = vi.fn(), read = vi.fn();
const heads = new Map<string, string>();
let serial = 0;
function record(extra: Partial<Parameters<typeof recordVenueReadTurn>[1]> = {}) {
  recordVenueReadTurn(claim.generation, { botId: claim.botId, threadId: claim.threadId, origin: "desktop", ...extra });
}
function say(threadId: string, text: string, extra: Partial<Message> = {}) {
  const message = { id: `v${++serial}`, role: "bot", kind: "text", text, at: NOW + serial,
    from: { botId: "finch", name: "Old Finch", color: "blue" },
    ...(heads.has(threadId) ? { parentId: heads.get(threadId) } : {}), ...extra } as Message;
  appendMessage(threadId, message); heads.set(threadId, message.id); return message;
}
function call(body: Record<string, unknown> = {}) { return serveVenueRead(database(), claim, { venueId: "venue", ...body }); }
function page(body: Record<string, unknown> = {}) {
  const response = call(body); expect(response.status).toBe(200);
  return response.body as { threadId: string; messages: VenueLine[]; before?: string };
}
function refused(result: ReturnType<typeof call>, line: string) {
  expect(result).toEqual({ status: 403, body: { error: line } });
  expect(JSON.stringify(result)).not.toContain("CANARY");
  expect(result.body).not.toHaveProperty("messages");
}
function exclude(...threads: string[]) {
  database().prepare("INSERT OR REPLACE INTO memory_scope_bindings VALUES('memory-owner-settings',?,'system','owner-settings',0,'granted',?)")
    .run(ensureScope("conversation", "direct"), JSON.stringify({ excludedThreadIds: threads }));
}
function person(thread: string, platform: "slack" | "discord" | "telegram" = "slack") {
  const binding = observeVerifiedHuman({ platform, connectionId: "fixture", authorityId: "team", userId: `${thread}-guest` });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: binding, expectedRevision: 1, as: "person" });
  bindHumanThread(thread, resolveHumanBinding(binding));
}
function project() {
  roster.groups[0]!.channelProject = { goal: "Launch" } as GroupRecord["channelProject"];
  channelToProjectRows(database(), { groupId: "venue", bulletin: "", leadBotId: "dax", now: NOW });
}
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  serial = 0; heads.clear(); shown.mockReset(); read.mockReset();
  forgetAllVenueReadTurns(); turnRequestByGeneration.clear();
  roster = {
    bots: [
      { id: "dax", name: "Dax", threadId: "direct", section: "Ops", tasks: [
        { threadId: "task" }, { threadId: "desk", channelProjectDesk: { groupId: "venue" } },
      ] },
      { id: "finch", name: "Finch", threadId: "finch-direct", section: "Ops" },
    ],
    groups: [{ id: "venue", name: "Venue", threadId: "room", section: "Ops", memberIds: ["dax", "finch"], tasks: [{ threadId: "room-task" }] }],
  } as unknown as typeof roster;
  setExecutionStore({ ...roster, bot: (id: string) => roster.bots.find(bot => bot.id === id), group: (id: string) => roster.groups.find(group => group.id === id) } as Store);
  setMemoryCaptureRoster(() => roster); setMemoryMode("active"); reconcileMemoryRoster(roster);
  surfaces = new Map([["direct", true], ["root", true]]); notOwner = new Set();
  setVenueReadLive({ ownerSurface: id => surfaces.get(id), notOwnerAudience: id => notOwner.has(id), roster: () => roster });
  registerProjectMemoryTools({ roster: () => roster, note: () => {}, shown, read });
  record();
});
afterEach(() => {
  vi.restoreAllMocks(); setVenueReadLive(null); forgetAllVenueReadTurns(); turnRequestByGeneration.clear();
  setExecutionStore(undefined as never); closeDatabase();
});

it("T16 newest 20 lines, ordered, with only the reader input and consuming-thread receipts", () => {
  const lines = Array.from({ length: 25 }, (_, n) => say("room", `line ${n}`));
  const handler = venueToolHandlers.get("read-messages")!;
  const spy = vi.fn(handler); venueToolHandlers.set("read-messages", spy);
  const first = page();
  expect(first.messages.map(line => line.text)).toEqual(lines.slice(5).map(line => line.text));
  expect(first.before).toBe(`r${database().prepare("SELECT rowid FROM messages WHERE id=?").get(lines[5]!.id)!.rowid}`);
  expect(spy.mock.calls[0]![0].input).toEqual({ threadId: "room", before: undefined, limit: undefined });
  expect(shown).toHaveBeenCalledWith("direct", lines.slice(5).map(line => ({ threadId: "room", messageId: line.id })));
  expect(read).toHaveBeenCalledWith("direct", "dax", lines.slice(5).map(line => ({ threadId: "room", id: line.id, role: "bot" })));
  expect(page({ before: first.before }).messages.map(line => line.text)).toEqual(lines.slice(0, 5).map(line => line.text));
});

it("T17 stand-in-only pages advance using rowids, without leaking message ids", () => {
  const rows = Array.from({ length: 5 }, () => say("room", "CANARY", { withheldFromBots: "forgotten" } as Partial<Message>));
  const first = page({ limit: 2 }), second = page({ limit: 2, before: first.before });
  expect(first.messages).toHaveLength(2); expect(second.messages).toHaveLength(2);
  expect(Number(second.before!.slice(1))).toBeLessThan(Number(first.before!.slice(1)));
  for (const line of [...first.messages, ...second.messages]) expect(Object.keys(line).sort()).toEqual(["at", "text"]);
  for (const row of rows) expect(JSON.stringify([first, second])).not.toContain(`"${row.id}"`);
  expect(shown).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});

it("T17 serialized byte cap defers rows without skipping, including escaped and multibyte text", () => {
  const rows = Array.from({ length: 30 }, (_, n) => say("room", `${n}:` + '漢\\"'.repeat(1300)));
  const first = page({ limit: 50 });
  expect(first.messages.length).toBeGreaterThan(0); expect(first.messages.length).toBeLessThan(30);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(48_000);
  const oldest = first.messages[0]!;
  expect("id" in oldest).toBe(true);
  if (!("id" in oldest)) throw new Error("Expected substantive row");
  expect(first.before).toBe(`r${database().prepare("SELECT rowid FROM messages WHERE id=?").get(oldest.id)!.rowid}`);
  const second = page({ limit: 50, before: first.before });
  const next = rows[rows.findIndex(row => row.id === oldest.id) - 1]!;
  expect(second.messages.at(-1)).toMatchObject({ id: next.id });
  expect(Buffer.byteLength(JSON.stringify(second))).toBeLessThanOrEqual(48_000);
});

it("T17 an oversized first entry refuses without exceeding the byte bound", () => {
  say("room", "text", { to: Array.from({ length: 10_000 }, () => "finch") });
  refused(call(), L2); expect(shown).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});

it.each([
  [{ limit: 51 }, "limit is 1 to 50"], [{ limit: 0 }, "limit is 1 to 50"], [{ limit: 1.5 }, "limit is 1 to 50"],
  [{ before: "message-id" }, "before is not a page cursor"], [{ before: "r-1" }, "before is not a page cursor"],
] as const)("T17 a malformed limit or cursor on an authorised venue is 400 with a neutral line %j", (body, line) => {
  const result = call(body);
  expect(result).toEqual({ status: 400, body: { error: line } });
  expect(JSON.stringify(result)).not.toContain("CANARY");
  expect(shown).not.toHaveBeenCalled();
});
it("T17 an unknown argument still refuses as L2", () => { refused(call({ extra: true }), L2); expect(shown).not.toHaveBeenCalled(); });

it.each(["slack", "discord", "telegram"] as const)("T18 %s person's direct turn returns L1 without reading", platform => {
  person("direct", platform); say("room", "CANARY"); refused(call(), L1); expect(shown).not.toHaveBeenCalled();
});
it.each(["false", "missing", "not-owner", "human", "root", "root-human"])("T19 live audience change: %s", change => {
  if (change === "false") surfaces.set("direct", false);
  if (change === "missing") surfaces.delete("direct");
  if (change === "not-owner") notOwner.add("direct");
  if (change === "human") person("direct");
  if (change.startsWith("root")) { record({ rootThreadId: "root" }); if (change === "root") surfaces.delete("root"); else person("root"); }
  refused(call(), L1);
});
it("T20 membership is re-read after dispatch", () => { roster.groups[0]!.memberIds = ["finch"]; refused(call(), L2); });
it.each(["pair", "archived", "unknown"])("T21 %s has the same refusal", kind => {
  if (kind === "pair") roster.groups[0]!.dm = true;
  if (kind === "archived") roster.groups[0]!.hidden = true;
  refused(call({ venueId: kind === "unknown" ? "missing" : "venue" }), L2);
});
it("T22 memory-off targets close, while another thread of that venue remains readable", () => {
  exclude("room"); refused(call(), L2); expect(page({ venueThreadId: "room-task" }).messages).toEqual([]);
});
it.each([1, 2])("T22 %i-hop memory-off copy is bare and joins neither source ledger", hops => {
  const original = say("task", "COPY_CANARY");
  const source = hops === 1 ? original : say("direct", "COPY_CANARY", { copyOf: { threadId: "task", messageIds: [original.id] } });
  say("room", "COPY_CANARY", { copyOf: { threadId: hops === 1 ? "task" : "direct", messageIds: [source.id] } });
  exclude("task");
  const result = page(); expect(result.messages).toHaveLength(1);
  expect(Object.keys(result.messages[0]!).sort()).toEqual(["at", "text"]);
  expect(JSON.stringify(result)).not.toContain("COPY_CANARY"); expect(shown).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});
it.each(["project", "channel", "ended", "null"])("T23 a bound desk closes the whole %s venue", kind => {
  if (kind === "project" || kind === "ended") project();
  if (kind === "ended") database().prepare("UPDATE project_settings SET ended_at=1 WHERE group_id='venue'").run();
  person("desk");
  if (kind === "null") database().prepare("UPDATE memory_scope_bindings SET intent=json_set(intent,'$.personId',NULL) WHERE subject_id='desk' AND subject_type='human-thread'").run();
  refused(call(), L2); refused(call({ venueThreadId: "room-task" }), L2);
});
it("T22 a hand-off whose source is a memory-off thread is bare and joins neither source ledger", () => {
  const original = say("task", "HANDOFF_CANARY");
  say("room", "HANDOFF_CANARY", { handoffOf: { threadId: "task", messageId: original.id } } as Partial<Message>);
  exclude("task");
  const result = page();
  for (const line of result.messages) expect(Object.keys(line).sort()).toEqual(["at", "text"]);
  expect(JSON.stringify(result)).not.toContain("HANDOFF_CANARY"); expect(shown).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});
it("T22 a copy of a hand-off whose source is a memory-off thread is bare", () => {
  const original = say("task", "HANDOFF2_CANARY");
  const handed = say("direct", "HANDOFF2_CANARY", { handoffOf: { threadId: "task", messageId: original.id } } as Partial<Message>);
  say("room", "HANDOFF2_CANARY", { copyOf: { threadId: "direct", messageIds: [handed.id] } });
  exclude("task");
  const result = page();
  for (const line of result.messages) expect(Object.keys(line).sort()).toEqual(["at", "text"]);
  expect(JSON.stringify(result)).not.toContain("HANDOFF2_CANARY"); expect(shown).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});
it("T25 a reply to a withheld line does not name the withheld line's id", () => {
  const hidden = say("room", "WITHHELD_CANARY", { withheldFromBots: true });
  say("room", "a visible reply", { replyToId: hidden.id } as Partial<Message>);
  const result = page();
  expect(result.messages.some(line => line.text === "a visible reply")).toBe(true);
  expect(JSON.stringify(result)).not.toContain(hidden.id); expect(JSON.stringify(result)).not.toContain("WITHHELD_CANARY");
});
it("T23 a copy from a person-bound thread is bare", () => {
  person("task"); const original = say("task", "PERSON_CANARY");
  say("room", "PERSON_CANARY", { copyOf: { threadId: "task", messageIds: [original.id] } });
  const result = page(); expect(result.messages).toHaveLength(1);
  expect(Object.keys(result.messages[0]!).sort()).toEqual(["at", "text"]);
  expect(JSON.stringify(result)).not.toContain("PERSON_CANARY"); expect(read).not.toHaveBeenCalled();
});
it("T24 another partition refuses with L2 and a copied ancestor crossing it is absent", () => {
  roster.bots[0]!.partitionedAt = NOW;
  roster.groups[0]!.partitionedFor = { dax: { kind: "team", teamId: "other-team" } };
  refused(call(), L2);
  delete roster.groups[0]!.partitionedFor;
  const original = say("unknown-thread", "PARTITION_CANARY");
  say("room", "PARTITION_CANARY", { copyOf: { threadId: "unknown-thread", messageIds: [original.id] } });
  expect(page().messages).toEqual([]); expect(read).not.toHaveBeenCalled();
});
it("T24 a hand-off, or a copy of one, whose source crosses the partition is absent", () => {
  roster.bots[0]!.partitionedAt = NOW;
  const original = say("unknown-thread", "PARTITION_HANDOFF_CANARY");
  const handed = say("room", "PARTITION_HANDOFF_CANARY", { handoffOf: { threadId: "unknown-thread", messageId: original.id } } as Partial<Message>);
  say("room", "PARTITION_HANDOFF_CANARY", { copyOf: { threadId: "room", messageIds: [handed.id] } });
  const result = page();
  expect(JSON.stringify(result)).not.toContain("PARTITION_HANDOFF_CANARY"); expect(read).not.toHaveBeenCalled();
});
it("T24 an isolated consuming thread refuses with L2", () => {
  // The current store's partition view is checked independently of the live ownership roster.
  roster.bots[0]!.partitionedAt = NOW;
  const isolatedBot = { ...roster.bots[0]!, threadId: "different", tasks: [] };
  setExecutionStore({ ...roster, bot: () => isolatedBot } as unknown as Store);
  refused(call(), L2);
});
it("T25 a forgotten line and its copy disclose no words, ids or sources", () => {
  const original = say("task", "FORGOTTEN_CANARY");
  captureSource(database(), { id: `message:task:${original.id}`, threadId: "task", messageId: original.id, kind: "text", speaker: "finch", outcome: "recorded", text: original.text! });
  say("room", "FORGOTTEN_CANARY", { copyOf: { threadId: "task", messageIds: [original.id] } });
  say("room", "FORGOTTEN_CANARY", { withheldFromBots: "forgotten" } as Partial<Message>);
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: `message:task:${original.id}` });
  const result = page(); expect(result.messages.length).toBeGreaterThan(0);
  for (const line of result.messages) expect(Object.keys(line).sort()).toEqual(["at", "text"]);
  expect(JSON.stringify(result)).not.toContain("FORGOTTEN_CANARY"); expect(shown).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});
it("T26 a Murage-voice projection is bare, and an unprojectable row is absent", () => {
  const chip = say("room", "CHIP_CANARY", { murage: { kind: "failure", status: { key: "withheld" } } } as Partial<Message>);
  say("room", "OMITTED_CANARY", { murage: { kind: "unknown", status: { key: "unknown" } } } as unknown as Partial<Message>);
  expect(page().messages).toEqual([{ at: chip.at, text: fixedCopy(chip) }]);
  expect(shown).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});
it("T26 a copy-chain projection carries no stored speaker name in its fixed text", () => {
  say("room", "WORDS_CANARY", { copyOf: { threadId: "missing", messageIds: ["gone"] },
    from: { botId: "departed", name: "NAME_CANARY", color: "blue" } });
  const result = page();
  expect(result.messages).toHaveLength(1);
  expect(Object.keys(result.messages[0]!).sort()).toEqual(["at", "text"]);
  expect(JSON.stringify(result)).not.toContain("CANARY");
  expect(shown).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});
// 1.0.7 simpler rule: any row carrying copyOf, handoffOf or handoffFrom is a stand-in (no words, no id), however clean its source; rows another
// partition holds are left out entirely (handoff-partition), never shown as stand-ins.
it.each([
  ["a copy from a clean in-venue thread", (source: Message) => ({ copyOf: { threadId: "room-task", messageIds: [source.id] } }), VENUE_LINKED_LINE],
  ["a hand-off by handoffOf", (source: Message) => ({ handoffOf: { threadId: "room-task", messageId: source.id } }), VENUE_LINKED_LINE],
  ["a hand-off saved with only handoffFrom", () => ({ handoffFrom: "room-task" }), VENUE_LINKED_LINE],
  ["a handoffFrom that is null", () => ({ handoffFrom: null }), VENUE_LINKED_LINE],
  // memory lineage cannot record a malformed link, so the line stays held as "checking": design 10 S2, a hidden linked row reads its
  // checking line, still a bare stand-in
  ["a malformed handoffOf", () => ({ handoffOf: "room-task" }), ROOM_REPLY_CHECKING],
] as const)("1.0.7 %s is a bare stand-in and joins no sources", (_label, link, line) => {
  const source = say("room-task", "SOURCE_CANARY");
  const linked = say("room", "LINKED_CANARY", link(source) as Partial<Message>);
  say("room", "plain line", { replyToId: linked.id } as Partial<Message>);
  const result = page();
  const stand = result.messages.find(entry => !("id" in entry));
  expect(stand).toEqual({ at: linked.at, text: line });
  expect(result.messages.find(entry => "id" in entry)).toMatchObject({ text: "plain line" });
  expect(result.messages.find(entry => "id" in entry)).not.toHaveProperty("re");
  expect(JSON.stringify(result)).not.toContain("LINKED_CANARY"); expect(JSON.stringify(result)).not.toContain(linked.id);
  const ids = (calls: unknown[][]) => JSON.stringify(calls);
  expect(ids(shown.mock.calls)).not.toContain(linked.id); expect(ids(read.mock.calls)).not.toContain(linked.id);
});
it("1.0.7 a partitioned bot: a handoffFrom-only row from another partition is absent, not a stand-in, and a reply to it names no id", () => {
  roster.bots[0]!.partitionedAt = NOW;
  const foreign = say("room", "FOREIGN_CANARY", { handoffFrom: "unknown-thread" } as Partial<Message>);
  const copied = say("room", "FOREIGN_COPY_CANARY", { copyOf: { threadId: "unknown-thread", messageIds: ["gone"] } });
  say("room", "a reply", { replyToId: foreign.id } as Partial<Message>);
  const result = page();
  expect(result.messages.filter(line => !("id" in line))).toEqual([]);
  expect(result.messages.map(line => line.text)).toEqual(["a reply"]);
  for (const id of [foreign.id, copied.id]) expect(JSON.stringify(result)).not.toContain(id);
  expect(JSON.stringify(result)).not.toContain("CANARY");
  expect(JSON.stringify([shown.mock.calls, read.mock.calls])).not.toContain(foreign.id);
});
it("1.0.7 a partitioned bot: an in-partition hand-off is still a stand-in, unlinked lines stay substantive", () => {
  roster.bots[0]!.partitionedAt = NOW;
  const ask = say("room-task", "ASK_CANARY");
  const handed = say("room", "INSIDE_CANARY", { handoffFrom: "room-task", handoffOf: { threadId: "room-task", messageId: ask.id } } as Partial<Message>);
  const plain = say("room", "plain");
  const result = page();
  expect(result.messages).toEqual([{ at: handed.at, text: VENUE_LINKED_LINE }, expect.objectContaining({ id: plain.id, text: "plain" })]);
  expect(JSON.stringify(result)).not.toContain("CANARY");
});
it("T27 card and room generations cannot acquire the venue reader", () => {
  turnRequestByGeneration.set("turn", "request"); refused(call(), L1);
  forgetAllVenueReadTurns(); refused(call(), L1);
});
// T28: budget refusals are 403 L3 (design 4.3 R10 amended 10-25 from 409; the bot-visible line is the same)
it("T28 six empty/repeated calls count even without a memory receipt; seventh never reads", () => {
  registerProjectMemoryTools({ roster: () => roster, note: () => {} });
  const handler = vi.fn(venueToolHandlers.get("read-messages")!); venueToolHandlers.set("read-messages", handler);
  for (let i = 0; i < 6; i++) expect(page().messages).toEqual([]);
  refused(call(), L3); expect(handler).toHaveBeenCalledTimes(6);
});
it("T28 149 emitted lines then 50 refuses, but one remaining line succeeds", () => {
  for (let i = 0; i < 50; i++) say("room", `line ${i}`);
  page({ limit: 50 }); page({ limit: 50 }); page({ limit: 49 });
  refused(call({ limit: 50 }), L3); expect(page({ limit: 1 }).messages).toHaveLength(1);
  expect(venueReadTurns.get("turn")!.lines).toBe(150);
  expect(shown).toHaveBeenCalledTimes(4);
});
it("T28 stand-ins consume the line budget", () => {
  say("room", "CANARY", { withheldFromBots: "forgotten" } as Partial<Message>);
  venueReadTurns.get("turn")!.lines = 150; refused(call(), L3); expect(shown).not.toHaveBeenCalled();
});
it("T28 a read throwing after scanning counts, and a full receipt returns no messages", () => {
  say("room", "CANARY");
  shown.mockImplementationOnce(() => { throw new Error("scan failed"); }); refused(call(), L1);
  expect(venueReadTurns.get("turn")!.attempts).toBe(1);
  shown.mockImplementationOnce(() => { throw Object.assign(new Error("full"), { status: 409 }); }); refused(call(), L3);
  expect(read).not.toHaveBeenCalled(); expect(venueReadTurns.get("turn")!.attempts).toBe(2);
});
it("T28 failed authorization attempts count too", () => {
  for (let i = 0; i < 6; i++) refused(call({ venueId: "missing" }), L2);
  refused(call(), L3);
});
it("T31 lifecycle is current at call: archived, ended, paused, closed, missing settings", () => {
  project(); say("desk", "desk line");
  expect(page({ venueThreadId: "desk" }).messages).toHaveLength(1);
  database().prepare("UPDATE project_settings SET run_state='paused',closed_at=1 WHERE group_id='venue'").run();
  expect(page({ venueThreadId: "desk" }).messages).toHaveLength(1);
  database().prepare("UPDATE project_settings SET ended_at=2 WHERE group_id='venue'").run();
  refused(call({ venueThreadId: "desk" }), L2); expect(page().messages).toEqual([]);
  database().prepare("DELETE FROM project_settings WHERE group_id='venue'").run();
  refused(call({ venueThreadId: "desk" }), L2);
  roster.groups[0]!.hidden = true; refused(call(), L2);
});
it("T31 a missing project settings table classifies the venue as a channel", () => {
  roster.groups[0]!.channelProject = { goal: "Launch" } as GroupRecord["channelProject"];
  const empty = new DatabaseSync(":memory:");
  try { expect([...venueThreads(empty, roster, "venue")]).toEqual(["room", "room-task"]); }
  finally { empty.close(); }
});
it.each(["SELECT e.value FROM memory_scope_bindings", "SELECT subject_id, json_extract(intent,'$.personId') AS person"])("T32 query failure (%s) returns L1 before page read", query => {
  const db = database(), prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(sql => { if (sql.includes(query)) throw new Error("database unavailable"); return prepare(sql); });
  const handler = vi.fn(venueToolHandlers.get("read-messages")!); venueToolHandlers.set("read-messages", handler);
  refused(call(), L1); expect(handler).not.toHaveBeenCalled();
});
it("T33 departed speakers and recipients use a member, never their stored name", () => {
  say("room", "hello", { to: ["finch", "dax", "missing"] });
  roster.groups[0]!.memberIds = ["dax"];
  expect(page().messages[0]).toMatchObject({ speaker: "a member", to: ["a member", "Dax", "a member"] });
});

describe("T19/T27/T29 dispatch mount", () => {
  const input = () => ({ surfacesForOwner: true, directOwnerAudience: true, origin: "desktop", automationThread: false,
    bot: roster.bots[0]!, threadId: "direct", agentsMcp: true });
  it.each(["desktop", "companion"])("mounts only a proven owner direct turn: %s", origin => {
    expect(venueReadMounts({ ...input(), origin })).toBe(true);
    expect(venueReadMounts({ ...input(), origin, threadId: "task" })).toBe(true);
  });
  it.each([
    { origin: undefined }, { origin: "unproven" }, { automationSource: "webhook" }, { automationSource: "routine" },
    { surfacesForOwner: false }, { directOwnerAudience: false }, { agentsMcp: false }, { notOwnerAudience: true },
    { chainNotOwner: true }, { chainRootThreadId: "root" }, { projectCardRun: {} }, { sharedWorkRun: {} },
    { automationThread: true }, { threadId: "desk" }, { threadId: "room" },
  ])("does not mount %j, and a direct POST without a record refuses", change => {
    forgetAllVenueReadTurns(); expect(venueReadMounts({ ...input(), ...change })).toBe(false); refused(call(), L1);
  });
  it("does not mount a shared-work task even without a run option", () => {
    const bot = { threadId: "direct", tasks: [{ threadId: "shared", sharedWork: {} }] };
    expect(venueReadMounts({ ...input(), bot, threadId: "shared" })).toBe(false);
  });
  it("R1/R3 records must match the bot and thread; foreign ownership refuses", () => {
    record({ botId: "finch" }); refused(call(), L1); record({ threadId: "other" }); refused(call(), L1); record();
    roster.groups[0]!.tasks!.push({ threadId: "direct" } as never); refused(call(), L1);
    roster.groups[0]!.tasks!.pop(); roster.bots[1]!.threadId = "direct"; refused(call(), L1);
  });
});

it("T31 capability expiration, replacement, revocation and forgery cannot retain a venue record", () => {
  let now = 1; const caps = new InternalCapabilities({ now: () => now, orphanMs: 10 });
  caps.begin("dax", "direct", "turn"); record();
  const token = caps.mint({ ...claim, kind: "agents", depth: 0, skillAuthoring: false });
  expect(requiredInternalKind("/api/internal/venue/read-messages")).toBe("agents");
  expect(caps.resolve(`Bearer ${"a".repeat(48)}`)).toBeNull();
  now = 12; expect(caps.resolve(`Bearer ${token}`)).toBeNull(); expect(venueReadTurns.has("turn")).toBe(false);
  caps.begin("dax", "direct", "turn"); record(); caps.begin("dax", "direct", "new"); expect(venueReadTurns.has("turn")).toBe(false);
  recordVenueReadTurn("new", { botId: "dax", threadId: "direct", origin: "desktop" });
  caps.revokeGeneration("direct", "new"); expect(venueReadTurns.size).toBe(0);
  record(); caps.revokeAll(); expect(venueReadTurns.size).toBe(0);
});

it("T16/T31 production route keeps the existing capability boundary before the venue handler", () => {
  const code = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const boundary = code.indexOf("const internalClaim = internalCapabilities.resolve(req.headers.authorization)");
  const route = code.indexOf('if (method === "POST" && path === "/api/internal/venue/read-messages")');
  expect(boundary).toBeGreaterThan(0); expect(route).toBeGreaterThan(boundary);
  expect(code.slice(boundary, route)).toContain('return json(res, 401, { error: "unauthorized" })');
  const wire = code.slice(route, code.indexOf("const projectToolMatch", route));
  expect(wire).toContain("await readInternalBody()");
  expect(wire).toContain("fromBotId: _fromBotId, fromThreadId: _fromThreadId, depth: _depth, ...body");
  expect(wire).toContain("serveVenueRead(database(), internalClaim, body)");
});
