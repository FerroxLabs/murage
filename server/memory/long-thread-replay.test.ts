// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61.1 (memreplay): a long direct chat failed every turn with
// MEMORY_REPLAY_LIMIT ("Rebel Wealth Accelerator", Dax, and a delegated
// reply from Kessler).
//
// Every memory-on turn writes a frame receipt, and a turn that recalls
// (memory_search, memory_get, quoted working context) a companion lookup
// receipt. A resumed native session links each new reply to EVERY receipt
// of that session (linkMemoryDisclosureOutput), so receipt i lists every
// later reply: the output lists grow as turns squared. The direct-chat
// replay check read the whole thread, parsed every output list into its
// 10000-node budget, and threw instead of withholding. About 100 turns in
// one session was enough; past 2048 receipts any direct chat threw on a
// fixed whole-thread cap however it got there.
//
// The check now reads only the receipts of the lines it is asked about,
// through the output index, judges each distinct thing a receipt cites
// once, and a direct turn asks only about the lines it replays. What a
// revoked or forgotten source produced is still never replayed.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryAccess, type MemoryRoster } from "./policy.ts";
import { captureSource } from "./capture.ts";
import { ownerMemoryTicket, saveMemoryCandidate } from "./authority.ts";
import { forgetMemory } from "./forget.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { MemoryDispatchReceipt, memoryContinuationChanged } from "./dispatch.ts";
import { filterDirectReplay, filterMemoryReplay } from "./disclosures.ts";
import { replayExclusions } from "./replay-lineage.ts";
import type { MemorySearchBridge } from "./search.ts";
import type { Message } from "../store.ts";

const roster: MemoryRoster = {
  bots: [
    { id: "dax", threadId: "dax-direct", section: "Operations" },
    { id: "kessler", threadId: "kessler-direct", section: "Operations" },
  ],
  groups: [],
};
/** What a direct turn may replay or quote (filterDirectReplay). */
const directAllowed = (t: string, m: Message[], a: MemoryAccess, s: Set<string>) => filterDirectReplay(t, m, a, s).allowed;
const empty: MemorySearchBridge = { search: async () => ({ hits: [], vectorRows: 0 }) };
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

function access(botId: string, thread: string): MemoryAccess {
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(); registry.begin(botId, thread, "g");
  const token = registry.mint({ botId, threadId: thread, generation: "g", depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
const version = (id: string) => (database().prepare("SELECT max(version) AS version FROM memory_records WHERE id=?").get(id) as { version: number }).version;

/** A memory of the owner's words in `thread`, active and owner-pinned, so
 * every turn's frame carries it (Dax's standing notes). */
function memory(thread: string, botId: string, key: string, text: string, pinned = true) {
  reconcileMemoryRoster(roster);
  captureSource(database(), { id: `src-${key}`, threadId: thread, kind: "text", speaker: "owner", outcome: "recorded", text });
  const id = saveMemoryCandidate(text, [{ sourceId: `src-${key}`, revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], `k-${key}`, access(botId, thread));
  database().prepare("UPDATE memory_records SET state='active', owner_pinned=? WHERE id=?").run(pinned ? 1 : 0, id);
  return id;
}
/** A team memory both bots may read, captured outside Dax's chat, so his
 * thread checkpoint does not carry it (forgetting it touches only what
 * recalled it). */
function teamMemory(key: string, text: string) {
  const id = memory("kessler-direct", "kessler", key, text, false);
  const team = (database().prepare("SELECT id FROM memory_scopes WHERE kind='team' AND owner_key='Operations'").get() as { id: string }).id;
  database().prepare("UPDATE memory_records SET scope_id=? WHERE id=?").run(team, id);
  database().prepare("UPDATE memory_sources SET scope_id=? WHERE id=?").run(team, `src-${key}`);
  return id;
}
const handle = (id: string, key: string) => ({ id, version: version(id), evidence: [{ sourceId: `src-${key}`, revision: 1 }] });

const owner = (id: string, at: number): Message => ({ id, role: "user", kind: "text", text: `ask ${id}`, at });
const reply = (id: string, at: number, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text: `answer ${id}`, at, from: { botId: "dax", name: "Dax", color: "#000" }, ...extra });

/** `turns` turns of Dax's direct chat, every one in the same resumed native
 * session (the frame never changed), every one recalling a memory through
 * memory_search, the way the dispatch path writes them. `extraLookup`
 * (turn -> record handle) adds a second recalled record on that turn. */
async function longConversation(turns: number, extraLookup: Record<number, ReturnType<typeof handle>> = {}) {
  const pin = memory("dax-direct", "dax", "pin", "Rebel Wealth Accelerator launches in March.");
  const recalled = memory("dax-direct", "dax", "recalled", "The offer is 997 for the first cohort.", false);
  const a = access("dax", "dax-direct");
  const messages: Message[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    messages.push(owner(`ask-${turn}`, turn * 10));
    const bundle = await buildMemoryBundle("what is the plan", a, empty);
    const receipt = new MemoryDispatchReceipt(bundle, a, "fuigo");
    receipt.sessionStarted("native-1");
    receipt.accepted();
    receipt.noteLookup([handle(recalled, "recalled"), ...(extraLookup[turn] ? [extraLookup[turn]] : [])], a);
    // a tool line and the answer, both outputs of the turn
    receipt.output(`tool-${turn}`);
    receipt.output(`reply-${turn}`);
    messages.push({ id: `tool-${turn}`, role: "bot", kind: "activity", at: turn * 10 + 1, tool: { name: "memory_search", ok: true } });
    messages.push(reply(`reply-${turn}`, turn * 10 + 2));
  }
  return { pin, recalled, a, messages };
}

it("red: a long direct chat with recall every turn replays without MEMORY_REPLAY_LIMIT", async () => {
  const { a, messages } = await longConversation(120);
  // the whole thread, as 0.1.61 asked (index.ts direct turn)
  expect(() => filterMemoryReplay("dax-direct", messages, a)).not.toThrow();
  expect(filterMemoryReplay("dax-direct", messages, a)).toHaveLength(messages.length);
  // and the replay a direct turn builds now
  const replayed = directAllowed("dax-direct", messages, a, new Set()).filter(m => m.kind === "text").slice(-40);
  expect(replayed).toHaveLength(40);
  expect(replayed.at(-1)?.id).toBe("reply-120");
  // the session check that decides whether to resume reads only its latest frame
  const bundle = await buildMemoryBundle("what is the plan", a, empty);
  expect(memoryContinuationChanged(bundle, "dax-direct", "fuigo", "native-1")).toBe(false);
}, 240_000);

it("a recalled memory the owner forgets is still withheld across the whole long session", async () => {
  const { recalled, a, messages } = await longConversation(100);
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: recalled });
  const kept = directAllowed("dax-direct", messages, access("dax", "dax-direct"), new Set());
  // every reply rests on the forgotten recall; the owner's words stay
  expect(kept.filter(m => m.role !== "user")).toEqual([]);
  expect(kept.filter(m => m.role === "user").length).toBeGreaterThanOrEqual(40);
  void a;
}, 240_000);

it("a source forgotten mid-session withholds the replies made from it on, and keeps the ones before", async () => {
  const side = teamMemory("side", "Kessler owns the webinar funnel.");
  const { messages } = await longConversation(110, { 90: handle(side, "side") });
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "src-side", revision: 1 });
  // the content rule (an owner-audience room turn, recall): the lookup receipt
  // of turn 90 vouches for every reply of the session from turn 90 on
  const withheld = replayExclusions("dax-direct", messages, null, { failClosed: true });
  for (let turn = 90; turn <= 110; turn++) expect(withheld.has(`reply-${turn}`)).toBe(true);
  for (let turn = 1; turn < 90; turn++) expect(withheld.has(`reply-${turn}`)).toBe(false);
  // a direct turn withholds them too (a forget also moves the deletion epoch,
  // which a direct chat's receipts are held to: its rule, unchanged)
  const kept = directAllowed("dax-direct", messages, access("dax", "dax-direct"), new Set()).map(m => m.id);
  for (let turn = 90; turn <= 110; turn++) expect(kept).not.toContain(`reply-${turn}`);
  expect(kept).toContain("ask-110");
}, 240_000);

it("a thread past 2048 receipts replays its recent lines, and one revoked receipt among them still withholds its reply", async () => {
  const { a, messages } = await longConversation(4);
  // 2,400 more turns of a transcript-replay engine (no native session), each
  // a frame and a lookup receipt citing the same memories: 4,800 receipts
  const frame = database().prepare("SELECT * FROM memory_disclosures WHERE thread_id='dax-direct' AND bundle_id NOT LIKE '%:lookup' LIMIT 1").get() as Record<string, string | number>;
  const lookup = database().prepare("SELECT * FROM memory_disclosures WHERE thread_id='dax-direct' AND bundle_id LIKE '%:lookup' LIMIT 1").get() as Record<string, string | number>;
  const insert = database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,NULL,?,?,?,?,?,?,?,?)");
  for (let turn = 5; turn <= 2404; turn++) {
    for (const [suffix, row] of [["", frame], [":lookup", lookup]] as const) {
      insert.run(`bulk-${turn}${suffix}`, "dax-direct", "openai-compat", row.record_versions, row.source_versions, JSON.stringify([`reply-${turn}`]), row.policy_revision, row.deletion_epoch, row.token_count, "delivered", turn * 10);
    }
    messages.push(owner(`ask-${turn}`, turn * 10), reply(`reply-${turn}`, turn * 10 + 2));
  }
  expect(() => filterMemoryReplay("dax-direct", messages.slice(-80), a)).not.toThrow();
  let kept = directAllowed("dax-direct", messages, a, new Set());
  expect(kept.filter(m => m.kind === "text").slice(-40).at(-1)?.id).toBe("reply-2404");
  expect(kept.map(m => m.id)).toContain("reply-2400");
  // one receipt the owner's later turn found revoked
  database().prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id='bulk-2400:lookup'").run();
  kept = directAllowed("dax-direct", messages, a, new Set());
  expect(kept.map(m => m.id)).not.toContain("reply-2400");
  expect(kept.map(m => m.id)).toContain("reply-2401");
  expect(kept.map(m => m.id)).toContain("ask-2400");
}, 240_000);

it("a delegated reply copied in from Kessler follows its original in a long chat", async () => {
  // a team memory both bots may read (a copy is held to its reader's access)
  const kesslerMemory = teamMemory("kessler", "The webinar list is 4,200 people.");
  const k = access("kessler", "kessler-direct");
  const kBundle = await buildMemoryBundle("webinar", k, empty);
  const kReceipt = new MemoryDispatchReceipt(kBundle, k, "fuigo");
  kReceipt.sessionStarted("k-native");
  kReceipt.accepted();
  kReceipt.noteLookup([handle(kesslerMemory, "kessler")], k);
  kReceipt.output("k-answer");
  const { a, messages } = await longConversation(100);
  messages.push(reply("copy-k-answer", 99_999, { from: { botId: "kessler", name: "Kessler", color: "#111" }, copyOf: { threadId: "kessler-direct", messageIds: ["k-answer"] } }));
  expect(directAllowed("dax-direct", messages, a, new Set()).map(m => m.id)).toContain("copy-k-answer");
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: kesslerMemory });
  // the copy goes with its original; Dax's own replies do not (content rule)
  const withheld = replayExclusions("dax-direct", messages.slice(-80), null, { failClosed: true });
  expect(withheld.has("copy-k-answer")).toBe(true);
  expect(withheld.has("reply-100")).toBe(false);
  const kept = directAllowed("dax-direct", messages, access("dax", "dax-direct"), new Set()).map(m => m.id);
  expect(kept).not.toContain("copy-k-answer");
  expect(kept).toContain("ask-100");
}, 240_000);

/** Dax's real thread shape (read-only copy of the owner's data, 2026-10-01):
 * 10,041 messages, 403 from the owner, 316 memory receipts, with the "RWA
 * watch: 30-min sweep" routine posting into the conversation forever. */
it("red: a conversation past 10,000 messages that a routine keeps posting into replays without MEMORY_REPLAY_LIMIT", async () => {
  const { a, messages } = await longConversation(3);
  const frame = database().prepare("SELECT * FROM memory_disclosures WHERE thread_id='dax-direct' AND bundle_id NOT LIKE '%:lookup' LIMIT 1").get() as Record<string, string | number>;
  const insert = database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
  let at = 1_000;
  // 400 owner turns, and a routine run every 30 minutes in between: each run
  // a run line, a dozen tool lines and a summary; one run in ten recalls
  for (let run = 1; messages.length <= 10_050; run++) {
    if (run % 25 === 0) messages.push(owner(`owner-${run}`, at++), reply(`owner-reply-${run}`, at++));
    messages.push({ id: `run-${run}`, role: "bot", kind: "activity", at: at++, tool: { name: "routine: RWA watch: 30-min sweep", ok: true } });
    for (let tool = 0; tool < 12; tool++) messages.push({ id: `run-${run}-tool-${tool}`, role: "bot", kind: "activity", at: at++, tool: { name: "browser_navigate", ok: true } });
    messages.push(reply(`run-${run}-summary`, at++));
    if (run % 10 === 0) insert.run(`run-receipt-${run}`, "dax-direct", "fuigo", `run-session-${run}`, frame.record_versions, frame.source_versions, JSON.stringify([`run-${run}-summary`]), frame.policy_revision, frame.deletion_epoch, frame.token_count, "delivered", at);
  }
  expect(messages.length).toBeGreaterThan(10_000);
  // 0.1.61 handed the whole branch to the check, which refused past 10,000
  expect(() => filterMemoryReplay("dax-direct", messages, a)).not.toThrow();
  const kept = directAllowed("dax-direct", messages, a, new Set());
  const replayed = kept.filter(m => m.kind === "text").slice(-40);
  expect(replayed).toHaveLength(40);
  expect(replayed.at(-1)?.id).toBe(messages.filter(m => m.kind === "text").at(-1)?.id);
  // the newest run with a receipt, made from a memory the owner then forgets,
  // is withheld; the runs after it are not
  const last = Number((database().prepare("SELECT max(CAST(substr(bundle_id,13) AS INTEGER)) AS n FROM memory_disclosures WHERE bundle_id LIKE 'run-receipt-%'").get() as { n: number }).n);
  const side = teamMemory("routine-side", "The sweep watches the RWA checkout page.");
  database().prepare("UPDATE memory_disclosures SET record_versions=? WHERE bundle_id=?").run(JSON.stringify([{ id: side, version: version(side) }]), `run-receipt-${last}`);
  expect(replayExclusions("dax-direct", replayed, null, { failClosed: true }).has(`run-${last}-summary`)).toBe(false);
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: side });
  const withheld = replayExclusions("dax-direct", replayed, null, { failClosed: true });
  expect(withheld.has(`run-${last}-summary`)).toBe(true);
  expect(replayed.map(m => m.id)).toContain(`run-${last - 10}-summary`);
  expect(withheld.has(`run-${last - 10}-summary`)).toBe(false);
  expect(directAllowed("dax-direct", messages, access("dax", "dax-direct"), new Set()).map(m => m.id)).not.toContain(`run-${last}-summary`);
}, 240_000);

it("a resumed session past 2048 receipts still decides from its latest frame (MEMORY_CONTINUATION_LIMIT)", async () => {
  const { a } = await longConversation(2);
  const frame = database().prepare("SELECT * FROM memory_disclosures WHERE thread_id='dax-direct' AND bundle_id NOT LIKE '%:lookup' ORDER BY created_at DESC LIMIT 1").get() as Record<string, string | number>;
  database().prepare(`WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value<2100)
    INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    SELECT 'old-frame-'||value,'dax-direct','fuigo','native-1',?,?,'[]',?,?,?,'delivered',value FROM n`).run(frame.record_versions, frame.source_versions, frame.policy_revision, frame.deletion_epoch, frame.token_count);
  const bundle = await buildMemoryBundle("what is the plan", a, empty);
  expect(memoryContinuationChanged(bundle, "dax-direct", "fuigo", "native-1")).toBe(false);
  // the latest frame differing still resets the session
  database().prepare("UPDATE memory_disclosures SET record_versions='[]' WHERE bundle_id=?").run(frame.bundle_id);
  expect(memoryContinuationChanged(bundle, "dax-direct", "fuigo", "native-1")).toBe(true);
}, 240_000);
