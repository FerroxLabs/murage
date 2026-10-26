// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SL-E r3 E3b (lanes/release104/designs/SL-E.md sections 10, 13, 16): with memory on, a linked person's hand-off reply is made with memory, the
// person's own. The result gate now asks WHOSE memory: a proven person reads what rests only on that person's own scopes, S(P) (the person's
// conversations, the person's preferences, shared folders granted to the person now), and nothing that rests on any other scope. Every unknown
// (W3-W7) is judged on a REAL lineage file (real messages.db, real lineage rows, footprints, receipt ranges), never a mocked verdict, and is
// never words. Every other audience keeps today's rule byte for byte.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doorEgress } from "./bot-read.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { isOwnUnsharedThread, isSamePersonUnsharedPair } from "./execution-audience.ts";
import { ownUnsharedWorkCheck } from "./handoff-binding.ts";
import { humanTask, linkHumanBinding, observeVerifiedHuman, OWNER, resolveHumanBinding, shareHumanScope, threadHumanPrincipal, type HumanPrincipal } from "./human-principals.ts";
import { closeMessageDb } from "./message-db.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { addTurnParents, closeTurnLineage, currentLsn, openTurnLineage } from "./memory/lineage-write.ts";
import { denyLookup } from "./memory/deny-read.ts";
import { STALE_MEM_LSN } from "./memory/lineage-types.ts";
import { ensureScope, lineageReaderScopes, personReadableScopes } from "./memory/policy.ts";
import { forceReadTimeJudgeForTest } from "./memory/read-time-retired.ts";
import { messageMadeWithMemory } from "./memory/replay-lineage.ts";
import { configureStatusRoster } from "./murage-status.ts";
import { configureResultEgress, personCopyHandOver, releaseStoredResult, writetimeLinesShown, type ResultEgressDeps } from "./result-egress.ts";
import { WorkerText } from "./released-text.ts";
import { plain } from "./testing/released.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const WORDS = "The venue holds 120 people and is free on the 14th (HELPER_WORDS)";

beforeEach(() => {
  closeMessageDb(); closeDatabase();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  forceReadTimeJudgeForTest(false);
  configureResultEgress(undefined); configureStatusRoster(undefined);
  closeMessageDb(); closeDatabase(); vi.restoreAllMocks();
});

let contacts = 0;
function linked() {
  const userId = `contact-${++contacts}`;
  const bindingId = observeVerifiedHuman({ platform: "slack", connectionId: `conn-${contacts}`, authorityId: "authority", userId });
  linkHumanBinding(ownerMemoryTicket(), { bindingId, expectedRevision: 1, as: "person" });
  return resolveHumanBinding(bindingId);
}

/** A person grant written as shareHumanScope wrote it before it refused kinds the share screen never offers (the same row id). */
function legacyGrant(personId: string, scopeId: string) {
  const id = "human-share:" + createHash("sha256").update(JSON.stringify([personId, scopeId])).digest("hex");
  database().prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'person',?,1,'granted','{}')").run(id, scopeId, personId);
}

/** The person's DM on the Chief, the helper's thread for the same person, and the scopes a footprint can name: the person's own (the work
 * conversation, the DM, the person's preferences), the owner's (the helper's bot scope, the owner's own conversation), a shared folder. */
function world(options: { personScopes?: ResultEgressDeps["personScopes"] } = {}) {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const chief = store.createBot({ name: "Chief", section: "Front" }, { seedMessages: false });
  const helper = store.createBot({ name: "Helper", section: "Front" }, { seedMessages: false });
  const principal = linked();
  const dm = humanTask(store, chief.id, principal)!.threadId, work = humanTask(store, helper.id, principal)!.threadId;
  const scope = {
    work: ensureScope("conversation", work), dm: ensureScope("conversation", dm), prefs: ensureScope("preferences", "person:" + principal.personId),
    bot: ensureScope("bot", helper.id), ownerChat: ensureScope("conversation", helper.threadId), project: ensureScope("project", "/shared/venue-plans"),
    team: ensureScope("team", "events"), room: ensureScope("room", "room-venues"), workspace: ensureScope("workspace", "workspace-1"),
  };
  const deps: ResultEgressDeps = {
    message: (thread, id) => store.messageById(thread, id), authorize: () => ({ ok: true }),
    copyOriginWithheld: () => false, capturedMessageWithheld: () => false, messageSourceForgotten: () => false,
    // the real readers, as index.ts wires them
    messageMadeWithMemory, partitionAllowed: () => true,
    ownUnsharedWork: ownUnsharedWorkCheck({ bot: id => store.bot(id) ?? undefined, isOwnUnsharedThread, isSamePersonUnsharedPair, principal: threadHumanPrincipal, message: (thread, id) => store.messageById(thread, id) }),
    personScopes: options.personScopes ?? (p => personReadableScopes(database(), p)),
    linesShown: writetimeLinesShown(database), doorShown: doorEgress(database),
  };
  configureResultEgress(deps);
  configureStatusRoster(name => store.bots.some(b => b.name === name));
  /** The helper's turn for this hand-off: its prompt records the hand-off, its reply follows it; `read` is the memory its receipt disclosed. */
  const answer = (read?: readonly string[], thread = work, handoffFrom = dm, lsn?: number) => {
    const prompt = store.appendMessage(thread, { role: "user", kind: "text", text: "find a venue", handoffFrom });
    const turn = openTurnLineage(database(), { threadId: thread, turnId: `turn-${Math.random().toString(36).slice(2)}` });
    if (read) addTurnParents(turn, [{ kind: "receipt", bundleId: `bundle-${Math.random().toString(36).slice(2)}`, lsn: lsn ?? currentLsn(database()), scopeIds: [...read] }]);
    const reply = store.appendMessage(thread, { role: "bot", kind: "text", text: WORDS, parentId: prompt.id });
    closeTurnLineage(turn);
    return reply;
  };
  /** The gate as the watch path asks it for the person's hand-off (E1: peerTurnNotOwner; no request). */
  const gate = (messageId: string, ref: { requestId?: string } = {}) =>
    plain(releaseStoredResult({ origin: { threadId: work, messageIds: [messageId] }, peerTurnNotOwner: true, ...ref }, helper.id, dm, { fromBotId: chief.id }, true, new WorkerText(WORDS), deps));
  const lineRow = (messageId: string) => database().prepare("SELECT l.lsn AS lsn,l.mem_lsn AS mem,l.footprint AS foot,l.thread_no AS no FROM memory_line_lineage l JOIN memory_thread_no t ON t.no=l.thread_no WHERE t.thread_id=? AND l.message_id=?").get(work, messageId) as { lsn: number; mem: number | null; foot: number | null; no: number } | undefined;
  return { store, chief, helper, principal, dm, work, scope, deps, answer, gate, lineRow };
}

describe("S(P): the scopes a person may read, read live", () => {
  it("holds the person's conversations, preferences and every granted kind the share screen offers; never a bot, an owner conversation or preferences grant", () => {
    const w = world();
    for (const shared of [w.scope.project, w.scope.team, w.scope.room, w.scope.workspace]) shareHumanScope(ownerMemoryTicket(), { personId: w.principal.personId, scopeId: shared, granted: true });
    // grants of kinds the screen never offers (made before shareHumanScope refused them) never enter S(P)
    const ownerPrefs = ensureScope("preferences", "person:owner");
    for (const unshareable of [w.scope.bot, w.scope.ownerChat, ownerPrefs]) legacyGrant(w.principal.personId, unshareable);
    const s = personReadableScopes(database(), w.principal);
    expect(s).not.toBe("unknown");
    const set = s as ReadonlySet<string>;
    for (const own of [w.scope.work, w.scope.dm, w.scope.prefs, w.scope.project, w.scope.team, w.scope.room, w.scope.workspace]) expect(set.has(own)).toBe(true);
    for (const foreign of [w.scope.bot, w.scope.ownerChat, ownerPrefs]) expect(set.has(foreign)).toBe(false);
    shareHumanScope(ownerMemoryTicket(), { personId: w.principal.personId, scopeId: w.scope.project, granted: false });
    expect((personReadableScopes(database(), w.principal) as ReadonlySet<string>).has(w.scope.project)).toBe(false);
  });
  it("W7: a read that throws answers unknown", () => {
    const broken = { prepare: () => { throw new Error("database is locked"); } } as unknown as ReturnType<typeof database>;
    expect(personReadableScopes(broken, OWNER)).toBe("unknown");
  });
});

describe("E3b: a proven person reads what rests only on that person's memory (real lineage)", () => {
  it("row 1: made with the person's own memory (work conversation + preferences) -> the words", () => {
    const w = world();
    const reply = w.answer([w.scope.work, w.scope.prefs]);
    expect(w.lineRow(reply.id)?.foot).not.toBeNull();
    expect(w.gate(reply.id)).toMatchObject({ kind: "text", text: WORDS });
  });
  it("row 1: an owner scope in the footprint (the helper's bot memory) -> withheld", () => {
    const w = world();
    const reply = w.answer([w.scope.work, w.scope.bot]);
    expect(w.gate(reply.id).kind).toBe("withheld");
  });
  it("row 2: an owner line earlier in the worker's thread folds into the reply's running footprint -> withheld", () => {
    const w = world();
    w.answer([w.scope.ownerChat]);
    const reply = w.answer([w.scope.work]);
    expect(w.gate(reply.id).kind).toBe("withheld");
  });
  it("row 6: a shared folder granted to the person -> the words; the grant withdrawn before the settle -> withheld", () => {
    const w = world();
    shareHumanScope(ownerMemoryTicket(), { personId: w.principal.personId, scopeId: w.scope.project, granted: true });
    const reply = w.answer([w.scope.project, w.scope.work]);
    expect(w.gate(reply.id)).toMatchObject({ kind: "text", text: WORDS });
    shareHumanScope(ownerMemoryTicket(), { personId: w.principal.personId, scopeId: w.scope.project, granted: false });
    expect(w.gate(reply.id).kind).toBe("withheld");
  });
  it("row 14: a granted bot scope the worker read (a grant made before the server refused it) -> withheld", () => {
    const w = world();
    legacyGrant(w.principal.personId, w.scope.bot);
    const reply = w.answer([w.scope.bot]);
    expect(w.gate(reply.id).kind).toBe("withheld");
  });
  it.each(["team", "room", "workspace"] as const)("row 14 r3.2: a granted %s scope the worker read -> the words; the grant withdrawn -> withheld", kind => {
    const w = world();
    const shared = w.scope[kind];
    shareHumanScope(ownerMemoryTicket(), { personId: w.principal.personId, scopeId: shared, granted: true });
    const reply = w.answer([shared, w.scope.work]);
    expect(w.gate(reply.id)).toMatchObject({ kind: "text", text: WORDS });
    shareHumanScope(ownerMemoryTicket(), { personId: w.principal.personId, scopeId: shared, granted: false });
    expect(w.gate(reply.id).kind).toBe("withheld");
  });
  it("row 9: a stale receipt (a policy bump since it was read) -> withheld by the watermark", () => {
    const w = world();
    const bystander = w.store.createBot({ name: "New sub-bot", section: "Front" }, { seedMessages: false });
    const reply = w.answer([w.scope.work]);
    expect(w.gate(reply.id).kind).toBe("text");
    // the policy bump: a bot moving to another team (an audience change); adding one withdraws nothing
    w.store.patchBot(bystander.id, { section: "Back office" });
    expect(w.gate(reply.id).kind).toBe("withheld");
  });
  it("row 7: the receipt flipped (settings, restore, roster), drain not yet run -> checking, never words", () => {
    const w = world();
    const reply = w.answer([w.scope.work]);
    const row = w.lineRow(reply.id)!;
    database().prepare("INSERT INTO memory_receipt_flips(thread_no,first_lsn,bundle_id) VALUES(?,?,?)").run(row.no, row.lsn, "flipped-bundle");
    expect(w.gate(reply.id).kind).toBe("checking");
  });
  it("W3: the file's read-time judge is not retired -> withheld (today's blind rule)", () => {
    const w = world();
    const reply = w.answer([w.scope.work]);
    forceReadTimeJudgeForTest(true);
    expect(w.gate(reply.id).kind).toBe("withheld");
  });
  it("W4: a generated line with no lineage row -> checking", () => {
    const w = world();
    const reply = w.answer([w.scope.work]);
    const row = w.lineRow(reply.id)!;
    database().prepare("DELETE FROM memory_line_lineage WHERE thread_no=? AND message_id=?").run(row.no, reply.id);
    expect(w.gate(reply.id).kind).toBe("checking");
  });
  it("W5: a line whose lineage names no memory but a receipt output record exists -> checking (both output forms)", () => {
    const w = world();
    const plainReply = w.answer();
    expect(w.lineRow(plainReply.id)).toMatchObject({ mem: null, foot: null });
    expect(w.gate(plainReply.id)).toMatchObject({ kind: "text", text: WORDS });
    database().prepare("INSERT INTO memory_disclosure_outputs(bundle_id,thread_id,message_id) VALUES(?,?,?)").run("output-bundle", w.work, plainReply.id);
    expect(w.gate(plainReply.id).kind).toBe("checking");
    const ranged = w.answer();
    const row = w.lineRow(ranged.id)!;
    expect(w.gate(ranged.id).kind).toBe("text");
    database().prepare("INSERT INTO memory_receipt_lines(bundle_id,thread_no,first_lsn,session_no) VALUES(?,?,?,NULL)").run("range-bundle", row.no, row.lsn);
    expect(w.gate(ranged.id).kind).toBe("checking");
  });
  it("W5 range bounds: a receipt range covers its thread from its first output on (receipt-outputs.ts); a line before it or in another thread is judged by the rest of the chain, a line in a pending flip stays checking", () => {
    const w = world();
    const reply = w.answer();
    const row = w.lineRow(reply.id)!;
    expect(row).toMatchObject({ mem: null, foot: null });
    // a range that starts after the line (a later output of a receipt) does not reach back to it
    database().prepare("INSERT INTO memory_receipt_lines(bundle_id,thread_no,first_lsn,session_no) VALUES(?,?,?,NULL)").run("later-bundle", row.no, row.lsn + 1);
    // a range of another thread, from its very first line
    database().prepare("INSERT INTO memory_receipt_lines(bundle_id,thread_no,first_lsn,session_no) VALUES(?,?,?,NULL)").run("other-bundle", row.no + 1000, 0);
    expect(w.gate(reply.id)).toMatchObject({ kind: "text", text: WORDS });
    // a receipt turned 'revoked' and not committed yet whose lines start at or before this one: held "checking" (deny-read.ts pendingWindows)
    database().prepare("INSERT INTO memory_receipt_flips(thread_no,first_lsn,bundle_id) VALUES(?,?,?)").run(row.no, row.lsn, "flipped-bundle");
    expect(w.gate(reply.id).kind).toBe("checking");
  });
  it("W6: a footprint too wide to name (more than 32 scopes) -> checking", () => {
    const w = world();
    const many = Array.from({ length: 33 }, (_, i) => ensureScope("conversation", `wide-${i}`));
    const reply = w.answer(many);
    expect(w.lineRow(reply.id)?.foot).toBe(0);
    expect(w.gate(reply.id).kind).toBe("checking");
  });
  it("W6 r3.2: a current receipt that disclosed nothing (mem_lsn set, footprint null) -> the words", () => {
    const w = world();
    const reply = w.answer([]);
    const row = w.lineRow(reply.id)!;
    expect(row.mem).not.toBeNull(); expect(row.foot).toBeNull();
    expect(w.gate(reply.id)).toMatchObject({ kind: "text", text: WORDS });
  });
  it("W6 r3.2: the same receipt stale (a policy bump since, or folded STALE_MEM_LSN) -> withheld by the watermark (W9)", () => {
    const w = world();
    const bystander = w.store.createBot({ name: "New sub-bot", section: "Front" }, { seedMessages: false });
    const reply = w.answer([]);
    expect(w.gate(reply.id).kind).toBe("text");
    // the policy bump: a bot moving to another team (an audience change); adding one withdraws nothing
    w.store.patchBot(bystander.id, { section: "Back office" });
    expect(w.gate(reply.id).kind).toBe("withheld");
    const folded = world();
    const stale = folded.answer([], folded.work, folded.dm, STALE_MEM_LSN);
    expect(folded.lineRow(stale.id)).toMatchObject({ mem: STALE_MEM_LSN, foot: null });
    expect(folded.gate(stale.id).kind).toBe("withheld");
  });
  it("W7: S(P) cannot be read -> checking, never words", () => {
    const w = world({ personScopes: () => "unknown" });
    const reply = w.answer([w.scope.work]);
    expect(w.gate(reply.id).kind).toBe("checking");
    const thrown = world({ personScopes: () => { throw new Error("database is locked"); } });
    const again = thrown.answer([thrown.scope.work]);
    expect(thrown.gate(again.id).kind).toBe("checking");
  });
});

describe("section 11 (A) r3.2: a person's own turn judges whose memory a line is made of by its scopes together with S(P)", () => {
  it("a line in the person's DM made of the person's work conversation: withheld for the thread-local reader, shown for the person's reader", () => {
    const w = world();
    const line = w.answer([w.scope.work], w.dm, w.work);
    const local = [w.scope.dm, w.scope.prefs];
    const page = { threadId: w.dm, lines: [{ messageId: line.id, author: "generated" as const }] };
    expect(denyLookup(database(), page, { audience: { owner: false, scopeIds: local } }).get(line.id)?.state).toBe("withheld");
    const reader = lineageReaderScopes({ scopeIds: local, humanPrincipal: w.principal });
    for (const scope of [...local, w.scope.work]) expect(reader).toContain(scope);
    expect(denyLookup(database(), page, { audience: { owner: false, scopeIds: reader } }).get(line.id)?.state).toBe("shown");
    // an owner scope in the line still withholds it from the person's reader
    const owned = w.answer([w.scope.bot], w.dm, w.work);
    expect(denyLookup(database(), { threadId: w.dm, lines: [{ messageId: owned.id, author: "generated" }] }, { audience: { owner: false, scopeIds: reader } }).get(owned.id)?.state).toBe("withheld");
  });
  it("the owner, and words nobody proved in the owner's thread, keep the turn's own set; S(P) unknown never narrows it", () => {
    const w = world();
    expect(lineageReaderScopes({ scopeIds: ["a"], humanPrincipal: OWNER })).toEqual(["a"]);
    const broken = { prepare: () => { throw new Error("database is locked"); } } as unknown as ReturnType<typeof database>;
    expect(lineageReaderScopes({ scopeIds: ["a"], humanPrincipal: w.principal }, broken)).toEqual(["a"]);
  });
});

describe("section 11 (A2) r3.2: a resumed person turn hands over a teammate's copy by the person's reader", () => {
  const readers = () => ({ linesShown: writetimeLinesShown(database), doorShown: doorEgress(database) });
  it("a copy of a reply made of the person's own memory -> the words; of an owner scope -> the withheld line; S(P) unknown -> still being checked", () => {
    const w = world();
    const reply = w.answer([w.scope.work, w.scope.prefs]);
    const copy = w.store.appendMessage(w.dm, { role: "bot", kind: "text", text: WORDS, copyOf: { threadId: w.work, messageIds: [reply.id] } });
    const scopes = personReadableScopes(database(), w.principal);
    expect(personCopyHandOver(readers(), w.chief.id, w.dm, copy, scopes)).toEqual({ withheld: false, unproven: false });
    expect(personCopyHandOver(readers(), w.chief.id, w.dm, copy, "unknown")).toEqual({ withheld: true, unproven: true });
    const owned = world();
    const ownerReply = owned.answer([owned.scope.work, owned.scope.bot]);
    const ownerCopy = owned.store.appendMessage(owned.dm, { role: "bot", kind: "text", text: WORDS, copyOf: { threadId: owned.work, messageIds: [ownerReply.id] } });
    expect(personCopyHandOver(readers(), owned.chief.id, owned.dm, ownerCopy, personReadableScopes(database(), owned.principal)).withheld).toBe(true);
  });
});

describe("E3b: every other audience keeps today's rule", () => {
  it("no proof (a request-bound result: a room or a team-tagged ask) -> the blind rule: any memory withholds", () => {
    const w = world();
    const reply = w.answer([w.scope.work]);
    expect(w.gate(reply.id, { requestId: "room-request" }).kind).toBe("withheld");
  });
  it("messageMadeWithMemory without scopes is today's boolean, whatever the footprint", () => {
    const w = world();
    // (none first: a later line of the thread starts from the head's running footprint)
    const none = w.answer(), own = w.answer([w.scope.work]);
    expect(messageMadeWithMemory(w.work, own.id)).toBe(true);
    expect(messageMadeWithMemory(w.work, none.id)).toBe(false);
    expect(messageMadeWithMemory(w.work, own.id, [w.scope.work, w.scope.prefs])).toBe("shown");
  });
});

describe("row 12: the reader is required; no flag can route a result past the memory check", () => {
  it("isSamePersonUnsharedPair: a reader that is not the threads' principal, or the owner, is never a person pair", () => {
    const w = world();
    const other = linked();
    const chief = w.store.bot(w.chief.id) ?? undefined, helper = w.store.bot(w.helper.id) ?? undefined;
    expect(isSamePersonUnsharedPair(w.principal, chief, w.dm, helper, w.work)).toBe(true);
    expect(isSamePersonUnsharedPair(other, chief, w.dm, helper, w.work)).toBe(false);
    expect(isSamePersonUnsharedPair(OWNER, chief, w.dm, helper, w.work)).toBe(false);
    const moved: HumanPrincipal = { ...w.principal, revision: w.principal.revision + 1 };
    expect(isSamePersonUnsharedPair(moved, chief, w.dm, helper, w.work)).toBe(false);
  });
  it("ownUnsharedWorkCheck answers a proof naming the principal, and no person proof without a way to name the reader", () => {
    const w = world();
    const reply = w.answer();
    const env = { bot: (id: string) => w.store.bot(id) ?? undefined, isOwnUnsharedThread, isSamePersonUnsharedPair, message: (thread: string, id: string) => w.store.messageById(thread, id) };
    const who = { fromBotId: w.chief.id, toBotId: w.helper.id, fromThreadId: w.dm }, origin = { threadId: w.work, messageIds: [reply.id] };
    expect(ownUnsharedWorkCheck({ ...env, principal: threadHumanPrincipal })(who, origin)).toEqual({ reader: "person", principal: w.principal });
    expect(ownUnsharedWorkCheck(env)(who, origin)).toBe(false);
    // and the gate, with no person proof, refuses the person's result exactly as before SL-E
    configureResultEgress({ ...w.deps, ownUnsharedWork: ownUnsharedWorkCheck(env) });
    expect(plain(releaseStoredResult({ origin, peerTurnNotOwner: true }, w.helper.id, w.dm, { fromBotId: w.chief.id }, true, new WorkerText(WORDS)))).toMatchObject({ kind: "refused", code: "origin_unconfirmed" });
  });
});
