// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { RepairBot, RepairTask } from "./keepall-unwedge.ts";
import { isFreshStartSessionRow, type FreshStartSessionRow } from "./gh18-fresh-start-predicate.ts";

const row: FreshStartSessionRow = Object.freeze({ thread_id: "direct-a", driver_instance: "driver-a", native_session: "native-a#2", revoke_id: 18 });
const task: RepairTask = Object.freeze({
  threadId: "direct-a", busy: false,
  resumeCursors: Object.freeze({ "driver-a": "native-a" }),
  resumeIncarnations: Object.freeze({ "driver-a": 2 }),
  resumeAudiences: Object.freeze({ "driver-a": "owner|x2:partition" }),
});
const bot: RepairBot = Object.freeze({ id: "bot-a", tasks: Object.freeze([task]) });
const deps = {
  audienceRevokeIds: new Set([18]),
  ownerDirectThread: (id: string) => id.startsWith("direct-"),
  liveThreads: new Set<string>(),
};

describe("GH18 P1 pure selection", () => {
  it("gh18_p1_selects_idle_owner_direct_audience_session_only", () => {
    expect(isFreshStartSessionRow(row, bot, deps)).toBe(true);
    // Historical owner audience and first-incarnation keys use keepall's exact rules.
    const legacy: RepairBot = { id: bot.id, tasks: [{ threadId: task.threadId, resumeCursors: { "driver-a": "native-a" } }] };
    expect(isFreshStartSessionRow({ ...row, native_session: "native-a" }, legacy, deps)).toBe(true);
    expect(isFreshStartSessionRow({ ...row, native_session: "0" }, { id: bot.id, tasks: [{ threadId: task.threadId, resumeCursors: { "driver-a": 0 } }] }, deps)).toBe(true);
  });

  it("gh18_p1_never_selects_content_marks", () => {
    expect(isFreshStartSessionRow({ ...row, revoke_id: 19 }, bot, deps)).toBe(false);
    expect(isFreshStartSessionRow(row, bot, { ...deps, audienceRevokeIds: new Set() })).toBe(false);
  });

  it("gh18_p1_never_selects_shared_chat_marks", () => {
    const room = { ...row, thread_id: "room-a" };
    expect(isFreshStartSessionRow(room, { id: bot.id, tasks: [{ ...task, threadId: "room-a" }] }, deps)).toBe(false);
    expect(isFreshStartSessionRow(row, bot, { ...deps, ownerDirectThread: () => false })).toBe(false);
  });

  it("gh18_p1_never_selects_sessions_with_live_turns", () => {
    expect(isFreshStartSessionRow(row, { id: bot.id, tasks: [{ ...task, busy: true }] }, deps)).toBe(false);
    expect(isFreshStartSessionRow(row, bot, { ...deps, liveThreads: new Set([task.threadId]) })).toBe(false);
    // Conflicting duplicate store entries must not let an idle entry mask a live one.
    expect(isFreshStartSessionRow(row, { id: bot.id, tasks: [task, { ...task, busy: true }] }, deps)).toBe(false);
  });

  it("gh18_p1_never_selects_other_bots", () => {
    const other: RepairBot = { id: "bot-b", tasks: [{ ...task, threadId: "direct-b" }] };
    expect(isFreshStartSessionRow(row, other, deps)).toBe(false);
    expect(isFreshStartSessionRow({ ...row, thread_id: "direct-b" }, bot, deps)).toBe(false);
    expect(isFreshStartSessionRow(row, { id: bot.id }, deps)).toBe(false);
  });

  it("gh18_p1_requires_exact_cursor_audience_instance_and_incarnation", () => {
    for (const changed of [
      { ...row, driver_instance: "driver-b" }, { ...row, native_session: "native-b#2" },
      { ...row, native_session: "native-a" }, { ...row, native_session: "native-a#3" },
    ]) expect(isFreshStartSessionRow(changed, bot, deps)).toBe(false);
    for (const audience of ["member", "owner-other", "member|x2:owner"]) {
      expect(isFreshStartSessionRow(row, { id: bot.id, tasks: [{ ...task, resumeAudiences: { "driver-a": audience } }] }, deps)).toBe(false);
    }
    for (const cursor of [null, undefined]) {
      expect(isFreshStartSessionRow(row, { id: bot.id, tasks: [{ ...task, resumeCursors: { "driver-a": cursor } }] }, deps)).toBe(false);
    }
  });

  it("gh18_p1_selects_exact_set_without_changing_snapshot", () => {
    const rows = [row, { ...row, revoke_id: 19 }, { ...row, thread_id: "room-a" }, { ...row, thread_id: "direct-b" }, { ...row, native_session: "native-a#1" }];
    const before = JSON.stringify({ rows, bot, revokes: [...deps.audienceRevokeIds], live: [...deps.liveThreads] });
    expect(rows.filter(candidate => isFreshStartSessionRow(candidate, bot, deps))).toEqual([row]);
    expect(JSON.stringify({ rows, bot, revokes: [...deps.audienceRevokeIds], live: [...deps.liveThreads] })).toBe(before);
  });
});
