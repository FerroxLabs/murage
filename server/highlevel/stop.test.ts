// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The two H3 Stop checks (GAP-HIGHLEVEL-109 sections 9.2 and 13; gates HIGHLEVEL-WRITE-OUTCOMES and
// HIGHLEVEL-CRASH-ROTATION; upstream b075d6be4 and 746a718f4). stop() does what index.ts revokeInternalGeneration
// does for HighLevel: revoke the turn's capability and fire highlevelCalls.turnEnded(generation).
import { describe, expect, it } from "vitest";
import { FAKE_CONNECTION_ID, FAKE_LOCATION_ID, highLevelHarness, rateLimited, scriptCrm, until } from "../testing/fake-highlevel.ts";
import { BUDGET_CALLS, type HighLevelCallContext } from "./client.ts";

const NOTE = { contactId: "contact_1", body: "Fixture note" };

/** Uses up the location's rate room from another, live caller. */
async function fillBudget(h: ReturnType<typeof highLevelHarness>) {
  const live: HighLevelCallContext = { connection: h.leases.views.get(FAKE_CONNECTION_ID)!, signal: new AbortController().signal, assertActive: () => {} };
  for (let i = 0; i < BUDGET_CALLS; i++) (await h.client.gate.admit(FAKE_LOCATION_ID, live)).spend();
}

describe("Stop cancels a call waiting on rate admission (H3, HIGHLEVEL-WRITE-OUTCOMES)", () => {
  it("Stop during a rate wait sends nothing, releases the reservation and records the change not_applied/stopped_before_send", async () => {
    const h = highLevelHarness({ manualSleep: true });
    scriptCrm(h.api);
    await fillBudget(h);
    const pending = h.host.call(h.claim, "HIGHLEVEL_ADD_NOTE", NOTE);
    const review = await h.approveNext();
    await until(() => h.sleeps.length > 0);
    expect(h.api.requests).toEqual([]);
    h.stop();
    const result = await pending;
    expect(result).toMatchObject({ isError: true, structuredContent: { stopped: true, outcome: "not_applied" } });
    expect(h.actions.get(review.actionId)).toMatchObject({ phase: "not_applied", outcomeCode: "stopped_before_send", dispatchAttempts: 0 });
    expect(h.client.gate.pending(FAKE_LOCATION_ID)).toBe(0);
    h.releaseSleeps();
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.api.requests).toEqual([]);
  });

  it("Stop during a read's Retry-After wait sends no second request", async () => {
    const h = highLevelHarness({ manualSleep: true });
    scriptCrm(h.api);
    h.api.first("GET", /^\/contacts\/contact_1$/u, rateLimited(3));
    const pending = h.host.call(h.claim, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" });
    await until(() => h.sleeps.some((sleep) => sleep.ms === 3_000));
    expect(h.api.calls("GET", /^\/contacts\/contact_1$/u)).toHaveLength(1);
    h.stop();
    expect(await pending).toMatchObject({ isError: true, structuredContent: { stopped: true } });
    h.releaseSleeps();
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.api.calls("GET", /^\/contacts\/contact_1$/u)).toHaveLength(1);
  });

  it("a change refused with 429 is not applied and never sent again", async () => {
    const h = highLevelHarness({ manualSleep: true });
    scriptCrm(h.api);
    h.api.first("POST", /\/notes$/u, rateLimited(3));
    const pending = h.host.call(h.claim, "HIGHLEVEL_ADD_NOTE", NOTE);
    const review = await h.approveNext();
    expect(await pending).toMatchObject({ isError: true, structuredContent: { outcome: "not_applied" } });
    expect(h.api.calls("POST", /\/notes$/u)).toHaveLength(1);
    expect(h.actions.get(review.actionId)).toMatchObject({ phase: "not_applied", dispatchAttempts: 1 });
  });

  it("Stop after the reservation is taken and before the send releases it and sends nothing", async () => {
    const h = highLevelHarness();
    scriptCrm(h.api);
    // Stop lands inside the pre-send authority recheck, which runs while the reservation is held.
    const pending = h.host.call(h.claim, "HIGHLEVEL_ADD_NOTE", NOTE);
    const review = await h.approveNext();
    h.leases.onConnection = () => {
      if (h.client.gate.pending(FAKE_LOCATION_ID) === 0) return;
      h.leases.onConnection = null;
      reserved = h.client.gate.pending(FAKE_LOCATION_ID);
      h.stop();
    };
    let reserved = 0;
    expect(await pending).toMatchObject({ isError: true, structuredContent: { stopped: true, outcome: "not_applied" } });
    expect(reserved).toBe(1);
    expect(h.client.gate.pending(FAKE_LOCATION_ID)).toBe(0);
    expect(h.api.requests).toEqual([]);
    expect(h.actions.get(review.actionId)).toMatchObject({ phase: "not_applied", outcomeCode: "stopped_before_send", dispatchAttempts: 0 });
  });

  it("a read waiting on rate room ends at once, and a queued next call never leaves", async () => {
    const h = highLevelHarness({ manualSleep: true });
    scriptCrm(h.api);
    await fillBudget(h);
    const first = h.host.call(h.claim, "HIGHLEVEL_LIST_PIPELINES", {});
    const second = h.host.call(h.claim, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" });
    await until(() => h.sleeps.length >= 2);
    h.stop();
    for (const result of await Promise.all([first, second])) expect(result).toMatchObject({ isError: true, structuredContent: { stopped: true } });
    const after = await h.host.call(h.claim, "HIGHLEVEL_GET_LOCATION", {});
    expect(after).toMatchObject({ isError: true });
    h.releaseSleeps();
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.api.requests).toEqual([]);
    expect(h.client.gate.pending(FAKE_LOCATION_ID)).toBe(0);
  });

  it("Stop while the change waits for the owner's review records it not_applied and sends nothing", async () => {
    const h = highLevelHarness();
    scriptCrm(h.api);
    const pending = h.host.call(h.claim, "HIGHLEVEL_ADD_NOTE", NOTE);
    await until(() => h.reviews.length > 0);
    h.stop();
    expect(await pending).toMatchObject({ isError: true, structuredContent: { stopped: true, outcome: "not_applied" } });
    expect(h.actions.get(h.reviews[0]!.actionId)).toMatchObject({ phase: "not_applied", outcomeCode: "stopped_before_send" });
    expect(() => h.actions.approve(h.reviews[0]!.actionId, h.reviews[0]!.reviewDigest)).toThrow(/not waiting/u);
    expect(h.api.requests).toEqual([]);
  });

  it("Stop during an in-flight change keeps outcome_unknown and never resends", async () => {
    const h = highLevelHarness({ deadlineMs: 40 });
    scriptCrm(h.api);
    h.api.first("POST", /\/notes$/u, "timeout");
    const pending = h.host.call(h.claim, "HIGHLEVEL_ADD_NOTE", NOTE);
    const review = await h.approveNext();
    await until(() => h.api.calls("POST", /\/notes$/u).length === 1);
    h.stop();
    expect(await pending).toMatchObject({ isError: true, structuredContent: { outcome: "outcome_unknown" } });
    expect(h.actions.get(review.actionId)).toMatchObject({ phase: "outcome_unknown", dispatchAttempts: 1 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.api.calls("POST", /\/notes$/u)).toHaveLength(1);
  });
});

describe("Stop is checked before any lease request that could start a refresh (H3, HIGHLEVEL-CRASH-ROTATION)", () => {
  it("a stopped turn whose token is inside the refresh margin makes zero lease and zero rotation requests", async () => {
    const h = highLevelHarness({ tokenExpiresInMs: 30_000 });
    scriptCrm(h.api);
    // Stop lands during the call's asynchronous setup (its connection status read), before the first lease request.
    h.leases.onConnection = () => { h.leases.onConnection = null; queueMicrotask(() => h.stop()); };
    const result = await h.host.call(h.claim, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" });
    expect(result).toMatchObject({ isError: true });
    expect(h.leases.leaseRequests).toEqual([]);
    expect(h.leases.rotations).toEqual([]);
    expect(h.api.requests).toEqual([]);
  });

  it("Stop during a wait, with the token now inside the margin, sends no lease request after the wait", async () => {
    const h = highLevelHarness({ manualSleep: true, tokenExpiresInMs: 5 * 60_000 });
    scriptCrm(h.api);
    h.api.first("GET", /^\/contacts\/contact_1$/u, rateLimited(3));
    const pending = h.host.call(h.claim, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" });
    await until(() => h.sleeps.length > 0);
    expect(h.leases.leaseRequests).toHaveLength(1);
    h.advance(5 * 60_000 - 10_000);
    h.stop();
    expect(await pending).toMatchObject({ isError: true, structuredContent: { stopped: true } });
    h.releaseSleeps();
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.leases.leaseRequests).toHaveLength(1);
    expect(h.leases.rotations).toEqual([]);
  });

  it("Stop after the broker sent a rotation delivers no token to the stopped turn; a later turn gets it with a new request", async () => {
    const h = highLevelHarness({ tokenExpiresInMs: 30_000 });
    scriptCrm(h.api);
    h.api.validTokens = h.leases.live;
    let release!: () => void;
    h.leases.hold = new Promise<void>((resolve) => { release = resolve; });
    const pending = h.host.call(h.claim, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" });
    await until(() => h.leases.rotations.length === 1);
    h.stop();
    release();
    h.leases.hold = null;
    expect(await pending).toMatchObject({ isError: true, structuredContent: { stopped: true } });
    expect(h.api.requests).toEqual([]);
    expect(h.leases.rotations).toHaveLength(1);
    const next = h.turn("gen_2");
    const result = await h.host.call(next, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" });
    expect(result.isError).toBeUndefined();
    expect(h.leases.leaseRequests).toHaveLength(2);
    expect(h.leases.rotations).toHaveLength(1);
    expect(h.api.requests.every((request) => request.headers.authorization === `Bearer hl_access_${FAKE_CONNECTION_ID}_v2`)).toBe(true);
  });

  it("a live turn on the same client is not affected by another turn's Stop", async () => {
    const h = highLevelHarness({ manualSleep: true });
    scriptCrm(h.api);
    h.api.first("GET", /^\/contacts\/contact_1$/u, rateLimited(3));
    const stopped = h.host.call(h.claim, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" });
    await until(() => h.sleeps.length > 0);
    const live = h.turn("gen_live", {}, "thread_2");
    h.stop();
    expect(await stopped).toMatchObject({ structuredContent: { stopped: true } });
    const pending = h.host.call(live, "HIGHLEVEL_ADD_NOTE", NOTE);
    await h.approveNext();
    expect(await h.settle(pending)).toMatchObject({ structuredContent: { outcome: "applied" } });
    expect(h.api.calls("POST", /\/notes$/u)).toHaveLength(1);
    expect(h.signals.signalFor(h.claim).aborted).toBe(true);
  });
});
