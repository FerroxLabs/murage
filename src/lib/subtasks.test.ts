// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { EMPTY_HELPERS, helperLine, helpersAfterEvent, pickSubtasks, type Subtask } from "@/lib/subtasks";
import { groupActivityRuns, groupTranscript } from "@/lib/activity-runs";
import { HelperRows, HelpersLine, HelpersSummary } from "@/components/HelpersLine";
import { TurnNarrationRun } from "@/components/TurnNarrationRun";
import type { Message } from "@/state/store";
import en from "@/locales/en.json";

const row = (id: string, status: Subtask["status"], extra: Partial<Subtask> = {}): Subtask => ({
  id, label: `Task ${id}`, status, startedAt: 1_000, toolCount: 0, ...extra,
});
const ev = (type: string, threadId: string, subtasks?: Subtask[]) => ({ type, threadId, subtasks });
const html = (node: unknown) => renderToStaticMarkup(node as never);

describe("helpers line", () => {
  it("appears with N helpers and says how many are working", () => {
    const rows = [row("a", "running"), row("b", "started"), row("c", "done", { endedAt: 5_000 })];
    expect(helperLine(rows)).toBe("2 helpers working");
    const out = html(createElement(HelpersLine, { helpers: rows }));
    expect(out).toContain("2 helpers working");
    expect(out).toContain('aria-expanded="false"');
    expect(out).not.toContain("helper-rows");
  });
  it("says one helper in the singular and all finished once none work", () => {
    expect(helperLine([row("a", "running")])).toBe("1 helper working");
    expect(helperLine([row("a", "done"), row("b", "failed")])).toBe("2 helpers finished");
  });
  it("renders nothing without helpers", () => {
    expect(html(createElement(HelpersLine, { helpers: [] }))).toBe("");
  });
  it("keeps the spoken line apart from the ticking timers", () => {
    const out = html(createElement(HelpersLine, { helpers: [row("a", "running")], defaultOpen: true }));
    expect(out).toMatch(/role="status" aria-live="polite" class="sr-only">1 helper working</);
    expect(out).toContain("focus-visible:ring-2");
  });
});

describe("live events", () => {
  it("replaces the whole list on each turn.subtask and ticks a row to done", () => {
    let state = helpersAfterEvent(EMPTY_HELPERS, ev("turn.subtask", "t1", [row("a", "started"), row("b", "started")]));
    expect(helperLine(state.live.t1)).toBe("2 helpers working");
    state = helpersAfterEvent(state, ev("turn.subtask", "t1", [row("a", "done", { endedAt: 3_000, toolCount: 4 }), row("b", "running", { toolCount: 1 })]));
    expect(helperLine(state.live.t1)).toBe("1 helper working");
    const out = html(createElement(HelperRows, { helpers: state.live.t1 }));
    expect(out).toContain('data-status="done"');
    expect(out).toContain("4 tools");
  });
  it("ignores other threads' frames and bad rows, and returns the same object for unrelated events", () => {
    expect(helpersAfterEvent(EMPTY_HELPERS, { type: "content.delta", threadId: "t1" })).toBe(EMPTY_HELPERS);
    const bad = helpersAfterEvent(EMPTY_HELPERS, ev("turn.subtask", "t1", [{ nope: 1 } as never, row("a", "running")]));
    expect(bad.live.t1).toHaveLength(1);
    const other = helpersAfterEvent(bad, ev("turn.subtask", "t2", [row("z", "running")]));
    expect(other.live.t1).toEqual(bad.live.t1);
  });
  it("moves a finished turn's helpers into runs, marking a leftover as failed", () => {
    let state = helpersAfterEvent(EMPTY_HELPERS, ev("turn.subtask", "t1", [row("a", "done", { endedAt: 2_000 }), row("b", "running")]));
    state = helpersAfterEvent(state, ev("turn.completed", "t1"));
    expect(state.live.t1).toBeUndefined();
    expect(state.runs.t1[0].map((r) => r.status)).toEqual(["done", "failed"]);
    expect(helpersAfterEvent(state, ev("turn.started", "t1"))).toBe(state);
  });
  it("clears the live list when a new turn starts or the session exits", () => {
    const state = helpersAfterEvent(EMPTY_HELPERS, ev("turn.subtask", "t1", [row("a", "running")]));
    expect(helpersAfterEvent(state, ev("turn.started", "t1")).live).toEqual({});
    expect(helpersAfterEvent(state, ev("session.exited", "t1")).runs).toEqual({});
  });
});

describe("reconnect", () => {
  it("rebuilds from the task snapshot when no live event arrived", () => {
    expect(pickSubtasks(undefined, [row("a", "running"), row("b", "done", { endedAt: 9 })])).toHaveLength(2);
  });
  it("prefers whichever side is further along", () => {
    const live = [row("a", "running")];
    const snap = [row("a", "done", { endedAt: 4_000, toolCount: 3 })];
    expect(pickSubtasks(live, snap)[0].status).toBe("done");
    expect(pickSubtasks(snap, live)[0].status).toBe("done");
    expect(pickSubtasks(live, [row("a", "running"), row("b", "started")])).toHaveLength(2);
  });
  it("is empty with no helpers anywhere", () => {
    expect(pickSubtasks(undefined, undefined)).toEqual([]);
  });
});

const msg = (id: string, at: number, extra: Partial<Message> = {}): Message =>
  ({ id, role: "bot", kind: "text", text: id, at, ...extra }) as Message;

describe("fold into the Worked for summary", () => {
  const runs = [[row("a", "done", { startedAt: 2_000, endedAt: 60_000, toolCount: 5 }), row("b", "failed", { startedAt: 2_500, endedAt: 30_000 })]];
  it("joins the existing fold of that turn", () => {
    const messages = [
      msg("u", 1_000, { role: "user" }),
      msg("n1", 3_000, { turnId: "T" }),
      msg("final", 90_000, { turnId: "T", turnTerminal: true }),
    ];
    const items = groupTranscript(messages, runs);
    const fold = items.find((i) => i.kind === "turn");
    expect(fold && fold.kind === "turn" && fold.helpers).toHaveLength(2);
    expect(items.some((i) => i.kind === "helpers")).toBe(false);
  });
  it("becomes its own Worked for row when the turn had no narration", () => {
    const messages = [msg("u", 1_000, { role: "user" }), msg("final", 90_000, { turnId: "T", turnTerminal: true })];
    const items = groupTranscript(messages, runs);
    const helpers = items.find((i) => i.kind === "helpers");
    expect(helpers && helpers.kind === "helpers" && helpers.label).toBe("Worked for 1m 28s");
    expect(items.map((i) => i.kind)).toEqual(["message", "helpers", "message"]);
  });
  it("works for rooms, which do not fold narration", () => {
    const messages = [msg("u", 1_000, { role: "user" }), msg("final", 90_000, { turnId: "T", turnTerminal: true })];
    expect(groupActivityRuns(messages, runs).map((i) => i.kind)).toEqual(["message", "helpers", "message"]);
  });
  it("changes nothing without helpers", () => {
    const messages = [msg("u", 1_000, { role: "user" }), msg("n1", 3_000, { turnId: "T" }), msg("final", 90_000, { turnId: "T", turnTerminal: true })];
    expect(groupTranscript(messages)).toEqual(groupTranscript(messages, undefined));
    expect(groupTranscript(messages, [])).toEqual(groupTranscript(messages));
    expect(html(createElement(HelpersLine, { helpers: [] }))).toBe("");
  });
  it("expands to label, status, duration and tool count per helper", () => {
    const out = html(createElement(HelpersSummary, { label: "Worked for 1m 28s", helpers: runs[0], defaultOpen: true }));
    expect(out).toContain("Task a");
    expect(out).toContain("done");
    expect(out).toContain("58s");
    expect(out).toContain("5 tools");
    expect(out).toContain("failed");
    const narrated = html(createElement(TurnNarrationRun, { label: "Worked for 1m", helpers: runs[0], forceOpen: true, children: "x" }));
    expect(narrated).toContain("Task b");
  });
});

describe("after a reload (stored with the closing message)", () => {
  const stored = [{ label: "Read logs", status: "done" as const, durationMs: 58_000, toolCount: 5 }, { label: "Check", status: "failed" as const, durationMs: 4_000, toolCount: 0 }];
  it("joins the turn's fold with no live state at all", () => {
    const messages = [msg("u", 1_000, { role: "user" }), msg("n1", 3_000, { turnId: "T" }), msg("final", 90_000, { turnId: "T", turnTerminal: true, turnHelpers: stored })];
    const fold = groupTranscript(messages).find((i) => i.kind === "turn");
    expect(fold && fold.kind === "turn" && fold.helpers?.map((h) => h.label)).toEqual(["Read logs", "Check"]);
    const out = html(createElement(HelperRows, { helpers: fold && fold.kind === "turn" ? fold.helpers! : [] }));
    expect(out).toContain("58s");
    expect(out).toContain("5 tools");
  });
  it("is its own Worked for row without narration, and in rooms", () => {
    const messages = [msg("u", 1_000, { role: "user" }), msg("final", 90_000, { turnId: "T", turnTerminal: true, turnHelpers: stored })];
    const items = groupTranscript(messages);
    expect(items.map((i) => i.kind)).toEqual(["message", "helpers", "message"]);
    expect(items[1].kind === "helpers" && items[1].label).toBe("Worked for 1m 29s");
    expect(groupActivityRuns(messages).map((i) => i.kind)).toEqual(["message", "helpers", "message"]);
  });
  it("does not double up when this window also saw the live run", () => {
    const messages = [msg("u", 1_000, { role: "user" }), msg("final", 90_000, { turnId: "T", turnTerminal: true, turnHelpers: stored })];
    const live = [[row("a", "done", { startedAt: 2_000, endedAt: 60_000 })]];
    expect(groupTranscript(messages, live).filter((i) => i.kind === "helpers")).toHaveLength(1);
  });
  it("says Worked for from the catalog", () => {
    expect(en["chat.workedFor"]).toBe("Worked for {time}");
    expect(en["chat.worked"]).toBe("Worked");
  });
});

describe("copy", () => {
  it("never says subagent, an em dash or the banned words", () => {
    const own = Object.entries(en).filter(([key]) => key.startsWith("helpers."));
    expect(own.length).toBeGreaterThan(5);
    for (const [, text] of own) expect(text).not.toMatch(/subagent|sub-agent|—|\bsafe|unsafe|safety/i);
  });
});
