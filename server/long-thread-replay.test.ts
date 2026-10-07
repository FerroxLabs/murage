// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.62: a long conversation (more than THREAD_RECEIPT_LIMIT memory receipts)
// failed every memory-on turn with MEMORY_REPLAY_LIMIT, and a long chat in one
// native session withheld every bot line. 0.1.62 shipped a hand-ported fix on
// 0.1.61; 1.0.0 carries the main-line form (filterDirectReplay, 0.1.61.1
// memreplay, root sets). These are the 0.1.62 guarantees, held against that
// form: the turn never fails on a long history, nothing made with memory that
// fails its check is replayed, recent bot lines survive, it stays fast, and a
// retained session holding a withheld line is not resumed.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./memory/policy.ts";
import * as disclosures from "./memory/disclosures.ts";
import { retainedSessionInvalid } from "./memory/dispatch.ts";
import { THREAD_RECEIPT_LIMIT } from "./memory/replay-lineage.ts";

const roster: MemoryRoster = { bots: [{ id: "dax", threadId: "dax-direct", section: "Operations" }], groups: [] };
const NONE: ReadonlySet<string> = new Set();
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
function access() {
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(); registry.begin("dax", "dax-direct", "g");
  const token = registry.mint({ botId: "dax", threadId: "dax-direct", generation: "g", depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
const text = (id: string, role: string, extra: Record<string, unknown> = {}) => ({ id, role, kind: "text", text: `line ${id}`, ...extra });
function longThread(receipts: number) {
  const a = access();
  database().prepare(`WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value<?)
    INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    SELECT 'old-'||value,'dax-direct','driver','[]','[]',json_array('reply-'||value),?,?,0,'delivered',value FROM n`).run(receipts, a.policyRevision, a.deletionEpoch);
  const messages = [text("u1", "user"), text("reply-1", "bot"), text("plain", "bot"), text("copy", "bot", { copyOf: { threadId: "other", messageIds: ["x"] } }), text("u2", "user")];
  return { a, messages };
}

it(`a direct chat past ${THREAD_RECEIPT_LIMIT} receipts still runs: owner words replay, a reply made with memory and a copy do not`, () => {
  const { a, messages } = longThread(THREAD_RECEIPT_LIMIT + 1);
  const { allowed, replayed } = disclosures.filterDirectReplay("dax-direct", messages, a, NONE);
  const kept = replayed.map(m => m.id);
  expect(kept).toContain("u1");
  expect(kept).toContain("u2");
  expect(kept).toContain("plain");
  // a copy is judged by its original (replay-lineage copy rules, covered in
  // server/memory/*.test.ts): the original here was made without memory
  expect(allowed.map(m => m.id)).toContain("copy");
  // a reply made with memory replays only while its receipt holds
  database().prepare(`UPDATE memory_disclosures SET record_versions='[{"id":"forgotten","version":1}]' WHERE bundle_id='old-1'`).run();
  const after = disclosures.filterDirectReplay("dax-direct", messages, a, NONE);
  expect(after.allowed.map(m => m.id)).not.toContain("reply-1");
  expect(after.replayed.map(m => m.id)).toEqual(expect.arrayContaining(["u1", "u2"]));
});

it("a 5000-message thread with 3000 receipts replays its recent lines in full and withholds only what fails its check", () => {
  const a = access();
  database().prepare(`WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value<?)
    INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    SELECT 'r-'||value,'dax-direct','driver',CASE WHEN value=3000 THEN '[{"id":"forgotten","version":1}]' ELSE '[]' END,'[]',json_array('m'||(value*2-1)),?,?,0,'delivered',value FROM n`).run(3000, a.policyRevision, a.deletionEpoch);
  // 5000 messages: odd ids are bot replies (the 3000 receipts cover m1..m5999), even ids the owner
  const messages = Array.from({ length: 5000 }, (_, i) => text(`m${i + 1}`, (i + 1) % 2 ? "bot" : "user"));
  const first = disclosures.filterDirectReplay("dax-direct", messages, a, NONE).replayed;
  // m5999 is outside the 5000; receipt 3000 covers m5999, so no recent line is withheld here
  expect(first).toHaveLength(disclosures.DIRECT_REPLAY_LINES);
  expect(first.at(-1)!.id).toBe("m5000");
  // a recent reply whose receipt cites something that is gone is withheld, nothing else
  database().prepare("UPDATE memory_disclosures SET output_message_ids='[\"m4999\"]' WHERE bundle_id='r-3000'").run();
  const after = disclosures.filterDirectReplay("dax-direct", messages, a, NONE).replayed.map(m => m.id);
  expect(after).not.toContain("m4999");
  expect(after).toHaveLength(disclosures.DIRECT_REPLAY_LINES);
  expect(after).toContain("m4998");
  expect(after).toContain("m5000");
});

// Review 0.1.62: a real long chat is ONE native session, and every output in a
// session is linked to every receipt of that session, so the receipts' output
// lists grow with the square of the turn count. A check that charged every
// listed id ran its budget out and withheld every bot line.
function oneSession(turns: number) {
  const a = access();
  const insert = database().prepare(`INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    VALUES(?,'dax-direct','driver','s1','[]','[]',?,?,?,0,'delivered',?)`);
  for (let k = 1; k <= turns; k++) {
    const outputs = Array.from({ length: turns - k + 1 }, (_, i) => `m${(k + i) * 2}`);
    // made now: after this data folder's lineage began (memory_lineage_meta.since)
    insert.run(`s-${k}`, JSON.stringify(outputs), a.policyRevision, a.deletionEpoch, Date.now() + k);
  }
  const messages = Array.from({ length: turns * 2 }, (_, i) => text(`m${i + 1}`, (i + 1) % 2 ? "user" : "bot"));
  return { a, messages };
}

it("a 400-turn chat in one session replays its recent bot lines with memory on", () => {
  const { a, messages } = oneSession(400);
  const { replayed } = disclosures.filterDirectReplay("dax-direct", messages, a, NONE);
  expect(replayed).toHaveLength(disclosures.DIRECT_REPLAY_LINES);
  expect(replayed.filter(m => m.role === "bot")).toHaveLength(disclosures.DIRECT_REPLAY_LINES / 2);
});

it("in that chat a reply whose receipt fails its check is still withheld, with every reply after it in the session", () => {
  const { a, messages } = oneSession(400);
  database().prepare(`UPDATE memory_disclosures SET record_versions='[{"id":"forgotten","version":1}]' WHERE bundle_id='s-390'`).run();
  const kept = disclosures.filterDirectReplay("dax-direct", messages, a, NONE).replayed.map(m => m.id);
  expect(kept).toContain("m778");
  for (let turn = 390; turn <= 400; turn++) expect(kept).not.toContain(`m${turn * 2}`);
  expect(kept).toContain("m799");
});

it("a 300-turn tool-heavy session (five outputs a turn) replays and checks recall lines in bounded time", async () => {
  const { randomUUID } = await import("node:crypto");
  const { capturedMessageWithheld } = await import("./memory/replay-lineage.ts");
  const a = access();
  const turns = 300, ids = Array.from({ length: turns * 5 }, () => randomUUID());
  const insert = database().prepare(`INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    VALUES(?,'dax-direct','driver','s1','[]','[]',?,?,?,0,'delivered',?)`);
  for (let k = 0; k < turns; k++) insert.run(`t-${k}`, JSON.stringify(ids.slice(k * 5)), a.policyRevision, a.deletionEpoch, k);
  const messages = ids.flatMap((id, i) => i % 5 === 4 ? [{ id: `u-${i}`, role: "user", kind: "text", text: "ask" }, { id, role: "bot", kind: "text", text: "answer" }] : [{ id, role: "bot", kind: "tool", text: "" }]);
  const started = performance.now();
  const { replayed } = disclosures.filterDirectReplay("dax-direct", messages, a, NONE);
  const replayMs = performance.now() - started;
  expect(replayed.filter(m => m.kind === "text" && m.role === "bot")).toHaveLength(disclosures.DIRECT_REPLAY_LINES / 2);
  const recallStarted = performance.now();
  for (const id of ids.slice(-100).filter((_, i) => i % 5 === 4)) expect(capturedMessageWithheld("dax-direct", id)).toBe(false);
  const recallMs = performance.now() - recallStarted;
  console.log(`replay ${replayMs.toFixed(0)} ms, 20 recall checks ${recallMs.toFixed(0)} ms`);
  expect(replayMs).toBeLessThan(5000);
});

it("a retained session that holds a withheld line is not resumed; one that holds none is", () => {
  const { a, messages } = oneSession(50);
  const kept = disclosures.filterDirectReplay("dax-direct", messages, a, NONE).replayed;
  const whyOff: { reason?: string } = {};
  expect(retainedSessionInvalid("dax-direct", "driver", "s1", whyOff), JSON.stringify(whyOff)).toBe(false);
  const whyRevoked: { reason?: string } = {};
  expect(disclosures.continuationMemoryRevoked("dax-direct", "driver", "s1", a, whyRevoked), JSON.stringify(whyRevoked)).toBe(false);
  database().prepare(`UPDATE memory_disclosures SET record_versions='[{"id":"forgotten","version":1}]' WHERE bundle_id='s-45'`).run();
  const after = disclosures.filterDirectReplay("dax-direct", messages, a, NONE).replayed;
  expect(after.filter(m => m.role === "bot").length).toBeLessThan(kept.filter(m => m.role === "bot").length);
  expect(disclosures.continuationMemoryRevoked("dax-direct", "driver", "s1", a)).toBe(true);
  expect(retainedSessionInvalid("dax-direct", "driver", "s1")).toBe(true);
  // a line withheld from an older session does not hold a newer one back
  expect(retainedSessionInvalid("dax-direct", "driver", "s2")).toBe(false);
});

it("the direct turn replays through filterDirectReplay and resets a retained session it may not resume (wiring)", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const direct = source.slice(source.indexOf("      let memoryReceipt: MemoryDispatchReceipt | undefined;"), source.indexOf("      if (!markDirectTurnDispatching"));
  expect(direct).toContain("filterDirectReplay(threadId,activeMessages,access,skipTranscript,replayOptions)");
  expect(direct).toMatch(/needsReplay=!resumeCursor \|\| revoked/);
  expect(direct).toContain("retainedSessionInvalid(threadId, instanceId, String(resumeCursor), offWhy)");
  expect(direct).toContain("MEMORY_SESSION_RESET_UNAVAILABLE");
});
