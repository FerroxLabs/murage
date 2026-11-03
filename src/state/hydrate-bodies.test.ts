// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PHONE-HYDRATE-BAD-BODY (11-02): an Android on reconnect got a /api/routines reply with no `runs` and the whole UI
// stopped drawing (TypeError in trimRoutineRuns). A bad snapshot reply now keeps what is on screen and is asked again.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MalformedReplyError, configReply, instancesReply, openCardsReply, routinesReply, sidebarReply, webhooksReply } from "./hydrate-bodies";
import { initialState, reducer, type AppState } from "./store";

const BAD_BODIES: unknown[] = ["<!doctype html><html><body>Bad gateway</body></html>", {}, null, undefined, [], 42];

describe("snapshot replies are checked before they are applied", () => {
  it.each(BAD_BODIES)("a reply of %j is refused, never applied", (body) => {
    const checks: Array<(reply: unknown) => unknown> = [routinesReply, instancesReply, webhooksReply, sidebarReply, configReply, openCardsReply];
    for (const check of checks) expect(() => check(body)).toThrow(MalformedReplyError);
  });

  it("a reply with one list missing or the wrong type is refused", () => {
    expect(() => routinesReply({ routines: [] })).toThrow(/runs/);
    expect(() => routinesReply({ routines: [], runs: "none" })).toThrow(/runs/);
    expect(() => routinesReply({ runs: [] })).toThrow(/routines/);
    expect(() => instancesReply({ instances: {} })).toThrow(/instances/);
    expect(() => webhooksReply({ webhooks: [], attempts: {} })).toThrow(/attempts/);
    expect(() => sidebarReply({ bots: [], groups: "x" })).toThrow(/groups/);
    expect(() => configReply("<html>")).toThrow(MalformedReplyError);
    expect(() => configReply(null)).toThrow(MalformedReplyError);
    expect(() => configReply({ error: "unavailable" })).toThrow(/surface/);
    expect(() => configReply({ surface: "remote" })).toThrow(/connected apps block/);
    expect(() => openCardsReply({ activeLeafId: "m1" })).toThrow(/openCards/);
    expect(() => openCardsReply({ openCards: {} })).toThrow(/openCards/);
  });

  it("a good reply passes through as it came", () => {
    expect(routinesReply({ routines: [{ id: "r" }], runs: [] })).toEqual({ routines: [{ id: "r" }], runs: [] });
    expect(instancesReply({ instances: [], engineNote: "n" })).toEqual({ instances: [], shellEnvironment: undefined, engineNote: "n" });
    expect(webhooksReply({ webhooks: [], ingress: null })).toEqual({ webhooks: [], attempts: [], ingress: null });
    expect(sidebarReply({ bots: [] })).toEqual({ bots: [] });
    const config = { surface: "remote", composio: { configured: false }, computer: false };
    expect(configReply(config)).toBe(config);
    expect(openCardsReply({ activeLeafId: "m1", openCards: [], pending: true })).toEqual({ activeLeafId: "m1", openCards: [], pending: true });
  });
});

describe("the store keeps what is on screen when a bad reply gets through", () => {
  const shown: AppState = { ...initialState, routines: [{ id: "kept" } as AppState["routines"][number]] };
  it.each([
    { type: "routinesHydrated", routines: [], runs: undefined },
    { type: "routinesHydrated", routines: undefined, runs: undefined },
    { type: "webhooksHydrated", webhooks: undefined, attempts: [], ingress: null },
    { type: "instances", instances: undefined },
    { type: "hydrate", bots: undefined, groups: [], computerControl: {}, sentTick: 0, liveGen: 0 },
  ])("$type with a missing list leaves the state as it was", (action) => {
    expect(() => reducer(shown, action as never)).not.toThrow();
    expect(reducer(shown, action as never)).toBe(shown);
  });

  it("every snapshot part goes through its check before it is dispatched", () => {
    const store = readFileSync(new URL("./store.tsx", import.meta.url), "utf8");
    expect(store).toContain('routinesReply<Routine, RoutineRun>(await api("/api/routines"))');
    expect(store).toContain('instancesReply<InstanceInfo>(await api("/api/instances"))');
    expect(store).toContain('configReply<ConfigStatus>(await api("/api/config"))');
    expect(store).toContain('webhooksReply<WebhookTrigger, WebhookAttempt>(await api("/api/webhooks"))');
    expect(store).toContain("const answer = sidebarReply(reply)");
    // both open-card reads refuse a reply without a card list and ask again after a wait
    expect(store.match(/const result = openCardsReply<Message>\(body\);/g)).toHaveLength(2);
    expect(store).toContain(".catch(askAgain);\n  }, [cardsThread, cardsLeaf, cardsRev, cardsRetry, dispatch]);");
    expect(store).not.toMatch(/const \{[^}]*\} = await api\("\/api\/(routines|instances|webhooks)"\)/);
  });
});
