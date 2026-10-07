// A direct turn's replay check reads lineage rows in proportion to the receipts of the
// thread, not to the pairs a resumed session lists (every reply on every earlier receipt),
// and nothing at all when no line it asks about was made under a receipt. Verdicts are
// what long-thread-replay.test.ts pins; this file pins the work, in rows no machine changes.
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
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryAccess, type MemoryRoster } from "./policy.ts";
import { captureSource } from "./capture.ts";
import { ownerMemoryTicket, saveMemoryCandidate } from "./authority.ts";
import { forgetMemory } from "./forget.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { MemoryDispatchReceipt } from "./dispatch.ts";
import { filterDirectReplay } from "./disclosures.ts";
import { replayExclusions, replayLimitWithheld, replayRowsRead, setReplayNodeBudgetForTest } from "./replay-lineage.ts";
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
afterEach(() => setReplayNodeBudgetForTest(null));
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



const rowsFor = (messages: Message[], a: MemoryAccess) => { const before = replayRowsRead(); const kept = directAllowed("dax-direct", messages, a, new Set()); return { kept, rows: replayRowsRead() - before }; };

it("a 120-turn resumed session reads rows in proportion to its receipts (240), with the same verdicts, and costs nothing for lines no receipt lists", async () => {
  const { a, messages, recalled } = await longConversation(120);
  const { kept, rows } = rowsFor(messages, a);
  expect(rows).toBeLessThan(1500);
  expect(kept.filter(m => m.kind === "text").slice(-40).map(m => m.id).at(-1)).toBe("reply-120");
  expect(kept.filter(m => m.role !== "user" && m.kind === "text").length).toBeGreaterThanOrEqual(20);
  // the verdict is unchanged: a forgotten recall still withholds every reply, the owner's words stay
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: recalled });
  const after = rowsFor(messages, access("dax", "dax-direct"));
  // every reply withheld: the lines asked about are probed, not each reply's receipts (26,430 rows before)
  expect(after.rows).toBeLessThan(2500);
  expect(after.kept.filter(m => m.role !== "user")).toEqual([]);
  expect(after.kept.filter(m => m.role === "user").length).toBeGreaterThanOrEqual(20);
  
  const strangers: Message[] = Array.from({ length: 40 }, (_, i) => reply(`stranger-${i}`, 100_000 + i));
  const stranger = rowsFor(strangers, access("dax", "dax-direct"));
  expect(stranger.kept).toHaveLength(40);
  expect(stranger.rows).toBeLessThanOrEqual(70);
  const plan = (sql: string, ...args: unknown[]) => database().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as never[])).map(row => String(row.detail)).join(" | ");
  expect(plan("SELECT count(*) AS n FROM (SELECT 1 FROM memory_disclosures WHERE thread_id=? LIMIT ?)", "t", 5)).toContain("memory_disclosures_thread");
  expect(plan("SELECT count(*) AS n FROM (SELECT 1 FROM memory_disclosure_outputs WHERE thread_id=? AND message_id IN (SELECT value FROM json_each(?)) LIMIT ?)", "t", "[]", 5)).toMatch(/USING (COVERING )?INDEX memory_disclosure_outputs/);
}, 240_000);


it("a whole-thread check that runs out of replay budget before reaching the line a bad receipt lists withholds that line and every line not proven sound", async () => {
  const { messages, recalled } = await longConversation(12);
  const strangers: Message[] = Array.from({ length: 5 }, (_, i) => reply(`stranger-${i}`, 100_000 + i));
  const asked = [...messages, ...strangers].map(m => ({ id: m.id, role: m.role }));
  const generated = asked.filter(m => m.role !== "user").map(m => m.id);
  const run = () => replayExclusions("dax-direct", asked, null, { failClosed: true });
  // healthy: nothing is withheld, strangers included
  expect(run().size).toBe(0);
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: recalled });
  // the thread's pairs outgrow its receipts, so the check judges the whole thread (the groupBad loop)
  const full = run();
  expect([...full].sort()).toEqual(messages.filter(m => m.role !== "user").map(m => m.id).sort());
  expect(full.has("stranger-0")).toBe(false);
  // exhausted: the same check with a budget too small to finish
  const hits = replayLimitWithheld();
  setReplayNodeBudgetForTest(2);
  const cut = run();
  expect(replayLimitWithheld()).toBeGreaterThan(hits);
  expect(cut.has("reply-12")).toBe(true);
  for (const id of generated) expect(cut.has(id)).toBe(true);
  expect(cut.has("ask-1")).toBe(false);
});
