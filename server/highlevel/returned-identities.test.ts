import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import type { HeldRequest, FrozenRequest } from "./held-request.ts";
import { canonicalJson } from "./operations/registry.ts";
import { HIGHLEVEL_OPERATION_MANIFEST } from "./operations/manifest.ts";
import { HIGHLEVEL_RETURNED_IDENTITY_SCHEMAS } from "./operations/returned-identity-schemas.ts";
import { bindReturnedIdentities, prepareReturnedIdentitySchema, returnedIdentitySchemaFor } from "./returned-identities.ts";

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
export function fixture(operation = "contacts.update", body: unknown = { firstName: "Approved", assignedTo: "user-approved" }) {
  const row = HIGHLEVEL_OPERATION_MANIFEST.find(r => r.id === operation)!;
  if (row.disposition !== "ready") throw new Error("fixture requires ready operation");
  const path = row.path.replace(/:([A-Za-z]+)/g, (_, key: string) => key === "locationId" ? "location-approved" : `${key}-approved`);
  const bytes = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
  const frozen: FrozenRequest = { operation: row.id, method: row.method, path, resource: path, query: [], bodyKind: body === undefined ? "none" : "json", contentType: body === undefined ? null : "application/json", bodySha256: sha(bytes), upload: null, requestDigest: "" };
  Object.assign(frozen, { requestDigest: sha(canonicalJson(["highlevel-request", 2, frozen.operation, frozen.method, frozen.path, frozen.resource, frozen.query, frozen.bodyKind, frozen.contentType, frozen.bodySha256, frozen.upload])) });
  Object.freeze(frozen);
  const held = { frozen, sendCopy: () => ({ url: new URL(`https://fixture.invalid${path}`), method: row.method, headers: { "Content-Type": "application/json" }, body: bytes.slice(), fileOffset: null, fileLength: null }) } as unknown as HeldRequest;
  return { held, frozen, schema: prepareReturnedIdentitySchema(held, "location-approved") };
}
const reviewerKeys = ["id", "contactId", "contact_id", "opportunityId", "pipelineId", "pipelineStageId", "locationId", "assignedTo", "userId", "followerId", "followers", "unrecognizedId", "unknown_id"];
const keys = [...new Set([...Object.values(HIGHLEVEL_RETURNED_IDENTITY_SCHEMAS).flatMap(s => Object.keys(s.identities)), ...reviewerKeys])];
const generated = HIGHLEVEL_OPERATION_MANIFEST.filter(r => r.disposition === "ready" && r.risk !== "R").flatMap(row => {
  const ownKeys = [...new Set([...Object.keys(HIGHLEVEL_RETURNED_IDENTITY_SCHEMAS[row.id].identities), ...reviewerKeys])];
  return ownKeys.flatMap(key => [1, 2, 3].flatMap(depth => [false, true].map(array => ({ operation: row.id, key, depth, array }))));
});
it.each(generated)("generated conflict $operation $key depth=$depth array=$array", ({ operation, key, depth, array }) => {
  const { frozen, schema } = fixture(operation, operation.includes(".followers.") ? { followers: ["u1"] } : {});
  let branch: unknown = { [key]: "unapproved-secret-value", sibling: "ordinary" };
  for (let d = 1; d < depth; d++) branch = { wrapper: array ? [branch] : branch };
  const response = { success: true, ...(operation.includes(".followers.") ? { followers: ["u1"] } : {}), sibling: array ? [branch] : branch };
  expect(bindReturnedIdentities(response, frozen, schema).status).toBe("conflict");
});
it("declares identities, created slots and pass-through for every manifest operation", () => {
  expect(keys.length).toBeGreaterThan(20);
  expect(Object.keys(HIGHLEVEL_RETURNED_IDENTITY_SCHEMAS).sort()).toEqual(HIGHLEVEL_OPERATION_MANIFEST.map(r => r.id).sort());
  for (const s of Object.values(HIGHLEVEL_RETURNED_IDENTITY_SCHEMAS)) {
    expect(s.identities.id).toBeDefined();
    expect(s.created).toBeInstanceOf(Array);
    expect(s.passThrough).toEqual({ locationId: "connectedLocation" });
  }
});
it("accepts approved target, approved related role and connected location", () => {
  const { frozen, schema } = fixture();
  expect(bindReturnedIdentities({ contact: { id: "contactId-approved", assignedTo: "user-approved", locationId: "location-approved" } }, frozen, schema).status).toBe("applied");
  expect(bindReturnedIdentities({ contact: { id: "user-approved" } }, frozen, schema).status).toBe("conflict");
});
it("accepts a new provider id only in its declared created slot", () => {
  const { frozen, schema } = fixture("contacts.create", { firstName: "Approved" });
  expect(bindReturnedIdentities({ contact: { id: "new-provider-id" } }, frozen, schema).status).toBe("applied");
  expect(bindReturnedIdentities({ contact: { id: "new-provider-id" }, other: [{ id: "new-provider-id" }] }, frozen, schema).status).toBe("conflict");
  expect(bindReturnedIdentities({ id: "different-new-id", contact: { id: "new-provider-id" } }, frozen, schema).status).toBe("conflict");
});
it("requires new confirmation for an upsert without an approved id", () => {
  const { frozen, schema } = fixture("contacts.upsert", { firstName: "Approved" });
  expect(bindReturnedIdentities({ new: true, contact: { id: "new-provider-id" } }, frozen, schema).status).toBe("applied");
  expect(bindReturnedIdentities({ new: false, contact: { id: "unapproved-existing-id" } }, frozen, schema).status).toBe("conflict");
});
it.each(["success", "succeeded", "succeded", "ok", "deleted"])("rejects nested negative %s", key => {
  const { frozen, schema } = fixture("contacts.delete", undefined);
  expect(bindReturnedIdentities({ success: true, nested: [{ more: { [key]: false } }] }, frozen, schema).status).toBe("not_applied");
});
it.each([{ error: "private provider failure" }, { errors: ["private failure"] }, { status: "failed" }, { statusCode: 400 }, { errorCount: 1 }])("rejects deep error %j", failure => {
  const { frozen, schema } = fixture();
  expect(bindReturnedIdentities({ contact: { id: "contactId-approved" }, nested: [{ more: failure }] }, frozen, schema).status).toBe("not_applied");
});
it("requires exact follower sets at every occurrence, including object arrays", () => {
  const { frozen, schema } = fixture("opportunities.followers.add", { followers: ["u1", "u2"] });
  for (const followers of [["u2", "u1"], [{ id: "u1" }, { userId: "u2" }]]) {
    expect(bindReturnedIdentities({ followers }, frozen, schema).status).toBe("applied");
  }
  for (const followers of [["u1"], ["u1", "u2", "u3"], ["u1", "u1", "u2"], [], [{ id: "u1", userId: "u3" }, { id: "u2" }]]) {
    expect(bindReturnedIdentities({ success: true, followers }, frozen, schema).status).toBe("conflict");
  }
  expect(bindReturnedIdentities({ success: true }, frozen, schema).status).toBe("conflict");
  expect(bindReturnedIdentities({ followers: ["u1", "u2"], nested: [{ followers: ["u1"] }] }, frozen, schema).status).toBe("conflict");
});
it("withholds provider key names and response values from diagnostics", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const { frozen, schema } = fixture();
    const result = bindReturnedIdentities({ success: true, nested: [{ secretCustomerId: "private-value" }] }, frozen, schema);
    expect(result).toEqual({ status: "conflict", reason: "unknown_identity", keys: ["secretCustomerId"] });
    expect(log.mock.calls).toHaveLength(0);
  } finally { log.mockRestore(); }
});
it("refuses missing confirmation, wrong operation context, modified bytes and forged schemas", () => {
  const { held, frozen, schema } = fixture();
  expect(bindReturnedIdentities({}, frozen, schema).status).toBe("conflict");
  expect(bindReturnedIdentities({ success: true }, { ...frozen }, schema).status).toBe("conflict");
  expect(bindReturnedIdentities({ success: true }, frozen, { ...schema }).status).toBe("conflict");
  expect(() => prepareReturnedIdentitySchema({ ...held, sendCopy: () => ({ ...held.sendCopy(), body: new TextEncoder().encode("{}") }) } as HeldRequest, "location-approved")).toThrow();
});
it("walks beyond three levels and through nested arrays without a recursion limit", () => {
  const { frozen, schema } = fixture();
  let nested: unknown = { contactId: "wrong" };
  for (let i = 0; i < 1000; i++) nested = { child: [[nested]] };
  expect(bindReturnedIdentities({ success: true, nested }, frozen, schema).status).toBe("conflict");
});
it("binds nested custom-field ids and stage ids to their own roles", () => {
  const c = fixture("contacts.update", { customFields: [{ id: "field-approved", field_value: "x" }] });
  expect(bindReturnedIdentities({ contact: { id: "contactId-approved", customFields: [{ id: "field-approved", field_value: "x" }] } }, c.frozen, c.schema).status).toBe("applied");
  expect(bindReturnedIdentities({ contact: { id: "contactId-approved", customFields: [{ id: "contactId-approved" }] } }, c.frozen, c.schema).status).toBe("conflict");
  const p = fixture("opportunities.pipelines.update", { stages: [{ id: "stage-approved", name: "One", position: 0 }, { name: "Two", position: 1 }] });
  expect(bindReturnedIdentities({ id: "pipelineId-approved", stages: [{ id: "stage-approved" }, { id: "new-stage" }] }, p.frozen, p.schema).status).toBe("applied");
  expect(bindReturnedIdentities({ id: "pipelineId-approved", stages: [{ id: "unexpected-stage" }, { id: "new-stage" }] }, p.frozen, p.schema).status).toBe("conflict");
});
it("created identities cannot masquerade as an already approved related id", () => {
  const { frozen, schema } = fixture("contacts.create", { firstName: "Approved" });
  expect(bindReturnedIdentities({ contact: { id: "location-approved" } }, frozen, schema).status).toBe("conflict");
});
it("rejects cyclic/non-JSON responses and malformed confirmation flags", () => {
  const { frozen, schema } = fixture();
  const response: Record<string, unknown> = { success: true }; response.loop = response;
  for (const value of [response, { success: true, nested: new Date() }, { success: true, more: [{ succeeded: "false" }] }]) {
    expect(bindReturnedIdentities(value, frozen, schema).status).toBe("conflict");
  }
});
it("keeps interleaved prepared requests isolated", () => {
  const a = fixture("contacts.update", { assignedTo: "a-user" });
  const b = fixture("contacts.update", { assignedTo: "b-user" });
  expect(bindReturnedIdentities({ success: true, assignedTo: "a-user" }, a.frozen, a.schema).status).toBe("applied");
  expect(bindReturnedIdentities({ success: true, assignedTo: "b-user" }, a.frozen, a.schema).status).toBe("conflict");
  expect(bindReturnedIdentities({ success: true, assignedTo: "b-user" }, b.frozen, b.schema).status).toBe("applied");
});
it.each([
  ["approved", "contacts.update", { firstName: "Approved" }, { contact: { id: "contactId-approved" } }],
  ["created", "contacts.create", { firstName: "Approved" }, { contact: { id: "provider-new" } }],
  ["pass-through", "contacts.update", { firstName: "Approved" }, { success: true, locationId: "location-approved" }],
] as const)("positive table: %s", (_label, operation, body, response) => {
  const { frozen, schema } = fixture(operation, body);
  expect(bindReturnedIdentities(response, frozen, schema)).toEqual({ status: "applied" });
});

it("walks root arrays as well as object envelopes", () => {
  const { frozen, schema } = fixture();
  expect(bindReturnedIdentities([[{ contactId: "wrong" }]], frozen, schema).status).toBe("conflict");
  expect(bindReturnedIdentities([[{ succeeded: false }]], frozen, schema).status).toBe("not_applied");
});
it("nested location ids cannot take an approved contact's role", () => {
  const { frozen, schema } = fixture();
  expect(bindReturnedIdentities({ success: true, location: { id: "location-approved" } }, frozen, schema).status).toBe("applied");
  expect(bindReturnedIdentities({ success: true, location: { id: "contactId-approved" } }, frozen, schema).status).toBe("conflict");
});

it("existing family hooks retrieve their exact request binding and refuse absent context", () => {
  const a = fixture("contacts.update", { assignedTo: "a-user" });
  const b = fixture("contacts.update", { assignedTo: "b-user" });
  expect(returnedIdentitySchemaFor(a.frozen)).toBe(a.schema);
  expect(returnedIdentitySchemaFor(b.frozen)).toBe(b.schema);
  expect(() => returnedIdentitySchemaFor({ ...a.frozen })).toThrow("binding missing");
  expect(() => prepareReturnedIdentitySchema(a.held, "different-location")).toThrow("binding refused");
});

it("a follower confirmation for the opposite action is a conflict", () => {
  const add = fixture("opportunities.followers.add", { followers: ["u1"] });
  const remove = fixture("opportunities.followers.remove", { followers: ["u1"] });
  expect(bindReturnedIdentities({ followersRemoved: ["u1"] }, add.frozen, add.schema).status).toBe("conflict");
  expect(bindReturnedIdentities({ followersAdded: ["u1"] }, remove.frozen, remove.schema).status).toBe("conflict");
});

// Generate coverage from the actual wire schemas, including scalar ID arrays
// and identity fields inside object arrays. No hand-maintained role inventory.
function arrayPaths(schema: z.ZodTypeAny | null, path: string[] = []): string[] {
  if (!schema) return [];
  if (schema instanceof z.ZodObject) return Object.entries(schema.shape).flatMap(([key, child]) => arrayPaths(child as z.ZodTypeAny, [...path, key]));
  if (schema instanceof z.ZodArray) return [path.join("."), ...arrayPaths(schema.element as z.ZodTypeAny, [...path, "*"])];
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) return arrayPaths(schema.unwrap() as z.ZodTypeAny, path);
  if (schema instanceof z.ZodUnion) return schema.options.flatMap(s => arrayPaths(s as z.ZodTypeAny, path));
  return [];
}
const multiRoles = HIGHLEVEL_OPERATION_MANIFEST.filter(r => r.disposition === "ready" && r.risk !== "R").flatMap(row => {
  const schema = HIGHLEVEL_RETURNED_IDENTITY_SCHEMAS[row.id];
  return [...new Set(arrayPaths(row.bodySchema))].flatMap(path => [...new Map(schema.sources
    .filter(s => (s.path === path || s.path.startsWith(`${path}.*.`)) && !arrayPaths(row.bodySchema).some(deeper => deeper.startsWith(`${path}.*.`) && (s.path === deeper || s.path.startsWith(`${deeper}.*.`)))).map(s => [s.path, s])).values()]
    .map(source => ({ operation: row.id, path, source: source.path, role: source.role,
      ordered: schema.created.some(s => s.role === source.role && s.when === "missing_request_id") })));
});
function nestPath(path: string[], value: unknown): Record<string, unknown> {
  if (!path.length) return value as Record<string, unknown>;
  if (path[0] === "*") return [nestPath(path.slice(1), value)] as unknown as Record<string, unknown>;
  return { [path[0]]: nestPath(path.slice(1), value) };
}
const collectionItems = (source: string, path: string, ids: string[]) => ids.map((id, index) => {
  if (source === path) return id;
  return { ...nestPath(source.slice(path.length + 3).split("."), id), ...(path === "stages" ? { name: `Stage ${index}`, position: index } : {}) };
});
const multiCases = multiRoles.filter(row => row.role !== "locationId").flatMap(row => ["approved", "duplicate", "missing", "extra", "absent", "swapped"].map(change => ({ ...row, change })));
it.each(multiCases)("F021 P1 generated slots $operation $source $change", ({ operation, path, source, ordered, change }) => {
  const ids = ["identity-A", "identity-B"];
  const body = nestPath(path.split("."), collectionItems(source, path, ids));
  const { frozen, schema } = fixture(operation, body);
  const returned = change === "duplicate" ? [ids[0], ids[0]] : change === "missing" ? [ids[0]]
    : change === "extra" ? [...ids, "identity-C"] : change === "swapped" ? [...ids].reverse() : ids;
  const response = { success: true, ...(change === "absent" ? {} : nestPath(path.split("."), collectionItems(source, path, returned))) };
  expect(bindReturnedIdentities(response, frozen, schema).status).toBe(change === "approved" || (change === "swapped" && !ordered) ? "applied" : "conflict");
});
it("F021 P1 generated table covers every multi-valued wire identity role", () => {
  expect(new Set(multiRoles.map(r => r.role))).toEqual(new Set(["fieldId", "contactId", "followerId", "pipelineStageId", "userId", "accountId", "availabilityId", "locationId", "productId", "priceId", "taxId", "automaticTaxCategoryId", "validOnProductId", "invoiceId", "paymentScheduleId", "postId", "documentId"]));
});
it.each(["root", "pipeline"])("F021 P1 mixed existing/new stages keep their slots in %s", envelope => {
  const { frozen, schema } = fixture("opportunities.pipelines.update", { stages: [{ id: "stage-A", name: "A", position: 0 }, { name: "B", position: 1 }] });
  const wrap = (stages: unknown[]) => envelope === "root" ? { success: true, stages } : { pipeline: { id: "pipelineId-approved", stages } };
  expect(bindReturnedIdentities(wrap([{ id: "stage-A" }, { id: "new-stage" }]), frozen, schema).status).toBe("applied");
  for (const stages of [[{ id: "stage-A" }, { id: "stage-A" }], [{ id: "stage-A" }], [{ id: "stage-A" }, { id: "new-stage" }, { id: "extra-stage" }]]) {
    expect(bindReturnedIdentities(wrap(stages), frozen, schema).status).toBe("conflict");
  }
});
it.each(["success", "succeeded", "succeded", "ok", "deleted"].flatMap(key => ["true", false].flatMap(flag => [false, true].map(reverse => ({ key, flag, reverse })))))
  ("F021 P3 finishes diagnostic traversal $key=$flag reverse=$reverse", ({ key, flag, reverse }) => {
    const { frozen, schema } = fixture("contacts.delete", undefined);
    const entries: [string, unknown][] = [["mysteryId", "secret"], [key, flag], ["nested", [{ anotherUnknown_id: "deeper-secret", deeper: { finalUnknownId: "last-secret" } }]]];
    const response = Object.fromEntries(reverse ? entries.reverse() : entries);
    expect(bindReturnedIdentities(response, frozen, schema).status).toBe("conflict");
    expect(vi.mocked(console.warn).mock.calls).toHaveLength(0);
  });
it("F021 P3 exact review witness logs neither provider keys nor values", () => {
  const { frozen, schema } = fixture();
  expect(bindReturnedIdentities({ mysteryId: "secret", success: "true" }, frozen, schema).status).toBe("conflict");
  expect(vi.mocked(console.warn).mock.calls).toHaveLength(0);
});
it.each(["cycle", "prototype", "malformed-object"])("F021 P3 finishes traversal after %s", kind => {
  const { frozen, schema } = fixture();
  const bad: Record<string, unknown> = kind === "prototype" ? Object.setPrototypeOf({ mysteryId: "secret" }, Date.prototype) : { mysteryId: "secret" };
  if (kind === "cycle") bad.loop = bad;
  const response = { success: kind === "malformed-object" ? bad : true, nested: [{ anotherUnknownId: "other-secret" }], bad };
  expect(bindReturnedIdentities(response, frozen, schema).status).toBe("conflict");
  expect(vi.mocked(console.warn).mock.calls).toHaveLength(0);
});

it.each(multiRoles.filter(row => row.role === "locationId"))("F021 P1 multi-location approval already fails closed $operation", ({ operation, path, source }) => {
  expect(() => fixture(operation, nestPath(path.split("."), collectionItems(source, path, ["location-approved", "another-location"])))).toThrow("binding refused");
});

it.each(["opportunities.pipelines.create", "opportunities.pipelines.update"])("F021 P1 provider-created stages remain unique and complete for %s", operation => {
  const { frozen, schema } = fixture(operation, { stages: [{ name: "A", position: 0 }, { name: "B", position: 1 }] });
  expect(bindReturnedIdentities({ success: true, stages: [{ id: "new-A", position: 0 }, { id: "new-B", position: 1 }] }, frozen, schema).status).toBe("applied");
  for (const stages of [[{ id: "new-A" }, { id: "new-A" }], [{ id: "new-A" }], [{ id: "new-A" }, { id: "new-B" }, { id: "new-C" }], [{ id: "new-A", position: 1 }, { id: "new-B", position: 0 }]]) {
    expect(bindReturnedIdentities({ success: true, stages }, frozen, schema).status).toBe("conflict");
  }
});
it("F021 P1 aliases may repeat the same slot but cannot contradict its approved position", () => {
  const { frozen, schema } = fixture("opportunities.pipelines.update", { stages: [{ id: "stage-A", name: "A", position: 0 }, { id: "stage-B", name: "B", position: 1 }] });
  const stages = [{ id: "stage-A", position: 0 }, { id: "stage-B", position: 1 }];
  expect(bindReturnedIdentities({ success: true, stages, pipeline: { stages: structuredClone(stages) } }, frozen, schema).status).toBe("applied");
  expect(bindReturnedIdentities({ success: true, stages, pipeline: { stages: [...stages].reverse() } }, frozen, schema).status).toBe("conflict");
});
