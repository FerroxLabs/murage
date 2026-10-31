// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import {
  expiredToken, FAKE_CONNECTION_ID, highLevelHarness, until, malformedSuccess, missingScope, oversized, rateLimited, redirectTo, scriptCrm, serverError,
} from "../testing/fake-highlevel.ts";
import { HighLevelError, MAX_RESPONSE_BYTES, RATE_RESOURCES, type HighLevelCallContext } from "./client.ts";
import { HIGHLEVEL_API_ORIGIN, HIGHLEVEL_CRM_SCOPES } from "./provider-contract.ts";

function setup(options: Parameters<typeof highLevelHarness>[0] = {}) {
  const h = highLevelHarness(options);
  const view = h.leases.views.get(FAKE_CONNECTION_ID)!;
  const ctx = (dispatches: number[] = []): HighLevelCallContext => ({
    connection: { ...view }, signal: new AbortController().signal, assertActive: () => {}, onDispatch: (attempt) => { dispatches.push(attempt); },
  });
  return { h, view, ctx, crm: (c = ctx()) => h.client.crm(c) };
}

const outcomeOf = async (promise: Promise<unknown>) => {
  try { await promise; return "ok"; } catch (error) { return error instanceof HighLevelError ? error.outcome : String(error); }
};

describe("the HighLevel client (GAP-HIGHLEVEL-109 sections 7 and 13)", () => {
  it("talks only to the fixed host, never follows redirects, and sends the lease's token and the manifest Version", async () => {
    const { h, crm } = setup();
    scriptCrm(h.api);
    await crm().getContact("contact_1");
    await crm().readConversation("conv_1").catch(() => undefined);
    expect(h.api.requests.length).toBeGreaterThan(0);
    for (const request of h.api.requests) {
      expect(`https://${request.host}`).toBe(HIGHLEVEL_API_ORIGIN);
      expect(request.redirect).toBe("manual");
      expect(request.headers.authorization).toBe(`Bearer hl_access_${FAKE_CONNECTION_ID}_v1`);
    }
    expect(h.api.calls("GET", /^\/contacts\/contact_1$/u)[0]!.headers.version).toBe("2021-07-28");
    expect(h.api.calls("GET", /\/messages$/u)[0]!.headers.version).toBe("2021-04-15");
  });

  it("refuses a path outside the manifest before any lease or request", async () => {
    const { h, ctx } = setup();
    for (const [operation, path] of [["contacts.get", "/conversations/messages"], ["contacts.get", "/contacts/../workflows"], ["contacts.get", "/contacts/a?x=1"], ["locations.get", "/locations/x/customValues"]] as const) {
      await expect(h.client.request(ctx(), operation, path)).rejects.toThrow(/never sends this request/u);
    }
    expect(h.api.requests).toEqual([]);
    expect(h.leases.leaseRequests).toEqual([]);
  });

  it("refuses a redirect and never reaches the redirect target; a redirected change has an unknown outcome", async () => {
    const { h, crm } = setup();
    h.api.on("GET", /^\/contacts\/contact_1$/u, redirectTo("https://evil.test/steal"));
    await expect(crm().getContact("contact_1")).rejects.toThrow(/redirect/u);
    h.api.on("POST", /\/notes$/u, redirectTo("https://evil.test/steal"));
    expect(await outcomeOf(crm().addNote("contact_1", "x"))).toBe("outcome_unknown");
    expect(h.api.requests.map((request) => request.host)).toEqual(["services.leadconnectorhq.com", "services.leadconnectorhq.com"]);
  });

  it("stops reading at the streamed 4 MiB cap", async () => {
    const { h, crm } = setup();
    h.api.on("GET", /^\/contacts\/contact_1$/u, oversized(MAX_RESPONSE_BYTES * 4));
    await expect(crm().getContact("contact_1")).rejects.toThrow(/too large/u);
    // consumption stops at the cap: the rest of a 16 MiB body is never pulled
    expect(h.api.streamedBytes).toBeLessThanOrEqual(MAX_RESPONSE_BYTES + 4 * 64 * 1024);
    h.api.on("POST", /\/notes$/u, oversized(MAX_RESPONSE_BYTES + 1));
    expect(await outcomeOf(crm().addNote("contact_1", "x"))).toBe("outcome_unknown");
  });

  it("honours Retry-After on 429, then sends once more", async () => {
    const { h, crm } = setup();
    h.api.on("GET", /^\/opportunities\/pipelines$/u, rateLimited(3)).on("GET", /^\/opportunities\/pipelines$/u, { status: 200, body: { pipelines: [] } });
    const before = h.now;
    await expect(crm().listPipelines()).resolves.toEqual({ pipelines: [] });
    expect(h.now - before).toBeGreaterThanOrEqual(3_000);
    expect(h.api.calls("GET", /pipelines/u)).toHaveLength(2);
    h.api.on("GET", /^\/opportunities\/pipelines$/u, rateLimited(1)).on("GET", /^\/opportunities\/pipelines$/u, rateLimited(1));
    await expect(crm().listPipelines()).rejects.toThrow(/limiting requests/u);
  });

  it("waits out the full Retry-After (60 s) before the one read retry", async () => {
    const { h, crm } = setup();
    h.api.on("GET", /^\/opportunities\/pipelines$/u, rateLimited(60)).on("GET", /^\/opportunities\/pipelines$/u, { status: 200, body: { pipelines: [] } });
    const before = h.now;
    await crm().listPipelines();
    expect(h.now - before).toBeGreaterThanOrEqual(60_000);
  });

  it("uses one retry in all for a read, whatever the reasons", async () => {
    const { h, crm } = setup();
    h.api.on("GET", /^\/opportunities\/pipelines$/u, serverError()).on("GET", /^\/opportunities\/pipelines$/u, rateLimited(1)).on("GET", /^\/opportunities\/pipelines$/u, { status: 200, body: {} });
    await expect(crm().listPipelines()).rejects.toThrow(/limiting requests/u);
    expect(h.api.requests).toHaveLength(2);
  });

  it("retries a read at most once", async () => {
    const { h, crm } = setup();
    h.api.on("GET", /^\/opportunities\/pipelines$/u, serverError()).on("GET", /^\/opportunities\/pipelines$/u, { status: 200, body: { pipelines: [] } });
    await expect(crm().listPipelines()).resolves.toEqual({ pipelines: [] });
    h.api.requests.length = 0;
    h.api.on("GET", /^\/opportunities\/pipelines$/u, serverError()).on("GET", /^\/opportunities\/pipelines$/u, "reset").on("GET", /^\/opportunities\/pipelines$/u, { status: 200, body: {} });
    await expect(crm().listPipelines()).rejects.toThrow(/did not answer/u);
    expect(h.api.requests).toHaveLength(2);
  });

  it("never retries a change after anything that may have reached HighLevel", async () => {
    for (const reply of [serverError(500), serverError(503), { status: 408, body: {} }, "reset", "timeout", malformedSuccess, { status: 200, body: {} }, { status: 200, body: { note: {} } }, { status: 201, body: "" }] as const) {
      const { h, crm, ctx } = setup();
      const dispatches: number[] = [];
      h.api.always("POST", /\/notes$/u, reply);
      expect(await outcomeOf(crm(ctx(dispatches)).addNote("contact_1", "x")), String(typeof reply === "string" ? reply : JSON.stringify(reply))).toBe("outcome_unknown");
      expect(h.api.calls("POST", /\/notes$/u)).toHaveLength(1);
      expect(dispatches).toEqual([1]);
    }
  });

  it("a change refused with 429 or an expired token is not applied and never sent again", async () => {
    for (const reply of [rateLimited(1), expiredToken] as const) {
      const { h, crm, ctx } = setup();
      const dispatches: number[] = [];
      h.api.always("POST", /\/notes$/u, reply);
      expect(await outcomeOf(crm(ctx(dispatches)).addNote("contact_1", "x"))).toBe("not_applied");
      expect(h.api.calls("POST", /\/notes$/u)).toHaveLength(1);
      expect(dispatches).toEqual([1]);
      expect(h.leases.rotations).toEqual([]);
    }
  });

  it("a 401 without a readable expired-token answer never asks for a rotation", async () => {
    const { h, crm } = setup();
    h.api.always("GET", /^\/contacts\/contact_1$/u, { status: 401, body: "" });
    await expect(crm().getContact("contact_1")).rejects.toThrow();
    expect(h.leases.leaseRequests.map((request) => request.reason)).toEqual(["use"]);
    expect(h.leases.rotations).toEqual([]);
  });

  it("a confirmed refusal is not applied, and reads report a malformed answer", async () => {
    const { h, crm } = setup();
    h.api.on("POST", /\/notes$/u, { status: 422, body: { message: ["body must not be empty"] } });
    expect(await outcomeOf(crm().addNote("contact_1", "x"))).toBe("not_applied");
    h.api.on("GET", /^\/contacts\/c2$/u, malformedSuccess);
    await expect(crm().getContact("c2")).rejects.toThrow(/could not be read/u);
  });

  it("after an expired-token 401 asks for one new lease, which may rotate once, and keeps the call on its own sign-in", async () => {
    const { h, crm } = setup();
    scriptCrm(h.api);
    h.api.validTokens = h.leases.live;
    await crm().getContact("contact_1");
    expect(h.leases.rotations).toEqual([]);
    h.api.first("GET", /^\/contacts\/contact_1$/u, expiredToken);
    await crm().getContact("contact_1");
    expect(h.leases.rotations).toEqual([{ connectionId: FAKE_CONNECTION_ID, fromVersion: 1, reason: "expired" }]);
    expect(h.leases.leaseRequests.map((request) => [request.connectionId, request.reason])).toEqual([[FAKE_CONNECTION_ID, "use"], [FAKE_CONNECTION_ID, "expired"]]);
    // a second rejection right after the rotation asks the owner to Reconnect instead of rotating again
    h.api.first("GET", /^\/contacts\/contact_1$/u, expiredToken).first("GET", /^\/contacts\/contact_1$/u, expiredToken);
    await expect(crm().getContact("contact_1")).rejects.toMatchObject({ signedOut: true });
    expect(h.leases.rotations).toHaveLength(2);
  });

  it("a missing scope names the permission and does not rotate", async () => {
    const { h, crm } = setup();
    h.api.on("GET", /^\/opportunities\/pipelines$/u, missingScope);
    await expect(crm().listPipelines()).rejects.toThrow(/View Opportunities permission \(opportunities\.readonly\)/u);
    expect(h.leases.leaseRequests).toHaveLength(1);
    expect(h.leases.rotations).toEqual([]);
  });

  it("refuses a lease for another sign-in, location or epoch, and sends nothing with it", async () => {
    for (const substitute of [{ locationId: "loc_other" }, { companyId: "co_other" }, { connectionEpoch: 2 }, { connectionId: "hl_conn_2" }, { accessToken: "" }]) {
      const { h, crm } = setup();
      h.leases.substitute = substitute;
      await expect(crm().getContact("contact_1"), JSON.stringify(substitute)).rejects.toThrow(/connection changed/u);
      expect(h.api.requests).toEqual([]);
    }
  });

  it("never reuses a held lease for another location or company on the same connection and epoch", async () => {
    for (const change of [{ locationId: "loc_moved" }, { companyId: "co_moved" }]) {
      const { h, view, ctx } = setup();
      scriptCrm(h.api);
      await h.client.crm(ctx()).getContact("contact_1");
      expect(h.leases.leaseRequests).toHaveLength(1);
      const sent = h.api.requests.length;
      const moved = { ...ctx(), connection: { ...view, ...change } };
      await expect(h.client.crm(moved).getContact("contact_1"), JSON.stringify(change)).rejects.toThrow(/connection changed/u);
      expect(h.leases.leaseRequests).toHaveLength(2);
      expect(h.api.requests).toHaveLength(sent);
    }
  });

  it("takes a fresh lease when a long rate wait outlived the held one", async () => {
    const { h, view, ctx } = setup({ manualSleep: true });
    scriptCrm(h.api);
    for (let i = 0; i < 90; i++) (await h.client.gate.admit(view.locationId, ctx())).spend();
    h.leases.substitute = { discardAt: h.now + 5_000 };
    const pending = h.client.crm(ctx()).getContact("contact_1");
    await until(() => h.sleeps.length > 0);
    h.leases.substitute = null;
    h.advance(70_000);
    h.releaseSleeps();
    await pending;
    expect(h.leases.leaseRequests).toHaveLength(2);
    expect(h.api.calls("GET", /^\/contacts\/contact_1$/u)).toHaveLength(1);
  });

  it("drops a held lease when it stops being usable, with no further call", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { h, crm } = setup();
      scriptCrm(h.api);
      await crm().getContact("contact_1");
      expect(h.client.holdsLease(FAKE_CONNECTION_ID)).toBe(true);
      vi.advanceTimersByTime(60_001);
      expect(h.client.holdsLease(FAKE_CONNECTION_ID)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a new location when every rate window is in use, and never forgets a live one", async () => {
    const { h, view, ctx } = setup();
    const held = [];
    for (let i = 0; i < RATE_RESOURCES; i++) held.push(await h.client.gate.admit(`loc_${i}`, ctx()));
    await expect(h.client.gate.admit("loc_new", ctx())).rejects.toThrow(/Too many HighLevel locations/u);
    expect(h.client.gate.pending("loc_0")).toBe(1);
    held[0]!.release();
    h.advance(11_000);
    await expect(h.client.gate.admit(view.locationId, ctx())).resolves.toBeDefined();
  });

  it("keeps a lease in memory at most 60 seconds and never past the refresh margin", async () => {
    const { h, crm } = setup();
    scriptCrm(h.api);
    await crm().getContact("contact_1");
    await crm().getContact("contact_1");
    expect(h.leases.leaseRequests).toHaveLength(1);
    h.advance(61_000);
    await crm().getContact("contact_1");
    expect(h.leases.leaseRequests).toHaveLength(2);
    const near = setup({ tokenExpiresInMs: 90_000 });
    scriptCrm(near.h.api);
    await near.crm().getContact("contact_1");
    near.h.advance(31_000);
    await near.crm().getContact("contact_1");
    expect(near.h.leases.leaseRequests).toHaveLength(2);
  });

  it("asks for exactly the ten CRM scopes the manifest uses", () => {
    expect(HIGHLEVEL_CRM_SCOPES).toEqual([
      "calendars.readonly", "calendars/events.readonly", "contacts.readonly", "contacts.write", "conversations.readonly",
      "conversations/message.readonly", "locations.readonly", "locations/customFields.readonly", "opportunities.readonly", "opportunities.write",
    ]);
  });
});
