// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// GH #18 wave 1B: preservation evidence, not authorization for a clear-marks feature.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { denyLookup, fenceVerdict, memoryLookup, refsLookup, sessionLookup } from "./deny-read.ts";
import { createKeepAllRepairGate, judgeKeepAllCursors, keepAllUnwedged, ownerAudienceSessions, startKeepAllRepair, type RepairBot } from "./keepall-unwedge.ts";
import { AUDIENCE_COALESCED, DENY_RANGE_COALESCE, memoryRefKey, type LineageReader, type MemoryRef } from "./lineage-types.ts";
import { drainRevokeMarkerBounded } from "./memory-revocation.ts";
import { buildPrompt, promptPart, toolText } from "./prompt-parts.ts";
import { commitRevoke, inheritMarks } from "./revoke-commit.ts";
import { holdRevoke, markerWorkPending, writeRange } from "./revoke-marker.ts";
import { sessionKeyOf } from "./session-incarnation.ts";
import { CONTENT, MEMBER, OWNER, WritetimeFixture } from "./testing/writetime-fixture.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const readers = [CONTENT, OWNER, MEMBER];
const defaultBots: RepairBot[] = [{ id: "bot-a", tasks: [{ threadId: "T", resumeCursors: { driver: "native" }, resumeAudiences: { driver: "owner" } }] }];
const ownerDirect = (thread: string) => thread === "T";
const tables = ["memory_deny_line", "memory_deny_range", "memory_deny_memory", "memory_deny_session", "memory_deny", "memory_tombstones"] as const;
const snapshot = (fx: WritetimeFixture, names: readonly string[] = tables) => Object.fromEntries(names.map(table => [table,
  fx.db.prepare(`SELECT * FROM ${table}`).all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
]));
const line = (fx: WritetimeFixture, threadId: string, messageId: string, reader: LineageReader) => denyLookup(fx.db, { threadId, lines: [{ messageId, author: "generated" }] }, reader).get(messageId);
const memory = (fx: WritetimeFixture, ref: MemoryRef, reader: LineageReader) => memoryLookup(fx.db, [ref], reader).get(memoryRefKey(ref));
const session = (fx: WritetimeFixture, thread: string, native = "native", reader = CONTENT, incarnation?: number, instance = "driver") => sessionLookup(fx.db, sessionKeyOf(thread, instance, native, incarnation), reader);

function setup() {
  const fx = new WritetimeFixture().cert(true).footprint(1, ["s-room"]);
  const dir = mkdtempSync(join(tmpdir(), "gh18-boundary-"));
  cleanups.push(() => { fx.close(); removeTempDirSync(dir); });
  fx.sessionLineage("T", "driver", "native", 1, 20);
  // Positive control: every repair really removes an eligible audience-only mark.
  fx.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(900)").run();
  fx.denySession("T", "driver", "native", 900);
  return { fx, dir };
}

function drain(fx: WritetimeFixture) {
  for (let i = 0; i < 20 && markerWorkPending(fx.db); i++) drainRevokeMarkerBounded(fx.db, { rows: 4096, ms: 250 });
  expect(markerWorkPending(fx.db)).toBe(false);
}

async function repair(fx: WritetimeFixture, dir: string, bots = defaultBots) {
  const judge = vi.fn(() => {
    const result = judgeKeepAllCursors(bots, {
      ownerDirectThread: ownerDirect, liveThreads: new Set(), revoked: () => false,
      verdict: (thread, instance, native, reader) => sessionLookup(fx.db, sessionKeyOf(thread, instance, native), reader === "content" ? CONTENT : MEMBER),
    });
    return { cleared: result.clears.length, botsMoved: 0, skipped: 0, keptChecking: result.keptChecking, keptLive: result.keptLive };
  });
  const outcome = await startKeepAllRepair(fx.db, dir, createKeepAllRepairGate(false), {
    ownerSessions: () => ownerAudienceSessions(bots, ownerDirect),
    drain: db => drainRevokeMarkerBounded(db, { rows: 4096, ms: 250 }, { background: true }),
    markerPending: markerWorkPending, judgeAndClear: judge, flush: () => {}, log: () => {},
  });
  expect(fx.db.prepare("SELECT 1 FROM memory_deny_session WHERE thread_id='T' AND driver_instance='driver' AND native_session='native' AND revoke_id=900").get()).toBeUndefined();
  return { outcome, judge };
}

it("unattributable_marks_retained", async () => {
  const { fx, dir } = setup();
  // 41 has no job/root left. 42 has only an inherited root, not an original cause.
  fx.reply("T", "marked", 10).reply("T", "ranged", 15).reply("T", "inherited", 30)
    .message("T", "missing-lineage", "bot")
    .denyLine("T", 10, 41).denyRange("T", 11, 20, 41).denyLine("T", 30, 42)
    .record("legacy", 1, "s-room").denyMemory("record", "legacy", 1, 41)
    .denySession("T", "driver", "native", 41).job(42, 31, "done")
    .record("forgotten", 1, "s-room").tombstone("record", "forgotten", 1)
    .reply("deleted-thread", "deleted", 40).deny("thread", "deleted-thread");
  fx.db.prepare("UPDATE memory_revoke_jobs SET kind='inherit',root=?,phase='done' WHERE revoke_id=42").run(JSON.stringify({ kind: "inherit", cause: "inherit" }));
  expect(fx.db.prepare("SELECT 1 FROM memory_revoke_jobs WHERE revoke_id=41").get()).toBeUndefined();
  const before = snapshot(fx);
  before.memory_deny_session = before.memory_deny_session.filter(row => row.revoke_id !== 900);
  for (let pass = 0; pass < 2; pass++) {
    expect((await repair(fx, dir)).outcome).toBe(pass ? "already" : "repaired");
    expect(snapshot(fx)).toEqual(before);
    for (const reader of readers) {
      expect(line(fx, "T", "marked", reader)).toEqual({ state: "withheld", reason: "deny-line" });
      expect(line(fx, "T", "inherited", reader)).toEqual({ state: "withheld", reason: "deny-line" });
      expect(line(fx, "T", "ranged", reader)).toEqual({ state: "withheld", reason: "deny-range" });
      expect(line(fx, "T", "missing-lineage", reader)).toEqual({ state: "checking", reason: "no-lineage" });
      expect(memory(fx, { kind: "record", id: "legacy", version: 1 }, reader)).toEqual({ state: "withheld", reason: "deny-memory" });
      expect(memory(fx, { kind: "record", id: "forgotten", version: 1 }, reader)).toEqual({ state: "withheld", reason: "tombstone" });
      expect(line(fx, "deleted-thread", "deleted", reader)?.state).toBe("withheld");
      expect(session(fx, "T", "native", reader)).toEqual({ state: "withheld", reason: "deny-session" });
      expect(session(fx, "T", "unproven", reader)).toEqual({ state: "checking", reason: "no-lineage" });
    }
  }
});

it("coalesced_ranges_retained", async () => {
  const { fx, dir } = setup();
  fx.reply("T", "content-range", 10).reply("T", "audience-range", 110).reply("T", "clean", 300, { footprint: 1 });
  // Exercise the real coalescer: original revoke identities disappear in both classes.
  for (let i = 0; i < DENY_RANGE_COALESCE; i++) {
    const revoke = 100 + i, audience = i % 2 === 1;
    if (audience) fx.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(?)").run(revoke);
    writeRange(fx.db, revoke, "T", audience ? 100 : 1, audience ? 200 : 50, "legacy");
  }
  expect(fx.db.prepare("SELECT revoke_id,reason FROM memory_deny_range ORDER BY revoke_id").all()).toEqual([
    { revoke_id: AUDIENCE_COALESCED, reason: "coalesced-audience" }, { revoke_id: -1, reason: "coalesced" },
  ]);
  const before = snapshot(fx, ["memory_deny_range"]);
  expect((await repair(fx, dir)).outcome).toBe("repaired");
  expect(snapshot(fx, ["memory_deny_range"])).toEqual(before);
  for (const reader of readers) {
    expect(line(fx, "T", "content-range", reader)).toEqual({ state: "withheld", reason: "deny-range" });
    expect(line(fx, "T", "clean", reader)).toEqual({ state: "shown" });
  }
  expect(line(fx, "T", "audience-range", CONTENT)).toEqual({ state: "shown" });
  expect(line(fx, "T", "audience-range", MEMBER)).toEqual({ state: "withheld", reason: "deny-range" });
});

it("shared_descendants_stay_withheld", async () => {
  const { fx, dir } = setup();
  const parent: MemoryRef = { kind: "record", id: "shared-parent", version: 1, scopeId: "s-room" };
  fx.record(parent.id, 1, "s-room").denyMemory("record", parent.id, 1, 41);
  // Two bots/scopes and two versions share the same pruned-root parent.
  const descendants: MemoryRef[] = [
    { kind: "record", id: "bot-a-note", version: 1, scopeId: "s-bot" },
    { kind: "record", id: "bot-b-note", version: 1, scopeId: "s-other" },
    { kind: "record", id: "bot-b-note", version: 2, scopeId: "s-other" },
  ];
  for (const ref of descendants) {
    fx.record(ref.id, ref.version!, ref.scopeId!).derive(parent.id, 1, ref.id, ref.version!);
    inheritMarks(fx.db, { kind: "record", ref, lsn: 20 }, [{ kind: "memory", ref: parent }], [], true);
  }
  fx.reply("T", "carried", 30).reply("other-bot", "carried", 40);
  for (const [threadId, lsn] of [["T", 30], ["other-bot", 40]] as const) {
    inheritMarks(fx.db, { kind: "line", threadId, lsn }, [{ kind: "memory", ref: parent }]);
  }
  drain(fx);
  const before = snapshot(fx);
  before.memory_deny_session = before.memory_deny_session.filter(row => row.revoke_id !== 900);
  expect((await repair(fx, dir)).outcome).toBe("repaired");
  expect(snapshot(fx)).toEqual(before);
  for (const reader of readers) {
    for (const ref of [parent, ...descendants]) {
      expect(memory(fx, ref, reader)).toEqual({ state: "withheld", reason: "deny-memory" });
      const payload = toolText("GH18_REVOKED_SHARED_BYTES", [{ kind: "memory", ref }]);
      expect(refsLookup(fx.db, payload.lineageOf, reader).state).toBe("withheld");
      const prompt = buildPrompt(undefined, [promptPart(payload.text, payload.lineageOf)]);
      expect(prompt.text).toBe("GH18_REVOKED_SHARED_BYTES");
      expect(fenceVerdict(fx.db, prompt, reader).state).toBe("withheld");
    }
    for (const threadId of ["T", "other-bot"]) {
      expect(line(fx, threadId, "carried", reader)?.state).toBe("withheld");
      const replay = buildPrompt(undefined, [promptPart("GH18_REVOKED_REPLAY_BYTES", [{ kind: "line", threadId, messageId: "carried", replay: true }])]);
      expect(replay.text).toBe("GH18_REVOKED_REPLAY_BYTES");
      expect(fenceVerdict(fx.db, replay, reader).state).toBe("withheld");
    }
  }
});

it("pending_delete_not_cleared", async () => {
  const { fx, dir } = setup();
  fx.reply("deleted", "old", 10).reply("held", "dependent", 15, { footprint: 1 })
    .sessionLineage("held", "driver", "native", 1, 15).record("held-note", 1, "s-room");
  const revoke = commitRevoke(fx.db, { kind: "thread", threadId: "deleted", cause: "delete-conversation" }, { inline: false });
  holdRevoke(fx.db, revoke, "pending-delete");
  fx.db.prepare("INSERT INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) VALUES('memory-revocation:pending-delete','s-room','system','memory-revocation',0,'granted','{}')").run();
  // Put the real marker at its bookkeeping hold; no mock drain reports success.
  drainRevokeMarkerBounded(fx.db, { rows: 4096, ms: 250 });
  expect(fx.db.prepare("SELECT state,phase FROM memory_revoke_jobs WHERE revoke_id=?").get(revoke)).toEqual({ state: "active", phase: "hold" });
  const names = [...tables, "memory_deny_pending", "memory_deny_pending_scope", "memory_scope_bindings"];
  const before = snapshot(fx, names);
  before.memory_deny_session = before.memory_deny_session.filter(row => row.revoke_id !== 900);
  const { outcome, judge } = await repair(fx, dir);
  expect(outcome).toBe("cursors-deferred");
  expect(judge).not.toHaveBeenCalled();
  expect(keepAllUnwedged(fx.db, dir)).toBe(false);
  expect(snapshot(fx, names)).toEqual(before);
  expect(markerWorkPending(fx.db)).toBe(true);
  for (const reader of readers) {
    expect(line(fx, "deleted", "old", reader)?.state).toBe("withheld");
    expect(line(fx, "held", "dependent", reader)).toEqual({ state: "checking", reason: "pending" });
    expect(session(fx, "held", "native", reader)).toEqual({ state: "checking", reason: "pending" });
    expect(memory(fx, { kind: "record", id: "held-note", version: 1, scopeId: "s-room" }, reader)).toEqual({ state: "checking", reason: "pending" });
  }
});

it("audience_exception_requires_exact_owner_cursor", async () => {
  const { fx, dir } = setup();
  const bots: RepairBot[] = [{ id: "bot-a", tasks: [
    { threadId: "T", resumeCursors: { driver: "native", reused: "same-id", member: "member", mixed: "mixed", empty: null },
      resumeIncarnations: { reused: 2 }, resumeAudiences: { driver: "owner", reused: "owner|x2:partition", member: "person:alice", mixed: "owner" } },
    { threadId: "room", resumeCursors: { driver: "native" }, resumeAudiences: { driver: "owner" } },
  ] }];
  const cases = [
    ["T", "driver", "native", 1, true], ["T", "driver", "stale", 1, false],
    ["T", "wrong-driver", "native", 1, false], ["T", "reused", "same-id", 1, false],
    ["T", "reused", "same-id", 2, true], ["T", "reused", "same-id", 3, false],
    ["T", "member", "member", 1, false], ["T", "empty", "null", 1, false],
    ["room", "driver", "native", 1, false], ["T", "mixed", "mixed", 1, true],
  ] as const;
  for (const [thread, instance, native, incarnation] of cases) {
    const key = sessionKeyOf(thread, instance, native, incarnation);
    if (instance !== "driver" || thread !== "T" || native !== "native") {
      fx.sessionLineage(thread, instance, key.nativeSession, 1, 20).denySession(thread, instance, key.nativeSession, 900);
    }
    expect(sessionLookup(fx.db, key, MEMBER)).toEqual({ state: "withheld", reason: "deny-session" });
  }
  fx.denySession("T", "mixed", "mixed", 41);
  const before = snapshot(fx, ["memory_deny_session"]).memory_deny_session;
  expect((await repair(fx, dir, bots)).outcome).toBe("repaired");
  const eligible = new Set(cases.filter(row => row[4]).map(([thread, instance, native, incarnation]) => JSON.stringify(sessionKeyOf(thread, instance, native, incarnation))));
  expect(snapshot(fx, ["memory_deny_session"]).memory_deny_session).toEqual(before.filter(row => row.revoke_id !== 900 || !eligible.has(JSON.stringify(sessionKeyOf(String(row.thread_id), String(row.driver_instance), String(row.native_session))))));
  for (const [thread, instance, native, incarnation, removed] of cases) {
    const contentMark = instance === "mixed";
    expect(session(fx, thread, native, MEMBER, incarnation, instance)).toEqual(removed && !contentMark ? { state: "shown" } : { state: "withheld", reason: "deny-session" });
    expect(session(fx, thread, native, CONTENT, incarnation, instance)).toEqual(contentMark ? { state: "withheld", reason: "deny-session" } : { state: "shown" });
  }
});
