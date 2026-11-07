// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// VENUE-POST-1017 r3 cut-down, gate tier: T11', T32', T33, T38 and the Q7 lineage shape. Fails on base (no venue-post.ts, no store boundary).
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { setExecutionStore } from "./execution-audience.ts";
import { bindHumanThread, linkHumanBinding, observeVerifiedHuman, resolveHumanBinding } from "./human-principals.ts";
import { appendMessage } from "./message-db.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { captureSource } from "./memory/capture.ts";
import { setMemoryCaptureRoster } from "./memory/capture-scope.ts";
import { forgetMemory } from "./memory/forget.ts";
import { ensureScope, reconcileMemoryRoster } from "./memory/policy.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { roomPeople } from "./room-people.ts";
import { dropUnprovenPostTo, type BotRecord, type GroupRecord, type Message, type Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { VENUE_POST_TOOL, venuePostBody, venuePostToolFor } from "./drivers/project-tool-schemas.ts";
import { authorizeVenuePost, forgetAllVenuePostTurns, postableVenues, recordVenuePostTurn, setVenuePostLive, venuePostedLine, venuePostLineage, venuePostMounts, venuePostTurns, VENUE_POST_NEEDS_FULL,
  VENUE_POST_NOT_AVAILABLE as P2, VENUE_POST_NOT_PICKED as P3, VENUE_POST_UNAVAILABLE as P1 } from "./venue-post.ts";

const NOW = 1_790_000_000_000;
const claim = { botId: "dax", threadId: "direct", generation: "turn" };
let roster: { bots: BotRecord[]; groups: GroupRecord[] };
const messages = new Map<string, Message>();
let serial = 0;
function ownerLine(text: string, extra: Partial<Message> = {}): Message {
  const message = { id: `o${++serial}`, role: "user", kind: "text", text, at: NOW + serial, origin: "desktop", ...extra } as Message;
  appendMessage("direct", message); messages.set(message.id, message); return message;
}
const mountBase = (message: Message, extra: Record<string, unknown> = {}) => ({
  botId: "dax", surfacesForOwner: true, directOwnerAudience: true, origin: message.origin, automationThread: false,
  bot: roster.bots[0]!, threadId: "direct", agentsMcp: true, message, ...extra,
}) as Parameters<typeof venuePostMounts>[0];
function mount(message: Message, extra: Record<string, unknown> = {}) {
  const record = venuePostMounts(mountBase(message, extra));
  if (record) recordVenuePostTurn(claim.generation, record);
  return record;
}
const call = (body: Record<string, unknown>) => authorizeVenuePost(database(), claim, { text: "Ship notes", ...body });
const refusedWith = (result: ReturnType<typeof call>, line: string) => expect(result).toEqual({ ok: false, status: 403, body: { error: line } });
function person(thread: string) {
  const binding = observeVerifiedHuman({ platform: "slack", connectionId: "fixture", authorityId: "team", userId: `${thread}-guest` });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: binding, expectedRevision: 1, as: "person" });
  bindHumanThread(thread, resolveHumanBinding(binding));
}

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  serial = 0; messages.clear(); forgetAllVenuePostTurns();
  roster = {
    bots: [{ id: "dax", name: "Dax", color: "blue", threadId: "direct", section: "Ops", tasks: [] }],
    groups: [
      { id: "venue", name: "Launch week", threadId: "room", section: "Ops", memberIds: ["dax"], tasks: [{ threadId: "room-task" }] },
      { id: "other", name: "Design reviews", threadId: "room2", section: "Ops", memberIds: ["dax"], tasks: [] },
      { id: "stranger", name: "Not a member", threadId: "room3", section: "Ops", memberIds: [], tasks: [] },
    ],
  } as unknown as typeof roster;
  setExecutionStore({ ...roster, bot: (id: string) => roster.bots.find(bot => bot.id === id), group: (id: string) => roster.groups.find(group => group.id === id) } as Store);
  setMemoryCaptureRoster(() => roster); setMemoryMode("active"); reconcileMemoryRoster(roster);
  setVenuePostLive({ ownerSurface: id => id === "direct", notOwnerAudience: () => false, roster: () => roster,
    message: (_thread, id) => messages.get(id) ?? null });
});
afterEach(() => { setVenuePostLive(null); forgetAllVenuePostTurns(); setExecutionStore(undefined as never); closeDatabase(); });

it("T11' no postTo: not listed and a call is P1; postTo: listed, wrong venue P3, the picked venue passes", () => {
  expect(mount(ownerLine("summarise the Launch week room"))).toBeNull();
  refusedWith(call({ venueId: "venue" }), P1);
  const record = mount(ownerLine("summarise the Launch week room", { postTo: { venueId: "venue" } }));
  expect(record?.request.postTo).toEqual({ venueId: "venue" });
  refusedWith(call({ venueId: "other" }), P3);
  refusedWith(call({ venueId: "venue", venueThreadId: "room-task" }), P3);
  const ok = call({ venueId: "venue" });
  expect(ok.ok && ok.target).toBe("room");
});

it("T32' postTo from any writer but a proven owner line of a direct thread is dropped; a non-member venue is P2", () => {
  const postTo = { venueId: "venue" };
  for (const origin of ["unproven", undefined] as const)
    expect(dropUnprovenPostTo({ role: "user", kind: "text", origin, postTo }, true)).not.toHaveProperty("postTo");
  expect(dropUnprovenPostTo({ role: "bot", kind: "text", origin: "desktop", postTo }, true)).not.toHaveProperty("postTo");
  expect(dropUnprovenPostTo({ role: "user", kind: "text", origin: "desktop", postTo }, false)).not.toHaveProperty("postTo");
  expect(dropUnprovenPostTo({ role: "user", kind: "text", origin: "desktop", postTo: { venueId: 7 } }, true)).not.toHaveProperty("postTo");
  expect(dropUnprovenPostTo({ role: "user", kind: "text", origin: "companion", postTo }, true).postTo).toEqual(postTo);
  // a routine, steer or hand-off turn never mounts, even with the field present
  const line = ownerLine("post it", { postTo });
  expect(venuePostMounts(mountBase(line, { automationSource: "schedule" }))).toBeNull();
  expect(venuePostMounts(mountBase(line, { origin: "unproven" }))).toBeNull();
  expect(venuePostMounts(mountBase(line, { draftOnly: true }))).toBeNull();
  mount(ownerLine("post it", { postTo: { venueId: "stranger" } }));
  refusedWith(call({ venueId: "stranger" }), P2);
});

it("T33 an edit or a forget of the request line revokes the pick (P3)", () => {
  const line = ownerLine("post the notes", { postTo: { venueId: "venue" } });
  mount(line);
  messages.set(line.id, { ...line, text: "post something else" });
  refusedWith(call({ venueId: "venue" }), P3);
  messages.set(line.id, line);
  expect(call({ venueId: "venue" }).ok).toBe(true);
  captureSource(database(), { id: `message:direct:${line.id}`, threadId: "direct", messageId: line.id, kind: "text", speaker: "owner", outcome: "recorded", text: line.text! });
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: `message:direct:${line.id}` });
  refusedWith(call({ venueId: "venue" }), P3);
});

it("Q2 three posts per turn", () => {
  mount(ownerLine("post", { postTo: { venueId: "venue" } }));
  for (let n = 0; n < 3; n++) expect(call({ venueId: "venue" }).ok).toBe(true);
  refusedWith(call({ venueId: "venue" }), P1);
});

it("T38 a person on the room thread or the target thread closes the venue (P2) and the picker omits it", () => {
  expect(roomPeople(database(), { id: "venue" }, "room")).toEqual([]);
  expect(postableVenues(database(), roster, roster.bots[0]!, "direct").map(v => v.venueId).sort()).toEqual(["other", "venue"]);
  person("room-task");
  expect(roomPeople(database(), { id: "venue" }, "room-task").length).toBe(1);
  mount(ownerLine("post", { postTo: { venueId: "venue", venueThreadId: "room-task" } }));
  refusedWith(call({ venueId: "venue", venueThreadId: "room-task" }), P2);
  expect(postableVenues(database(), roster, roster.bots[0]!, "direct").map(v => v.venueId)).toEqual(["other"]);
  // a granted person on the room scope closes the room thread too
  const scope = ensureScope("room", "other");
  database().prepare("INSERT INTO memory_scope_bindings VALUES('human-share:t38',?,'person','p-1',1,'granted','{}')").run(scope);
  expect(roomPeople(database(), { id: "other" }, "room2")).toEqual(["p-1"]);
  expect(postableVenues(database(), roster, roster.bots[0]!, "direct")).toEqual([]);
});

it("Q7 the post's lineage is the 1:1 prefix with the shown request line, no turn id", () => {
  const refs = venuePostLineage("direct", "dax", 12, ["o1"]);
  expect(refs[0]).toEqual({ kind: "prefix", threadId: "direct", headLsn: 12, shown: ["o1"] });
  expect(JSON.stringify(refs)).not.toContain("turnId");
});

it("a revoked generation takes its venue_post record with it (the capability store forgets it, as it does venue_read's)", () => {
  const caps = new InternalCapabilities({ now: () => NOW });
  const generation = caps.begin("dax", "direct");
  recordVenuePostTurn(generation, { botId: "dax", threadId: "direct", origin: "desktop", request: { messageId: "o1", textHash: "h", postTo: { venueId: "g1" } } });
  expect(venuePostTurns.has(generation)).toBe(true);
  caps.revokeGeneration("direct", generation);
  expect(venuePostTurns.has(generation)).toBe(false);
});

it("venue_post's schema and wire body: the picked venue and the words only, never a thread or bot id", () => {
  expect(VENUE_POST_TOOL.name).toBe("venue_post");
  expect(VENUE_POST_TOOL.inputSchema.required).toEqual(["venue_id", "text"]);
  expect(VENUE_POST_TOOL.inputSchema.properties.text.maxLength).toBe(4000);
  expect(venuePostBody({ venue_id: "g1", text: "hi", threadId: "other", botId: "x" })).toEqual({ venueId: "g1", text: "hi" });
  expect(venuePostBody({ venue_id: "g1", venue_thread_id: "t1", text: "hi" })).toEqual({ venueId: "g1", venueThreadId: "t1", text: "hi" });
  // the listed tool names the owner's pick, so the bot is told which room (Astra p5 High); no pick lists the plain tool
  expect(venuePostToolFor({ venueId: "g1" }).description).toContain('the owner picked venue_id "g1" (its main chat: omit venue_thread_id).');
  expect(venuePostToolFor({ venueId: "g1", venueThreadId: "t1" }).description).toContain('venue_id "g1" and venue_thread_id "t1".');
  expect(venuePostToolFor(null)).toBe(VENUE_POST_TOOL);
  expect(venuePostToolFor({ venueId: "g1" }).inputSchema).toBe(VENUE_POST_TOOL.inputSchema);
  const index = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
  expect(index).toContain("venuePostListed && venuePost ? venuePost.request.postTo : null");
  expect(index).toMatch(/MURAGE_VENUE_POST_PICK: JSON\.stringify\(\{ venueId: venuePost\.venueId/);
  expect(venuePostedLine("Launch")).toBe("Posted in Launch.");
  expect(venuePostedLine(undefined)).toBe("Posted in the project or channel.");
  for (const line of [VENUE_POST_NEEDS_FULL, venuePostedLine("x"), VENUE_POST_TOOL.description]) expect(line).not.toMatch(/—/);
});
