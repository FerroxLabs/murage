// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 lineage-cold, truthful reasons: a reply that is left out only because the allowance ran out was not deleted, changed or forgotten, and
// is never described as such. The check tells three things apart: withdrawn (something it used was deleted or changed), forgotten (the owner
// forgot the reply itself) and checking (earlier context is still being checked). A reply that is "checking" says so in the room line a member
// reads, under the reply for its owner, and in one note over the conversation; it is cleared as soon as a later check can prove the reply.
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { GROUP_CONTEXT_MESSAGES, ROOM_REPLY_CHECKING, ROOM_REPLY_FORGOTTEN, ROOM_REPLY_WITHHELD } from "../room-context.ts";
import { roomTranscriptWithoutMemory } from "../room-transcript.ts";
import type { Message } from "../store.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { chainStore } from "./schema.ts";
import { forgetKeptLineageForTest, replayExclusions } from "./replay-lineage.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const thread = "check-room", driver = "drv", session = "sess";
const here = dirname(fileURLToPath(import.meta.url));
const source = (reply: number) => `message:${thread}:r${reply}`;
beforeEach(() => { closeDatabase(); forgetKeptLineageForTest(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

/** A room of `n` replies, each resting on the one before it (receipt cites the previous reply as a source). */
function room(n: number): Message[] {
  setMemoryMode("active");
  reconcileMemoryRoster({ bots: [{ id: "b", threadId: thread }], groups: [] });
  const db = database(), scope = ensureScope("conversation", thread), write = chainStore(db);
  db.exec("BEGIN");
  const addSource = db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,'hash','text','bot:b','settled',NULL,'active')");
  const addMessage = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  const addReceipt = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,'[]',?,?,0,0,0,'delivered',9)");
  for (let index = 0; index < n; index++) { addSource.run(source(index), scope, thread, `r${index}`); addMessage.run(thread, `r${index}`, index, "bot", "text", `reply ${index}`, "{}"); }
  for (let index = 0; index < n; index++) addReceipt.run(`rc${index}`, thread, driver, session, JSON.stringify(index ? [{ id: source(index - 1), revision: 1 }] : []), JSON.stringify([`r${index}`]));
  let parent: string | null = null;
  const pointer = db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)");
  for (let index = 0; index < n; index++) { parent = write(parent, index, [`${thread}\u0000r${index}`]); pointer.run(thread, `r${index}`, parent); }
  db.prepare("INSERT OR IGNORE INTO memory_scope_bindings VALUES('memory-lineage-backfill-v3',?,'system','lineage-backfill',0,'granted',?)").run(scope, JSON.stringify({ done: true }));
  db.exec("COMMIT");
  closeDatabase(); forgetKeptLineageForTest(); database();
  return Array.from({ length: n }, (_, index) => ({ id: `r${index}`, at: 1_000_000 + index * 60_000, role: "bot", kind: "text", text: `reply ${index}`, from: { botId: "b", name: "Moss" } }) as unknown as Message);
}
const lineOf = (messages: readonly Message[], id: string) => messages.find(message => message.id === id)!.text ?? "";

it("a reply left out only because the allowance ran out is 'checking', reads as the checking line, and is not described as deleted, changed or forgotten", () => {
  const messages = room(60);
  const cold = roomTranscriptWithoutMemory(LineageAllowance.turn(5), thread, messages, true)!;
  expect(cold.withheld.size, "nothing could be proven in 5 nodes").toBeGreaterThan(0);
  expect(cold.forgotten.size).toBe(0);
  expect([...cold.checking].sort()).toEqual([...cold.withheld].sort());
  for (const id of cold.checking) {
    expect(lineOf(cold.messages, id)).toContain(`[${ROOM_REPLY_CHECKING}]`);
    expect(lineOf(cold.messages, id)).not.toContain("deleted or changed");
    expect(lineOf(cold.messages, id)).not.toContain("forget");
  }
  // a member who is not the owner's audience is shown no such line: the reply is just left out
  const other = roomTranscriptWithoutMemory(LineageAllowance.turn(5), thread, messages, false)!;
  expect(other.messages.length).toBeLessThan(messages.length);
  expect(other.checking.size).toBe(0);
});

it("once a later check has the room to prove the replies, the same replies are shown and none is 'checking'", () => {
  const messages = room(60);
  const starved = roomTranscriptWithoutMemory(LineageAllowance.turn(5), thread, messages, true)!;
  expect(starved.checking.size).toBeGreaterThan(0);
  const warm = roomTranscriptWithoutMemory(LineageAllowance.turn(1_000_000), thread, messages, true)!;
  expect(warm.withheld.size).toBe(0);
  expect(warm.checking.size).toBe(0);
  // a room turn shows the newest window (GROUP_CONTEXT_MESSAGES text lines); everything in it is proven and shown
  expect(warm.messages.map(message => message.text)).toEqual(messages.slice(-GROUP_CONTEXT_MESSAGES).map(message => message.text));
});

it("a reply that used something deleted or changed keeps its deleted/changed line, even when the allowance also ran short; one the owner forgot keeps the forgotten line", () => {
  const messages = room(30);
  // the source of r0 was deleted: r1 rests on it (its receipt cites r0's source), and so does everything above
  database().prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(source(0));
  forgetKeptLineageForTest();
  const withdrawn = roomTranscriptWithoutMemory(LineageAllowance.turn(1_000_000), thread, messages, true)!;
  expect(withdrawn.withheld.has("r1")).toBe(true);
  expect(withdrawn.checking.size, "proven withdrawn, not unproven").toBe(0);
  expect(lineOf(withdrawn.messages, "r1")).toContain(`[${ROOM_REPLY_WITHHELD}]`);
  expect(withdrawn.forgotten.has("r0"), "the reply whose own source was forgotten says so").toBe(true);
  expect(lineOf(withdrawn.messages, "r0")).toContain(`[${ROOM_REPLY_FORGOTTEN}]`);
  // the same history with too little room: the replies that cannot be proven are 'checking', the one the owner forgot stays forgotten
  forgetKeptLineageForTest();
  const short = roomTranscriptWithoutMemory(LineageAllowance.turn(3), thread, messages, true)!;
  expect(lineOf(short.messages, "r0")).toContain(`[${ROOM_REPLY_FORGOTTEN}]`);
  expect(short.checking.has("r0")).toBe(false);
  for (const id of short.checking) expect(lineOf(short.messages, id)).toContain(`[${ROOM_REPLY_CHECKING}]`);
});

it("replayExclusions reports the ids left out for lack of room apart from the ones it proved withdrawn", () => {
  const messages = room(20);
  database().prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(source(15));
  forgetKeptLineageForTest();
  const checking = new Set<string>();
  const ids = messages.map(message => ({ id: message.id, role: "bot" }));
  const full = replayExclusions(LineageAllowance.turn(1_000_000), thread, ids, null, { failClosed: true, checking });
  expect(full.size).toBeGreaterThan(0);
  expect(checking.size, "everything withheld here was proven withdrawn").toBe(0);
  forgetKeptLineageForTest();
  const starved = new Set<string>();
  const some = replayExclusions(LineageAllowance.turn(4), thread, ids, null, { failClosed: true, checking: starved });
  expect(some.size).toBeGreaterThan(0);
  expect(starved.size, "left out for lack of room").toBeGreaterThan(0);
  for (const id of starved) expect(some.has(id)).toBe(true);
});

it("the owner copy is exact and free of the words the owner should never read", () => {
  const notice = "Earlier context in this conversation is still being checked, so some older replies were left out for now.";
  const underReply = "Bots will see this reply once earlier memory is checked.";
  const memberLine = "Reply left out until earlier memory is checked";
  expect(ROOM_REPLY_CHECKING).toBe(memberLine);
  const groupView = readFileSync(join(here, "..", "..", "src", "components", "GroupView.tsx"), "utf8");
  expect(groupView).toContain(`"${underReply}"`);
  expect(groupView).toContain(notice);
  expect(groupView).toMatch(/m\.withheldFromBots === "checking" \? "Bots will see this reply once earlier memory is checked\."/);
  for (const text of [notice, underReply, memberLine]) {
    expect(text, text).not.toMatch(/—|–/);
    expect(text, text).not.toMatch(/database|validat|verif|integrity|repair|\bfix|corrupt|broken|\bsafe|unsafe/i);
  }
  // the server writes the note and the app reads it
  const index = readFileSync(join(here, "..", "index.ts"), "utf8");
  // "checking" is never stored: the owner's note holds final verdicts only (80e0b65ee)
  expect(index).toContain("if (transcript.withheld.has(shown.id) && transcript.checking.has(shown.id) && !transcript.forgotten.has(shown.id)) continue;");
  expect(index).not.toContain('"checking" as const');
  expect(readFileSync(join(here, "..", "store.ts"), "utf8")).toContain('withheldFromBots?: boolean | "forgotten" | "checking";');
  expect(readFileSync(join(here, "..", "..", "src", "state", "store.tsx"), "utf8")).toContain('withheldFromBots?: boolean | "forgotten" | "checking";');
});
