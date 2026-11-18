// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// NOLIM-UI2-CLI2 (Rev 3.3 U4, M-order): the order of the two checks after a window's preview lands, pinned on the pure
// function the button calls, so it cannot be reordered without a red test (the DOM cannot reach it: a list move retires
// the press before a preview can be judged).
import { describe, expect, it } from "vitest";
import { boundToThread, chatRequestKey, judgeThreadWindow } from "./approve-all-thread";

const T = "thread-1";
const keys = [chatRequestKey(T, { requestId: "A" }), chatRequestKey(T, { requestId: "C" })];
const entry = (requestId: string) => ({ threadId: T, requestId });
const good = { scope: "thread", threadId: T, batchId: "b1", eligible: [entry("A"), entry("C")], later: [], excluded: [], closed: [] };
// a preview that is a protocol error against the window: it places nothing the window asked for
const broken = { scope: "thread", threadId: T, batchId: null, eligible: [], later: [], excluded: [], closed: [] };

describe("boundToThread: nothing outside the window, whatever the list, and nothing that is not a preview", () => {
  const base = (over: Record<string, unknown>) => ({ ...good, ...over });
  it.each(["eligible", "later", "excluded", "closed"] as const)("an unrequested id in %s is a protocol error", (list) => {
    const extra = entry("ZZ");
    // every asked id is placed (A, C in eligible), plus one id nobody asked for in the list under test
    const preview = list === "eligible" ? base({ eligible: [entry("A"), entry("C"), extra] }) : base({ [list]: [extra] });
    expect(boundToThread(preview, T, keys)).toEqual({ at: "protocol" });
  });
  it("all asked ids closed plus an unrequested excluded id is a protocol error, never each-own", () => {
    const preview = { scope: "thread", threadId: T, batchId: null, eligible: [], later: [], excluded: [entry("ZZ")], closed: [entry("A"), entry("C")] };
    expect(boundToThread(preview, T, keys)).toEqual({ at: "protocol" });
  });
  it.each([null, undefined, 7, "x"])("a response of %s is a protocol error and never throws", (value) => {
    expect(boundToThread(value as never, T, keys)).toEqual({ at: "protocol" });
    expect(judgeThreadWindow(true, value as never, T, keys)).toEqual({ at: "protocol" });
  });
});

describe("judgeThreadWindow: the press snapshot is judged before the preview", () => {
  it("a moved list is changed even when the preview is a protocol error (a swapped order would say protocol)", () => {
    expect(boundToThread(broken, T, keys)).toEqual({ at: "protocol" });
    expect(judgeThreadWindow(false, broken, T, keys)).toEqual({ at: "changed" });
  });
  it("a moved list is changed even when the preview is good (the batch is never read)", () => {
    expect(judgeThreadWindow(false, good, T, keys)).toEqual({ at: "changed" });
  });
  it("an unmoved list reads the preview: cards for a good one, protocol for a broken one", () => {
    expect(judgeThreadWindow(true, good, T, keys)).toMatchObject({ at: "cards", excluded: 0, later: 0 });
    expect(judgeThreadWindow(true, broken, T, keys)).toEqual({ at: "protocol" });
  });
});
