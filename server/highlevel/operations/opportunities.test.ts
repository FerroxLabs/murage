// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { levelCovers } from "../../../shared/highlevel.ts";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { operationSpec, HIGHLEVEL_OPERATION_MANIFEST, type OperationSpec, type PreflightRequester, type RequestDraft, type ReadSpec, type MutationSpec, type ManifestRow, type Gate } from "./registry.ts";
import { prepareReturnedIdentitySchema } from "../returned-identities.ts";
import { HeldRequest } from "../held-request.ts";
import * as contract from "../provider-contract.ts";
import type { fakeHighLevelRequester } from "../fake-provider.ts";
import { opportunitiesRoutes } from "../fake/opportunities.ts";
import { opportunitiesOperations } from "./opportunities.ts";

// In-memory provider fixture only; production preparation uses PreflightRequester.
type FixtureRequester = Pick<ReturnType<typeof fakeHighLevelRequester>, "request">;
const locationId = "loc_fixture_01";
const SENTINEL = "PRIVATE_DEAL_VALUE_901";
const rows = [
  ["pipelines.list", "R", "GET", "/opportunities/pipelines", { locationId }],
  ["search", "R", "GET", "/opportunities/search", { locationId, query: SENTINEL }],
  ["get", "R", "GET", "/opportunities/opp_1", { locationId, opportunityId: "opp_1" }],
  ["create", "C", "POST", "/opportunities/", { locationId, pipelineId: "pipe_1", contactId: "contact_1", name: SENTINEL, status: "open" }],
  ["update", "C", "PUT", "/opportunities/opp_1", { locationId, opportunityId: "opp_1", name: SENTINEL }],
  ["status", "C", "PUT", "/opportunities/opp_1/status", { locationId, opportunityId: "opp_1", status: "won" }],
  ["upsert", "C", "POST", "/opportunities/upsert", { locationId, pipelineId: "pipe_1", name: SENTINEL, status: "open" }],
  ["delete", "D", "DELETE", "/opportunities/opp_1", { locationId, opportunityId: "opp_1" }],
  ["followers.add", "C", "POST", "/opportunities/opp_1/followers", { locationId, opportunityId: "opp_1", followers: ["user_1"] }],
  ["followers.remove", "C", "DELETE", "/opportunities/opp_1/followers", { locationId, opportunityId: "opp_1", followers: ["user_1"] }],
  ["pipelines.create", "C", "POST", "/opportunities/pipelines", { locationId, name: SENTINEL, stages: [{ name: "New", position: 0 }] }],
  ["pipelines.update", "C", "PUT", "/opportunities/pipelines/pipe_1", { locationId, pipelineId: "pipe_1", name: SENTINEL }],
  ["pipelines.delete", "D", "DELETE", "/opportunities/pipelines/pipe_1", { locationId, pipelineId: "pipe_1" }],
] as const;
function spec(verb: string) {
  const found = opportunitiesOperations.find((s) => s.id === `opportunities.${verb}`);
  expect(found, `operation ${verb} must be implemented`).toBeDefined();
  return found! as OperationSpec & { prepare?: MutationSpec["prepare"]; prepareRead?: ReadSpec["prepareRead"] };
}
function crm() {
  const request = vi.fn(async (op: string): Promise<unknown> => {
    if (op === "opportunities.pipelines.list") return { pipelines: [{ id: "pipe_1", stages: [{ id: "stage_1" }] }] };
    if (op === "contacts.get") return { contact: { id: "contact_1", locationId } };
    if (op === "users.get") return { id: "user_1", roles: { locationIds: [locationId] } };
    return { opportunity: { id: "opp_1", locationId, pipelineId: "pipe_1", pipelineStageId: "stage_1", name: SENTINEL } };
  });
  return { request } satisfies FixtureRequester;
}

// Isolated family adapter for preparation/projection contract checks only.
// Production approval, held dispatch and recovery are in opportunities-dispatch.test.ts.
function preflight(s: OperationSpec, c: FixtureRequester): PreflightRequester {
  return { read: async (op, d) => {
    if (!s.preflight.includes(op) || contract.HIGHLEVEL_ENDPOINTS[op]?.retry !== "read") throw new Error("preflight_not_allowed");
    return c.request(op, "GET", d.path, d.body, d.query);
  } };
}
async function execute(s: OperationSpec, c: FixtureRequester, input: Record<string, unknown>) {
  const a = s.args.parse(input);
  const pre = preflight(s, c);
  let draft: RequestDraft;
  if (s.risk === "R") {
    await s.ownership!(pre, a, { locationId });
    draft = await s.prepareRead(a, { locationId });
  } else draft = await s.prepare!(pre, a, { locationId });
  const raw = await c.request(s.id, s.endpoint.method, draft.path, (draft.body?.kind === "json" ? draft.body.value : undefined), draft.query);
  const held = HeldRequest.freeze(s, draft, { locationId });
  if (s.risk !== "R") prepareReturnedIdentitySchema(held, locationId);
  const recordId = s.risk === "R" ? undefined : s.recordId?.(raw, held.frozen);
  return { value: s.risk === "R" ? s.project(raw) : s.project(raw, held.frozen), ...(recordId ? { recordId } : {}) };
}

describe("F2 Deals and pipelines", () => {
  it("opps.moveStageNeedsStageInPipeline", async () => {
    const s = spec("update");
    expect(typeof s.ownership).toBe("function");
    const c = crm();
    const args = s.args.parse({ locationId, opportunityId: "opp_1", pipelineStageId: "stage_other" });
    await expect(s.ownership!(preflight(s, c), args, { locationId })).rejects.toThrow(/stage|pipeline/i);
    expect(c.request.mock.calls.every(([op]) => op.endsWith(".get") || op.endsWith(".list"))).toBe(true);
    await expect(s.ownership!(preflight(s, c), { ...args, pipelineStageId: "stage_1" }, { locationId })).resolves.toBeUndefined();
  });
  it("opps.statusEnumClosed", () => {
    for (const verb of ["create", "update", "upsert", "status"]) {
      const s = spec(verb);
      const a = rows.find(([v]) => v === verb)![4];
      for (const status of ["open", "won", "lost", "abandoned"]) expect(s.args.safeParse({ ...a, status }).success).toBe(true);
      for (const status of ["all", "closed", "", "https://evil.test"]) expect(s.args.safeParse({ ...a, status }).success).toBe(false);
    }
  });
  it("opps.pipelineWriteProviderAbsentRefused", async () => {
    const absent = vi.spyOn(contract, "endpointFor").mockReturnValue(null);
    try {
      for (const [verb, risk, , , sample] of rows.filter(([v]) => v.startsWith("pipelines.") && v !== "pipelines.list")) {
        const s = spec(verb);
        expect(s.risk).toBe(risk);
        const c = crm();
        await expect(execute(s, c, sample)).rejects.toThrow(/provider_absent/);
        await expect(s.ownership!(preflight(s, c), sample, { locationId })).rejects.toThrow(/provider_absent/);
        expect(c.request).not.toHaveBeenCalled();
      }
    } finally { absent.mockRestore(); }
  });
  for (const [verb, risk, method, path, sample] of rows) {
    it(`${verb}: strict schema, frozen endpoint, risk and value-free metadata`, () => {
      const s = spec(verb);
      const a = s.args.parse(sample);
      expect(s.risk).toBe(risk);
      expect(s.family).toBe("opportunities");
      expect(s.endpoint).toBe(contract.HIGHLEVEL_ENDPOINTS[s.id]);
      expect(operationSpec(s.id)?.id).toBe(s.id);
      expect(s.endpoint.method).toBe(method);
      expect(s.endpoint.path.test(path)).toBe(true);
      expect(s.endpoint.path.test(`${path}/extra`)).toBe(false);
      expect(s.endpoint.version).toBe("2021-07-28");
      expect(s.endpoint.scope).toBe(verb === "pipelines.create" ? "pipelines.create" : verb.startsWith("pipelines.") && risk !== "R" ? "pipelines.write" : risk === "R" ? "opportunities.readonly" : "opportunities.write");
      expect(s.endpoint.retry).toBe(risk === "R" ? "read" : "write");
      for (const key of ["extra", "url", "headers", "token", "path"]) expect(s.args.safeParse({ ...a, [key]: "https://evil.test" }).success).toBe(false);
      expect(s.args.safeParse({ ...a, locationId: "https://evil.test" }).success).toBe(false);
      expect(JSON.stringify([s.fields(a), s.recordRefs(a)])).not.toContain(SENTINEL);
      expect(s.targets(a)).toBe(1);
    });
    it(`${verb}: ownership cannot cross the granted location`, async () => {
      const s = spec(verb);
      expect(typeof s.ownership).toBe("function");
      const c = crm();
      await expect(s.ownership!(preflight(s, c), s.args.parse(sample), { locationId: "other_location" })).rejects.toThrow("Choose the HighLevel business connected here.");
      expect(c.request).not.toHaveBeenCalled();
    });
  }
});

// Pure level/risk contract adapter. Production authorization is tested separately.
function harness(level: "read" | "change" | "full") {
  const requests: Array<{ op: string; method: string; path: string; body?: unknown; query?: Record<string, string> }> = [];
  const requester: FixtureRequester = { async request(op, method, path, body, query) {
    requests.push({ op, method, path, body, query });
    if (op === "contacts.get") return { contact: { id: "contact_1", locationId } };
    if (op === "users.get") return { id: "user_1", roles: { locationIds: [locationId] } };
    const route = opportunitiesRoutes.find(r => r.operation === op && r.method === method && r.path.test(path));
    if (!route) throw new Error("Unscripted F2 route");
    return route.handle({ operation: op, method, path, body, query });
  } };
  return { requests, requester, async run(verb: string, input: Record<string, unknown>) {
    const s = spec(verb);
    const allowed = levelCovers(level, s.risk);
    if (!allowed) throw new Error("not_granted");
    const a = s.args.parse(input);
    await s.ownership!(preflight(s, requester), a, { locationId });
    return execute(s, requester, a);
  } };
}
for (const [verb, risk, method, path, sample] of rows) {
  it(`${verb}: read/change grants and exact fake dispatch`, async () => {
    const read = harness("read");
    if (risk === "R") await expect(read.run(verb, sample)).resolves.toHaveProperty("value");
    else {
      await expect(read.run(verb, sample)).rejects.toThrow("not_granted");
      expect(read.requests).toEqual([]);
    }
    if (risk === "D") {
      const change = harness("change");
      await expect(change.run(verb, sample)).rejects.toThrow("not_granted");
      expect(change.requests).toEqual([]);
    }
    const allowed = harness(risk === "D" ? "full" : "change");
    await allowed.run(verb, sample);
    expect(allowed.requests.at(-1)).toMatchObject({ op: `opportunities.${verb}`, method, path });
    expect(allowed.requests.filter(r => r.method !== "GET")).toHaveLength(risk === "R" ? 0 : 1);
  });

}
it("opps.foreignNestedRecordsNeverDispatch", async () => {
  for (const [verb, , , , sample] of rows.filter(([, , , , a]) => "opportunityId" in a)) {
    const c = crm();
    c.request.mockResolvedValue({ opportunity: { id: "opp_1", pipelineId: "pipe_other", locationId: "foreign" } });
    await expect(execute(spec(verb), c, spec(verb).args.parse(sample))).rejects.toThrow(/ownership/);
    expect(c.request.mock.calls).toHaveLength(1);
  }
  for (const verb of ["create"]) {
    const c = crm();
    const original = c.request.getMockImplementation()!;
    c.request.mockImplementation(async op => op === "contacts.get" ? { contact: { id: "contact_1", locationId: "foreign" } } : original(op));
    const a = spec(verb).args.parse(rows.find(([v]) => v === verb)![4]);
    await expect(execute(spec(verb), c, a)).rejects.toThrow(/ownership/);
    expect(c.request.mock.calls.some(([op]) => op === `opportunities.${verb}`)).toBe(false);
  }
});
it("opps.boundedProjectionDropsProviderNoise", () => {
  const get = spec("get");
  const result = get.project({ opportunity: { id: "opp_1", name: "x".repeat(20000), monetaryValue: 200, secret: SENTINEL, nested: { error: SENTINEL } } });
  expect(JSON.stringify(result)).not.toContain(SENTINEL);
  expect(JSON.stringify(result).length).toBeLessThan(2200);
  const list = spec("pipelines.list");
  const projected = list.project({ pipelines: Array.from({ length: 200 }, () => ({ id: "pipe_1", stages: Array.from({ length: 200 }, () => ({ id: "stage_1" })) })) }) as { pipelines: Array<{ stages: unknown[] }> };
  expect(projected.pipelines.length).toBeLessThanOrEqual(100);
  expect(projected.pipelines[0]!.stages.length).toBeLessThanOrEqual(100);
});
it("opps.followersCountTowardBulkAndIdsCannotTraverse", () => {
  expect(spec("followers.add").targets({ locationId, opportunityId: "opp_1", followers: ["user_1", "user_2"] })).toBe(2);
  for (const id of ["../escape", "x%2fy", "%252f", "..", ".", "x?token=a", "https://evil.test", "x\\y"]) {
    expect(spec("get").args.safeParse({ locationId, opportunityId: id }).success).toBe(false);
  }
});

it("opps.pipelineStagesAreStrictAndBelongToTheirPipeline", async () => {
  const s = spec("pipelines.update");
  for (const stages of [[], [{ name: "New", position: 0, url: "https://evil.test" }], [{ name: "https://evil.test", position: 0 }], [{ name: "New", position: 0 }, { name: "NEW", position: 1 }]]) {
    expect(s.args.safeParse({ locationId, pipelineId: "pipe_1", stages }).success).toBe(false);
  }
  const c = crm();
  await expect(s.ownership!(preflight(s, c), s.args.parse({ locationId, pipelineId: "pipe_1", stages: [{ id: "stage_foreign", name: "New", position: 0 }] }), { locationId })).rejects.toThrow(/stage/);
});
it("opps.writePayloadsKeepOnlyReviewedFieldsAndUseProviderNames", async () => {
  const h = harness("change");
  await h.run("update", { locationId, opportunityId: "opp_1", pipelineStageId: "stage_2", monetaryValue: 42 });
  expect(h.requests.at(-1)!.body).toEqual({ pipelineStageId: "stage_2", monetaryValue: 42 });
  await h.run("upsert", { locationId, pipelineId: "pipe_1", name: "New" });
  expect(h.requests.at(-1)!.body).toEqual({ locationId, pipelineId: "pipe_1", name: "New", status: "open", followers: [], isRemoveAllFollowers: false, followersActionType: "add" });
  await h.run("search", { locationId, pipelineId: "pipe_1", pipelineStageId: "stage_1", status: "all" });
  expect(h.requests.at(-1)!.query).toEqual({ location_id: locationId, pipeline_id: "pipe_1", pipeline_stage_id: "stage_1", page: "1", limit: "20" });
});

it("opps.stageReplacementEscalatesAsBulk", () => {
  const s = spec("pipelines.update");
  expect(s.risk).toBe("C");
  expect(s.targets({ locationId, pipelineId: "pipe_1", name: "Renamed" })).toBe(1);
  expect(s.fields({ locationId, pipelineId: "pipe_1", name: "Renamed" })).toEqual(["name"]);
  expect(spec("pipelines.delete").fields({ locationId, pipelineId: "pipe_1" })).toEqual([]);
  expect(s.targets({ locationId, pipelineId: "pipe_1", stages: [{ name: "Replacement", position: 0 }] })).toBeGreaterThan(1);
});
it("opps.projectionBoundsAggregateBytesAndIsIdempotent", () => {
  const s = spec("pipelines.list");
  const value = s.project({ pipelines: Array.from({ length: 100 }, () => ({ id: "pipe_1", name: "名".repeat(3000),
    stages: Array.from({ length: 100 }, () => ({ id: "stage_1", name: "名".repeat(3000), position: 0 })) })) });
  expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(65536);
  const search = spec("search");
  const first = search.project({ opportunities: [{ id: "opp_1", name: "Example" }], meta: { total: 20 } });
  expect(search.project(first)).toEqual(first);
});
it("opps.malformedWriteSuccessIsUnknownAndNeverRetried", async () => {
  const s = spec("update");
  const c = crm();
  const original = c.request.getMockImplementation()!;
  c.request.mockImplementation(async op => op === s.id ? { opportunity: { id: "wrong_id" } } : original(op));
  await expect(execute(s, c, { locationId, opportunityId: "opp_1", name: "Reviewed" })).rejects.toMatchObject({ outcome: "outcome_unknown" });
  expect(c.request.mock.calls.filter(([op]) => op === s.id)).toHaveLength(1);
});
it("opps.followersAndAssigneeMustBelongToLocation", async () => {
  const c = crm();
  const original = c.request.getMockImplementation()!;
  c.request.mockImplementation(async op => op === "users.get" ? { id: "user_1", roles: { locationIds: ["foreign"] } } : original(op));
  await expect(execute(spec("followers.add"), c, { locationId, opportunityId: "opp_1", followers: ["user_1"] })).rejects.toThrow(/ownership/);
  await expect(execute(spec("update"), c, { locationId, opportunityId: "opp_1", assignedTo: "user_1" })).rejects.toThrow(/ownership/);
  expect(c.request.mock.calls.some(([op]) => op === "opportunities.followers.add" || op === "opportunities.update")).toBe(false);
});

// Every family draft uses the frozen preparation seam and read-only preflights.
for (const [verb, risk, , path, sample] of rows) {
  it(`${verb}: amended request preparation binds resource and has read-only preflight`, async () => {
    const s = spec(verb) as unknown as {
      prepare?: (pre: unknown, a: unknown, ctx: { locationId: string }) => Promise<{ path: string; resource: string }>;
      prepareRead?: (a: unknown, ctx: { locationId: string }) => Promise<{ path: string; resource: string }>;
      nested?: boolean; preflight?: readonly string[];
    };
    expect(s.preflight).toBeDefined();
    expect(typeof s.nested).toBe("boolean");
    for (const id of s.preflight ?? []) expect(contract.HIGHLEVEL_ENDPOINTS[id]?.retry).toBe("read");
    const c = crm();
    const pre = { read: (op: Parameters<FixtureRequester["request"]>[0], draft: { path: string; body?: unknown; query?: Record<string, string> }) =>
      (c as FixtureRequester).request(op, "GET", draft.path, draft.body, draft.query) };
    const a = spec(verb).args.parse(sample);
    const draft = risk === "R" ? (expect(typeof s.prepareRead).toBe("function"), await s.prepareRead!(a, { locationId }))
      : (expect(typeof s.prepare).toBe("function"), await s.prepare!(pre, a, { locationId }));
    expect(draft.path).toBe(path);
    expect(draft.resource).toBe("opportunityId" in sample ? "opportunities:opportunity:opp_1"
      : verb === "pipelines.update" || verb === "pipelines.delete" ? "opportunities:pipeline:pipe_1" : `location:${locationId}`);
    expect(c.request.mock.calls.every(([op]) => contract.HIGHLEVEL_ENDPOINTS[op]?.retry === "read")).toBe(true);
  });
}

for (const verb of ["update", "status", "delete"] as const) {
  it(`freeze.otherOpportunityIdRefused:${verb}`, async () => {
    const s = spec(verb);
    expect(typeof s.prepare).toBe("function");
    const c = crm();
    const original = c.request.getMockImplementation()!;
    c.request.mockImplementation(async op => op === "opportunities.get"
      ? { opportunity: { id: "opp_other", locationId, pipelineId: "pipe_1" } } : original(op));
    const a = s.args.parse(rows.find(([v]) => v === verb)![4]);
    await expect(s.prepare!(preflight(s, c), a, { locationId })).rejects.toThrow(/ownership/);
    expect(c.request.mock.calls.every(([op]) => contract.HIGHLEVEL_ENDPOINTS[op]?.retry === "read")).toBe(true);
  });
  it(`freeze.argsChangedDuringPreflightCannotRetarget:${verb}`, async () => {
    const s = spec(verb);
    expect(typeof s.prepare).toBe("function");
    const c = crm();
    const a = { ...rows.find(([v]) => v === verb)![4] } as Record<string, unknown>;
    const original = c.request.getMockImplementation()!;
    c.request.mockImplementation(async op => {
      a.opportunityId = "opp_other";
      a.name = "Unreviewed";
      return original(op);
    });
    const draft = await s.prepare!(preflight(s, c), a, { locationId });
    expect(draft.resource).toBe("opportunities:opportunity:opp_1");
    expect(draft.path).toBe(verb === "status" ? "/opportunities/opp_1/status" : "/opportunities/opp_1");
    expect(JSON.stringify(draft)).not.toContain("opp_other");
    expect(JSON.stringify(draft)).not.toContain("Unreviewed");
  });
}
for (const [verb, risk, , , sample] of rows) {
  it(`${verb}: no legacy run member can bypass frozen transport`, () => {
    const s = spec(verb);
    const c = crm();
    expect("run" in s).toBe(false);
    expect(c.request).not.toHaveBeenCalled();
    expect(s.endpoint.retry).toBe(risk === "R" ? "read" : "write");
  });
  it(`${verb}: context location is authoritative and a mismatch refuses before lease`, async () => {
    const s = spec(verb);
    const c = crm();
    const a = s.args.parse(sample);
    expect(s.preflight).toBeDefined();
    const pre = preflight(s, c);
    if (s.risk === "R") await expect(s.prepareRead!(a, { locationId: "foreign" })).rejects.toThrow("Choose the HighLevel business connected here.");
    else await expect(s.prepare!(pre, a, { locationId: "foreign" })).rejects.toThrow("Choose the HighLevel business connected here.");
    expect(c.request).not.toHaveBeenCalled();
    const withoutLocation = Object.fromEntries(Object.entries(a).filter(([key]) => key !== "locationId"));
    expect(s.args.safeParse(withoutLocation).success).toBe(true);
  });
}

it("registry.noRunMember", () => {
  for (const s of opportunitiesOperations) expect("run" in s).toBe(false);
});
it("registry.everyReadHasPrepareRead", async () => {
  for (const [verb, risk, , , sample] of rows) {
    if (risk !== "R") continue;
    const s = spec(verb);
    const pending = s.prepareRead!(s.args.parse(sample), { locationId });
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).resolves.toHaveProperty("resource");
  }
});
it("registry.familySpecsBindTheirRowAndSchema", () => {
  for (const s of opportunitiesOperations) {
    const row = HIGHLEVEL_OPERATION_MANIFEST.find(row => row.id === s.id);
    expect(s.row).toBe(row);
    expect(row!.id).toBe(s.id);
    expect(row!.argsSchema).toBe(s.args);
    expect(row!.preflight).toBe(s.preflight);
  }
});

it("registry.manifestDiscriminatesReadyAndAbsentEndpoints", () => {
  // These assertions run under the server TypeScript check as well as Vitest.
  // An absent provider endpoint must be representable without inventing a route.
  type Ready = Extract<ManifestRow, { disposition: "ready" }>;
  type Absent = Extract<ManifestRow, { disposition: "provider_absent" }>;
  expectTypeOf<Ready["method"]>().toEqualTypeOf<contract.HighLevelMethod>();
  expectTypeOf<Ready["path"]>().toEqualTypeOf<string>();
  expectTypeOf<Ready["scope"]>().toEqualTypeOf<string>();
  expectTypeOf<Ready["version"]>().toEqualTypeOf<string>();
  expectTypeOf<Absent["method"]>().toEqualTypeOf<contract.HighLevelMethod | null>();
  expectTypeOf<Absent["path"]>().toEqualTypeOf<string | null>();
  expectTypeOf<Absent["scope"]>().toEqualTypeOf<string | null>();
  expectTypeOf<Absent["version"]>().toEqualTypeOf<string | null>();
  expectTypeOf<Gate>().toEqualTypeOf<"R" | "GC" | "GC+" | "GD" | "GDp">();
  for (const s of opportunitiesOperations) {
    expect(s.row.disposition).toBe("ready");
    expect(s.row.gate).toBe(s.risk === "R" ? "R" : s.risk === "D" ? "GD" : "GC");
  }
});

it.each([false, true])("registry.providerAbsentRowNeverCreatesOpportunitySpec (unknown endpoint: %s)", async unknownEndpoint => {
  vi.resetModules();
  vi.doMock("./manifest.ts", async () => {
    const actual = await vi.importActual<typeof import("./manifest.ts")>("./manifest.ts");
    return { HIGHLEVEL_OPERATION_MANIFEST: actual.HIGHLEVEL_OPERATION_MANIFEST.map(row =>
      row.id === "opportunities.pipelines.create"
        ? { ...row, disposition: "provider_absent", ...(unknownEndpoint ? { method: null, path: null, scope: null, version: null } : {}) } : row) };
  });
  try {
    const { opportunitiesOperations: available } = await import("./opportunities.ts");
    expect(available.map(s => s.id)).toEqual(opportunitiesOperations.map(s => s.id).filter(id => id !== "opportunities.pipelines.create"));
  } finally {
    vi.doUnmock("./manifest.ts");
    vi.resetModules();
  }
});

for (const [verb, risk, , path, sample] of rows) {
  if (risk !== "R") continue;
  it(`T-D5 freeze.acceptsReadSpec:${verb} and refuses wrong location`, async () => {
    const s = spec(verb);
    if (s.risk !== "R") throw new Error("Expected a read spec");
    const draft = await s.prepareRead(s.args.parse(sample), { locationId });
    const held = HeldRequest.freeze(s, draft, { locationId });
    expect(held.frozen).toMatchObject({ operation: s.id, method: "GET", path, resource: draft.resource });
    await expect(s.prepareRead(s.args.parse(sample), { locationId: "foreign" })).rejects.toThrow("Choose the HighLevel business connected here.");
  });
}

for (const [verb, , , , sample] of rows) {
  it(`F0 wire body:${verb} matches the frozen schema`, async () => {
    const s = spec(verb);
    const a = s.args.parse(sample);
    const draft = s.risk === "R" ? await s.prepareRead(a, { locationId })
      : await s.prepare(preflight(s, crm()), a, { locationId });
    if (draft.body?.kind === "json") {
      expect(s.row.bodySchema).not.toBeNull();
      expect(s.row.bodySchema!.parse(draft.body.value)).toEqual(draft.body.value);
    } else expect(s.row.bodySchema).toBeNull();
  });
}
