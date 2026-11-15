import { describe, expect, it } from "vitest";
import * as shared from "../../shared/highlevel.ts";
import { existsSync } from "node:fs";

const families = ["contacts", "opportunities", "conversations", "calendars", "automations", "location", "users", "forms", "payments", "social", "funnels", "blogs", "courses", "media", "documents", "saas", "snapshots"];
describe("S0 contract freeze", () => {
  it("includes every original and amendment family", () => {
    expect((shared as Record<string, unknown>).HIGHLEVEL_FAMILIES).toEqual(families);
  });
  it("publishes risk levels and legacy migration contracts", () => {
    expect(typeof (shared as Record<string, unknown>).levelCovers).toBe("function");
    expect(Object.keys((shared as Record<string, unknown>).LEGACY_TOOL_TO_OPERATION ?? {})).toHaveLength(20);
  });
  it("publishes isolated family and fake extension points", () => {
    for (const family of families) {
      expect(existsSync(`server/highlevel/operations/${family}.ts`), family).toBe(true);
      expect(existsSync(`server/highlevel/fake/${family}.ts`), family).toBe(true);
    }
  });
});

import * as registry from "./operations/registry.ts";
import { endpointFor } from "./provider-contract.ts";
import { HIGHLEVEL_PROVIDER_MANIFEST, providerOperation } from "./provider-manifest.ts";
import { z } from "zod";

describe("S0 provider and registry boundaries", () => {
  it("dispatches qualified operation ids and refuses absent operations", () => {
    expect(endpointFor("contacts.delete", "DELETE", "/contacts/contact_1")).not.toBeNull();
    expect(endpointFor("snapshots.apply", "POST", "/snapshots/apply")).toBeNull();
    expect(endpointFor("contacts.get", "GET", "/contacts/%252fescape")).toBeNull();
  });
  it("has scoped entries for all families, with explicit absence", () => {
    expect(new Set(HIGHLEVEL_PROVIDER_MANIFEST.map(row => row.family))).toEqual(new Set(families));
    for (const row of HIGHLEVEL_PROVIDER_MANIFEST.filter(row => row.status === "qualified")) {
      expect(row.scope, row.operation).toBeTruthy();
      expect(row.scope, row.operation).not.toBe("none");
      expect(row.requestSchema?.strict).toBe(true);
    }
    expect(providerOperation("courses.import")?.status).toBe("qualified");
  });
  it("rejects extra keys, nested credentials and URL values before a family runs", () => {
    const wrap = (registry as Record<string, unknown>).strictOperationArgs as undefined | ((schema: z.ZodType) => z.ZodType);
    expect(typeof wrap).toBe("function");
    if (typeof wrap !== "function") return;
    const schema = wrap(z.object({ name: z.string(), nested: z.object({ authorization: z.string() }).strict().optional() }).strict());
    expect(schema.safeParse({ name: "Ada" }).success).toBe(true);
    expect(schema.safeParse({ name: "Ada", extra: "value" }).success).toBe(false);
    expect(schema.safeParse({ name: "https://outside.test" }).success).toBe(false);
    expect(schema.safeParse({ name: "Ada", nested: { authorization: "secret" } }).success).toBe(false);
    expect(() => wrap(z.object({ name: z.string() }).passthrough())).toThrow();
    expect(() => wrap(z.string())).toThrow();
    const ids = wrap(z.object({ contactId: z.string(), userIds: z.array(z.string()) }).strict());
    expect(ids.safeParse({ contactId: "valid_01", userIds: ["user_1"] }).success).toBe(true);
    expect(ids.safeParse({ contactId: "%252fescape", userIds: [] }).success).toBe(false);
    expect(ids.safeParse({ contactId: "valid_01", userIds: ["../escape"] }).success).toBe(false);
  });
});

import { HIGHLEVEL_ENDPOINTS, HIGHLEVEL_CRM_SCOPES, HIGHLEVEL_PERMISSION_NAMES } from "./provider-contract.ts";
import { fakeHighLevelRequester, HIGHLEVEL_FAKE_ROUTES } from "./fake-provider.ts";
import eventRows from "./provider-events.json" with { type: "json" };
import { HIGHLEVEL_EVENT_TYPES } from "../../shared/app-triggers.ts";

it("wires every qualified path and keeps every absent route closed", () => {
  const ids = HIGHLEVEL_PROVIDER_MANIFEST.map(row => row.operation);
  expect(new Set(ids).size).toBe(ids.length);
  for (const row of HIGHLEVEL_PROVIDER_MANIFEST) {
    const path = row.path?.replace(/:[A-Za-z][A-Za-z0-9]*|\{[^}]+\}/gu, "fixture_01") ?? "/unavailable";
    const endpoint = endpointFor(row.operation, row.method ?? "POST", path);
    if (row.status === "provider_absent") expect(endpoint, row.operation).toBeNull();
    else {
      expect(endpoint, row.operation).toMatchObject({ version: row.Version, scope: row.scope, retry: row.risk === "R" ? "read" : "write" });
      expect(endpointFor(row.operation, row.method!, `${path}/outside`)).toBeNull();
      expect(endpointFor(row.operation, row.method === "GET" ? "POST" : "GET", path)).toBeNull();
      for (const fields of Object.values(row.requestSchema!.providerFields)) expect(fields.every(field => field.trim().length > 0), row.operation).toBe(true);
    }
  }
  for (const scope of HIGHLEVEL_CRM_SCOPES) expect(HIGHLEVEL_PERMISSION_NAMES[scope]).toBeTruthy();
});

it("refuses family risk, endpoint and schema drift before preparation", async () => {
  let prepared = 0;
  const row = registry.HIGHLEVEL_OPERATION_MANIFEST.find(r => r.id === "contacts.create")!;
  const spec: registry.MutationSpec<any> = {
    id: row.id, family: row.family, risk: "C", title: "Create a contact", row,
    endpoint: HIGHLEVEL_ENDPOINTS[row.id]!, args: row.argsSchema, preflight: row.preflight,
    nested: false, gate: "GC", send: false, precondition: "none",
    recordRefs: () => [], fields: () => ["name"], targets: () => 1,
    prepare: async (_pre, input, ctx) => { const a = row.argsSchema.parse(input) as Record<string, unknown>; prepared++; return { path: "/contacts/", resource: `location:${ctx.locationId}`, body: { kind: "json", value: { ...a, locationId: ctx.locationId } } }; },
    project: value => value,
  };
  expect(() => registry.freezeOperationSpec({ ...spec, risk: "R" } as unknown as registry.OperationSpec)).toThrow(/frozen provider contract/u);
  expect(() => registry.freezeOperationSpec({ ...spec, endpoint: { ...spec.endpoint, scope: "users.write" } })).toThrow();
  const frozen = registry.freezeOperationSpec(spec) as registry.MutationSpec;
  const pre: registry.PreflightRequester = { read: async () => ({}) };
  await expect(frozen.prepare(pre, { name: "https://outside.test" }, { locationId: "loc" })).rejects.toThrow();
  expect(prepared).toBe(0);
  await frozen.prepare(pre, { name: "Ada" }, { locationId: "loc" });
  expect(prepared).toBe(1);
});

it("keeps all family/fake imports isolated and supports a scripted fake requester", async () => {
  expect(Object.keys(HIGHLEVEL_FAKE_ROUTES)).toEqual(families);
  for (const family of shared.HIGHLEVEL_FAMILIES) expect(Array.isArray(registry.familyOperations(family))).toBe(true);
  const fake = fakeHighLevelRequester([{ operation: "contacts.get", method: "GET", path: /^\/contacts\/fixture_1$/u, handle: () => ({ contact: { id: "fixture_1" } }) }]);
  await expect(fake.request("contacts.get", "GET", "/contacts/fixture_1")).resolves.toEqual({ contact: { id: "fixture_1" } });
  await expect(fake.request("contacts.delete", "DELETE", "/contacts/fixture_1")).rejects.toThrow();
  expect(fake.calls).toHaveLength(1);
});

it("qualifies every inbound event but never enables a webhook in S0", () => {
  expect(eventRows.map(row => row.event)).toEqual([...HIGHLEVEL_EVENT_TYPES]);
  expect(eventRows.every(row => row.enabled === false)).toBe(true);
  expect(eventRows.find(row => row.event === "InvoicePaid")?.status).toBe("qualified");
  expect(eventRows.find(row => row.event === "FormSubmission")?.status).toBe("provider_absent");
});
