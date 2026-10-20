// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// LINEAGE-DESIGN-S6 read paths (Astra's early review of the combined S6 build): one test per finding, each failing on 3d6e21d67.
//  1. a project page a bot reads passes every row through the door: a forgotten owner line is never a stand-in that keeps its words;
//  2. a non-owner search hit passes the door (copy ancestry, classification of what a copy stands on) before any snippet is cut;
//  3. an anchor the check cannot read, or a summary citation in none of the project's threads, is not admissible (fail closed);
//  4. the partition check and the summary anchor check seek by the messages primary key, in batches, whatever the history.
import { mkdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { setExecutionStore } from "./execution-audience.ts";
import { appendMessage, closeMessageDb, searchMessages } from "./message-db.ts";
import { setMemoryCaptureRoster } from "./memory/capture-scope.ts";
import { memoryLookup } from "./memory/deny-read.ts";
import { memoryRefKey, type MemoryRef } from "./memory/lineage-types.ts";
import { ensureScope, reconcileMemoryRoster, type MemoryRoster } from "./memory/policy.ts";
import { setMemoryMode } from "./memory/repository.ts";
import * as anchorModule from "./murage-anchor.ts";
import { murageAnchor } from "./murage-anchor.ts";
import { partitionSourcesAllowed } from "./partition-sources.ts";
import { projectSummaryLayer } from "./project-layers.ts";
import { readProjectMessages } from "./project-memory-tools.ts";
import { channelToProjectRows } from "./project-settings.ts";
import type { Message, Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const NOW = 1_790_000_000_000;
type Roster = MemoryRoster & { bots: Array<MemoryRoster["bots"][number] & { name: string }> };
let roster: Roster;
let n = 0;
const heads = new Map<string, string>();

beforeEach(() => {
  closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  heads.clear();
  roster = {
    bots: [
      { id: "dax", name: "Dax", threadId: "dax-direct", section: "Sales", tasks: [{ threadId: "dax-desk", channelProjectDesk: { groupId: "launch" } }] },
      { id: "finch", name: "Finch", threadId: "finch-direct", section: "Ops" },
    ],
    groups: [{ id: "launch", threadId: "launch-chat", memberIds: ["dax", "finch"], channelProject: { goal: "Launch" } }],
  };
  setExecutionStore({ bot: (id: string) => roster.bots.find(bot => bot.id === id), bots: roster.bots, groups: roster.groups } as unknown as Store);
  setMemoryCaptureRoster(() => roster);
  setMemoryMode("active");
  reconcileMemoryRoster(roster);
  channelToProjectRows(database(), { groupId: "launch", bulletin: "", leadBotId: "finch", now: NOW });
});
afterEach(() => { setExecutionStore(undefined as never); closeMessageDb(); closeDatabase(); });

function say(threadId: string, text: string, extra: Partial<Message> = {}): Message {
  const message = { id: `r${++n}`, role: "bot", kind: "text", text, at: NOW + n, from: { botId: "finch", name: "Finch", color: "blue" }, ...(heads.has(threadId) ? { parentId: heads.get(threadId) } : {}), ...extra } as Message;
  heads.set(threadId, message.id);
  appendMessage(threadId, message);
  return message;
}

describe("finding 1: the project page has no stand-in bypass", () => {
  it("a forgotten owner line reaches a reading bot only as its withheld line, never its words", () => {
    say("launch-chat", "plain reply");
    say("launch-chat", "OWNER_FORGOTTEN_CANARY", { role: "user", from: undefined, withheldFromBots: "forgotten" } as Partial<Message>);
    const result = readProjectMessages(database(), roster, "launch", {}, { botId: "dax", threadId: "dax-desk" });
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.body)).not.toContain("OWNER_FORGOTTEN_CANARY");
    expect(JSON.stringify(result.body)).toContain("plain reply");
  });
});

describe("finding 2: a non-owner search hit passes the door", () => {
  it("a copy whose original is gone, or is Murage-voice, gives no snippet to a non-owner; the owner still finds both", () => {
    say("launch-chat", "LOST_COPY_CANARY");
    const lost = heads.get("launch-chat")!;
    database().prepare("UPDATE messages SET json=json_set(json,'$.copyOf',json(?)) WHERE thread_id='launch-chat' AND id=?").run(JSON.stringify({ threadId: "dax-direct", messageIds: ["absent"] }), lost);
    const line = say("dax-direct", "status words", { murageLine: true } as Partial<Message>);
    say("launch-chat", "VOICE_COPY_CANARY");
    const voiced = heads.get("launch-chat")!;
    database().prepare("UPDATE messages SET json=json_set(json,'$.copyOf',json(?)) WHERE thread_id='launch-chat' AND id=?").run(JSON.stringify({ threadId: "dax-direct", messageIds: [line.id] }), voiced);
    say("launch-chat", "PLAIN_CANARY words");
    expect(searchMessages("LOST_COPY_CANARY", 40, undefined, {})).toEqual([]);
    expect(searchMessages("VOICE_COPY_CANARY", 40, undefined, {})).toEqual([]);
    expect(searchMessages("PLAIN_CANARY", 40, undefined, {}).map(hit => hit.messageId)).toHaveLength(1);
    expect(searchMessages("LOST_COPY_CANARY", 40, undefined, { owner: true })).toHaveLength(1);
    expect(searchMessages("VOICE_COPY_CANARY", 40, undefined, { owner: true })).toHaveLength(1);
  });
  it("a stored row the search filter hid before (murageLine 1, behind a duplicate kind) or reads as Murage-voice now (murage 0) stays out of a non-owner search", () => {
    const rows: Array<[string, string]> = [
      ["LINE_ONE_CANARY", "{\"murageLine\":1,\"kind\":\"text\",\"kind\":\"routine.run\"}"],
      ["MURAGE_ZERO_CANARY", "{\"murage\":0}"],
    ];
    for (const [canary, json] of rows) {
      const message = say("launch-chat", `${canary} words`);
      database().prepare("UPDATE messages SET json=? WHERE thread_id='launch-chat' AND id=?").run(json.replace(/^\{/, `{"id":"${message.id}","role":"bot","text":"${canary} words","at":${message.at},`), message.id);
      expect(searchMessages(canary, 40, undefined, {}), canary).toEqual([]);
    }
  });
});

describe("finding 3: an unknown anchor is not admissible", () => {
  it("a missing row, a row that is not a stored message object and a message id without its thread read as withheld; no message id is no anchor", () => {
    const plain = say("t", "plain");
    const db = database();
    expect(murageAnchor(db, "t", plain.id)).toBe(false);
    expect(murageAnchor(db, "t", "gone")).toBe(true);
    expect(murageAnchor(db, null, plain.id)).toBe(true);
    expect(murageAnchor(db, "t", null)).toBe(false);
    const broken = say("t", "broken");
    db.prepare("UPDATE messages SET json='[1]' WHERE thread_id='t' AND id=?").run(broken.id);
    expect(murageAnchor(db, "t", broken.id)).toBe(true);
  });
  it("a record whose evidence cites a source with a missing anchor row, an unparseable anchor or a message id without its thread reads as withheld", () => {
    const plain = say("launch-chat", "plain");
    const broken = say("launch-chat", "broken");
    const db = database(), scope = ensureScope("conversation", "launch-chat");
    // JSON5 text: the messages triggers read it, json_valid and JSON.parse both refuse it
    db.prepare("UPDATE messages SET json='{role:1}' WHERE thread_id='launch-chat' AND id=?").run(broken.id);
    const source = db.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,turn_id,revision,content_hash,kind,speaker,outcome,branch_id,state) VALUES(?,?,?,?,NULL,1,'hash','text','bot:finch','settled',NULL,'active')");
    const sourceVersion = db.prepare("INSERT INTO memory_source_versions(source_id,revision,content_hash,payload,created_at) VALUES(?,1,'hash','{}',1)");
    const record = db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,valid_to,supersedes_id,created_at) VALUES(?,1,?,'fact',?,'a','active',0,1,NULL,NULL,1)");
    const evidence = db.prepare("INSERT INTO memory_evidence(record_id,record_version,source_id,source_revision,start_byte,end_byte) VALUES(?,1,?,1,0,1)");
    for (const [id, threadId, messageId] of [["plain", "launch-chat", plain.id], ["missing", "launch-chat", "never-written"], ["invalid", "launch-chat", broken.id], ["threadless", null, plain.id]] as const) {
      source.run(`s-${id}`, scope, threadId, messageId); sourceVersion.run(`s-${id}`);
      record.run(`r-${id}`, scope, `text ${id}`); evidence.run(`r-${id}`, `s-${id}`);
    }
    const verdict = (ref: MemoryRef) => memoryLookup(db, [ref], { audience: null }).get(memoryRefKey(ref));
    expect(verdict({ kind: "record", id: "r-plain", version: 1 })).toEqual({ state: "shown" });
    for (const id of ["missing", "invalid", "threadless"]) {
      expect(verdict({ kind: "source", id: `s-${id}` }), `source ${id}`).toEqual({ state: "withheld", reason: "murage-anchor" });
      expect(verdict({ kind: "record", id: `r-${id}`, version: 1 }), `record ${id}`).toEqual({ state: "withheld", reason: "murage-anchor" });
    }
  });
  it("anchor parity: one table of anchors gives the same verdict on the source path (murageAnchor) and the record walk, which judges each cited anchor with murageAnchor", () => {
    const db = database(), scope = ensureScope("conversation", "launch-chat");
    const source = db.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,turn_id,revision,content_hash,kind,speaker,outcome,branch_id,state) VALUES(?,?,?,?,NULL,1,'hash','text','bot:finch','settled',NULL,'active')");
    const sourceVersion = db.prepare("INSERT INTO memory_source_versions(source_id,revision,content_hash,payload,created_at) VALUES(?,1,'hash','{}',1)");
    const record = db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,valid_to,supersedes_id,created_at) VALUES(?,1,?,'fact',?,'a','active',0,1,NULL,NULL,1)");
    const evidence = db.prepare("INSERT INTO memory_evidence(record_id,record_version,source_id,source_revision,start_byte,end_byte) VALUES(?,1,?,1,0,1)");
    // [case, stored JSON (undefined: the row as written; "missing": no row), anchor thread, whether the anchor is withheld]
    const table: Array<[string, string | undefined, "thread" | "none" | "empty-thread" | "no-id" | "empty-id", boolean]> = [
      ["written plain", undefined, "thread", false],
      ["{}", "{}", "thread", false], ["[1]", "[1]", "thread", true], ["null", "null", "thread", true], ["42", "42", "thread", true],
      ["string", "\"words\"", "thread", true], ["JSON5", "{role:1}", "thread", true],
      ["murage 0", "{\"murage\":0}", "thread", true], ["murage empty", "{\"murage\":\"\"}", "thread", true], ["murage false", "{\"murage\":false}", "thread", false],
      ["murage null", "{\"murage\":null}", "thread", false], ["murage true", "{\"murage\":true}", "thread", true],
      ["murageLine 1", "{\"murageLine\":1}", "thread", false], ["murageLine true", "{\"murageLine\":true}", "thread", true],
      ["actorKind murage", "{\"actorKind\":\"murage\"}", "thread", true], ["kind routine.run", "{\"kind\":\"routine.run\"}", "thread", true],
      ["kind number", "{\"kind\":1}", "thread", false], ["missing row", "missing", "thread", true],
      ["id without its thread", undefined, "none", true], ["id with an empty thread", undefined, "empty-thread", true],
      ["no message id", undefined, "no-id", false], ["empty message id", undefined, "empty-id", false],
      ["duplicate murage key", "{\"murage\":false,\"murage\":true}", "thread", true], ["trailing NUL", "{}\u0000", "thread", true],
    ];
    const rows = table.map(([name, json, thread, withheld], i) => {
      const message = say("launch-chat", `case ${i}`);
      if (json !== undefined && json !== "missing") db.prepare("UPDATE messages SET json=? WHERE thread_id='launch-chat' AND id=?").run(json, message.id);
      const threadId = thread === "none" ? null : thread === "empty-thread" ? "" : "launch-chat";
      const messageId = thread === "no-id" ? null : thread === "empty-id" ? "" : json === "missing" ? `never-written-${i}` : message.id;
      source.run(`s-p${i}`, scope, threadId, messageId); sourceVersion.run(`s-p${i}`);
      record.run(`r-p${i}`, scope, `text ${i}`); evidence.run(`r-p${i}`, `s-p${i}`);
      return { name, withheld, threadId, messageId, i };
    });
    const anchored = { state: "withheld", reason: "murage-anchor" }, shown = { state: "shown" };
    for (const row of rows) {
      const ref: MemoryRef = { kind: "record", id: `r-p${row.i}`, version: 1 };
      expect(murageAnchor(db, row.threadId, row.messageId), `source path: ${row.name}`).toBe(row.withheld);
      expect(memoryLookup(db, [ref], { audience: null }).get(memoryRefKey(ref)), `record walk: ${row.name}`).toEqual(row.withheld ? anchored : shown);
    }
  });
  it("a project summary whose cited message is in none of the project's threads is not shown", () => {
    const outside = say("finch-direct", "outside words");
    const inside = say("launch-chat", "inside words");
    const view = { groupId: "launch", botId: "dax", names: new Map<string, string>(), threads: new Set(["launch-chat", "dax-desk"]) };
    const write = (text: string, ids: string[], version: number) => database().prepare("INSERT INTO project_summaries(group_id,version,text,source_message_ids,made_by,at,stale) VALUES('launch',?,?,?,'finch',?,0)").run(version, text, JSON.stringify(ids), NOW + version);
    write("SUMMARY_INSIDE_CANARY", [inside.id], 1);
    expect(projectSummaryLayer(database(), view, true)).toContain("SUMMARY_INSIDE_CANARY");
    write("SUMMARY_OUTSIDE_CANARY", [inside.id, outside.id], 2);
    expect(projectSummaryLayer(database(), view, true)).not.toContain("SUMMARY_OUTSIDE_CANARY");
    write("SUMMARY_GONE_CANARY", ["never-written"], 3);
    expect(projectSummaryLayer(database(), view, true)).not.toContain("SUMMARY_GONE_CANARY");
  });
});

/** The statements a check prepares, on a database whose every other member is the real one. */
function recording(db: DatabaseSync): { db: DatabaseSync; sql: string[] } {
  const sql: string[] = [];
  const proxy = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (query: string) => { sql.push(query); return target.prepare(query); };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy, sql };
}
/** Every plan line of the statements that read `messages`; a scan of it (SCAN m, SCAN messages, with or without a covering index) is the
 * history-dependent cost the check must not have. */
function messagePlans(db: DatabaseSync, sql: readonly string[]): string[] {
  return sql.filter(query => /\bmessages\b(?!_)/.test(query)).flatMap(query =>
    (db.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as Array<{ detail: string }>).map(row => row.detail));
}

describe("finding 4: the work follows the citations, never the history", () => {
  it("the partition check and the summary anchor check seek the messages primary key in batches, and never scan", () => {
    const bot = { id: "pb", name: "Pb", threadId: "pb-home", partitionedAt: 1, tasks: [{ threadId: "pb-task" }] };
    roster.bots.push(bot as never);
    for (let i = 0; i < 300; i += 1) say(i % 2 ? "pb-home" : "elsewhere", `history ${i}`);
    const root = say("pb-task", "root");
    const middle = say("pb-task", "middle", { copyOf: { threadId: "pb-task", messageIds: [root.id] } } as Partial<Message>);
    const copy = say("pb-home", "copy", { copyOf: { threadId: "pb-task", messageIds: [middle.id] } } as Partial<Message>);
    const watched = recording(database());
    expect(partitionSourcesAllowed(watched.db, bot.id, "pb-home", [copy.id])).toBe(true);
    // one statement for the citation, one per copy level: never one per id, never more as the history grows
    expect(watched.sql.filter(query => /\bmessages\b(?!_)/.test(query)).length).toBeLessThanOrEqual(3);
    const plans = messagePlans(database(), watched.sql);
    expect(plans.some(detail => /SEARCH m USING (INDEX|PRIMARY KEY|COVERING INDEX) sqlite_autoindex_messages_1 \(thread_id=\? AND id=\?\)/.test(detail))).toBe(true);
    expect(plans.filter(detail => /^SCAN (m|messages)\b/.test(detail))).toEqual([]);
    // a citation the check cannot place in the threads it was told of is not established, and no other thread is read for it
    const outside = say("elsewhere", "outside");
    const strict = recording(database());
    expect(partitionSourcesAllowed(strict.db, bot.id, "pb-home", [outside.id], { threads: ["pb-task"], only: true })).toBe(false);
    expect(messagePlans(database(), strict.sql).filter(detail => /^SCAN (m|messages)\b/.test(detail))).toEqual([]);
    // the summary's anchors: citations x threads in one statement, by primary key
    const anchors = recording(database());
    expect(typeof anchorModule.bareAnchorsWithheld).toBe("function");
    expect(anchorModule.bareAnchorsWithheld(anchors.db, ["pb-task", "pb-home"], [root.id, copy.id])).toBe(false);
    expect(anchors.sql.length).toBe(1);
    expect(messagePlans(database(), anchors.sql).filter(detail => /^SCAN (m|messages)\b/.test(detail))).toEqual([]);
  });
});
