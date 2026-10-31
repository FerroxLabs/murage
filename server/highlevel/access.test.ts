// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// HIGHLEVEL-TOOLS-AND-GRANTS (GAP-HIGHLEVEL-109 section 16), first slice: native membership, ceilings, draft-only,
// exact review staleness, forged capabilities, non-owner rooms, external relays and pending connections.
import { describe, expect, it } from "vitest";
import { HIGHLEVEL_TOOL_NAMES, HIGHLEVEL_WRITE_TOOLS } from "../../shared/highlevel.ts";
import { accessRoleBinding } from "../bot-access-role.ts";
import { FAKE_CONNECTION_ID, highLevelHarness, scriptCrm, until } from "../testing/fake-highlevel.ts";
import { assertConnectedAppCall } from "../bot-access.ts";
import { filterRelayToolList, filterRelayToolListBytes, highlevelRelayRefusal, visibleHighLevelTools } from "./access.ts";
import { argumentsDigest, HighLevelActions, normalizeArguments, reviewDigestFor, type ActionIntent } from "./actions.ts";

const WRITE_ARGS: Record<string, Record<string, unknown>> = {
  HIGHLEVEL_CREATE_CONTACT: { email: "new@fixture.test" },
  HIGHLEVEL_UPDATE_CONTACT: { contactId: "contact_1", city: "Paris" },
  HIGHLEVEL_ADD_TAGS: { contactId: "contact_1", tags: ["vip"] },
  HIGHLEVEL_REMOVE_TAGS: { contactId: "contact_1", tags: ["vip"] },
  HIGHLEVEL_ADD_NOTE: { contactId: "contact_1", body: "x" },
  HIGHLEVEL_ADD_TASK: { contactId: "contact_1", title: "Call", dueDate: "2026-11-01T10:00:00Z" },
  HIGHLEVEL_CREATE_OPPORTUNITY: { pipelineId: "pipe_1", contactId: "contact_1", name: "Deal" },
  HIGHLEVEL_UPDATE_OPPORTUNITY: { opportunityId: "opp_1", status: "won" },
};

const code = (result: { structuredContent?: Record<string, unknown> }) => result.structuredContent?.code;

describe("native membership comes before every generic shortcut", () => {
  it("unrestricted generic access without a native grant gets no HighLevel tool and sends nothing", async () => {
    const h = highLevelHarness();
    scriptCrm(h.api);
    delete h.bot.highlevelAccess;
    expect(h.bot.connectedAppAccess).toBeUndefined();
    expect(visibleHighLevelTools(h.bot)).toEqual([]);
    expect(code(await h.host.call(h.claim, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" }))).toBe("not_granted");
    expect((await h.host.handle(h.claim, { jsonrpc: "2.0", id: 1, method: "tools/list" })).result).toEqual({ tools: [] });
    expect(h.api.requests).toEqual([]);
    expect(h.leases.leaseRequests).toEqual([]);
  });

  it("a grant for another bot, another connection or a missing tool grants nothing", async () => {
    const h = highLevelHarness();
    scriptCrm(h.api);
    h.saveAccess([{ ...h.grant(), botId: "bot_other" }]);
    expect(code(await h.host.call(h.claim, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" }))).toBe("not_granted");
    h.saveAccess([h.grant("read", "hl_conn_other")]);
    expect(code(await h.host.call(h.claim, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1", connectionId: FAKE_CONNECTION_ID }))).toBe("not_granted");
    h.saveAccess([{ ...h.grant(), tools: ["HIGHLEVEL_LIST_PIPELINES"] }]);
    expect(code(await h.host.call(h.claim, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" }))).toBe("not_granted");
    expect(h.api.requests).toEqual([]);
  });

  it("two granted locations need an explicit connectionId", async () => {
    const h = highLevelHarness();
    scriptCrm(h.api);
    h.leases.add({ connectionId: "hl_conn_2", locationId: "loc_2" });
    h.saveAccess([h.grant(), h.grant("read", "hl_conn_2")]);
    expect(code(await h.host.call(h.claim, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" }))).toBe("choose_connection");
    expect((await h.host.call(h.claim, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1", connectionId: FAKE_CONNECTION_ID })).isError).toBeUndefined();
  });

  it("a role change leaves the saved grants stale until the owner saves again", async () => {
    const h = highLevelHarness();
    scriptCrm(h.api);
    h.bot.title = "Promoted";
    expect(code(await h.host.call(h.claim, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" }))).toBe("not_granted");
    h.saveAccess();
    expect((await h.host.call(h.claim, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" })).isError).toBeUndefined();
  });
});

describe("ceilings and draft-only", () => {
  it("ceiling read refuses every change and hides it from tools/list", async () => {
    const h = highLevelHarness({ ceiling: "read" });
    scriptCrm(h.api);
    for (const tool of HIGHLEVEL_WRITE_TOOLS) expect(code(await h.host.call(h.claim, tool, WRITE_ARGS[tool]!)), tool).toBe("read_only");
    const listed = visibleHighLevelTools(h.bot);
    for (const tool of HIGHLEVEL_WRITE_TOOLS) expect(listed).not.toContain(tool);
    expect(listed).toContain("HIGHLEVEL_GET_CONTACT");
    expect(h.reviews).toEqual([]);
    expect(h.api.requests).toEqual([]);
  });

  it("restricted generic access with allowWrites:false stays a further ceiling on changes, and reads still work", async () => {
    const h = highLevelHarness();
    scriptCrm(h.api);
    h.bot.connectedAppAccess = { revision: 0, roleBinding: accessRoleBinding(h.bot), mode: "restricted", allowWrites: false, grants: [], requests: [] };
    for (const tool of HIGHLEVEL_WRITE_TOOLS) expect(code(await h.host.call(h.claim, tool, WRITE_ARGS[tool]!)), tool).toBe("writes_blocked");
    expect((await h.host.call(h.claim, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" })).isError).toBeUndefined();
    expect(h.api.calls("POST", /\/notes$/u)).toEqual([]);
  });

  it("a draft-only bot gets verified reads only", async () => {
    const h = highLevelHarness();
    scriptCrm(h.api);
    h.bot.draftOnly = true;
    for (const tool of HIGHLEVEL_WRITE_TOOLS) expect(code(await h.host.call(h.claim, tool, WRITE_ARGS[tool]!)), tool).toBe("draft_only");
    expect(visibleHighLevelTools(h.bot).filter((tool) => HIGHLEVEL_WRITE_TOOLS.has(tool as never))).toEqual([]);
    expect((await h.host.call(h.claim, "HIGHLEVEL_LIST_PIPELINES", {})).isError).toBeUndefined();
  });

  it("connected apps off for the bot refuses everything, helpers included", async () => {
    const h = highLevelHarness();
    h.bot.composio = false;
    expect(code(await h.host.call(h.claim, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" }))).toBe("bot_unavailable");
    expect((await h.host.call(h.claim, "HIGHLEVEL_LIST_CONNECTIONS", {})).isError).toBe(true);
    expect(visibleHighLevelTools(h.bot)).toEqual([]);
  });
});

describe("exact review: a changed argument, role, revision or epoch stales the approval", () => {
  it("an approval for different arguments does not approve this change", async () => {
    const h = highLevelHarness();
    scriptCrm(h.api);
    const pending = h.host.call(h.claim, "HIGHLEVEL_ADD_NOTE", { contactId: "contact_1", body: "approved text" });
    await until(() => h.reviews.length > 0);
    const review = h.reviews[0]!;
    const row = h.actions.get(review.actionId)!;
    const other = reviewDigestFor({ ...row, argumentsDigest: argumentsDigest("HIGHLEVEL_ADD_NOTE", { contactId: "contact_1", body: "other text" }) });
    expect(() => h.actions.approve(review.actionId, other)).toThrow(/different change/u);
    expect(review.values).toEqual({ contactId: "contact_1", body: "approved text" });
    h.actions.deny(review.actionId);
    expect(await pending).toMatchObject({ isError: true, structuredContent: { outcome: "not_applied" } });
    expect(h.api.requests).toEqual([]);
  });

  for (const [what, change] of [
    ["role", (h: ReturnType<typeof highLevelHarness>) => { h.bot.title = "Changed"; h.saveAccess(); }],
    ["access record revision", (h: ReturnType<typeof highLevelHarness>) => { h.saveAccess([h.grant()], 2); }],
    ["selected grant's own revision", (h: ReturnType<typeof highLevelHarness>) => { h.saveAccess([{ ...h.grant(), revision: 2 }], 1); }],
    ["company", (h: ReturnType<typeof highLevelHarness>) => { h.leases.views.get(FAKE_CONNECTION_ID)!.companyId = "co_moved"; }],
    ["policy revision", (h: ReturnType<typeof highLevelHarness>) => { h.bot.connectedAppAccess = { revision: 7, roleBinding: accessRoleBinding(h.bot), mode: "unrestricted", allowWrites: true, grants: [], requests: [] }; }],
    ["connection epoch", (h: ReturnType<typeof highLevelHarness>) => { h.leases.views.get(FAKE_CONNECTION_ID)!.epoch = 2; }],
  ] as const) {
    it(`a ${what} change after approval stales it and sends nothing`, async () => {
      const h = highLevelHarness();
      scriptCrm(h.api);
      const pending = h.host.call(h.claim, "HIGHLEVEL_ADD_NOTE", { contactId: "contact_1", body: "x" });
      await until(() => h.reviews.length > 0);
      const review = h.reviews[0]!;
      change(h);
      h.actions.approve(review.actionId, review.reviewDigest);
      expect(await pending).toMatchObject({ isError: true, structuredContent: { outcome: "stale" } });
      expect(h.actions.get(review.actionId)!.phase).toBe("stale");
      expect(h.api.calls("POST", /\/notes$/u)).toEqual([]);
    });
  }

  it("a grant revoked during the pre-send rate wait stales the approval and sends nothing", async () => {
    const h = highLevelHarness({ manualSleep: true });
    scriptCrm(h.api);
    const view = h.leases.views.get(FAKE_CONNECTION_ID)!;
    const live = { connection: view, signal: new AbortController().signal, assertActive: () => {} };
    for (let i = 0; i < 90; i++) (await h.client.gate.admit(view.locationId, live)).spend();
    const pending = h.host.call(h.claim, "HIGHLEVEL_ADD_NOTE", { contactId: "contact_1", body: "x" });
    const review = await h.approveNext();
    await until(() => h.sleeps.length > 0);
    h.saveAccess([h.grant("read")], 2);
    h.advance(20_000);
    h.releaseSleeps();
    expect(await pending).toMatchObject({ isError: true, structuredContent: { outcome: "stale" } });
    expect(h.actions.get(review.actionId)).toMatchObject({ phase: "stale", dispatchAttempts: 0 });
    expect(h.api.calls("POST", /\/notes$/u)).toEqual([]);
  });

  it("a grant revoked while the connection status is read is honoured at once, for reads and changes", async () => {
    const h = highLevelHarness();
    scriptCrm(h.api);
    h.leases.onConnection = () => { h.leases.onConnection = null; h.saveAccess([], 2); };
    expect(code(await h.host.call(h.claim, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" }))).toBe("not_granted");
    expect(h.api.requests).toEqual([]);
    const w = highLevelHarness();
    scriptCrm(w.api);
    const pending = w.host.call(w.claim, "HIGHLEVEL_ADD_NOTE", { contactId: "contact_1", body: "x" });
    const review = await w.approveNext();
    // the downgrade lands during a post-approval recheck's own status read
    w.leases.onConnection = () => { w.leases.onConnection = null; w.saveAccess([w.grant("read")], 2); };
    expect(await pending).toMatchObject({ isError: true, structuredContent: { outcome: "stale" } });
    expect(w.actions.get(review.actionId)).toMatchObject({ phase: "stale", dispatchAttempts: 0 });
    expect(w.api.calls("POST", /\/notes$/u)).toEqual([]);
  });

  it("a read that waited for rate room is authorized again before it leaves", async () => {
    const h = highLevelHarness({ manualSleep: true });
    scriptCrm(h.api);
    const view = h.leases.views.get(FAKE_CONNECTION_ID)!;
    const live = { connection: view, signal: new AbortController().signal, assertActive: () => {} };
    for (let i = 0; i < 90; i++) (await h.client.gate.admit(view.locationId, live)).spend();
    const pending = h.host.call(h.claim, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" });
    await until(() => h.sleeps.length > 0);
    h.saveAccess([], 2);
    h.advance(20_000);
    h.releaseSleeps();
    expect(await pending).toMatchObject({ isError: true });
    expect(h.api.requests).toEqual([]);
  });

  it("the custom-field read inside an approved change is authorized again before it leaves", async () => {
    const h = highLevelHarness({ manualSleep: true });
    scriptCrm(h.api);
    const view = h.leases.views.get(FAKE_CONNECTION_ID)!;
    const live = { connection: view, signal: new AbortController().signal, assertActive: () => {} };
    for (let i = 0; i < 90; i++) (await h.client.gate.admit(view.locationId, live)).spend();
    const pending = h.host.call(h.claim, "HIGHLEVEL_CREATE_CONTACT", { firstName: "Ada", customFields: { "Lead source": "web" } });
    const review = await h.approveNext();
    await until(() => h.sleeps.length > 0);
    h.saveAccess([], 2);
    h.advance(20_000);
    h.releaseSleeps();
    expect(await pending).toMatchObject({ isError: true });
    expect(h.api.calls("GET", /customFields/u)).toEqual([]);
    expect(h.api.calls("POST", /^\/contacts\/$/u)).toEqual([]);
    expect(h.actions.get(review.actionId)!.dispatchAttempts).toBe(0);
  });

  it("HIGHLEVEL_LIST_CONNECTIONS answers only with grants still held after its status reads", async () => {
    const h = highLevelHarness();
    h.leases.onConnection = () => { h.leases.onConnection = null; h.saveAccess([], 2); };
    const result = await h.host.call(h.claim, "HIGHLEVEL_LIST_CONNECTIONS", {});
    expect(result.structuredContent).toMatchObject({ connections: [] });
  });

  it("refuses arguments over 64 KiB before review", async () => {
    const h = highLevelHarness();
    const result = await h.host.call(h.claim, "HIGHLEVEL_ADD_NOTE", { contactId: "contact_1", body: "x".repeat(70 * 1024) });
    expect(result.content[0]!.text).toMatch(/larger than 64 KiB/u);
    expect(h.reviews).toEqual([]);
  });

  it("a review expiry that cannot be recorded rejects the wait and leaves nothing dispatchable", async () => {
    let failing = false;
    const rows = new Map<string, ActionIntent>();
    const journal = { put: (row: ActionIntent) => { if (failing) throw new Error("disk full"); rows.set(row.actionId, row); }, delete: (id: string) => { rows.delete(id); }, all: () => [...rows.values()] };
    const actions = new HighLevelActions({ journal, reviewTtlMs: 5 });
    const review = actions.propose({ botId: "b", threadId: "t", turnGeneration: "g", connectionId: "hl_a", connectionEpoch: 1, locationId: "l", companyId: "c",
      grantRevision: 1, accessRevision: 1, policyRevision: 1, roleBinding: "r" }, "HIGHLEVEL_ADD_NOTE", { contactId: "c1", body: "x" }, { recordRefs: [], fields: ["body"] });
    failing = true;
    await expect(actions.awaitDecision(review.actionId, new AbortController().signal)).rejects.toThrow(/could not be recorded/u);
    expect(actions.review(review.actionId)).toBeUndefined();
  });

  it("sends only the reviewed values, even if the caller's arguments change after the proposal", async () => {
    const h = highLevelHarness();
    scriptCrm(h.api);
    const args: Record<string, unknown> = { contactId: "contact_1", body: "approved text" };
    const pending = h.host.call(h.claim, "HIGHLEVEL_ADD_NOTE", args);
    await until(() => h.reviews.length > 0);
    args.body = "swapped text";
    h.actions.approve(h.reviews[0]!.actionId, h.reviews[0]!.reviewDigest);
    expect(await pending).toMatchObject({ structuredContent: { outcome: "applied" } });
    const sent = h.api.calls("POST", /\/notes$/u);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ body: "approved text" });
  });

  it("a nested field named connectionId is part of the reviewed change", () => {
    const a = normalizeArguments({ connectionId: "hl_a", contactId: "c", customFields: [{ key: "connectionId", value: "1", connectionId: "x" }] });
    expect(a).toEqual({ contactId: "c", customFields: [{ connectionId: "x", key: "connectionId", value: "1" }] });
    expect(argumentsDigest("HIGHLEVEL_UPDATE_CONTACT", { contactId: "c", customFields: [{ connectionId: "x" }] }))
      .not.toBe(argumentsDigest("HIGHLEVEL_UPDATE_CONTACT", { contactId: "c", customFields: [{ connectionId: "y" }] }));
  });

  it("an approved change runs once and leaves a receipt with ids and field names only", async () => {
    const h = highLevelHarness();
    scriptCrm(h.api);
    const pending = h.host.call(h.claim, "HIGHLEVEL_ADD_NOTE", { contactId: "contact_1", body: "secret value" });
    const review = await h.approveNext();
    expect(await pending).toMatchObject({ structuredContent: { outcome: "applied" } });
    const row = h.actions.get(review.actionId)!;
    expect(row).toMatchObject({ phase: "applied", dispatchAttempts: 1, receipt: { recordId: "note_new", fields: ["body"], approvalBasis: "owner_exact_review" } });
    expect(JSON.stringify(row)).not.toContain("secret value");
    expect(h.api.calls("POST", /\/notes$/u)).toHaveLength(1);
    expect(h.actions.statusFor("bot_other", review.actionId)).toBeUndefined();
    expect((await h.host.call(h.claim, "HIGHLEVEL_ACTION_STATUS", { actionId: review.actionId })).structuredContent).toMatchObject({ phase: "applied" });
  });
});

describe("capability, audience and relay boundaries", () => {
  it("refuses a claim of another kind, a copied claim object and a revoked claim", async () => {
    const h = highLevelHarness();
    scriptCrm(h.api);
    h.capabilities.begin("bot_1", "thread_x", "gen_x");
    const other = h.capabilities.resolve(`Bearer ${h.capabilities.mint({ botId: "bot_1", threadId: "thread_x", generation: "gen_x", kind: "connectors", depth: 0, skillAuthoring: false })}`)!;
    expect((await h.host.call(other, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" })).content[0]!.text).toMatch(/cannot reach HighLevel/u);
    expect((await h.host.handle(other, { id: 1, method: "tools/list" })).error).toBeDefined();
    expect((await h.host.call({ ...h.claim }, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" })).content[0]!.text).toMatch(/turn has ended/u);
    h.stop();
    expect((await h.host.call(h.claim, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" })).content[0]!.text).toMatch(/turn has ended/u);
    expect(h.api.requests).toEqual([]);
  });

  it("refuses a turn whose audience is not the owner (a room with other people)", async () => {
    const h = highLevelHarness();
    scriptCrm(h.api);
    const room = h.turn("gen_room", { notOwnerAudience: true }, "thread_room");
    expect((await h.host.call(room, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" })).content[0]!.text).toMatch(/owner's own conversations/u);
    expect(h.api.requests).toEqual([]);
  });

  it("external relays can neither run nor discover a native name", () => {
    expect(highlevelRelayRefusal({ method: "tools/call", params: { name: "HIGHLEVEL_GET_CONTACT", arguments: {} } })).toMatch(/only through Murage's own/u);
    expect(highlevelRelayRefusal([{ method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "HIGHLEVEL_ADD_NOTE", account: "a", arguments: {} }] } } }])).not.toBeNull();
    expect(highlevelRelayRefusal({ method: "tools/call", params: { name: "GMAIL_FETCH_EMAILS", arguments: {} } })).toBeNull();
    expect(highlevelRelayRefusal({ method: "tools/list" })).toBeNull();
    const listed = filterRelayToolList({ tools: [{ name: "HIGHLEVEL_GET_CONTACT" }, { name: "GMAIL_FETCH_EMAILS" }, { name: "HIGHLEVEL_ACTION_STATUS" }] });
    expect(listed.tools.map((tool) => tool.name)).toEqual(["GMAIL_FETCH_EMAILS"]);
  });

  it("the connected-app relay gate refuses a native name in unrestricted mode, with no native grant", () => {
    const h = highLevelHarness();
    h.saveAccess([], 2);
    expect(h.bot.connectedAppAccess?.mode ?? "unrestricted").toBe("unrestricted");
    expect(() => assertConnectedAppCall(h.bot as never, { method: "tools/call", params: { name: "HIGHLEVEL_GET_CONTACT", arguments: {} } })).toThrow(/only through Murage's own/u);
    expect(() => assertConnectedAppCall(h.bot as never, { method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "HIGHLEVEL_UPDATE_CONTACT", account: "a", arguments: {} }] } } })).toThrow(/only through Murage's own/u);
    expect(() => assertConnectedAppCall(h.bot as never, { method: "tools/call", params: { name: "GMAIL_FETCH_EMAILS", arguments: {} } })).not.toThrow();
  });

  it("the relay's raw tools/list answer loses native names, as JSON or as an event stream", () => {
    const answer = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "HIGHLEVEL_ADD_NOTE" }, { name: "GMAIL_FETCH_EMAILS" }] } };
    const json = JSON.parse(new TextDecoder().decode(filterRelayToolListBytes("application/json", new TextEncoder().encode(JSON.stringify(answer)))));
    expect(json.result.tools).toEqual([{ name: "GMAIL_FETCH_EMAILS" }]);
    const sse = new TextDecoder().decode(filterRelayToolListBytes("text/event-stream", new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(answer)}\n\n`)));
    expect(sse).not.toContain("HIGHLEVEL_ADD_NOTE");
    expect(sse).toContain("GMAIL_FETCH_EMAILS");
  });

  it("a connection still waiting for browser confirmation gives no authority and no lease", async () => {
    for (const state of ["pending_browser_confirmation", "needs_reconnect", "disconnecting", "disconnected"] as const) {
      const h = highLevelHarness();
      scriptCrm(h.api);
      h.leases.views.get(FAKE_CONNECTION_ID)!.state = state;
      for (const tool of ["HIGHLEVEL_GET_CONTACT", "HIGHLEVEL_ADD_NOTE"] as const) {
        expect(code(await h.host.call(h.claim, tool, tool === "HIGHLEVEL_ADD_NOTE" ? { contactId: "contact_1", body: "x" } : { contactId: "contact_1" })), `${state} ${tool}`).toBe("connection_not_ready");
      }
      expect(h.reviews).toEqual([]);
      expect(h.leases.leaseRequests).toEqual([]);
      expect(h.api.requests).toEqual([]);
    }
  });

  it("tools/list advertises exactly what this bot may call", async () => {
    const h = highLevelHarness();
    const listed = (await h.host.handle(h.claim, { id: 1, method: "tools/list" })).result as { tools: Array<{ name: string }> };
    expect(listed.tools.map((tool) => tool.name)).toEqual([...HIGHLEVEL_TOOL_NAMES, "HIGHLEVEL_LIST_CONNECTIONS", "HIGHLEVEL_ACTION_STATUS"]);
  });
});
