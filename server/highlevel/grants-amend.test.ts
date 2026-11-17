import { heldNoteDetail } from "./testing/contract-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import * as shared from "../../shared/highlevel.ts";
import * as runtime from "./runtime.ts";
import { HighLevelActions, type ActionContext } from "./actions.ts";
const s = shared as unknown as Record<string, (...args: any[]) => any>;
const r = runtime as unknown as Record<string, (...args: any[]) => any>;
const bot = { id: "bot_1", roleBinding: "owner-role" };
const connection = { connectionId: "hl_loc123", locationId: "loc123", state: "connected", confirmedAt: "now" };
const oldGrant = { toolkit: "highlevel", accountId: connection.connectionId, botId: bot.id, revision: 7, ceiling: "read", tools: ["HIGHLEVEL_SEARCH_CONTACTS", "HIGHLEVEL_LIST_CALENDARS"] };
const stored = { revision: 8, roleBinding: bot.roleBinding, grants: [oldGrant] };
const effective = (value: unknown = stored, who = bot) => s.effectiveHighLevelAccess!(value, who);
const update = (families: unknown, extra = {}, options = {}) => r.highlevelGrantUpdate!([{ connectionId: connection.connectionId, families, ...extra }], {
  connection, botId: bot.id, roleBinding: bot.roleBinding, revision: 9, driverKind: "fuigoAgent", desktop: true, previous: stored, ...options,
});

describe("HL r2-r4 C1 amendments", () => {
  it("grants.legacySingleToolNoNewReads", () => {
    expect(typeof s.operationAllowed).toBe("function");
    const grant = effective({ ...stored, grants: [{ ...oldGrant, tools: ["HIGHLEVEL_SEARCH_CONTACTS"] }] }).grants[0];
    // R4-PROVISIONAL fixture: every R row in the binding r3 manifest, including absent rows.
    const ops = ["contacts.search", "contacts.get", "contacts.notes.list", "contacts.notes.get", "contacts.tasks.list", "contacts.tasks.get", "contacts.appointments.list", "opportunities.pipelines.list", "opportunities.search", "opportunities.get", "conversations.search", "conversations.get", "conversations.messages.list", "conversations.message.get", "conversations.email.get", "calendars.list", "calendars.get", "calendars.freeSlots", "calendars.groups.list", "calendars.resources.list", "calendars.events.list", "calendars.appointment.get", "calendars.appointmentNotes.list", "automations.workflows.list", "automations.campaigns.list", "location.get", "location.customFields.list", "location.customFields.get", "location.customValues.list", "location.customValues.get", "location.tags.list", "location.tags.get", "location.tasks.search", "location.templates.list", "users.list", "users.get", "forms.list", "forms.submissions", "forms.surveys.list", "forms.surveys.submissions", "payments.invoices.list", "payments.invoices.get", "payments.orders.list", "payments.orders.get", "payments.transactions.list", "payments.transactions.get", "payments.subscriptions.list", "payments.subscriptions.get", "payments.products.list", "payments.products.get", "social.accounts.list", "social.posts.list", "social.posts.get", "social.categories.list", "social.tags.list", "blogs.sites.list", "blogs.posts.list", "blogs.authors.list", "blogs.categories.list", "blogs.slug.check", "media.files.list", "documents.list", "documents.templates.list", "funnels.list", "funnels.pages.list", "funnels.pages.count", "funnels.redirects.list", "courses.list", "courses.offers.list", "saas.location.get", "snapshots.list", "snapshots.status"];
    for (const op of ops) expect(s.operationAllowed!(grant, op, "R"), op).toBe(op === "contacts.search");
  });
  it("grants.legacyRestrictionSurvivesUnrelatedSave", () => {
    const result = update(shared.defaultHighLevelFamilies());
    expect(result.ok).toBe(true);
    expect(result.grants[0].operations).toMatchObject({ contacts: ["contacts.search"], calendars: ["calendars.list"] });
  });
  it("grants.offFamilyStaysRestrictedWithoutBroaden", () => {
    const saved = update(shared.defaultHighLevelFamilies());
    const after = effective({ grantsVersion: 2, revision: 9, roleBinding: bot.roleBinding, grants: saved.grants });
    expect(s.operationAllowed!(after.grants[0], "forms.list", "R")).toBe(false);
    const explicit = update(shared.defaultHighLevelFamilies(), { broaden: { forms: true } });
    const broadened = effective({ grantsVersion: 2, revision: 9, roleBinding: bot.roleBinding, grants: explicit.grants });
    expect(s.operationAllowed!(broadened.grants[0], "forms.list", "R")).toBe(true);
  });
  it("grants.broadenFamilyClearsOnlyThatRestriction", () => {
    const result = update(shared.defaultHighLevelFamilies(), { broaden: { contacts: true } });
    expect(result.ok).toBe(true);
    expect(result.grants[0].operations.contacts).toBeUndefined();
    expect(result.grants[0].operations.calendars).toEqual(["calendars.list"]);
  });
  it("grants.denyRuleRemovalDesktopOnly", () => {
    const previous = { ...stored, denyRules: ["HIGHLEVEL_CONTACTS"] };
    expect(update(shared.defaultHighLevelFamilies(), {}, { previous, denyRules: [], desktop: false })).toMatchObject({ ok: false, status: 403 });
    expect(update(shared.defaultHighLevelFamilies(), {}, { previous, denyRules: ["HIGHLEVEL_CONTACTS", "HIGHLEVEL:R"], desktop: false })).toMatchObject({ ok: true, denyRules: ["HIGHLEVEL_CONTACTS", "HIGHLEVEL:R"] });
    expect(update(shared.defaultHighLevelFamilies(), {}, { previous, denyRules: [], desktop: true })).toMatchObject({ ok: true, denyRules: [] });
  });
  it("grants.unparseableReturnsNull", () => expect(effective({ ...stored, revision: -1 })).toBeNull());
  it("effective.keepsRoleBinding", () => expect(effective()).toMatchObject({ grantsVersion: 2, synthesized: true, roleBinding: bot.roleBinding, revision: 8 }));
  it("effective.roleChangeReturnsNull", () => expect(effective(stored, { ...bot, roleBinding: "new-role" })).toBeNull());
  it("effective.otherBotGrantDropped", () => expect(effective({ ...stored, grants: [{ ...oldGrant, botId: "other" }] }).grants).toEqual([]));
  it("effective.keepsGrantRevisionAndBotId", () => {
    expect(effective().grants[0]).toMatchObject({ botId: bot.id, revision: 7, ceiling: "read", legacy: true });
    expect(effective(effective())).toEqual(effective());
  });
  it("effective.grantRevisionBumpStalesApproval", () => {
    expect(effective().grants[0].legacy).toBe(true);
    const actions = new HighLevelActions({ journal: { all: () => [], put: () => {}, delete: () => {} } });
    const before = effective();
    const context: ActionContext = { botId: bot.id, threadId: "thread_1", turnGeneration: "g", connectionId: connection.connectionId, locationId: "loc123", companyId: "co", connectionEpoch: 1, grantRevision: before.grants[0].revision, accessRevision: before.revision, policyRevision: 1, roleBinding: before.roleBinding };
    const review = actions.propose(context, "HIGHLEVEL_ADD_NOTE", { body: "fixture" }, heldNoteDetail(context.locationId, "fixture"));
    actions.approve(review.actionId, review.reviewDigest);
    const saved = update(shared.defaultHighLevelFamilies());
    const after = effective({ grantsVersion: 2, revision: 9, roleBinding: bot.roleBinding, grants: saved.grants });
    expect(() => actions.beginDispatch(review.actionId, { ...context, grantRevision: after.grants[0].revision, accessRevision: after.revision, roleBinding: after.roleBinding })).toThrow(/changed/);
    expect(actions.get(review.actionId)?.phase).toBe("stale");
  });
  it("effective.legacySynthesisAfterValidation", () => {
    expect(effective({ ...stored, roleBinding: "wrong" })).toBeNull();
    expect(effective().grants[0].operations).toEqual({ contacts: ["contacts.search"], calendars: ["calendars.list"] });
  });
  it("deny.legacySRuleReadAsSend", () => {
    expect(effective({ ...stored, denyRules: ["HIGHLEVEL:S"] }).denyRules).toEqual(["HIGHLEVEL:SEND"]);
  });
  it("deny.sendRuleMatchesEverySendRow", () => {
    expect(typeof s.highlevelDenyMatch).toBe("function");
    for (const type of ["sms", "email", "whatsapp", "facebook", "instagram", "gmb", "livechat", "scheduledSms", "scheduledEmail"]) expect(s.highlevelDenyMatch!(["HIGHLEVEL:SEND"], `conversations.send.${type}`, "C")).toBe(true);
    expect(s.highlevelDenyMatch!(["HIGHLEVEL:SEND"], "conversations.attachment.upload", "C")).toBe(false);
  });
  it("grants.saasSnapshotsDefaultOff", () => expect(shared.defaultHighLevelFamilies()).toMatchObject({ saas: "off", snapshots: "off" }));
  it("effective.releaseReadRevisionFixture", () => {
    const before = effective();
    const after = effective({ ...stored, revision: 9, grants: [{ ...oldGrant, revision: 9 }] });
    expect(before.grants[0].legacy).toBe(true);
    expect([after.revision, after.grants[0].revision, after.roleBinding]).toEqual([9, 9, before.roleBinding]);
  });
});
