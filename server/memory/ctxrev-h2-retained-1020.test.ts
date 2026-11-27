// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// CTXREV H2 (1.0.20 outage: "I stopped this turn because some of its context is no longer available." on every turn).
// Owners: lane ctxrev-h2-retained owns the held-context settle before a release adds refs (send-fence.ts settleHeldContext, called from
// lineage-write.ts proposeTurnParents); revokekeep-1020 owns the keep decision itself (send-fence.ts keepOwnerTurn) and the redaction state.
//
// Field sequence (owner Mac, 1.0.20): `native fence refusal engine=lease site=lease.ledger kind=turn`, `[memory] ledger refusal
// cause=withheld:deny-memory`, `[memory] retained fence refused { refs: { receipt: 1, 'prefix-shown': 1, none: 1 }, refusedMembers: 1 }`,
// then MEMORY_CONTEXT_REVOKED fence=withheld/deny-memory at response.emit. The running owner turn held one memory receipt; an install-wide
// receipt revoke (scope=global cause=roster / import, minutes apart) flipped it; the engine's next request reply went through
// proposeTurnParents, which judged everything the turn ALREADY held as if it were new context, so the owner-keep rule
// (SEAN RULING revokekeep: a remembered detail revoked mid-turn never stops the owner's turn) was never asked and the whole turn was sealed.
// Real store, real lineage writer, real receipt revoke, real send fence and the real consuming response gate; nothing under test is mocked.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { closeMessageDb } from "../message-db.ts";
import { Store } from "../store.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { bindConsumingTurn, emitConsumingTurnResponse, registerConsumingDescriptor } from "../consuming-turn-response.ts";
import { doorReader } from "../bot-read.ts";
import { refsLookup } from "./deny-read.ts";
import { addTurnParents, checkedOpenTurns, closeTurnLineage, currentLsn, openTurnLineage, refuseRetainedTurn, writeRecordLineage } from "./lineage-write.ts";
import type { LineageReader, LineageRef, LineageVerdict } from "./lineage-types.ts";
import { drainRevokeMarker } from "./memory-revocation.ts";
import { commitRevoke } from "./revoke-commit.ts";
import { revokeAllDisclosures } from "./revocation.ts";
import { assertRetainedFence, prepareRetainedFence } from "./send-fence.ts";

const OWNER: LineageReader = { audience: { owner: true, scopeIds: [] } };
const SECRET = "Vault code 7731-BRAVO-DELTA for the east office";
let warnings: unknown[][] = [];

beforeEach(() => {
  closeMessageDb(); closeDatabase();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args); });
});
afterEach(() => { closeMessageDb(); closeDatabase(); vi.restoreAllMocks(); });

type Keep = (verdict?: LineageVerdict) => boolean;
/** An owner turn whose prompt is already with the engine. It holds what the field turn held: one memory receipt, its own thread's prefix
 * with one line shown in words, and one part resting on nothing stored. */
function runningOwnerTurn(keep?: Keep) {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bot = store.createBot({ name: "Desk Helper", section: "Ops" }, { seedMessages: false });
  const earlier = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "The weekly report goes out on Mondays." });
  const db = database();
  const meta = db.prepare("SELECT policy_revision AS p, deletion_epoch AS e FROM memory_meta WHERE id=1").get() as { p: number; e: number };
  db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,NULL,'[]','[]','[]',?,?,?,?,?)")
    .run("bundle-h2", bot.threadId, "fixture", meta.p, meta.e, 10, "delivered", Date.now());
  const turnId = "turn-h2";
  const turn = openTurnLineage(db, { threadId: bot.threadId, turnId });
  const refusedWith: LineageVerdict[] = [];
  prepareRetainedFence(turn, OWNER, verdict => { refusedWith.push(verdict); }, db, keep);
  const receipt: LineageRef = { kind: "receipt", bundleId: "bundle-h2", lsn: currentLsn(db), scopeIds: [] };
  const prefix: LineageRef = { kind: "prefix", threadId: bot.threadId, held: null, shown: [earlier.id], content: true };
  const none: LineageRef = { kind: "none", reason: "owner-text" as never };
  addTurnParents(turn, [receipt, prefix, none]);
  expect(() => assertRetainedFence(turn, db)).not.toThrow();
  const members = checkedOpenTurns(turn);
  const binding = bindConsumingTurn({
    identity: { botId: bot.id, threadId: bot.threadId, dispatchGeneration: turnId, lineageTurnIds: members.map(m => m.turnId), adapterLeaseId: turnId },
    turn, db, isCurrent: () => true,
    onLedgerRefused: verdict => { for (const member of members) refuseRetainedTurn(member, verdict); },
  });
  return { store, bot, db, turn, turnId, refusedWith, receipt, prefix, none, earlier, binding };
}
type Fixture = ReturnType<typeof runningOwnerTurn>;
const descriptor = () => registerConsumingDescriptor("native:openai:tool-append", "native");
/** The engine's next request is answered: the reply's bytes go out only through the consuming response gate. */
function reply(w: Fixture, refs: readonly LineageRef[] = []) {
  const write = vi.fn(() => "written");
  const out = emitConsumingTurnResponse(w.binding, descriptor(), { bytes: 8, refs, write });
  return { out, write };
}
/** The install-wide receipt revoke the owner Mac logged 136 times (`memory receipts revoked scope=global cause=roster|import`). */
function globalReceiptRevoke(w: Fixture) {
  revokeAllDisclosures(w.db, "roster");
  drainRevokeMarker(w.db);
  expect(refsLookup(w.db, [w.receipt], OWNER)).toEqual({ state: "withheld", reason: "deny-memory" });
}
const kinds = (turn: { parents: readonly LineageRef[] }) => turn.parents.map(ref => ref.kind).sort();
const refusedLogs = () => warnings.filter(args => args[0] === "[memory] retained fence refused");

it("H2-1 field shape: a held receipt flipped by an install-wide revoke; the engine's next reply is released and the turn continues without it", () => {
  const keep = vi.fn<Keep>(() => true);
  const w = runningOwnerTurn(keep);
  try {
    globalReceiptRevoke(w);
    let release: ReturnType<typeof reply> | undefined;
    // v1.0.20: throws MEMORY_CONTEXT_REVOKED and logs `retained fence refused { refs: { receipt: 1, 'prefix-shown': 1, none: 1 } }`
    expect(() => { release = reply(w); }).not.toThrow();
    expect(release!.write).toHaveBeenCalledTimes(1);
    expect(w.refusedWith).toEqual([]);
    expect(refusedLogs()).toEqual([]);
    // the owner is told (the hook writes the one left-out notice), with the real verdict
    expect(keep).toHaveBeenCalledTimes(1);
    expect(keep.mock.calls[0]![0]).toEqual({ state: "withheld", reason: "deny-memory" });
    // only the withheld receipt leaves what the turn keeps and cites
    expect(kinds(w.turn)).toEqual(["none", "prefix"]);
    // later replies are clean: nothing withheld is held any more, the owner is not told twice
    expect(reply(w).write).toHaveBeenCalledTimes(1);
    expect(keep).toHaveBeenCalledTimes(1);
    const answer = w.store.appendMessage(w.bot.threadId, { role: "bot", kind: "text", text: "Here is the report outline you asked for.", turnId: w.turnId });
    expect(String(database().prepare("SELECT text FROM messages WHERE thread_id=? AND id=?").get(w.bot.threadId, answer.id)!.text)).toBe("Here is the report outline you asked for.");
  } finally { closeTurnLineage(w.turn); }
});

it("H2-2 a reply that adds new, readable context after the revoke is released; the new context is kept, the withheld receipt is not", () => {
  const keep = vi.fn<Keep>(() => true);
  const w = runningOwnerTurn(keep);
  try {
    globalReceiptRevoke(w);
    // the owner's own words, written after the revoke: readable on their own (a generated line from before the policy watermark is not)
    const fresh = w.store.appendMessage(w.bot.threadId, { role: "user", kind: "text", text: "Meeting notes are in the shared folder." });
    const freshRef: LineageRef = { kind: "line", threadId: w.bot.threadId, messageId: fresh.id };
    expect(refsLookup(w.db, [freshRef], OWNER)).toEqual({ state: "shown" });
    expect(reply(w, [freshRef]).write).toHaveBeenCalledTimes(1);
    expect(w.refusedWith).toEqual([]);
    expect(w.turn.parents).toContainEqual(freshRef);
    expect(w.turn.parents.some(ref => ref.kind === "receipt")).toBe(false);
    // the direct writer path (tool results, steer quotes) takes the same rule
    expect(() => addTurnParents(w.turn, [{ kind: "none", reason: "owner-text" as never }])).not.toThrow();
    expect(keep).toHaveBeenCalledTimes(1);
  } finally { closeTurnLineage(w.turn); }
});

it("H2-3 privacy: NEW context that is itself withheld never reaches the engine, even on an owner turn that keeps running", () => {
  const keep = vi.fn<Keep>(() => true);
  const w = runningOwnerTurn(keep);
  try {
    const forgotten = w.store.appendMessage(w.bot.threadId, { role: "bot", kind: "text", text: SECRET });
    const forgottenRef: LineageRef = { kind: "line", threadId: w.bot.threadId, messageId: forgotten.id };
    commitRevoke(w.db, { kind: "line", threadId: w.bot.threadId, messageIds: [forgotten.id], cause: "forget" });
    drainRevokeMarker(w.db);
    expect(refsLookup(w.db, [forgottenRef], OWNER).state).toBe("withheld");
    const write = vi.fn(() => "written");
    expect(() => emitConsumingTurnResponse(w.binding, descriptor(), { bytes: 8, refs: [forgottenRef], write })).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(write).not.toHaveBeenCalled();
    expect(w.turn.parents).not.toContainEqual(forgottenRef);
    // refused for the new ref itself; nothing the turn held was dropped and the owner hook was not asked
    expect(w.refusedWith).toHaveLength(1);
    expect(w.refusedWith[0]!.state).toBe("withheld");
    expect(keep).not.toHaveBeenCalled();
    expect(kinds(w.turn)).toEqual(["none", "prefix", "receipt"]);
  } finally { closeTurnLineage(w.turn); }
});

it("H2-4 privacy: a new withheld record is refused also when the turn drops a withheld receipt in the same release", () => {
  const w = runningOwnerTurn(() => true);
  try {
    const forgotten = w.store.appendMessage(w.bot.threadId, { role: "bot", kind: "text", text: SECRET });
    const forgottenRef: LineageRef = { kind: "line", threadId: w.bot.threadId, messageId: forgotten.id };
    commitRevoke(w.db, { kind: "line", threadId: w.bot.threadId, messageIds: [forgotten.id], cause: "forget" });
    globalReceiptRevoke(w);
    const write = vi.fn(() => "written");
    expect(() => emitConsumingTurnResponse(w.binding, descriptor(), { bytes: 8, refs: [forgottenRef], write })).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(write).not.toHaveBeenCalled();
    expect(w.refusedWith).toHaveLength(1);
    expect(w.refusedWith[0]).not.toEqual({ state: "withheld", reason: "deny-memory" });
    expect(w.turn.parents).not.toContainEqual(forgottenRef);
  } finally { closeTurnLineage(w.turn); }
});

it("H2-4b privacy, direct writer path (tool results, steer quotes): a new withheld record is never added behind a dropped receipt", () => {
  const w = runningOwnerTurn(() => true);
  try {
    const forgotten = w.store.appendMessage(w.bot.threadId, { role: "bot", kind: "text", text: SECRET });
    const forgottenRef: LineageRef = { kind: "line", threadId: w.bot.threadId, messageId: forgotten.id };
    commitRevoke(w.db, { kind: "line", threadId: w.bot.threadId, messageIds: [forgotten.id], cause: "forget" });
    globalReceiptRevoke(w);
    expect(() => addTurnParents(w.turn, [forgottenRef])).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(w.turn.parents).not.toContainEqual(forgottenRef);
    expect(w.refusedWith).toHaveLength(1);
    expect(w.refusedWith[0]).not.toEqual({ state: "withheld", reason: "deny-memory" });
  } finally { closeTurnLineage(w.turn); }
});

it("H2-5 guard: a turn with no owner keep hook (any other audience) is still refused by the same revoke", () => {
  const w = runningOwnerTurn();
  try {
    globalReceiptRevoke(w);
    const write = vi.fn(() => "written");
    expect(() => emitConsumingTurnResponse(w.binding, descriptor(), { bytes: 8, refs: [], write })).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(write).not.toHaveBeenCalled();
    expect(w.refusedWith).toEqual([{ state: "withheld", reason: "deny-memory" }]);
    expect(refusedLogs()).toHaveLength(1);
  } finally { closeTurnLineage(w.turn); }
});

it("H2-6 guard: an owner turn whose prompt is not written yet (the hook says no) is still refused, so it is rebuilt without the memory", () => {
  const keep = vi.fn<Keep>(() => false);
  const w = runningOwnerTurn(keep);
  try {
    globalReceiptRevoke(w);
    const write = vi.fn(() => "written");
    expect(() => emitConsumingTurnResponse(w.binding, descriptor(), { bytes: 8, refs: [], write })).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(write).not.toHaveBeenCalled();
    expect(w.refusedWith).toEqual([{ state: "withheld", reason: "deny-memory" }]);
    // nothing was dropped behind the refusal: the rebuild decides what the new prompt carries
    expect(kinds(w.turn)).toEqual(["none", "prefix", "receipt"]);
  } finally { closeTurnLineage(w.turn); }
});

it("H2-7 a remembered line the owner forgot mid-turn: the next reply is released and the forgotten words never reach the stored answer", () => {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bot = store.createBot({ name: "Desk Helper", section: "Ops" }, { seedMessages: false });
  const safe = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Budget ceiling stays at the agreed figure." });
  const secret = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: SECRET });
  const db = database(), turnId = "turn-h2-line";
  const turn = openTurnLineage(db, { threadId: bot.threadId, turnId });
  const refused = vi.fn();
  prepareRetainedFence(turn, OWNER, refused, db, () => true);
  const secretRef: LineageRef = { kind: "line", threadId: bot.threadId, messageId: secret.id };
  const safeRef: LineageRef = { kind: "line", threadId: bot.threadId, messageId: safe.id };
  addTurnParents(turn, [secretRef, safeRef]);
  const binding = bindConsumingTurn({
    identity: { botId: bot.id, threadId: bot.threadId, dispatchGeneration: turnId, lineageTurnIds: [turnId], adapterLeaseId: turnId },
    turn, db, isCurrent: () => true, onLedgerRefused: verdict => { for (const member of checkedOpenTurns(turn)) refuseRetainedTurn(member, verdict); },
  });
  try {
    commitRevoke(db, { kind: "line", threadId: bot.threadId, messageIds: [secret.id], cause: "forget" });
    drainRevokeMarker(db);
    const write = vi.fn(() => "written");
    expect(() => emitConsumingTurnResponse(binding, descriptor(), { bytes: 8, refs: [], write })).not.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
    expect(refused).not.toHaveBeenCalled();
    expect(turn.parents).toEqual([safeRef]);
    const answer = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `Summary done. (Earlier you noted: ${SECRET}.)`, turnId });
    const row = db.prepare("SELECT text, json FROM messages WHERE thread_id=? AND id=?").get(bot.threadId, answer.id) as { text: string; json: string };
    expect(row.text).not.toContain(SECRET);
    expect(row.json).not.toContain("7731-BRAVO-DELTA");
    expect(row.text).toContain("Summary done.");
    expect(row.text).toContain("[removed]");
  } finally { closeTurnLineage(turn); }
});

// CTXREV H2 A-2 (arbiter row A-2, Astra NO): the keep rule redacts only whole withdrawn LINES. A detail from a revoked memory receipt, or a
// partial quote of a forgotten line, survived in the stored answer and was replayed to the engine on later turns. The kept reply of a turn
// whose held context was withdrawn by its own privacy revoke is now withheld from bots for good (the owner still sees it).
const lineRef = (threadId: string, messageId: string): LineageRef => ({ kind: "line", threadId, messageId });
const storedRow = (db: ReturnType<typeof database>, threadId: string, id: string) =>
  db.prepare("SELECT text, json_extract(json,'$.withheldFromBots') AS w FROM messages WHERE thread_id=? AND id=?").get(threadId, id) as { text: string; w: unknown };

const markCounts = (db: ReturnType<typeof database>) => {
  const n = (table: string) => Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
  return { line: n("memory_deny_point"), range: n("memory_deny_range"), session: n("memory_deny_session") };
};

it("A2-1 a memory receipt revoked mid-turn: the kept reply that used its detail is never replayed to bots; the owner still sees it", () => {
  const w = runningOwnerTurn(() => true);
  try {
    globalReceiptRevoke(w);
    expect(reply(w).write).toHaveBeenCalledTimes(1);
    expect(kinds(w.turn)).toEqual(["none", "prefix"]);
    // the reply repeats a detail the revoked memory supplied; nothing names a stored line, so whole-line redaction cannot catch it
    const before = markCounts(w.db);
    const answer = w.store.appendMessage(w.bot.threadId, { role: "bot", kind: "text", text: "Your locker combination is 31-07-44, as you told me.", turnId: w.turnId });
    // its own line mark and nothing else: no range over later lines, no session mark on the running owner turn's engine (that would stop a
    // resumed owner turn at its next adapter write, against Sean's revokekeep rule); a second write of the reply adds nothing
    expect(markCounts(w.db)).toEqual({ ...before, line: before.line + 1 });
    w.store.patchMessage(w.bot.threadId, answer.id, { text: "Your locker combination is 31-07-44, as you told me. Anything else?" });
    expect(markCounts(w.db)).toEqual({ ...before, line: before.line + 1 });
    closeTurnLineage(w.turn);
    const row = storedRow(w.db, w.bot.threadId, answer.id);
    expect(row.text).toBe("Your locker combination is 31-07-44, as you told me. Anything else?");
    expect(row.w).toBe(1);
    // the next turn's replay judges the stored reply: withheld (own flag), so its words never reach the engine again
    expect(refsLookup(w.db, [lineRef(w.bot.threadId, answer.id)], OWNER)).toEqual({ state: "withheld", reason: "own-flag" });
    // the reader door every bot replay goes through (bot-read.ts botMessages/botRows) never reads the note: a committed mark must withhold it
    expect(refsLookup(w.db, [lineRef(w.bot.threadId, answer.id)], doorReader()).state).toBe("withheld");
    expect(refsLookup(w.db, [lineRef(w.bot.threadId, answer.id)], doorReader(OWNER.audience)).state).toBe("withheld");
  } finally { closeTurnLineage(w.turn); }
});

// r5 (Astra BLOCK on aee61b5311: this witness stayed GREEN with the hide mark removed). With the forgotten line in the turn's OWN thread the
// forget's positional range already covers every later line of the running turn, so the door withheld the reply without the hide mark. The
// held line now lives in another conversation: only the reply's own hide mark can withhold it (RED with hideReplay's hideReplyLine off).
it("A2-2 a partial quote of a line the owner forgot mid-turn in another conversation survives whole-line redaction; the reply is never replayed to bots", () => {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bot = store.createBot({ name: "Desk Helper", section: "Ops" }, { seedMessages: false });
  const other = store.createBot({ name: "Site Helper", section: "Ops" }, { seedMessages: false });
  const safe = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Budget ceiling stays at the agreed figure." });
  const secret = store.appendMessage(other.threadId, { role: "bot", kind: "text", text: SECRET });
  const db = database(), turnId = "turn-a2-quote";
  const turn = openTurnLineage(db, { threadId: bot.threadId, turnId });
  prepareRetainedFence(turn, OWNER, vi.fn(), db, () => true);
  addTurnParents(turn, [lineRef(other.threadId, secret.id), lineRef(bot.threadId, safe.id)]);
  const binding = bindConsumingTurn({
    identity: { botId: bot.id, threadId: bot.threadId, dispatchGeneration: turnId, lineageTurnIds: [turnId], adapterLeaseId: turnId },
    turn, db, isCurrent: () => true, onLedgerRefused: verdict => { for (const member of checkedOpenTurns(turn)) refuseRetainedTurn(member, verdict); },
  });
  try {
    commitRevoke(db, { kind: "line", threadId: other.threadId, messageIds: [secret.id], cause: "forget" });
    drainRevokeMarker(db);
    const write = vi.fn(() => "written");
    expect(() => emitConsumingTurnResponse(binding, descriptor(), { bytes: 8, refs: [], write })).not.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
    expect(turn.parents.map(ref => ref.kind === "line" ? ref.messageId : ref.kind)).toEqual([safe.id]);
    // an excerpt of the forgotten line, not the whole line: whole-string redaction leaves it in place
    const answer = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Done. The code was 7731-BRAVO-DELTA.", turnId });
    closeTurnLineage(turn);
    const row = storedRow(db, bot.threadId, answer.id);
    expect(row.text).toContain("7731-BRAVO-DELTA");
    expect(row.w).toBe(1);
    // the door's verdict comes from the reply's own hide mark, not from the forget's marks (which stay in the other conversation)
    expect(refsLookup(db, [lineRef(bot.threadId, answer.id)], doorReader())).toEqual({ state: "withheld", reason: "deny-line" });
    expect(refsLookup(db, [lineRef(bot.threadId, answer.id)], doorReader(OWNER.audience)).state).toBe("withheld");
    // guard: the untouched line of the same thread written before the turn is still shown (the forget did not reach this conversation)
    expect(refsLookup(db, [lineRef(bot.threadId, safe.id)], doorReader()).state).toBe("shown");
  } finally { closeTurnLineage(turn); }
});

it("A2-3 guard: a reply of an owner turn whose held context was never revoked stays replayable to bots", () => {
  const w = runningOwnerTurn(() => true);
  try {
    expect(reply(w).write).toHaveBeenCalledTimes(1);
    expect(kinds(w.turn)).toEqual(["none", "prefix", "receipt"]);
    const answer = w.store.appendMessage(w.bot.threadId, { role: "bot", kind: "text", text: "Here is the report outline you asked for.", turnId: w.turnId });
    closeTurnLineage(w.turn);
    expect(storedRow(w.db, w.bot.threadId, answer.id).w).toBeNull();
    expect(refsLookup(w.db, [lineRef(w.bot.threadId, answer.id)], OWNER)).toEqual({ state: "shown" });
    expect(refsLookup(w.db, [lineRef(w.bot.threadId, answer.id)], doorReader()).state).toBe("shown");
  } finally { closeTurnLineage(w.turn); }
});

// r5 (Fable BLOCK on aee61b5311, capture): the kept reply was still captured as an active memory source with its words, so its detail could
// be learned again and recalled to a bot later. A hidden reply is captured left out (empty payload, retired, job born complete).
const sourceOf = (db: ReturnType<typeof database>, threadId: string, id: string) =>
  db.prepare(`SELECT s.state, json_extract(v.payload,'$.text') AS text, json_extract(v.payload,'$.excluded') AS excluded FROM memory_sources s
    JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision WHERE s.id=?`).get(`message:${threadId}:${id}`) as { state: string; text: string; excluded: string | null } | undefined;
const activeSourcesWith = (db: ReturnType<typeof database>, words: string) => Number((db.prepare(`SELECT count(*) AS n FROM memory_sources s
  JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision WHERE s.state='active' AND instr(v.payload, ?) > 0`).get(words) as { n: number }).n);

it("A2-4 the kept reply of a turn whose held memory was revoked mid-turn is never a memory source with its words; an untouched reply is", () => {
  const w = runningOwnerTurn(() => true);
  try {
    globalReceiptRevoke(w);
    expect(reply(w).write).toHaveBeenCalledTimes(1);
    const answer = w.store.appendMessage(w.bot.threadId, { role: "bot", kind: "text", text: "Your locker combination is 31-07-44, as you told me.", turnId: w.turnId, turnTerminal: true });
    closeTurnLineage(w.turn);
    expect(storedRow(w.db, w.bot.threadId, answer.id).text).toContain("31-07-44");
    expect(sourceOf(w.db, w.bot.threadId, answer.id)).toEqual({ state: "retired", text: "", excluded: "withheld-reply" });
    expect(activeSourcesWith(w.db, "31-07-44")).toBe(0);
  } finally { closeTurnLineage(w.turn); }
  // guard: the same terminal reply of a turn with nothing revoked is captured with its words
  closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  const g = runningOwnerTurn(() => true);
  try {
    expect(reply(g).write).toHaveBeenCalledTimes(1);
    const answer = g.store.appendMessage(g.bot.threadId, { role: "bot", kind: "text", text: "Your locker combination is 31-07-44, as you told me.", turnId: g.turnId, turnTerminal: true });
    closeTurnLineage(g.turn);
    expect(sourceOf(g.db, g.bot.threadId, answer.id)).toMatchObject({ state: "active", excluded: null });
    expect(activeSourcesWith(g.db, "31-07-44")).toBe(1);
  } finally { closeTurnLineage(g.turn); }
});

// r5 (Fable BLOCK on aee61b5311, D6): the hide mark is a deny_line row of the thread, and every object a later turn saves carries the
// thread's prefix range over it, so after one kept reply every later note of the thread read withheld, for good. The hide mark now
// is skipped by every carry; what the kept turn itself saves (it saw the revoked detail) takes its own mark at its write (hideTurnRecord),
// whether or not a reply is stored yet. A later turn's note and reply are shown.
it("A2-5 a note saved by the kept turn (before or after its hidden reply) is withheld; the next turn's note and reply in the same conversation are shown", () => {
  const w = runningOwnerTurn(() => true);
  const noteRef = (id: string): LineageRef => ({ kind: "memory", ref: { kind: "note", id, version: 1 } });
  let next: ReturnType<typeof openTurnLineage> | undefined;
  try {
    globalReceiptRevoke(w);
    expect(reply(w).write).toHaveBeenCalledTimes(1);
    // the kept turn saves a note before any reply is stored (a save-note tool call right after the revoke): no hide mark exists yet
    writeRecordLineage(w.db, { kind: "note", id: "note-before-reply", version: 1 }, w.turn);
    expect(refsLookup(w.db, [noteRef("note-before-reply")], doorReader()).state).toBe("withheld");
    const answer = w.store.appendMessage(w.bot.threadId, { role: "bot", kind: "text", text: "Your locker combination is 31-07-44, as you told me.", turnId: w.turnId });
    expect(refsLookup(w.db, [lineRef(w.bot.threadId, answer.id)], doorReader()).state).toBe("withheld");
    // the kept turn saves a note after its reply: it saw the revoked detail, so the note is withheld like the reply
    writeRecordLineage(w.db, { kind: "note", id: "note-same-turn", version: 1 }, w.turn);
    expect(refsLookup(w.db, [noteRef("note-same-turn")], doorReader()).state).toBe("withheld");
    closeTurnLineage(w.turn);
    // the owner asks again: a new turn of the same conversation, built on its prefix (the door already leaves the hidden reply out)
    const ask = w.store.appendMessage(w.bot.threadId, { role: "user", kind: "text", text: "What is on the agenda for Monday?" });
    next = openTurnLineage(w.db, { threadId: w.bot.threadId, turnId: "turn-h2-next" });
    addTurnParents(next, [{ kind: "prefix", threadId: w.bot.threadId, held: null, shown: [w.earlier.id, ask.id], content: true }]);
    const later = w.store.appendMessage(w.bot.threadId, { role: "bot", kind: "text", text: "Monday starts with the weekly report.", turnId: "turn-h2-next" });
    writeRecordLineage(w.db, { kind: "note", id: "note-next-turn", version: 1 }, next);
    expect(refsLookup(w.db, [lineRef(w.bot.threadId, later.id)], doorReader()).state).toBe("shown");
    expect(refsLookup(w.db, [noteRef("note-next-turn")], doorReader()).state).toBe("shown");
    // the hidden reply stays hidden and the same-turn note stays withheld
    expect(refsLookup(w.db, [lineRef(w.bot.threadId, answer.id)], doorReader()).state).toBe("withheld");
    expect(refsLookup(w.db, [noteRef("note-same-turn")], doorReader()).state).toBe("withheld");
  } finally { closeTurnLineage(w.turn); if (next) closeTurnLineage(next); }
});
