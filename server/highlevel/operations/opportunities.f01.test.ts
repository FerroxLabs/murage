import { expect, it } from "vitest";
import { operationSpec, type PreflightRequester } from "./registry.ts";
import { prepareReturnedIdentitySchema } from "../returned-identities.ts";
import { HeldRequest } from "../held-request.ts";

const locationId = "loc_fixture";
const pre: PreflightRequester = { read: async (op, draft) => {
  if (op === "opportunities.get") return { opportunity: { id: draft.path.split("/").at(-1), pipelineId: "pipe_A" } };
  if (op === "opportunities.pipelines.list") return { pipelines: [{ id: "pipe_A", stages: [] }, { id: "pipe_B", stages: [] }] };
  if (op === "users.get") return { id: "user_A", roles: { locationIds: [locationId] } };
  if (op === "contacts.get") return { contact: { id: "contact_A", locationId } };
  throw new Error(`Unexpected fixture read: ${op}`);
} };

// Registered-hook fixture; production approval/dispatch is tested separately.
async function prepared(id: string, args: Record<string, unknown>) {
  const spec = operationSpec(id)!;
  if (spec.risk === "R") throw new Error("Expected mutation");
  const draft = await spec.prepare(pre, spec.args.parse(args), { locationId });
  const held = HeldRequest.freeze(spec, draft, { locationId });
  prepareReturnedIdentitySchema(held, locationId);
  const frozen = held.frozen;
  return { spec, draft, frozen };
}

for (const hook of ["project", "recordId"] as const) {
  it.each([
    ["opportunities.update", { opportunityId: "opp_A", name: "Reviewed" }, { opportunity: { id: "opp_B" } }],
    ["opportunities.pipelines.update", { pipelineId: "pipe_A", name: "Reviewed" }, { pipeline: { id: "pipe_B" } }],
  ] as const)(`F0.1 retained target through ${hook}: %s`, async (id, args, raw) => {
    const { spec, frozen } = await prepared(id, args);
    expect(() => spec[hook]!(raw, frozen)).toThrow(expect.objectContaining({ outcome: "outcome_unknown" }));
  });
  for (const verb of ["add", "remove"]) {
    it.each([{}, { success: false }, { followers: [] }, { followersAdded: [] }, { followersRemoved: [] },
      { followersAdded: ["user_A"], success: false }, { followersRemoved: ["user_A"], success: false }])(
      `F0.1 followers.${verb} rejects ambiguous confirmation through ${hook}: %j`, async raw => {
        const { spec, frozen } = await prepared(`opportunities.followers.${verb}`, { opportunityId: "opp_A", followers: ["user_A"] });
        expect(() => spec[hook]!(raw, frozen)).toThrow(expect.objectContaining({ outcome: JSON.stringify(raw).includes("false") && !((verb === "add" ? "followersRemoved" : "followersAdded") in raw) ? "not_applied" : "outcome_unknown" }));
      });
  }
}

it("runtime dependency: real held preparation is implemented", async () => {
  const { spec, draft } = await prepared("opportunities.update", { opportunityId: "opp_A", name: "Reviewed" });
  expect(HeldRequest.freeze(spec, draft, { locationId }).frozen.path).toBe("/opportunities/opp_A");
});

it("interleaved preparations keep their own targets; missing or swapped context refuses", async () => {
  const a = await prepared("opportunities.update", { opportunityId: "opp_A", name: "First" });
  const b = await prepared("opportunities.update", { opportunityId: "opp_B", name: "Second" });
  const raw = { opportunity: { id: "opp_A" } };
  expect(a.spec.recordId!(raw, a.frozen)).toBe("opp_A");
  expect(a.spec.project(raw, a.frozen)).toEqual({ id: "opp_A" });
  expect(() => a.spec.project(raw, b.frozen)).toThrow();
  expect(() => a.spec.project(raw)).toThrow();
  expect(() => a.spec.recordId!(raw)).toThrow();
  for (const patch of [{ operation: "opportunities.create" as const }, { method: "POST" as const }, { path: "/opportunities/opp_A/status" }, { resource: "opportunities:opportunity:opp_B" }])
    expect(() => a.spec.project(raw, { ...a.frozen, ...patch })).toThrow();
});

it.each([
  { id: "opp_B", opportunity: { id: "opp_A" } },
  { opportunityId: "opp_B", opportunity: { id: "opp_A" } },
  { opportunity: { id: "opp_A", opportunityId: "opp_B" } },
])("all response identity aliases agree: %j", async raw => {
  const { spec, frozen } = await prepared("opportunities.update", { opportunityId: "opp_A", name: "Reviewed" });
  expect(() => spec.project(raw, frozen)).toThrow(); expect(() => spec.recordId!(raw, frozen)).toThrow();
});

it.each([
  ["opportunities.create", { pipelineId: "pipe_A", contactId: "contact_A", name: "New" }, "opportunity"],
  ["opportunities.upsert", { pipelineId: "pipe_A", name: "New" }, "opportunity"],
  ["opportunities.pipelines.create", { name: "New", stages: [{ name: "New", position: 0 }] }, "pipeline"],
] as const)("create/upsert validates a new provider ID and reported location: %s", async (id, args, envelope) => {
  const { spec, frozen } = await prepared(id, structuredClone(args));
  const record = { id: "new_provider_id", locationId,
    ...(id === "opportunities.upsert" ? { followers: [] } : {}),
    ...(id === "opportunities.pipelines.create" ? { stages: [{ id: "new_stage", position: 0 }] } : {}),
  };
  const raw = { ...(id === "opportunities.upsert" ? { new: true } : {}), [envelope]: record };
  expect(spec.recordId!(raw, frozen)).toBe("new_provider_id");
  expect(spec.project(raw, frozen)).toHaveProperty("id", "new_provider_id");
  expect(() => spec.project({ ...raw, [envelope]: { ...record, locationId: "foreign" } }, frozen)).toThrow();
  if (id === "opportunities.pipelines.create") {
    const incomplete = { pipeline: { id: "new_provider_id", locationId } };
    expect(() => spec.recordId!(incomplete, frozen)).toThrow();
    expect(() => spec.project(incomplete, frozen)).toThrow();
  }
});

it.each(["add", "remove"])("followers.%s validates operation-specific confirmation without inventing a receipt ID", async verb => {
  const { spec, frozen } = await prepared(`opportunities.followers.${verb}`, { opportunityId: "opp_A", followers: ["user_A"] });
  const raw = verb === "add" ? { followers: ["user_A"], followersAdded: ["user_A"] } : { followersRemoved: ["user_A"] };
  expect(spec.recordId!(raw, frozen)).toBeUndefined(); expect(spec.project(raw, frozen)).toEqual(raw);
});
