import { afterEach, expect, it, vi } from "vitest";
import { operationSpec, type PreflightRequester } from "./registry.ts";
import { HeldRequest } from "../held-request.ts";
import * as identities from "../returned-identities.ts";
import { HIGHLEVEL_RETURNED_IDENTITY_SCHEMAS } from "./returned-identity-schemas.ts";

const locationId = "loc_fixture";
const pre: PreflightRequester = { read: async (op, draft) => {
  if (op === "opportunities.get") return { opportunity: { id: draft.path.split("/").at(-1), pipelineId: "pipe_A" } };
  if (op === "opportunities.pipelines.list") return { pipelines: [{ id: "pipe_A", stages: [{ id: "stage_A" }] }] };
  if (op === "users.get") return { id: "user_A", roles: { locationIds: [locationId] } };
  if (op === "contacts.get") return { contact: { id: "contact_A", locationId } };
  throw new Error("Unexpected fixture read");
} };
async function prepared(verb: string, args: Record<string, unknown>) {
  const spec = operationSpec(`opportunities.${verb}`)!;
  if (spec.risk === "R") throw new Error("mutation required");
  const held = HeldRequest.freeze(spec, await spec.prepare(pre, args, { locationId }), { locationId });
  identities.prepareReturnedIdentitySchema(held, locationId);
  return { spec, frozen: held.frozen };
}
afterEach(() => vi.restoreAllMocks());
const examples = [
  ["create", { pipelineId: "pipe_A", contactId: "contact_A", name: "New" }, { opportunity: { id: "new_opp", contactId: "contact_A", contact: { contactId: "contact_A" } } }],
  ["update", { opportunityId: "opp_A", pipelineId: "pipe_A", pipelineStageId: "stage_A", assignedTo: "user_A" }, { opportunity: { id: "opp_A", pipelineId: "pipe_A", pipelineStageId: "stage_A", assignedTo: "user_A" } }],
  ["status", { opportunityId: "opp_A", status: "won" }, { succeeded: true }],
  ["upsert", { pipelineId: "pipe_A", name: "New" }, { new: true, opportunity: { id: "new_opp", followers: [] } }],
  ["delete", { opportunityId: "opp_A" }, { succeeded: true }],
  ["followers.add", { opportunityId: "opp_A", followers: ["user_A"] }, { followersAdded: ["user_A"] }],
  ["followers.remove", { opportunityId: "opp_A", followers: ["user_A"] }, { followersRemoved: ["user_A"] }],
  ["pipelines.create", { name: "New", stages: [{ name: "New", position: 0 }] }, { pipeline: { id: "new_pipe", stages: [{ id: "new_stage" }] } }],
  ["pipelines.update", { pipelineId: "pipe_A", stages: [{ id: "stage_A", name: "Existing", position: 0 }, { name: "New", position: 1 }] }, { pipeline: { id: "pipe_A", stages: [{ id: "stage_A" }, { id: "new_stage" }] } }],
  ["pipelines.delete", { pipelineId: "pipe_A" }, { success: true }],
] as const;
for (const [verb, args, good] of examples) {
  it(`F02 ${verb}: positive hooks use the shared binder and connected location`, async () => {
    const { spec, frozen } = await prepared(verb, structuredClone(args));
    const bind = vi.spyOn(identities, "bindReturnedIdentities");
    const raw = { ...structuredClone(good), locationId };
    spec.recordId!(raw, frozen); spec.project(raw, frozen);
    expect(bind).toHaveBeenCalledTimes(2);
    for (const call of bind.mock.calls) expect(call[1]).toBe(frozen);
  });
  const schema = HIGHLEVEL_RETURNED_IDENTITY_SCHEMAS[`opportunities.${verb}`];
  const keys = [...new Set([...Object.keys(schema.identities), "contactId", "unknown_id", "opportunityId", "pipelineId", "pipelineStageId", "assignedTo", "locationId", "followersAdded", "followersRemoved"])];
  for (const depth of [1, 2, 3]) for (const array of [false, true]) it.each(keys)(`F02 ${verb} conflicting %s depth=${depth} array=${array}`, async key => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { spec, frozen } = await prepared(verb, structuredClone(args));
    let nested: unknown = { [key]: key.startsWith("follower") ? ["foreign"] : "foreign" };
    for (let n = 1; n < depth; n++) nested = { extra: nested };
    const raw = { ...structuredClone(good), extra: array ? [nested] : nested };
    for (const hook of ["project", "recordId"] as const) expect(() => spec[hook]!(raw, frozen)).toThrow(expect.objectContaining({ outcome: "outcome_unknown" }));
  });
}
it.each([
  ["nested contactId alias", { opportunity: { id: "new_opp", contact: { contactId: "contact_other" } } }],
  ["related contact disagreement", { opportunity: { id: "new_opp", contactId: "contact_A", contact: { id: "contact_other" } } }],
])("F02 reviewer %s", async (_label, raw) => {
  const { spec, frozen } = await prepared("create", { pipelineId: "pipe_A", contactId: "contact_A", name: "New" });
  expect(() => spec.project(raw, frozen)).toThrow(); expect(() => spec.recordId!(raw, frozen)).toThrow();
});
it.each([{ success: false }, { deep: [{ succeeded: false }] }, { deep: [{ error: "PRIVATE" }] }])("F02 nested negative %j", async extra => {
  const { spec, frozen } = await prepared("update", { opportunityId: "opp_A", name: "Reviewed" });
  const raw = { opportunity: { id: "opp_A", ...extra } };
  expect(() => spec.project(raw, frozen)).toThrow(expect.objectContaining({ outcome: "not_applied" }));
  expect(() => spec.recordId!(raw, frozen)).toThrow(expect.objectContaining({ outcome: "not_applied" }));
});
it.each([["user_other"], [], ["user_A", "user_other"], ["user_A", "user_A"]].map(followers => ({ followers })))("F02 follower set differs $followers", async ({ followers }) => {
  const { spec, frozen } = await prepared("followers.add", { opportunityId: "opp_A", followers: ["user_A"] });
  expect(() => spec.project({ followersAdded: followers }, frozen)).toThrow();
});
it("F02 existing pipeline stage cannot be replaced by a newly issued ID", async () => {
  const { spec, frozen } = await prepared("pipelines.update", { pipelineId: "pipe_A", stages: [{ id: "stage_A", name: "Existing", position: 0 }] });
  expect(() => spec.project({ pipeline: { id: "pipe_A", stages: [{ id: "new_stage" }] } }, frozen)).toThrow();
});
it("F02 upsert without an approved ID requires new:true", async () => {
  const { spec, frozen } = await prepared("upsert", { pipelineId: "pipe_A", name: "New" });
  expect(() => spec.project({ new: false, opportunity: { id: "unapproved_existing", followers: [] } }, frozen)).toThrow();
});
it("P2 upsert binds the approved ID from retained body bytes under the location resource", async () => {
  const args = { id: "opp_A", pipelineId: "pipe_A", name: "Reviewed" };
  const spec = operationSpec("opportunities.upsert")!;
  if (spec.risk === "R") throw new Error("mutation required");
  const held = HeldRequest.freeze(spec, await spec.prepare(pre, args, { locationId }), { locationId });
  args.id = "opp_B";
  expect(spec.row.pathResourceSegment).toBeNull();
  expect(held.frozen.resource).toBe(`location:${locationId}`);
  expect(JSON.parse(new TextDecoder().decode(held.sendCopy().body)).id).toBe("opp_A");
  const bound = identities.prepareReturnedIdentitySchema(held, locationId);
  const good = { new: false, opportunity: { id: "opp_A", followers: [] } };
  expect(identities.bindReturnedIdentities(good, held.frozen, bound)).toEqual({ status: "applied" });
  expect(spec.recordId!(good, held.frozen)).toBe("opp_A");
  expect(spec.project(good, held.frozen)).toMatchObject({ id: "opp_A" });
  for (const isNew of [false, true]) {
    const wrong = { new: isNew, opportunity: { id: "opp_B", followers: [] } };
    expect(identities.bindReturnedIdentities(wrong, held.frozen, bound)).toMatchObject({ status: "conflict" });
    expect(() => spec.recordId!(wrong, held.frozen)).toThrow();
    expect(() => spec.project(wrong, held.frozen)).toThrow();
  }
});
