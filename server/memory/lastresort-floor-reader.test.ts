// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// LASTRESORT-MIN M2 (designs/LASTRESORT-AUDIENCE-1018-MINIMAL.md, Q2 items 6-9): the last-resort replay for a non-owner audience is
// prepared by the reader its send fence uses. A reply carrying an audience-only revoke mark (a receipt flipped by a roster or scope change)
// is dropped at prepare, before the early return for a thread with nothing memory-made; the floor only ever withholds more, and a lookup
// that cannot be read drops the line. No reader (every other turn): the result is what it was.
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { roomTranscriptWithoutMemory } from "../room-transcript.ts";
import type { Message } from "../store.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { denyLookup } from "./deny-read.ts";
import type { LineageReader } from "./lineage-types.ts";
import { MEMBER, WritetimeFixture } from "./testing/writetime-fixture.ts";

const AUDIENCE_REVOKE = 7;
const READER: LineageReader = MEMBER;
const msg = (id: string, role: "user" | "bot", at: number): Message => ({ id, role, kind: "text", text: `${id} words`, at } as Message);
const LINES = [msg("o1", "user", 1), msg("g1", "bot", 2), msg("g2", "bot", 3)];
const floor = (reader?: LineageReader, lines: readonly Message[] = LINES, unproven = false) =>
  roomTranscriptWithoutMemory(LineageAllowance.tool(1_000_000_000), "D", lines, false, undefined, unproven, { whole: true, reader });
const ids = (result: { messages: Message[] } | undefined, lines: readonly Message[] = LINES) => (result?.messages ?? lines).map(m => m.id);

let f: WritetimeFixture;
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); f = new WritetimeFixture(database()); });
afterEach(() => { closeDatabase(); });

/** A channel person's thread: g1 and g2 were made with memory shared to the person; an audience-only mark then covers g1. */
function memoryThread(): void {
  f.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(?)").run(AUDIENCE_REVOKE);
  f.footprint(1, ["s-room"]);
  f.owner("D", "o1", 1).reply("D", "g1", 2, { memLsn: 5, footprint: 1 }).reply("D", "g2", 3, { memLsn: 5, footprint: 1 }).meta("deny_generation", 3);
  f.denyLine("D", 2, AUDIENCE_REVOKE).meta("deny_generation", 4);
}
/** Nothing memory-made in the thread (no footprint, no memory lsn), the same audience-only mark on g1. */
function plainThread(): void {
  f.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(?)").run(AUDIENCE_REVOKE);
  f.owner("D", "o1", 1).reply("D", "g1", 2).reply("D", "g2", 3).meta("deny_generation", 3);
  f.denyLine("D", 2, AUDIENCE_REVOKE).meta("deny_generation", 4);
}

it("(a) a reply carrying an audience-only mark is dropped for a non-owner reader; without the reader it is kept (the leak shape)", () => {
  memoryThread();
  expect(ids(floor())).toContain("g1");
  expect(ids(floor(READER))).toEqual(["o1", "g2"]);
});

it("(b) a thread with nothing memory-made still gets an explicit floor for a reader, never undefined", () => {
  plainThread();
  expect(floor()).toBeUndefined();
  const result = floor(READER);
  expect(result).toBeDefined();
  expect(ids(result)).toEqual(["o1", "g2"]);
  expect(result!.withheld.size).toBe(0);
  expect(result!.checked).toEqual(new Set(["o1", "g1", "g2"]));
});

it("(c) a lookup that cannot be read drops the line (fails closed)", () => {
  memoryThread();
  f.db.exec("DROP TABLE memory_deny_line");
  const dropped = ids(floor(READER));
  expect(dropped).not.toContain("g1");
  expect(dropped).not.toContain("g2");
});

it("(d) no reader: the result is exactly today's (undefined for a thread with nothing memory-made, the line kept where only the audience mark is set)", () => {
  plainThread();
  expect(floor()).toBeUndefined();
  expect(floor({ audience: null })).toBeUndefined(); // an owner (content) reader is not an audience reader: the floor ignores it
});

it("(d2) no reader, a memory-held thread: the audience mark drops nothing and withholds nothing", () => {
  memoryThread();
  expect(ids(floor())).toEqual(["o1", "g1", "g2"]);
  expect(floor()!.withheld.size).toBe(0);
});

it("(e) additive: a reply the owner forgot stays dropped for a reader that would show it (the content rule is not replaced)", () => {
  memoryThread();
  f.db.prepare("DELETE FROM memory_deny_line").run(); // g1 and g2 are audience-shown now
  f.tombstone("source", "message:D:g1");
  expect(ids(floor(READER))).toEqual(["o1", "g2"]);
  expect(ids(floor())).toEqual(["o1", "g2"]); // and without a reader too: today's behaviour, unchanged
});

it("(f) additive: words nobody proved are the owner's (unproven) plus a reader and NO marks: the memory-made replies stay dropped (a replace of the union would lose them)", () => {
  f.footprint(1, ["s-room"]);
  f.owner("D", "o1", 1).reply("D", "g1", 2, { memLsn: 5, footprint: 1 }).reply("D", "g2", 3, { memLsn: 5, footprint: 1 }).meta("deny_generation", 3);
  expect(ids(floor(undefined, LINES, true))).toEqual(["o1"]); // control: today's unproven rule alone
  expect(ids(floor(READER, LINES, true))).toEqual(["o1"]);
  expect(ids(floor(READER, LINES, false))).toEqual(["o1", "g1", "g2"]); // control: no unproven, no marks, nothing to drop
});

// Astra F2: the rows above build their own refs and readers, so they cannot see the production call sites. These read index.ts (as
// direct-replay-without-memory.test.ts does) and pin the owner-only tag at both producers and the reader at all three floors.
const index = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
it("(g) wiring: direct and room minimal prompts use only fresh human input, with stored replay removed", () => {
  expect(index).toContain('let directPrompt = memoryLastResort ? messageOnlyPrompt(turnLineage,');
  expect(index).toContain('let roomPrompt = roomLastResort ? messageOnlyPrompt(roomTurnLineage,');
  expect(index).not.toContain('ownReplayRefs(');
  expect(index).toContain('userMessage.role === "user" ? userMessage.text : undefined');
  expect(index).toContain('roomHumanInput.text : undefined');
  expect(index).toContain('transcript = [];');
  expect(index).toContain('memoryContext:memoryLastResort || selectiveDropped ? undefined');
  expect(index).toContain('memoryContext:roomLastResort || roomSelectiveDropped ? undefined');
});
it("(h) wiring: a non-owner last resort passes its fence reader to all three floors, an owner one passes none", () => {
  expect(index).toContain('const lastResortReader: LineageReader | undefined = memoryLastResort && !directOwnerAudience ? { audience: { owner: false, scopeIds: lineageReaderScopes({ scopeIds: [], humanPrincipal }) } } : undefined;');
  expect(index.match(/\{ whole: true, reader: lastResortReader \}/g)?.length).toBe(2);
  expect(index).toContain("reader: memoryLastResort && !roomOwnerAudience ? { audience: { owner: false, scopeIds: [] } } : undefined");
  expect(index.match(/roomTranscriptWithoutMemory\(/g)?.length).toBe(3);
});

it("(i) additive (Astra F1): a copy whose original the owner forgot is shown by the audience lookup yet dropped by the content path; the floor still drops it", () => {
  f.footprint(1, ["s-room"]);
  f.owner("D", "o1", 1).reply("D", "g1", 2, { memLsn: 5, footprint: 1 }).reply("D", "g2", 3, { memLsn: 5, footprint: 1 }).owner("U", "x", 9).meta("deny_generation", 3);
  const lines = [LINES[0], { ...LINES[1], copyOf: { threadId: "U", messageIds: ["x"] } } as Message, LINES[2]];
  f.tombstone("source", "message:U:x"); // the owner forgot the original
  // premise: the audience lookup on D shows g1 (the forgotten original is on another thread, no mark on D)
  expect(denyLookup(f.db, { threadId: "D", lines: [{ messageId: "g1", author: "generated" as const }] }, READER).get("g1")?.state).toBe("shown");
  expect(ids(floor(READER, lines), lines)).toEqual(["o1", "g2"]);
  expect(ids(floor(undefined, lines), lines)).toEqual(["o1", "g2"]); // today's behaviour, unchanged
});
