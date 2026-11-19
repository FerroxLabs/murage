import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { opportunitiesOperations } from "./opportunities.ts";
import { HIGHLEVEL_OPERATION_MANIFEST } from "./manifest.ts";
import { schemas } from "./schemas/opportunities.ts";
import type { FrozenRequest } from "../held-request.ts";
import type { OperationSpec } from "./registry.ts";

// Hook-only response fixture; F0.1 tests separately use real prepare/freeze and
// production host tests prove approval binding before these hooks are called.
function responseContext(spec: OperationSpec): FrozenRequest {
  const pipeline = spec.id.startsWith("opportunities.pipelines.");
  const path = spec.row.path!.replace(/:opportunityId|\{opportunityId\}/g, "opp_1").replace(/:pipelineId|\{pipelineId\}/g, "pipe_1");
  return { operation: spec.id, method: spec.endpoint.method, path,
    resource: spec.row.pathResourceSegment === null ? "location:loc_fixture" : pipeline ? "opportunities:pipeline:pipe_1" : "opportunities:opportunity:opp_1",
    query: [], bodyKind: "json", contentType: "application/json", bodySha256: "hook-fixture", requestDigest: "hook-fixture", upload: null };
}

it("F0: every ready opportunity row is implemented by identity", () => {
  const rows = HIGHLEVEL_OPERATION_MANIFEST.filter(row => row.family === "opportunities" && row.disposition === "ready");
  expect(opportunitiesOperations.map(spec => spec.id).sort()).toEqual(rows.map(row => row.id).sort());
  for (const spec of opportunitiesOperations) expect(spec.row).toBe(rows.find(row => row.id === spec.id));
});
it("F0: args and wire schemas use the frozen family objects", () => {
  for (const spec of opportunitiesOperations) {
    const schema = schemas[spec.id as keyof typeof schemas];
    expect(spec.args).toBe(schema.argsSchema);
    expect(spec.row.bodySchema).toBe(schema.bodySchema);
  }
});
it("F0: ratified ownership preflights use the frozen allowlist", () => {
  for (const spec of opportunitiesOperations) {
    expect(spec.preflight).toBe(HIGHLEVEL_OPERATION_MANIFEST.find(row => row.id === spec.id)!.preflight);
  }
});
it("F0: family has no provisional declarations or registry casts", () => {
  const source = readFileSync(new URL("./opportunities.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/R4-PROVISIONAL|PROVISIONAL INTERFACE|LegacyOperationSpec|provisionalRow|as unknown as|export (?:type|interface)/);
});
it("F0: registry validates every family spec and preserves lookup identity", async () => {
  const { operationSpec, assertRegistryCompleteness } = await import("./registry.ts");
  const specs: readonly OperationSpec[] = opportunitiesOperations;
  expect(() => assertRegistryCompleteness(specs, ["opportunities"])).not.toThrow();
  for (const spec of specs) expect(operationSpec(spec.id)).toBe(spec);
});

it.each([
  ["delete", { success: false }],
  ["followers.add", {}],
  ["followers.add", { success: false }],
  ["followers.remove", {}],
  ["followers.remove", { success: false }],
  ["status", { succeded: false }],
  ["pipelines.delete", { success: "true" }],
  ["get", { opportunity: { id: "../foreign" } }],
  ["create", { opportunity: {} }],
  ["update", { opportunity: { id: "" } }],
  ["upsert", {}],
  ["pipelines.create", { pipeline: { id: "../foreign" } }],
  ["pipelines.update", { pipeline: {} }],
])("F0 settlement hooks reject malformed success:%s", (verb, raw) => {
  const spec = opportunitiesOperations.find(spec => spec.id === `opportunities.${verb}`)!;
  expect(() => spec.project(raw, responseContext(spec))).toThrow(/expected record/);
  if (spec.risk !== "R") expect(() => spec.recordId!(raw, responseContext(spec))).toThrow(/expected record/);
});

it.each(["get"])("F0 settlement validation preserves idempotent deal projection:%s", verb => {
  const spec = opportunitiesOperations.find(spec => spec.id === `opportunities.${verb}`)!;
  const frozen = responseContext(spec);
  const once = spec.project({ opportunity: { id: "opp_1", name: "Fixture", providerOnly: "drop" } }, frozen);
  expect(spec.project(once, frozen)).toEqual(once);
});

it.each(["create", "update", "upsert"])("F02 replaces fabricated mutation context: %s", verb => {
  const spec = opportunitiesOperations.find(spec => spec.id === `opportunities.${verb}`)!;
  expect(() => spec.project({ opportunity: { id: "opp_1" } }, responseContext(spec))).toThrow();
});
