// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Today's Needs you block (Today slice 1.0.18): Decide before Worth a look, three lines then "and {n} more", the
// badge count as the truth, one reconnect source, a failed routine dropped when its restore row lists it by key,
// quiet at 30 minutes, busy hand-offs, and spend jumps.
import { describe, expect, it } from "vitest";
import type { RoutineRun } from "@/lib/routines";
import type { NeedsSummaryRow } from "@/components/shell/shell-contract";
import type { ConnectionToRestore } from "../../shared/inbox";
import { needsLines, TODAY_QUIET_MS, type NeedsLinesInput } from "./today-needs";

const MIN = 60_000;
const at = (h: number, m = 0) => new Date(2026, 10, 4, h, m).getTime();
const NOW = at(12);
const DAY = 86_400_000;
const open = () => undefined;
const owed = (id: string, segment: NeedsSummaryRow["segment"], line = `Q ${id}`): NeedsSummaryRow => ({ id, line, meta: "Max · waiting since 09:00", open, segment });
const run = (over: Partial<RoutineRun>): RoutineRun => ({ id: "x", routineId: "r1", routineName: "Morning brief", target: "bot", botId: "nova", runOn: "ember", scheduledFor: at(8), status: "completed", manual: false, startedAt: at(8), finishedAt: at(8, 1), createdAt: at(8), ...over });
const restoreRow = (over: Partial<ConnectionToRestore> = {}): ConnectionToRestore => ({ id: "connection:restore", routines: ["Inbox sweep"], routineKeys: ["routine:r2"], bots: ["Nova"], since: at(7), detail: "A connection Inbox sweep depends on is no longer authorized.", link: { threadId: "t-r2", messageId: "m-r2" }, ...over });
const input = (over: Partial<NeedsLinesInput> = {}): NeedsLinesInput => ({
  now: NOW, count: 0, rows: [], restore: [], reconnectApps: [], handoffs: [],
  routines: [{ id: "r1" }, { id: "r2" }, { id: "r3" }], runs: [], bots: [],
  botNames: { nova: "Nova", max: "Max", maple: "Maple" },
  ...over,
});
const ids = (lines: { id: string }[]) => lines.map((line) => line.id);
const working = (id: string, since: number | undefined, lastActivityAt: number | undefined) => ({
  id, name: id === "nova" ? "Nova" : "Max", threadId: `${id}-main`, busy: true, activity: "working" as const, turnStartedAt: since,
  tasks: [{ threadId: `${id}-main`, title: "Matching invoices", createdAt: 0, activity: "working" as const, turnStartedAt: since, lastActivityAt }],
});

describe("Today's Needs you lines", () => {
  it("puts Decide (oldest first) before Worth a look, shows three, and counts the rest as more", () => {
    const result = needsLines(input({
      count: 4,
      rows: [owed("a1", "approval"), owed("q1", "question"), owed("a2", "approval"), owed("c1", "connection")],
      runs: [run({ id: "f", routineId: "r3", routineName: "Weekly digest", status: "failed", finishedAt: at(9) })],
    }));
    expect(ids(result.all)).toEqual(["a1", "q1", "a2", "c1", "failed:r3"]);
    expect(result.all.map((line) => line.level)).toEqual(["decide", "decide", "decide", "look", "look"]);
    expect(result.all[1]).toMatchObject({ kind: "question", text: { raw: "Q q1" }, meta: { raw: "Max · waiting since 09:00" }, act: { key: "ux.l2a.today.act.open" } });
    expect(ids(result.lines)).toEqual(["a1", "q1", "a2"]);
    expect(result).toMatchObject({ hidden: 2, unnamed: 0, more: 2, rest: false, nothing: false, decide: 3, look: 2 });
    expect(ids(needsLines(input({ count: 4, rows: [owed("a1", "approval"), owed("q1", "question"), owed("a2", "approval"), owed("c1", "connection")], cap: Number.POSITIVE_INFINITY })).lines)).toEqual(["a1", "q1", "a2", "c1"]);
  });

  it("takes the badge count as the truth: owed items it cannot name go to the door, and never says Nothing needs you above 0", () => {
    const result = needsLines(input({ count: 5, rows: [owed("a1", "approval")] }));
    expect(result).toMatchObject({ unnamed: 4, more: 4, rest: true, nothing: false });
    const none = needsLines(input({ count: 2 }));
    expect(none).toMatchObject({ nothing: false, rest: true, unnamed: 2, more: 2 });
    expect(needsLines(input({ count: 0 }))).toMatchObject({ nothing: true, rest: false, more: 0 });
    expect(needsLines(input({ count: undefined }))).toMatchObject({ nothing: false, checking: true, unnamed: 0 });
    // Nothing owed but something worth a look: not "Nothing needs you".
    expect(needsLines(input({ count: 0, reconnectApps: [{ slug: "gmail", label: "Gmail" }] })).nothing).toBe(false);
  });

  it("dedupes reconnect across the Inbox, its restore rows and needs-reconnect, by source, never by name", () => {
    const apps = [{ slug: "gmail", label: "Gmail" }, { slug: "gmail", label: "Gmail" }, { slug: "slack", label: "Slack" }];
    const fromInbox = needsLines(input({ count: 2, rows: [owed("c1", "connection", "Reconnect Gmail")], restore: [restoreRow()], reconnectApps: apps }));
    expect(ids(fromInbox.all)).toEqual(["c1"]);
    expect(fromInbox.all[0]).toMatchObject({ kind: "connection", act: { key: "ux.l2a.today.look.reconnectAct" }, target: { type: "needs" } });
    const fromRestore = needsLines(input({ count: 1, restore: [restoreRow()], reconnectApps: apps }));
    expect(ids(fromRestore.all)).toEqual(["restore:connection:restore"]);
    expect(fromRestore.all[0]).toMatchObject({
      text: { raw: "A connection Inbox sweep depends on is no longer authorized." },
      meta: { key: "ux.l2a.today.look.reconnectMeta", params: { n: 1, time: "07:00" } },
      target: { type: "link", threadId: "t-r2", messageId: "m-r2" },
    });
    expect(fromRestore.unnamed, "the restore row is the owed connection").toBe(0);
    expect(needsLines(input({ count: 1, restore: [restoreRow({ link: undefined })] })).all[0]?.target).toEqual({ type: "apps" });
    const fromMemory = needsLines(input({ count: 0, reconnectApps: apps }));
    expect(ids(fromMemory.all)).toEqual(["reconnect:gmail", "reconnect:slack"]);
    expect(fromMemory.all[0]).toMatchObject({ text: { key: "ux.l2a.today.look.reconnect", params: { app: "Gmail" } }, meta: null, target: { type: "apps" } });
  });

  it("drops a failed routine when a restore row lists it by key, even when another routine has the same name", () => {
    const runs = [
      run({ id: "f2", routineId: "r2", routineName: "Inbox sweep", status: "failed", error: "Gmail is not authorized.", finishedAt: at(9) }),
      run({ id: "f3", routineId: "r3", routineName: "Inbox sweep", status: "missed", finishedAt: undefined, scheduledFor: at(10) }),
    ];
    const result = needsLines(input({ count: 1, restore: [restoreRow()], runs }));
    expect(ids(result.all)).toEqual(["restore:connection:restore", "failed:r3"]);
    expect(result.all[1]).toMatchObject({
      text: { key: "ux.l2a.today.look.failed", params: { routine: "Inbox sweep" } },
      meta: { key: "ux.l2a.today.look.failedMeta", params: { bot: "Nova", time: "10:00" } },
      detail: { key: "ux.l2a.today.look.failedGeneric" },
      target: { type: "run", routineId: "r3", runId: "f3" },
    });
    // With no restore row, both show; the error is the second line.
    const both = needsLines(input({ runs }));
    expect(ids(both.all)).toEqual(["failed:r3", "failed:r2"]);
    expect(both.all[1]?.detail).toEqual({ raw: "Gmail is not authorized." });
  });

  it("reads only the newest terminal run of a routine today, and leaves yesterday and deleted routines out", () => {
    const result = needsLines(input({ runs: [
      run({ id: "old-fail", status: "failed", finishedAt: at(7) }),
      run({ id: "then-ok", status: "completed", finishedAt: at(9) }),
      run({ id: "yday", routineId: "r2", status: "failed", finishedAt: at(9) - DAY, scheduledFor: at(9) - DAY }),
      run({ id: "gone", routineId: "deleted", status: "failed", finishedAt: at(9) }),
      run({ id: "live", routineId: "r3", status: "running", finishedAt: undefined }),
    ] }));
    expect(result.all).toEqual([]);
  });

  it("calls a working bot quiet at 30 minutes, not 29, from the later of its turn start and its last row", () => {
    const at29 = needsLines(input({ bots: [working("nova", NOW - 60 * MIN, NOW - 29 * MIN)] }));
    expect(at29.all).toEqual([]);
    const at30 = needsLines(input({ bots: [working("nova", NOW - 60 * MIN, NOW - TODAY_QUIET_MS)] }));
    expect(at30.all).toHaveLength(1);
    expect(at30.all[0]).toMatchObject({ id: "quiet:nova", kind: "quiet", text: { key: "ux.l2a.today.look.quiet", params: { bot: "Nova", n: 30 } }, act: { key: "ux.l2a.today.act.watch" }, target: { type: "chat", botId: "nova", threadId: "nova-main" } });
    // Unknown timestamps never count; a waiting bot is not working.
    expect(needsLines(input({ bots: [working("nova", undefined, undefined)] })).all).toEqual([]);
    expect(needsLines(input({ bots: [{ ...working("nova", NOW - 90 * MIN, undefined), activity: "waiting-on-you", tasks: [] }] })).all).toEqual([]);
    expect(ids(needsLines(input({ bots: [working("max", NOW - 45 * MIN, undefined), working("nova", NOW - 90 * MIN, NOW - 40 * MIN)] })).all)).toEqual(["quiet:max", "quiet:nova"]);
  });

  it("needs an explicit working activity: a busy-only bot (no activity) is never called quiet", () => {
    const busyOnly = (id: string) => {
      const bot = working(id, NOW - 90 * MIN, NOW - 60 * MIN);
      const { activity: _a, ...rest } = bot;
      return { ...rest, tasks: bot.tasks.map(({ activity: _t, ...task }) => task) };
    };
    expect(needsLines(input({ bots: [busyOnly("nova")] })).all).toEqual([]);
    // the same bot with the activity set is quiet
    expect(ids(needsLines(input({ bots: [working("nova", NOW - 90 * MIN, NOW - 60 * MIN)] })).all)).toEqual(["quiet:nova"]);
    // the bot's own fields say working for its open conversation (no task row): still explicit
    const own = { ...working("nova", NOW - 90 * MIN, undefined), tasks: [] };
    expect(ids(needsLines(input({ bots: [own] })).all)).toEqual(["quiet:nova"]);
  });

  it("shows a hand-off from the busy read once, named both ways, and skips one it cannot name", () => {
    const result = needsLines(input({ handoffs: [
      { sourceBotId: "nova", targetBotId: "maple", sourceThreadId: "t1" },
      { sourceBotId: "nova", targetBotId: "maple", sourceThreadId: "t1" },
      { sourceBotId: "ghost", targetBotId: "maple", sourceThreadId: "t2" },
    ] }));
    expect(result.all).toHaveLength(1);
    expect(result.all[0]).toMatchObject({
      kind: "handoff", text: { key: "ux.l2a.today.look.handoff", params: { from: "Nova", to: "Maple" } },
      meta: { key: "ux.l2a.today.look.handoffMeta", params: { to: "Maple" } }, target: { type: "chat", botId: "nova", threadId: "t1" },
    });
  });

  it("flags spend at 3x the usual and $0.50 more, and never on a null cost, thin history or a zero median", () => {
    const history = (routineId: string, costs: Array<number | null>) => costs.map((cost, index) => run({ id: `${routineId}-h${index}`, routineId, cost, finishedAt: at(8) - (index + 1) * DAY, scheduledFor: at(8) - (index + 1) * DAY }));
    const today = (routineId: string, cost: number | null) => run({ id: `${routineId}-today`, routineId, routineName: `Routine ${routineId}`, cost, finishedAt: at(9) });
    const result = needsLines(input({ runs: [
      ...history("r1", [0.3, 0.3, 0.2, 0.4, 0.3, 9]), today("r1", 0.9),  // 3x 0.30 and 0.60 more: flagged (the 6th earlier cost is ignored)
      ...history("r2", [0.1, 0.1, 0.1]), today("r2", 0.5),                // 5x but only 0.40 more: not flagged
      ...history("r3", [0.3, null, 0.3]), today("r3", 3),                 // two finite earlier costs: not flagged
    ], routines: [{ id: "r1" }, { id: "r2" }, { id: "r3" }] }));
    expect(ids(result.all)).toEqual(["spendJump:r1"]);
    expect(result.all[0]).toMatchObject({
      text: { key: "ux.l2a.today.look.spendLine", params: { routine: "Routine r1", cost: "$0.90" } },
      meta: { key: "ux.l2a.today.look.spendMeta", params: { bot: "Nova", usual: "$0.30" } },
      act: { key: "ux.l2a.today.look.spendAct" }, target: { type: "usage" },
    });
    const zero = needsLines(input({ runs: [...history("r1", [0, 0, 0]), today("r1", 5)] }));
    expect(zero.all).toEqual([]);
    const nullToday = needsLines(input({ runs: [...history("r1", [0.3, 0.3, 0.3]), today("r1", null)] }));
    expect(nullToday.all).toEqual([]);
  });

  it("the $0.50 floor is exact to the cent: $0.70 against a usual $0.20 is flagged, $0.69 is not", () => {
    const history = (costs: number[]) => costs.map((cost, index) => run({ id: `h${index}`, cost, finishedAt: at(8) - (index + 1) * DAY, scheduledFor: at(8) - (index + 1) * DAY }));
    expect(ids(needsLines(input({ runs: [...history([0.2, 0.2, 0.2]), run({ id: "t", cost: 0.7, finishedAt: at(9) })] })).all)).toEqual(["spendJump:r1"]);
    expect(needsLines(input({ runs: [...history([0.2, 0.2, 0.2]), run({ id: "t", cost: 0.69, finishedAt: at(9) })] })).all).toEqual([]);
  });

  it("measures against exactly the 5 strictly earlier runs: a 6th, an equal or later time, and below 3x never count", () => {
    const earlier = (costs: number[]) => costs.map((cost, index) => run({ id: `h${index}`, cost, finishedAt: at(8) - (index + 1) * DAY, scheduledFor: at(8) - (index + 1) * DAY }));
    const today = (cost: number, extra: Partial<RoutineRun> = {}) => run({ id: "t", cost, finishedAt: at(9), ...extra });
    // newest five are 0.10, 0.10, 0.10, 1.00, 1.00 (median 0.10): $0.70 is flagged. Six (with the older 1.00) would make
    // the median 0.55 and hide it.
    expect(ids(needsLines(input({ runs: [...earlier([0.1, 0.1, 0.1, 1, 1, 1]), today(0.7)] })).all)).toEqual(["spendJump:r1"]);
    // two earlier runs is thin history; a run at the very same time, or a later one, never makes it three
    expect(needsLines(input({ runs: [...earlier([0.1, 0.1]), today(0.7), run({ id: "same", cost: 0.1, finishedAt: at(9) })] })).all).toEqual([]);
    expect(needsLines(input({ runs: [...earlier([0.1, 0.1]), today(0.7), run({ id: "later", cost: 0.1, finishedAt: at(9, 30) })] })).all).toEqual([]);
    expect(ids(needsLines(input({ runs: [...earlier([0.1, 0.1, 0.1]), today(0.7)] })).all)).toEqual(["spendJump:r1"]);
    // below 3x: usual $0.50, $1.40 is 0.90 more but under 3x
    expect(needsLines(input({ runs: [...earlier([0.5, 0.5, 0.5]), today(1.4)] })).all).toEqual([]);
    expect(ids(needsLines(input({ runs: [...earlier([0.5, 0.5, 0.5]), today(1.5)] })).all)).toEqual(["spendJump:r1"]);
  });

  it("orders Worth a look as reconnect, failed routine, quiet bot, hand-off, spend", () => {
    const result = needsLines(input({
      count: 0,
      reconnectApps: [{ slug: "gmail", label: "Gmail" }],
      runs: [
        run({ id: "f", routineId: "r3", status: "failed", finishedAt: at(9) }),
        ...[1, 2, 3].map((n) => run({ id: `h${n}`, routineId: "r2", cost: 0.2, finishedAt: at(8) - n * DAY, scheduledFor: at(8) - n * DAY })),
        run({ id: "big", routineId: "r2", cost: 2, finishedAt: at(10) }),
      ],
      bots: [working("max", NOW - 50 * MIN, undefined)],
      handoffs: [{ sourceBotId: "nova", targetBotId: "maple" }],
      cap: Number.POSITIVE_INFINITY,
    }));
    expect(result.all.map((line) => line.kind)).toEqual(["reconnect", "failed", "quiet", "handoff", "spendJump"]);
    expect(result.decide).toBe(0);
  });
});
