// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AT-S1 / AT-01 / AT-05: the connected-app event shapes are strict and match the Flux contract fixtures. A loose schema
// would let event content (untrusted, written outside the owner's control) carry routing, billing or a child ceiling.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bodyDigest } from "./app-trigger-canonical.mjs";
import {
  APP_CLIENT_LIMIT_KEYS, APP_EVENT_ERROR_CODES, APP_EVENT_TYPES, APP_RUN_CONTEXT, appClaimItemSchema, appEventErrorBodySchema, appEventScheduleSchema,
  appFilterSchema, appRunContextSchema, appTriggerBindingSchema, appTriggerPolicySchema, clientLimitsFrom, deliveryRecord, matchesFilter, type AppRunContext,
} from "./app-triggers.ts";

const root = new URL("../test/fixtures/flux-app-events-v1/", import.meta.url);
const json = <T,>(path: string) => JSON.parse(readFileSync(new URL(path, root), "utf8")) as T;
const limitsFile = json<{ grade: string; limits: Record<string, number> }>("limits.json");
const errors = json<Array<{ code: string; httpStatus: number; retryable: boolean }>>("errors.json");

const SUB = "754ff2fc-423d-5573-bded-ccf9fb7cde23";
const binding = { ownerAccountId: "acct_owner_a", homeId: "0b8f5b4e-1f6a-4c1e-9d55-2b7a8c3e9f10", homeEpoch: 1, triggerId: "trg-1", bindingRevision: 3, policyDigest: bodyDigest({ policy: 1 }), billingRef: "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f" };

interface CatalogFile { grade: string; spec: { eventType: string; reserve: boolean }; example: { projection: unknown; sourceKey: string; occurredAt: string } }
const catalog = (APP_EVENT_TYPES).map(type => [type, json<CatalogFile>(`catalog/${type}.json`)] as const);
const itemFor = (file: CatalogFile, extra: Record<string, unknown> = {}) => ({
  deliveryId: "d5c0e7d2-5286-59ca-a0ac-8b6c55f56db8", subscriptionId: SUB, eventType: file.spec.eventType, sourceKey: file.example.sourceKey,
  occurredAt: file.example.occurredAt, deadlineAt: "2026-10-26T10:15:30Z", catchUp: false, digest: bodyDigest(file.example.projection), projection: file.example.projection, ...extra,
});

describe("event types and the schedule", () => {
  it("exactly three event types, the calendar reserve never among them", () => {
    expect(APP_EVENT_TYPES).toEqual(["gmail.message.new", "github.issue.opened", "slack.channel.message"]);
    expect(APP_EVENT_TYPES as readonly string[]).not.toContain("google_calendar.event.created");
    for (const [type, file] of catalog) { expect(file.spec.eventType).toBe(type); expect(file.spec.reserve).toBe(false); expect(file.grade).toBe("DRAFT"); }
  });
  it("the event schedule is exactly two keys", () => {
    expect(appEventScheduleSchema.parse({ type: "app_event", triggerId: "trg-1" })).toEqual({ type: "app_event", triggerId: "trg-1" });
    for (const extra of [{ at: 1 }, { time: "09:00" }, { weekdays: [1] }, { engineKey: "engine:x" }, { nextRunAt: 5 }]) {
      expect(appEventScheduleSchema.safeParse({ type: "app_event", triggerId: "trg-1", ...extra }).success).toBe(false);
    }
    for (const triggerId of ["", "has space", "x".repeat(129), "tab\t", 7]) expect(appEventScheduleSchema.safeParse({ type: "app_event", triggerId }).success).toBe(false);
  });
});

describe("delivery records (adapter contract item 3)", () => {
  for (const [type, file] of catalog) {
    it(`${type}: the catalogue example projection parses as a delivery`, () => {
      const item = appClaimItemSchema.parse(itemFor(file));
      const record = deliveryRecord(item, binding);
      expect(Object.keys(record).sort()).toEqual(["billingRef", "bindingRevision", "catchUp", "deadlineAt", "deliveryId", "digest", "eventType", "homeEpoch", "homeId", "occurredAt", "ownerAccountId", "policyDigest", "projection", "sourceKey", "subscriptionId", "triggerId"].sort());
    });
  }
  it("a digest that is not body_digest(projection) refuses", () => {
    const file = catalog[0]![1];
    expect(appClaimItemSchema.safeParse(itemFor(file, { digest: bodyDigest({ other: true }) })).success).toBe(false);
  });
  it("event content cannot add routing, billing or ceilings", () => {
    const file = catalog[0]![1];
    for (const extra of [{ ownerAccountId: "acct_x" }, { billingRef: binding.billingRef }, { childCreates: 4 }, { triggerId: "trg-9" }]) {
      expect(appClaimItemSchema.safeParse(itemFor(file, extra)).success).toBe(false);
    }
    expect(appClaimItemSchema.safeParse(itemFor(file, { eventType: "google_calendar.event.created" })).success).toBe(false);
    const projection = { ...(file.example.projection as object), html: "<script>" };
    expect(appClaimItemSchema.safeParse(itemFor(file, { projection, digest: bodyDigest(projection) })).success).toBe(false);
  });
  it("binding fields come from the binding row and parse strictly", () => {
    const item = appClaimItemSchema.parse(itemFor(catalog[0]![1]));
    expect(() => deliveryRecord(item, { ...binding, homeEpoch: 0 })).toThrow();
    expect(() => deliveryRecord(item, { ...binding, extra: 1 } as never)).toThrow();
  });
});

describe("the child ceiling is a literal zero", () => {
  it("the run context is exactly the five host values", () => {
    expect(APP_RUN_CONTEXT).toEqual({ source: "app", unattended: true, automated: true, childCreates: 0, childHandoffs: 0 });
    expect(Object.isFrozen(APP_RUN_CONTEXT)).toBe(true);
    expect(appRunContextSchema.safeParse({ ...APP_RUN_CONTEXT, childCreates: 1 }).success).toBe(false);
    expect(appRunContextSchema.safeParse({ ...APP_RUN_CONTEXT, childHandoffs: 1 }).success).toBe(false);
    expect(appRunContextSchema.safeParse({ ...APP_RUN_CONTEXT, unattended: false }).success).toBe(false);
  });
  it("a child ceiling of 1 does not type-check", () => {
    // @ts-expect-error childCreates is the literal 0
    const widened: AppRunContext = { ...APP_RUN_CONTEXT, childCreates: 1 };
    expect(widened.childCreates).toBe(1);
  });
  it("binding and policy rows refuse a ceiling of 1", () => {
    const row = {
      triggerId: "trg-1", routineId: "r-1", botId: "bot-a", ownerAccountId: "acct_owner_a", homeId: binding.homeId, homeEpoch: 1, bindingRevision: 1, routineRevision: 1,
      subscriptionId: SUB, providerTriggerInstanceId: "ti_1", connectedAccountId: "ca_1", eventType: "slack.channel.message", instructionDigest: bodyDigest("i"),
      policyId: "p-1", policyRevision: 1, policyDigest: binding.policyDigest, billingRef: binding.billingRef, botKeyId: "bk-1", billingReceiptDigest: bodyDigest("r"),
      filter: { all: [] }, syncState: "active", activatedAt: 1, childCreates: 0, childHandoffs: 0,
    };
    expect(appTriggerBindingSchema.safeParse(row).success).toBe(true);
    expect(appTriggerBindingSchema.safeParse({ ...row, childCreates: 1 }).success).toBe(false);
    expect(appTriggerBindingSchema.safeParse({ ...row, childHandoffs: 4 }).success).toBe(false);
    const { billingRef: _billingRef, ...noBilling } = row;
    expect(appTriggerBindingSchema.safeParse(noBilling).success).toBe(false);
    const policy = { policyId: "p-1", revision: 1, triggerId: "trg-1", bindingDigest: bodyDigest("b"), approvedAt: 1, revokedAt: null, childCreates: 0, childHandoffs: 0 };
    expect(appTriggerPolicySchema.safeParse(policy).success).toBe(true);
    expect(appTriggerPolicySchema.safeParse({ ...policy, childCreates: 1 }).success).toBe(false);
  });
});

describe("errors.json (D-11, FINAL)", () => {
  it("the code list is the fixture's", () => {
    expect([...APP_EVENT_ERROR_CODES].sort()).toEqual(errors.map(row => row.code).sort());
    expect(errors).toHaveLength(36);
  });
  for (const row of errors) {
    it(`${row.code}: its envelope parses`, () => {
      const body = { version: 1, error: { code: row.code, retryable: row.retryable, requestId: "ae_0123abcd", ...(row.retryable ? { retryAfterSec: 30 } : {}) } };
      expect(appEventErrorBodySchema.safeParse(body).success).toBe(true);
    });
  }
  it("no message member, no unknown code", () => {
    expect(appEventErrorBodySchema.safeParse({ version: 1, error: { code: "not_found", retryable: false, requestId: "ae_01", message: "x" } }).success).toBe(false);
    expect(appEventErrorBodySchema.safeParse({ version: 1, error: { code: "teapot", retryable: false, requestId: "ae_01" } }).success).toBe(false);
    expect(appEventErrorBodySchema.safeParse({ version: 1, error: { code: "not_found", retryable: false, requestId: "ae_01" }, extra: 1 }).success).toBe(false);
  });
});

describe("limits come from limits.json via capabilities", () => {
  const capabilities = (limits: Record<string, number>, contractRevision = 1) => ({ version: 1, contractRevision, grantPurposes: ["home_enroll"], limits, eventTypesListed: 3 });
  it("every client limit is the FINAL fixture value", () => {
    expect(limitsFile.grade).toBe("FINAL");
    const limits = clientLimitsFrom(capabilities(limitsFile.limits))!;
    for (const key of APP_CLIENT_LIMIT_KEYS) expect(limits[key]).toBe(limitsFile.limits[key]);
    expect(limits.subscriptionsPerOwner).toBe(20);
    expect(limits.admittedEventsPerOwner24h).toBe(500);
    expect(limits.controlRequestsPerHomePerMinute).toBe(120);
  });
  it("a missing limit or an unknown contract revision holds admission", () => {
    const { runLeaseSec: _drop, ...partial } = limitsFile.limits;
    expect(clientLimitsFrom(capabilities(partial))).toBeNull();
    expect(clientLimitsFrom(capabilities(limitsFile.limits, 2))).toBeNull();
    expect(clientLimitsFrom({ ...capabilities(limitsFile.limits), eventTypesListed: 4 })).toBeNull();
  });
});

describe("filters (no model, no expression)", () => {
  const projection = { fields: { channel: "C1", label_ids: ["INBOX", "UNREAD"], count: 3, title: "Café notes" }, resourceRefs: [] };
  it("eq, contains and in, case-sensitive, NFC-compared", () => {
    expect(matchesFilter({ all: [] }, projection)).toBe(true);
    expect(matchesFilter({ all: [{ field: "channel", op: "eq", value: "C1" }] }, projection)).toBe(true);
    expect(matchesFilter({ all: [{ field: "channel", op: "eq", value: "c1" }] }, projection)).toBe(false);
    expect(matchesFilter({ all: [{ field: "label_ids", op: "contains", value: "UNREAD" }] }, projection)).toBe(true);
    expect(matchesFilter({ all: [{ field: "title", op: "contains", value: "Café" }] }, projection)).toBe(true);
    expect(matchesFilter({ all: [{ field: "count", op: "in", value: [1, 3] }] }, projection)).toBe(true);
  });
  it("a missing or wrong-type field does not match", () => {
    expect(matchesFilter({ all: [{ field: "absent", op: "eq", value: "x" }] }, projection)).toBe(false);
    expect(matchesFilter({ all: [{ field: "count", op: "eq", value: "3" }] }, projection)).toBe(false);
    expect(matchesFilter({ all: [{ field: "count", op: "contains", value: "3" }] }, projection)).toBe(false);
  });
  it("bounded: at most 16 clauses, 256-character strings, 20-value lists, no other operator", () => {
    const clause = { field: "f", op: "eq", value: "v" };
    expect(appFilterSchema.safeParse({ all: Array(16).fill(clause) }).success).toBe(true);
    expect(appFilterSchema.safeParse({ all: Array(17).fill(clause) }).success).toBe(false);
    expect(appFilterSchema.safeParse({ all: [{ ...clause, value: "x".repeat(257) }] }).success).toBe(false);
    expect(appFilterSchema.safeParse({ all: [{ field: "f", op: "in", value: Array(21).fill("a") }] }).success).toBe(false);
    expect(appFilterSchema.safeParse({ all: [{ field: "f", op: "regex", value: ".*" }] }).success).toBe(false);
  });
});
