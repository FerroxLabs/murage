// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { planInvocation, projectFamilyScopeCoverage } from "./scope-policy.ts";
import { IMPLEMENTED_SCOPE_VECTORS } from "./scope-policy.vectors.ts";
import { HIGHLEVEL_OPERATION_MANIFEST } from "./operations/manifest.ts";
import { familyOperations } from "./operations/registry.ts";
import { invocationArgumentPlanSchema, INVOCATION_DESCRIPTORS, type PassiveConnectionMetadata } from "./operations/invocation-plans.ts";
const passive: PassiveConnectionMetadata = { connectionId: "conn1", locationId: "loc1", connectionEpoch: 1, credentialVersion: 1, scopes: [] };
const allScopes = [...new Set(INVOCATION_DESCRIPTORS.flatMap(d => [d.endpointScope, ...d.readers.map(r => r.scope)]))];
const metadata = { ...passive, scopes: allScopes };
function plan(operation: string, args: Record<string, unknown>, connection = metadata) {
  const result = planInvocation(operation, args, connection);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw Error("Expected scope plan");
  expect(invocationArgumentPlanSchema.safeParse(result.plan).success).toBe(true);
  return result.plan;
}
afterEach(() => vi.unstubAllGlobals());
describe("G2 independent implemented operation plans", () => {
  it("pins exactly all implemented ready rows with handwritten vectors", () => {
    const implemented = HIGHLEVEL_OPERATION_MANIFEST.flatMap(row => familyOperations(row.family).filter(spec => spec.id === row.id).map(spec => spec.id));
    expect(IMPLEMENTED_SCOPE_VECTORS.map(v => v.operation).sort()).toEqual(implemented.sort());
  });
  for (const vector of IMPLEMENTED_SCOPE_VECTORS) {
    it(vector.operation, () => {
      const result = plan(vector.operation, vector.args);
      expect(result.requiredScopes).toEqual([...vector.scopes].sort());
      expect(result.readers.map(r => [r.operation, r.phase, r.maxReads])).toEqual(vector.reads);
      expect(result.mandatoryPreparationReads).toBe(vector.preparation);
      // F1 directly reconciles a contact write. F5 observes the target-scoped automation effect; neither may reuse preparation evidence.
      const contactEvidence = vector.operation.startsWith("automations.") ? "target-scoped-effect" : "post-write-direct";
      expect(result.readers.filter(r => r.phase === "recovery" && r.operation === "contacts.get").every(r => r.evidenceClass === contactEvidence && r.reuse === "never")).toBe(true);
    });
    it(`${vector.operation}: removal of any required scope is before all I/O`, () => {
      for (const missing of vector.scopes) {
        const counts = { credentials: 0, reads: 0, writes: 0, reviews: 0 };
        vi.stubGlobal("fetch", () => { counts.reads++; return Promise.resolve(new Response("{}")); });
        const result = planInvocation(vector.operation, vector.args, { ...metadata, scopes: allScopes.filter(scope => scope !== missing) });
        if (result.ok) { counts.credentials++; counts.reads++; counts.writes++; counts.reviews++; }
        expect(counts).toEqual({ credentials: 0, reads: 0, writes: 0, reviews: 0 });
        expect(result).toMatchObject({ ok: false, refusal: { code: "missing_scope", operation: vector.operation, permissionIds: [missing], connectionId: "conn1" } });
      }
    });
  }
});
it("G2 custom-field IDs and names both require one definitions read, empty fields none", () => {
  for (const field of [{ id: "field1", value: "X" }, { name: "Region", value: "X" }]) {
    const args = { contactId: "c1", customFields: [field] }, result = plan("contacts.update", args);
    expect(result.requiredScopes).toEqual(["contacts.readonly", "contacts.write", "locations/customFields.readonly"]);
    expect(result.readers.filter(r => r.operation === "location.customFields.list")).toHaveLength(1);
    expect(result.mandatoryPreparationReads).toBe(2);
    expect(planInvocation("contacts.update", args, { ...metadata, scopes: ["contacts.readonly", "contacts.write"] })).toMatchObject({ ok: false, refusal: { code: "missing_scope", permissionIds: ["locations/customFields.readonly"] } });
    expect(args).toEqual({ contactId: "c1", customFields: [field] });
  }
  expect(plan("contacts.update", { contactId: "c1", customFields: [] }).requiredScopes).toEqual(["contacts.readonly", "contacts.write"]);
});
it("G2 six/500 target preparation batches are distinct from bounded direct recovery", () => {
  for (const [count, batches] of [[6, 1], [500, 5]]) {
    const result = plan("contacts.tags.bulk", { contacts: Array.from({ length: count! }, (_, i) => `c${i}`), type: "add", tags: ["X"] });
    expect(result.mandatoryPreparationReads).toBe(batches);
    expect(result.readers.map(r => [r.operation, r.phase, r.maxReads, r.evidenceClass])).toEqual([
      ["contacts.search", "prepare", batches, "locator-observation"], ["contacts.get", "recovery", 5, "post-write-direct"],
    ]);
    expect(result.maxLogicalReads).toBe(5);
  }
});
for (const length of [75, 76, 128]) {
  it(`G2 bulk selector boundary ${length} preserves the public schema and refuses unsupported locators before scopes`, () => {
    const args = { contacts: ["c".repeat(length)], type: "add", tags: ["X"] };
    const row = HIGHLEVEL_OPERATION_MANIFEST.find(row => row.id === "contacts.tags.bulk")!;
    expect(row.argsSchema.safeParse(args).success).toBe(true);
    const original = structuredClone(args);
    const fetch = vi.fn(() => { throw Error("unexpected provider I/O"); });
    vi.stubGlobal("fetch", fetch);
    let scopeReads = 0;
    const result = planInvocation("contacts.tags.bulk", args, { ...metadata, get scopes() { scopeReads++; return metadata.scopes; } });
    if (length === 75) {
      expect(result).toMatchObject({ ok: true, plan: { mandatoryPreparationReads: 1 } });
    } else {
      expect(result).toMatchObject({ ok: false, refusal: { code: "unsupported_locator", permissionIds: [] } });
      expect(scopeReads).toBe(0);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(args).toEqual(original);
  });
}
it("G2 500 distinct 75-character bulk selectors fit five batches without dropping or truncating IDs", () => {
  const contacts = Array.from({ length: 500 }, (_, i) => `c${String(i).padStart(74, "0")}`);
  expect(new Set(contacts).size).toBe(500);
  expect(contacts.every(id => id.length === 75)).toBe(true);
  const args = { contacts, type: "add", tags: ["X"] };
  expect(Buffer.byteLength(JSON.stringify({ operation: "contacts.tags.bulk", args }))).toBeLessThan(65_536);
  const result = plan("contacts.tags.bulk", args);
  expect(result.mandatoryPreparationReads).toBe(5);
  expect(result.readers.map(reader => [reader.operation, reader.phase, reader.maxReads])).toEqual([
    ["contacts.search", "prepare", 5], ["contacts.get", "recovery", 5],
  ]);
  const changed = { ...args, contacts: [...contacts.slice(0, -1), `${contacts[499]}X`] };
  expect(planInvocation("contacts.tags.bulk", changed, { ...metadata, scopes: [] })).toMatchObject({ ok: false, refusal: { code: "unsupported_locator" } });
  expect(contacts[499]).toHaveLength(75);
});
it("G2 body-ID upsert chooses direct lookup and response-dependent pipeline membership", () => {
  const result = plan("opportunities.upsert", { id: "o1", pipelineId: "p1", name: "Fixture deal" });
  expect(result.requiredScopes).toEqual(["opportunities.readonly", "opportunities.write"]);
  expect(result.readers.map(r => [r.operation, r.phase])).toEqual([["opportunities.get", "prepare"], ["opportunities.pipelines.list", "prepare"], ["opportunities.get", "recovery"]]);
  expect(result.readers[1]!.selectors).toContainEqual({ kind: "dependency", slot: "prepare.opportunities.get", field: "pipelineId" });
});
it("G2 zero/one/many unique users choose no read, one direct read or a single membership list", () => {
  for (const [args, reader] of [[{}, null], [{ assignedTo: "u1", followers: ["u1"] }, "users.get"], [{ assignedTo: "u1", followers: ["u2"] }, "users.list"]] as const) {
    const result = plan("opportunities.upsert", { id: "o1", pipelineId: "p1", name: "Fixture", ...args });
    expect(result.readers.filter(r => r.operation.startsWith("users.")).map(r => r.operation)).toEqual(reader ? [reader] : []);
  }
});
it("G2 course import has no invented recovery reader and only its exact mutation scope", () => {
  const result = plan("courses.import", { locationId: "loc1", products: [] });
  expect(result.requiredScopes).toEqual(["courses.write"]); expect(result.readers).toEqual([]); expect(result.mandatoryPreparationReads).toBe(0);
});
it("G2 invalid/uncovered rows fail closed; PIT location proof grants no writes", () => {
  for (const operation of ["made.up", "saas.disable", "snapshots.create"]) expect(planInvocation(operation, {}, metadata).ok).toBe(false);
  expect(planInvocation("contacts.update", { contactId: "c1", name: "X" }, { ...metadata, scopes: ["locations.readonly"] })).toMatchObject({ ok: false, refusal: { code: "missing_scope" } });
  expect(planInvocation("contacts.update", { contactId: "c1", name: "X", locationId: "other" }, metadata).ok).toBe(false);
});
it("G2 deterministic immutable plans bind arguments, selectors and generation", () => {
  const args = { contactId: "c1", firstName: "Ada" };
  const first = plan("contacts.update", args);
  expect(first).toEqual(plan("contacts.update", { firstName: "Ada", contactId: "c1" }));
  expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first.readers)).toBe(true);
  const changed = plan("contacts.update", { ...args, contactId: "c2" });
  expect(first.argumentDigest).not.toEqual(changed.argumentDigest);
  expect(first.readers[0]!.selectorDigest).not.toEqual(changed.readers[0]!.selectorDigest);
  expect(first.readers[0]!.logicalKey).not.toEqual(plan("contacts.update", args, { ...metadata, connectionEpoch: 2 }).readers[0]!.logicalKey);
  expect(JSON.stringify(first)).not.toContain("Ada");
});
it("G2 family coverage distinguishes conditional missing permissions, restrictions and absent implementations", () => {
  const coverage = projectFamilyScopeCoverage("contacts", { ...metadata, scopes: ["contacts.readonly", "contacts.write"] }, ["contacts.update"], ["contacts.update"]);
  expect(coverage).toMatchObject({ family: "contacts", operationIds: ["contacts.update"], missingRequired: [], missingConditional: ["locations/customFields.readonly"], unimplementedOperationIds: [], providerAbsentOperationIds: [] });
  const unknown = projectFamilyScopeCoverage("courses", metadata, [], ["courses.import", "courses.list"]);
  expect(unknown.unimplementedOperationIds).toEqual(["courses.import"]);
  expect(unknown.providerAbsentOperationIds).toEqual(["courses.list"]);
  expect(projectFamilyScopeCoverage("contacts", metadata, ["contacts.update"], []).operationIds).toEqual([]);
});

it("G2 no declared-but-unreachable read can broaden a concrete plan", () => {
  const result = plan("contacts.update", { contactId: "c1", name: "X" });
  const unrelated = { ...result.readers[0]!, slot: "prepare.unplanned", operation: "contacts.search", logicalKey: "f".repeat(64) };
  expect(invocationArgumentPlanSchema.safeParse({ ...result, readers: [...result.readers, unrelated] }).success).toBe(false);
  expect(result.requiredScopes).not.toContain("locations/customFields.readonly");
});
it("G2 projections cover all 17 families without treating provider absence as permission", () => {
  const families = ["contacts", "opportunities", "conversations", "calendars", "automations", "location", "users", "forms", "payments", "social", "blogs", "media", "documents", "funnels", "courses", "saas", "snapshots"] as const;
  for (const family of families) {
    const coverage = projectFamilyScopeCoverage(family, metadata, []);
    expect(coverage.family).toBe(family); expect(coverage.operationIds).toEqual([]);
    const absent = HIGHLEVEL_OPERATION_MANIFEST.filter(row => row.family === family && row.disposition === "provider_absent").map(row => row.id).sort();
    expect(coverage.providerAbsentOperationIds).toEqual(absent);
  }
});
it("G2 permission labels carry locale inventory keys", async () => {
  const { projectMissingPermissions } = await import("./scope-policy.ts");
  expect(projectMissingPermissions(["contacts.write", "contacts.readonly", "contacts.write"])).toEqual([
    { permissionId: "contacts.readonly", localeKey: "highlevel.permission.contacts.readonly", label: "View Contacts" },
    { permissionId: "contacts.write", localeKey: "highlevel.permission.contacts.write", label: "Edit Contacts" },
  ]);
});
it("G2 duplicate bulk IDs and malformed passive generations fail before credentials", () => {
  expect(planInvocation("contacts.tags.bulk", { contacts: ["c1", "c1"], type: "add", tags: ["X"] }, metadata)).toMatchObject({ ok: false, refusal: { code: "invalid_plan" } });
  expect(planInvocation("contacts.update", { contactId: "c1", name: "X" }, { ...metadata, connectionEpoch: 0 })).toMatchObject({ ok: false, refusal: { code: "invalid_plan" } });
});
