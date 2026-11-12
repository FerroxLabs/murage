import { heldNoteDetail } from "./testing/contract-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as shared from "../../shared/highlevel.ts";
import * as runtime from "./runtime.ts";
import { HighLevelActions, type ActionContext } from "./actions.ts";
import { HighLevelTurnSignals } from "./host.ts";
import { HIGHLEVEL_ENDPOINTS } from "./provider-contract.ts";

// typeof guards make missing frozen interfaces assertion failures on the read-only base.
const s = shared as unknown as Record<string, (...args: any[]) => any>;
const r = runtime as unknown as Record<string, (...args: any[]) => any>;
const connection = { connectionId: "hl_loc123", locationId: "loc123", state: "connected", confirmedAt: "now" };
const input = { connection, botId: "bot_1", revision: 2, driverKind: "fuigoAgent", desktop: true };
const oldGrant = { toolkit: "highlevel", accountId: connection.connectionId, tools: ["HIGHLEVEL_GET_CONTACT", "HIGHLEVEL_ADD_NOTE"], botId: "bot_1", revision: 1, ceiling: "propose" };
function defaults() { expect(typeof s.defaultHighLevelFamilies).toBe("function"); return s.defaultHighLevelFamilies!(); }
function update(rows: unknown[], patch = {}) { expect(typeof r.highlevelGrantUpdate).toBe("function"); return r.highlevelGrantUpdate!(rows, { ...input, ...patch }); }

describe("HL-WRITES-1019 C1", () => {
  it("grants.preV2ReadsAsRead", () => {
    expect(typeof s.effectiveHighLevelAccess).toBe("function");
    const value = s.effectiveHighLevelAccess!({ revision: 1, roleBinding: "r", grants: [oldGrant] }, { id: "bot_1", roleBinding: "r" });
    expect(value.grants[0]).toMatchObject({ ceiling: "propose", families: { contacts: "read", payments: "off", users: "off" }, operations: { contacts: ["contacts.get"] }, legacy: true });
    expect(shared.operationAllowed(value.grants[0], "contacts.notes.create", "C")).toBe(false);
    expect(value.synthesized).toBe(true);
  });
  it("grants.aboveReadNeedsDesktop", () => {
    const families = { ...defaults(), contacts: "change" };
    expect(update([{ connectionId: connection.connectionId, families }], { desktop: false })).toMatchObject({ ok: false, status: 403, body: { code: "on_computer" } });
    expect(update([{ connectionId: connection.connectionId, families }])).toMatchObject({ ok: true, grants: [{ ceiling: "propose", families }] });
    expect(update([{ connectionId: connection.connectionId, families: defaults() }], { desktop: false }).ok).toBe(true);
    expect(update([], { desktop: false, driverKind: "unknown" })).toEqual({ ok: true, grants: [], denyRules: [] });
  });
  it("grants.engineUnsupported409", () => {
    expect(update([{ connectionId: connection.connectionId, families: defaults() }], { driverKind: "openclaw" })).toMatchObject({ ok: false, status: 409, body: { code: "engine_unsupported" } });
  });
  it("grants.downgradeStalesOpenReview", () => {
    const changed = update([{ connectionId: connection.connectionId, families: defaults() }]);
    expect(changed.grants[0].revision).toBe(2);
    const actions = new HighLevelActions({ journal: { all: () => [], put: () => {}, delete: () => {} } });
    const context: ActionContext = { botId: "bot_1", threadId: "thread_1", turnGeneration: "g", connectionId: connection.connectionId, locationId: "loc123", companyId: "co", connectionEpoch: 1, grantRevision: 1, accessRevision: 1, policyRevision: 1, roleBinding: "r" };
    const review = actions.propose(context, "HIGHLEVEL_ADD_NOTE", { body: "sentinel" }, heldNoteDetail(context.locationId, "sentinel"));
    actions.approve(review.actionId, review.reviewDigest);
    expect(() => actions.beginDispatch(review.actionId, { ...context, grantRevision: changed.grants[0].revision, accessRevision: 2 })).toThrow(/changed/);
    expect(actions.get(review.actionId)?.phase).toBe("stale");
  });
  it("grants.rollbackFailsClosed", () => {
    const result = update([{ connectionId: connection.connectionId, families: { ...defaults(), contacts: "full" } }]);
    const value = { grantsVersion: 2, revision: 2, roleBinding: "r", grants: result.grants };
    const oldSchema = z.object({ revision: z.number(), roleBinding: z.string(), grants: z.array(z.unknown()) }).strict();
    expect(oldSchema.safeParse(value).success).toBe(false);
    // 1.0.18 rejects the v2 record; approved writes recover conservatively without resending.
    const rows = new Map<string, any>();
    const journal = { all: () => [...rows.values()], put: (row: any) => { rows.set(row.actionId, row); }, delete: (id: string) => { rows.delete(id); } };
    const actions = new HighLevelActions({ journal });
    const context: ActionContext = { botId: "bot_1", threadId: "thread_1", turnGeneration: "g", connectionId: connection.connectionId, locationId: "loc123", companyId: "co", connectionEpoch: 1, grantRevision: 2, accessRevision: 2, policyRevision: 1, roleBinding: "r" };
    const review = actions.propose(context, "HIGHLEVEL_ADD_NOTE", { body: "fixture" }, heldNoteDetail(context.locationId, "fixture"));
    actions.approve(review.actionId, review.reviewDigest);
    const restarted = new HighLevelActions({ journal }); restarted.recover();
    expect(restarted.get(review.actionId)).toMatchObject({ phase: "outcome_unknown", outcomeCode: "interrupted_after_approval" });
    expect(restarted.review(review.actionId)).toBeUndefined();
  });
  it("grants.defaultsPaymentsUsersOff", () => {
    const families = defaults();
    expect(families.payments).toBe("off"); expect(families.users).toBe("off");
    for (const [family, level] of Object.entries(families)) if (!["payments", "users", "saas", "snapshots"].includes(family)) expect(level).toBe("read");
    expect(Object.keys(families)).toEqual(expect.arrayContaining(["social", "blogs", "media", "documents", "funnels", "courses", "saas", "snapshots"]));
  });
  it("scopes.missingPerFamily", () => {
    expect(typeof r.highlevelFamilyScopes).toBe("function");
    const report = r.highlevelFamilyScopes!(["contacts.readonly"], HIGHLEVEL_ENDPOINTS);
    expect(report.contacts.present).toContain("contacts.readonly");
    expect(report.contacts.missing).toContain("contacts.write");
    expect(report.contacts.missingNames).toContain("Edit Contacts");
    expect(report.opportunities.present).toEqual([]);
    expect(report.opportunities.missing).toContain("opportunities.readonly");
    expect(report.contacts.canChange).toBe(false);
    expect(r.highlevelFamilyScopes!([], {}).contacts.canChange).toBe(false);
  });
});

it("v2 operation narrowing and strict families cannot be bypassed by compatibility tools", () => {
  const families = defaults();
  const result = update([{ connectionId: connection.connectionId, families: { ...families, contacts: "full" }, operations: ["contacts.get"] }]);
  expect(result.ok).toBe(true);
  expect(result.grants[0].tools).toEqual(["HIGHLEVEL_GET_CONTACT"]);
  expect(update([{ connectionId: connection.connectionId, families: { ...families, typo: "full" } }]).ok).toBe(false);
  expect(update([{ connectionId: connection.connectionId, families, operations: ["contacts.https://evil"] }]).ok).toBe(false);
  for (const level of ["off", "read", "change", "full"] as const) {
    expect(shared.levelCovers(level, "D")).toBe(level === "full");
    expect(shared.levelCovers(level, "C")).toBe(level === "full" || level === "change");
  }
});

it("non-desktop status omits grant details and only a verified scope inventory enables changes", () => {
  const result = update([{ connectionId: connection.connectionId, families: { ...defaults(), contacts: "full" } }]);
  const bots = [{ id: "bot_1", roleBinding: "r", driverKind: "fuigoAgent", highlevelAccess: { grantsVersion: 2, revision: 2, roleBinding: "r", grants: result.grants } }];
  const status = { connection, tokenSaved: true, journalHeld: false, bots };
  const redacted = r.highlevelStatusBody!({ ...status, desktop: false });
  expect(redacted.bots[0]).toEqual({ botId: "bot_1", offered: true, level: "full" });
  expect(redacted.familyScopes).toBeUndefined();
  expect(r.highlevelStatusBody!({ ...status, desktop: true }).bots[0].access.grantsVersion).toBe(2);
  expect(r.highlevelVerifiedScopes!({ ...connection, state: "pending_browser_confirmation", scopes: ["contacts.write"] })).toEqual([]);
  expect(r.highlevelFamilyScopes!(["contacts.readonly", "contacts.write"]).contacts.canChange).toBe(true);
});

it("all-off families and empty operation allowlists have no effective grants", () => {
  const families = Object.fromEntries(Object.keys(defaults()).map((family) => [family, "off"]));
  for (const row of [{ families }, { families: defaults(), operations: [] }]) {
    const result = update([{ connectionId: connection.connectionId, ...row }]);
    expect(result.ok).toBe(true);
    expect(s.effectiveHighLevelAccess!({ grantsVersion: 2, revision: 2, roleBinding: "r", grants: result.grants }, { id: "bot_1", roleBinding: "r" }).grants).toEqual([]);
  }
});

it("disconnect or token replacement stales approved but unsent actions", () => {
  const rows = new Map<string, any>();
  const rt = runtime.createHighLevelRuntime({ threadMarkState: () => "unmarked", dataDir: "unused-with-memory-journal", capabilities: { isActive: () => true },
    signals: new HighLevelTurnSignals(), bot: () => undefined,
    journal: { all: () => [...rows.values()], put: (row) => { rows.set(row.actionId, row); }, delete: (id) => { rows.delete(id); } },
  });
  const context: ActionContext = { botId: "bot_1", threadId: "thread_1", turnGeneration: "g", connectionId: connection.connectionId, locationId: "loc123", companyId: "co", connectionEpoch: 1, grantRevision: 1, accessRevision: 1, policyRevision: 1, roleBinding: "r" };
  const review = rt.actions.propose(context, "HIGHLEVEL_ADD_NOTE", { body: "sentinel" }, heldNoteDetail(context.locationId, "sentinel"));
  rt.actions.approve(review.actionId, review.reviewDigest);
  rt.endConnection(connection.connectionId, "token_changed");
  expect(rt.actions.get(review.actionId)).toMatchObject({ phase: "stale", outcomeCode: "token_changed" });
  expect(() => rt.actions.beginDispatch(review.actionId, context)).toThrow();
});
