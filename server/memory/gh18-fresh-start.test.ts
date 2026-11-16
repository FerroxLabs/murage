// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it } from "vitest";
import { sessionAudienceChanged } from "../session-audience.ts";
import { applyFreshStartRows, planFreshStart, type FreshStartPlan } from "./gh18-fresh-start.ts";
import type { RepairBot } from "./keepall-unwedge.ts";
import { denyLookup, memoryLookup, sessionLookup } from "./deny-read.ts";
import { AUDIENCE_COALESCED, memoryRefKey, type MemoryRef } from "./lineage-types.ts";
import { sessionKeyOf } from "./session-incarnation.ts";
import { CONTENT, MEMBER, OWNER, WritetimeFixture } from "./testing/writetime-fixture.ts";

const fixtures: WritetimeFixture[] = [];
afterEach(() => { for (const fx of fixtures.splice(0)) fx.close(); });
const deps = {
  ownerDirectThread: (id: string) => id !== "room",
  liveThreads: new Set<string>(),
  pendingDeletion: (_id: string) => false,
};
const bot: RepairBot = { id: "bot-a", tasks: [{ threadId: "T", resumeCursors: { driver: "native" } }] };
function setup() {
  const fx = new WritetimeFixture().cert(true).footprint(1, ["s-room"]);
  fixtures.push(fx);
  fx.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(900),(901),(?)").run(AUDIENCE_COALESCED);
  fx.sessionLineage("T", "driver", "native", 1, 20).denySession("T", "driver", "native", 900);
  return fx;
}
function snapshot(fx: WritetimeFixture) {
  const tables = fx.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'memory_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [String(name),
    fx.db.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`).all()
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ]));
}
function apply(fx: WritetimeFixture, plan: FreshStartPlan) {
  fx.db.exec("BEGIN IMMEDIATE");
  try { const count = applyFreshStartRows(fx.db, plan); fx.db.exec("COMMIT"); return count; }
  catch (error) { fx.db.exec("ROLLBACK"); throw error; }
}
function seedExclusions(fx: WritetimeFixture) {
  fx.reply("T", "line", 10).reply("T", "range", 15).reply("T", "audience-range", 110)
    .reply("T", "clean", 300, { footprint: 1 }).message("T", "no-lineage", "bot")
    .denyLine("T", 10, 41).denyLine("T", 10, 900).denyRange("T", 11, 20, -1)
    .denyRange("T", 100, 200, AUDIENCE_COALESCED)
    .record("legacy", 1, "s-room").record("legacy", 2, "s-room")
    .denyMemory("record", "legacy", 1, 41).denyMemory("record", "legacy", 2, 900)
    .record("forgotten", 1, "s-room").tombstone("record", "forgotten", 1)
    .record("shared-child", 1, "s-other").derive("legacy", 1, "shared-child", 1)
    .denyMemory("record", "shared-child", 1, 42)
    .reply("deleted", "old", 40).deny("thread", "deleted")
    .pending("held", 10, 43).pendingScope("s-project", 10, 43).job(43, 40)
    .job(42, 40, "done").receipt("revoked", "elsewhere", "driver", "native", { state: "revoked" });
  fx.db.prepare("UPDATE memory_revoke_jobs SET kind='inherit',root='{}',phase='done' WHERE revoke_id=42").run();
  fx.db.prepare("INSERT INTO memory_revoke_frontier VALUES(43,1,'{}')").run();
  fx.db.prepare("INSERT INTO memory_revoke_reached VALUES(43,'held',10)").run();
  fx.db.prepare("INSERT INTO memory_session_incarnation VALUES('T','driver','native',1)").run();
}

it("fresh_start_clears_exactly_p1", () => {
  const fx = setup();
  seedExclusions(fx);
  const selected: RepairBot = { id: "bot-a", tasks: [
    { threadId: "T", resumeCursors: { driver: "native", reused: "same", member: "member", mixed: "mixed", empty: null, absent: undefined },
      resumeIncarnations: { reused: 2 }, resumeAudiences: { reused: "owner|x2:partition", member: "person:alice", mixed: "owner" } },
    { threadId: "room", resumeCursors: { driver: "native" } },
  ] };
  const eligible = [sessionKeyOf("T", "driver", "native"), sessionKeyOf("T", "reused", "same", 2), sessionKeyOf("T", "mixed", "mixed")];
  const excluded = [sessionKeyOf("T", "driver", "stale"), sessionKeyOf("T", "wrong", "native"),
    sessionKeyOf("T", "reused", "same", 1), sessionKeyOf("T", "reused", "same", 3),
    sessionKeyOf("T", "member", "member"), sessionKeyOf("T", "empty", "null"),
    sessionKeyOf("room", "driver", "native"), sessionKeyOf("other-bot", "driver", "native")];
  for (const key of [...eligible.slice(1), ...excluded]) fx.sessionLineage(key.threadId, key.driverInstance, key.nativeSession, 1, 20)
    .denySession(key.threadId, key.driverInstance, key.nativeSession, 900);
  fx.denySession("T", "driver", "native", 901).denySession("T", "mixed", "mixed", 41);
  const before = snapshot(fx), storedBot = structuredClone(selected);
  const plan = planFreshStart(fx.db, selected, deps);
  expect(plan.blocked).toBeNull();
  // One entry per deny row (two audience revokes can mark the same key).
  expect(plan.sessionRows).toHaveLength(4);
  expect(plan.cursorClears).toHaveLength(5); // includes the member and room cursors
  expect(snapshot(fx)).toEqual(before); // preview is read-only
  expect(selected).toEqual(storedBot);
  expect(apply(fx, plan)).toBe(4);
  const expected = { ...before, memory_deny_session: before.memory_deny_session.filter(row =>
    !([900, 901].includes(Number(row.revoke_id)) && eligible.some(key => key.threadId === row.thread_id && key.driverInstance === row.driver_instance && key.nativeSession === row.native_session))) };
  expect(snapshot(fx)).toEqual(expected); // every other table, including epochs, is identical
  const retained = expected.memory_deny_session.filter(row => ["T", "room"].includes(String(row.thread_id))).length
    + before.memory_deny_line.length + before.memory_deny_range.length;
  expect(plan.retainedBlocks).toBe(retained);
  expect(plan.retainedCapped).toBe(false);
  expect(apply(fx, plan)).toBe(0);
  expect(selected).toEqual(storedBot); // S2 applies and durably flushes recorded cursor clears
});

it("fresh_start_reader_projection_unchanged", () => {
  const fx = setup();
  seedExclusions(fx);
  fx.sessionLineage("T", "member", "member-session", 1, 20).denySession("T", "member", "member-session", 900);
  const selected: RepairBot = { id: "bot-a", tasks: [{ threadId: "T", resumeCursors: { driver: "native", member: "member-session" }, resumeAudiences: { member: "person:alice" } }] };
  const refs: MemoryRef[] = [
    { kind: "record", id: "legacy", version: 1 }, { kind: "record", id: "legacy", version: 2 },
    { kind: "record", id: "forgotten", version: 1 }, { kind: "record", id: "shared-child", version: 1 },
  ];
  const keys = [sessionKeyOf("T", "driver", "native"), sessionKeyOf("T", "member", "member-session"), sessionKeyOf("T", "driver", "missing")];
  const projection = () => [CONTENT, OWNER, MEMBER].map(reader => ({
    lines: ["line", "range", "audience-range", "clean", "no-lineage"].map(messageId =>
      denyLookup(fx.db, { threadId: "T", lines: [{ messageId, author: "generated" }] }, reader).get(messageId)),
    records: refs.map(ref => memoryLookup(fx.db, [ref], reader).get(memoryRefKey(ref))),
    // Review amendment: compare all content sessions and only reachable audience sessions.
    sessions: keys.filter((_, i) => reader === CONTENT || i !== 0).map(key => sessionLookup(fx.db, key, reader)),
  }));
  const before = projection();
  expect(before[0].lines[0]?.state).toBe("withheld");
  expect(before[0].lines[3]?.state).toBe("shown");
  expect(sessionLookup(fx.db, keys[0], MEMBER)).toEqual({ state: "withheld", reason: "deny-session" });
  const plan = planFreshStart(fx.db, selected, deps);
  expect(apply(fx, plan)).toBe(1);
  expect(projection()).toEqual(before);
  // Preserve the direct lookup counterexample, with no extra deny row to mask it.
  for (const reader of [OWNER, MEMBER]) expect(sessionLookup(fx.db, keys[0], reader)).toEqual({ state: "shown" });
  // The real dispatch audience selector rejects every owner-cursor form for non-owner turns.
  // These are the function and fingerprints index.ts uses before any resume.
  for (const recorded of [undefined, "owner", "owner|x2:0:home:general:hash", "owner|x2:partition"]) {
    for (const current of ["person:alice", "person:alice|x2:0:home:general:hash", "owner,chain-not-owner", "unproven,owner"]) {
      expect(sessionAudienceChanged(recorded, true, current)).toBe(true);
    }
  }
  expect(sessionAudienceChanged("person:alice", true, "person:alice")).toBe(false);
  expect(sessionLookup(fx.db, keys[1], MEMBER)).toEqual({ state: "withheld", reason: "deny-session" });
});

it("fresh_start_other_bot_and_room_untouched", () => {
  const fx = setup();
  fx.denySession("room", "driver", "native", 900).denySession("other-bot", "driver", "native", 900);
  const other: RepairBot = { id: "bot-b", tasks: [{ threadId: "other-bot", resumeCursors: { driver: "native" } }] };
  const selected: RepairBot = { ...bot, tasks: [...bot.tasks!, { threadId: "room", resumeCursors: { driver: "native" } }] };
  const before = snapshot(fx), otherBefore = structuredClone(other);
  const plan = planFreshStart(fx.db, selected, deps);
  expect(apply(fx, plan)).toBe(1);
  expect(snapshot(fx).memory_deny_session).toEqual(before.memory_deny_session.filter(row => row.thread_id !== "T"));
  expect(plan.cursorClears.map(clear => [clear.botId, clear.threadId])).toEqual([["bot-a", "T"], ["bot-a", "room"]]);
  expect(other).toEqual(otherBefore);
});

it.each(["busy", "live"])("fresh_start_live_task_keeps_cursor_and_rows (%s)", mode => {
  const fx = setup(), before = snapshot(fx);
  const selected: RepairBot = { ...bot, tasks: [...bot.tasks!, { threadId: "other-task", busy: mode === "busy", resumeCursors: { driver: "live" } }] };
  const original = structuredClone(selected);
  const plan = planFreshStart(fx.db, selected, { ...deps, liveThreads: new Set(mode === "live" ? ["other-task"] : []) });
  expect(plan.blocked).toBe("bot-busy");
  expect(plan.sessionRows).toEqual([]);
  expect(plan.cursorClears).toEqual([]);
  expect(apply(fx, plan)).toBe(0);
  expect(snapshot(fx)).toEqual(before);
  expect(selected).toEqual(original);
});

it("fresh_start_pending_deletion_blocks", () => {
  const fx = setup();
  fx.pending("T", 1, 41).pendingScope("s-room", 1, 41).job(41, 20);
  const before = snapshot(fx);
  const plan = planFreshStart(fx.db, bot, { ...deps, pendingDeletion: id => id === "T" });
  expect(plan.blocked).toBe("deletion-pending");
  expect(plan.sessionRows).toEqual([]);
  expect(plan.cursorClears).toEqual([]);
  expect(apply(fx, plan)).toBe(0);
  expect(snapshot(fx)).toEqual(before);
});

it("fresh_start_over_bound_blocks_no_partial", () => {
  const fx = setup();
  fx.db.exec("BEGIN");
  for (let n = 1; n <= 5000; n++) {
    const revoke = 10000 + n;
    fx.db.prepare("INSERT INTO memory_revoke_audience VALUES(?)").run(revoke);
    fx.denySession("T", "driver", "native", revoke);
  }
  fx.db.exec("COMMIT");
  const before = snapshot(fx), plan = planFreshStart(fx.db, bot, deps);
  expect(plan.blocked).toBe("limit-exceeded");
  expect(plan.sessionRows).toEqual([]);
  expect(plan.cursorClears).toEqual([]);
  expect(apply(fx, plan)).toBe(0);
  expect(snapshot(fx)).toEqual(before);
});

it("fresh_start_content_session_mark_kept", () => {
  const fx = setup();
  fx.denySession("T", "driver", "native", 41);
  const plan = planFreshStart(fx.db, bot, deps);
  expect(apply(fx, plan)).toBe(1);
  expect(fx.db.prepare("SELECT revoke_id FROM memory_deny_session").all()).toEqual([{ revoke_id: 41 }]);
  expect(plan.retainedBlocks).toBe(1);
  for (const reader of [CONTENT, OWNER, MEMBER]) expect(sessionLookup(fx.db, sessionKeyOf("T", "driver", "native"), reader))
    .toEqual({ state: "withheld", reason: "deny-session" });
});

it.each(["certificate", "thread"])("fresh_start_unready_blocks (%s)", mode => {
  const fx = setup();
  if (mode === "certificate") fx.cert(false); else fx.ready("T", false);
  const before = snapshot(fx), plan = planFreshStart(fx.db, bot, deps);
  expect(plan.blocked).toBe("lineage-unready");
  expect(apply(fx, plan)).toBe(0);
  expect(snapshot(fx)).toEqual(before);
});

it("fresh_start_retained_count_is_capped_after_p1_exclusion", () => {
  const fx = setup();
  fx.db.exec("BEGIN");
  for (let n = 1; n <= 5001; n++) fx.denyLine("T", n, 41);
  fx.db.exec("COMMIT");
  const plan = planFreshStart(fx.db, bot, deps);
  expect(plan.blocked).toBeNull();
  expect(plan.retainedBlocks).toBe(5001);
  expect(plan.retainedCapped).toBe(true);
  expect(apply(fx, plan)).toBe(1);
});

it("fresh_start_requires_caller_transaction_and_rolls_back_with_audit", () => {
  const fx = setup(), before = snapshot(fx), plan = planFreshStart(fx.db, bot, deps);
  expect(() => applyFreshStartRows(fx.db, plan)).toThrow();
  fx.db.exec("BEGIN IMMEDIATE");
  expect(applyFreshStartRows(fx.db, plan)).toBe(1);
  fx.db.exec("ROLLBACK");
  expect(snapshot(fx)).toEqual(before);
});

it("fresh_start_accepts_exact_bound_and_rechecks_before_any_delete", () => {
  const fx = setup();
  fx.db.exec(`WITH RECURSIVE ids(n) AS (SELECT 10000 UNION ALL SELECT n+1 FROM ids WHERE n<14998)
    INSERT INTO memory_revoke_audience SELECT n FROM ids;
    INSERT INTO memory_deny_session SELECT 'T','driver','native',revoke_id FROM memory_revoke_audience WHERE revoke_id>=10000`);
  const plan = planFreshStart(fx.db, bot, deps);
  expect(plan.blocked).toBeNull();
  expect(plan.sessionRows).toHaveLength(5000);
  expect(plan.retainedBlocks).toBe(0);
  // A changed snapshot belongs to S2's 409 path. The deletion helper also
  // refuses an over-bound set before its first write, even with a stale plan.
  fx.denySession("T", "driver", "native", 901);
  const before = snapshot(fx);
  expect(() => apply(fx, plan)).toThrow("GH18_LIMIT_EXCEEDED");
  expect(snapshot(fx)).toEqual(before);
  fx.db.prepare("DELETE FROM memory_deny_session WHERE revoke_id=901").run();
  expect(apply(fx, plan)).toBe(5000);
});

it("fresh_start_bounds_cursor_candidates_too", () => {
  const fx = setup(), before = snapshot(fx);
  const selected: RepairBot = { id: "bot-a", tasks: [{ threadId: "T",
    resumeCursors: Object.fromEntries(Array.from({ length: 5001 }, (_, n) => [`driver-${n}`, "native"])),
  }] };
  const plan = planFreshStart(fx.db, selected, deps);
  expect(plan.blocked).toBe("limit-exceeded");
  expect(plan.cursorClears).toEqual([]);
  expect(apply(fx, plan)).toBe(0);
  expect(snapshot(fx)).toEqual(before);
});

it("fresh_start_unsupported_schema_blocks", () => {
  const fx = setup();
  fx.db.exec("DROP TABLE memory_deny_range");
  const before = snapshot(fx), plan = planFreshStart(fx.db, bot, deps);
  expect(plan.blocked).toBe("unsupported-schema");
  expect(apply(fx, plan)).toBe(0);
  expect(snapshot(fx)).toEqual(before);
});

it("fresh_start_unavailable_dependency_blocks", () => {
  const fx = setup(), before = snapshot(fx);
  const plan = planFreshStart(fx.db, bot, { ...deps, pendingDeletion: () => { throw new Error("unavailable"); } });
  expect(plan.blocked).toBe("policy-unavailable");
  expect(plan.cursorClears).toEqual([]);
  expect(apply(fx, plan)).toBe(0);
  expect(snapshot(fx)).toEqual(before);
});

it("fresh_start_unmarked_cursors_and_empty_bot", () => {
  const fx = setup();
  const selected: RepairBot = { id: "bot-b", tasks: [{ threadId: "other", resumeCursors: { driver: 0, null: null, missing: undefined }, resumeIncarnations: { driver: 3 } }] };
  const plan = planFreshStart(fx.db, selected, deps);
  expect(plan.blocked).toBeNull();
  expect(plan.sessionRows).toEqual([]);
  expect(plan.cursorClears).toEqual([{ botId: "bot-b", threadId: "other", instanceId: "driver", cursor: 0, incarnation: 3 }]);
  expect(apply(fx, plan)).toBe(0);
  expect(planFreshStart(fx.db, { id: "empty" }, deps)).toEqual({
    botId: "empty", sessionRows: [], cursorClears: [], retainedBlocks: 0, retainedCapped: false, blocked: null,
  });
});
