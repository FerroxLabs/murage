// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Today's Worth a look reads (Today slice 1.0.18): needs-reconnect and the busy team-map, one of each in flight,
// one more read for a change that lands mid-read, nothing after abort, and junk answers read as nothing.
import { describe, expect, it } from "vitest";
import { parseBusyHandoffs, parseReconnectApps, WORTH_A_LOOK_PATHS, worthALookReader, type WorthALook } from "./use-worth-a-look";

function deferredFetch() {
  const calls: Array<{ path: string; signal: AbortSignal; resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];
  const fetch = (path: string, init: { signal: AbortSignal }) => new Promise<unknown>((resolve, reject) => { calls.push({ path, signal: init.signal, resolve, reject }); });
  return { calls, fetch };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Today's Worth a look reads", () => {
  it("asks the two routes only, the team map for busy hand-offs", () => {
    expect(WORTH_A_LOOK_PATHS).toEqual({ reconnect: "/api/connectors/needs-reconnect", handoffs: "/api/team-map?phase=busy" });
  });

  it("keeps one read of each in flight and reads exactly once more for changes that land mid-read", async () => {
    const { calls, fetch } = deferredFetch();
    const answers: Array<Partial<WorthALook>> = [];
    const reader = worthALookReader(fetch, (part) => answers.push(part));
    void reader.refresh();
    void reader.refresh();
    void reader.refresh();
    expect(calls.map((call) => call.path)).toEqual(["/api/connectors/needs-reconnect", "/api/team-map?phase=busy"]);
    calls[0]!.resolve({ apps: [{ slug: "gmail", label: "Gmail", accounts: [] }] });
    calls[1]!.resolve({ collaborations: [], queued: [{ sourceBotId: "nova", targetBotId: "maple", sourceThreadId: "t1" }], running: [] });
    await flush();
    expect(calls).toHaveLength(4);
    expect(answers).toEqual([
      { reconnect: [{ slug: "gmail", label: "Gmail" }] },
      { handoffs: [{ sourceBotId: "nova", targetBotId: "maple", sourceThreadId: "t1" }] },
    ]);
    calls[2]!.reject(new Error("offline"));
    calls[3]!.resolve({ queued: [] });
    await flush();
    expect(calls).toHaveLength(4);
    expect(answers.at(-1)).toEqual({ handoffs: [] });
    expect(answers).toHaveLength(3);
  });

  it("sends nothing and reads nothing once aborted", async () => {
    const { calls, fetch } = deferredFetch();
    const answers: Array<Partial<WorthALook>> = [];
    const reader = worthALookReader(fetch, (part) => answers.push(part));
    void reader.refresh();
    reader.abort();
    expect(calls.every((call) => call.signal.aborted)).toBe(true);
    calls[0]!.resolve({ apps: [{ slug: "gmail", label: "Gmail" }] });
    calls[1]!.resolve({ queued: [] });
    await flush();
    void reader.refresh();
    await flush();
    expect(answers).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("reads junk answers as nothing and keeps only well-formed rows", () => {
    for (const junk of [null, undefined, "x", 3, {}, { apps: "no" }, { queued: {} }]) {
      expect(parseReconnectApps(junk)).toEqual([]);
      expect(parseBusyHandoffs(junk)).toEqual([]);
    }
    expect(parseReconnectApps({ apps: [null, { slug: "" }, { slug: "slack" }, { slug: "gmail", label: "Gmail" }] })).toEqual([{ slug: "slack", label: "slack" }, { slug: "gmail", label: "Gmail" }]);
    expect(parseBusyHandoffs({ queued: [{ sourceBotId: "a" }, { sourceBotId: "a", targetBotId: "b", reason: "sort mail", sourceThreadId: 4 }] })).toEqual([{ sourceBotId: "a", targetBotId: "b", reason: "sort mail" }]);
  });
});
