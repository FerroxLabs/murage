import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { canonicalBindingJson } from "./binding-json.ts";
import type { FrozenRequest, HeldRequest } from "./held-request.ts";
import { bindReturnedIdentities, prepareReturnedIdentitySchema } from "./returned-identities.ts";
import { prepareTagReturnedIdentitySchema } from "./returned-confirmation.ts";

function fixture(operation: "contacts.tags.add" | "contacts.tags.remove", before: string[], tags = ["a"]) {
  const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
  const bytes = canonicalBindingJson({ tags });
  const frozen: FrozenRequest = { operation, method: operation.endsWith("add") ? "POST" : "DELETE", path: "/contacts/c1/tags", resource: "contacts:contact:c1", query: [], bodyKind: "json", contentType: "application/json", bodySha256: sha(bytes), upload: null, requestDigest: "" };
  Object.assign(frozen, { requestDigest: sha(canonicalBindingJson(["highlevel-request", 2, frozen.operation, frozen.method, frozen.path, frozen.resource, frozen.query, frozen.bodyKind, frozen.contentType, frozen.bodySha256, frozen.upload])) });
  Object.freeze(frozen);
  const held = { frozen, sendCopy: () => ({ url: new URL(`https://fixture.invalid${frozen.path}`), method: frozen.method, body: bytes.slice(), headers: {}, fileOffset: null, fileLength: null }) } as HeldRequest;
  const schema = prepareTagReturnedIdentitySchema(held, "loc", before);
  return { held, frozen, schema, check: (response: unknown) => bindReturnedIdentities(response, frozen, schema) };
}
it.each([
  ["contacts.tags.add", [], ["a"]], ["contacts.tags.remove", ["a"], []],
  ["contacts.tags.add", ["b"], ["b", "a"]], ["contacts.tags.remove", ["a", "b"], ["b"]],
] as const)("F022 tags-only confirms %s from %j to %j", (operation, before, after) => {
  expect(fixture(operation, [...before]).check({ tags: [...after] })).toEqual({ status: "applied" });
});
it.each(["contacts.tags.add", "contacts.tags.remove"] as const)("F022 %s rejects unequal sets even with success and approved id", operation => {
  const f = fixture(operation, ["a", "b"]);
  for (const tags of [["a"], ["b", "extra"], ["b", "b"], [42], null, undefined]) {
    expect(f.check({ success: true, contactId: "c1", tags }).status).toBe("conflict");
  }
  expect(f.check({ success: true, contactId: "c1" }).status).toBe("conflict");
});
it.each([0, 1, 2, 3])("F022 tags confirmation still checks foreign contact at depth %i", depth => {
  const f = fixture("contacts.tags.add", []);
  let bad: unknown = { contactId: "foreign" };
  for (let i = 0; i < depth; i++) bad = { children: [bad] };
  expect(f.check({ tags: ["a"], other: bad }).status).toBe("conflict");
});
it("F022 complete response walk includes unknown identities and negatives", () => {
  const f = fixture("contacts.tags.add", []);
  expect(f.check({ tags: ["a"], nested: [{ success: false }] }).status).toBe("not_applied");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(f.check({ tags: ["a"], nested: [{ privateId: "secret", success: "true" }] }).status).toBe("conflict");
    expect(warn.mock.calls).toHaveLength(0);
  } finally { warn.mockRestore(); }
});
it("F022 missing pre-state cannot be bypassed by a generic success flag", () => {
  const f = fixture("contacts.tags.add", []);
  const frozen = Object.freeze({ ...f.frozen });
  const schema = prepareReturnedIdentitySchema({ ...f.held, frozen } as HeldRequest, "loc");
  expect(bindReturnedIdentities({ tags: ["a"], success: true }, frozen, schema).status).toBe("conflict");
});
it("F022 expected set is detached from inputs, immutable and scoped to retained request", () => {
  const before = ["b"], f = fixture("contacts.tags.add", before);
  before.push("foreign");
  expect(f.check({ tags: ["a", "b"] }).status).toBe("applied");
  expect(() => prepareTagReturnedIdentitySchema(f.held, "loc", [])).toThrow();
  expect(f.check({ tags: ["a", "b"] }).status).toBe("applied");
});
it("F022 malformed pre-state refuses instead of assuming empty", () => {
  for (const tags of [["a", "a"], [""], [42], null]) expect(() => fixture("contacts.tags.add", tags as string[])).toThrow();
});
it("F022 every echoed tags set must agree", () => {
  const f = fixture("contacts.tags.add", []);
  expect(f.check({ tags: ["a"], nested: [{ tags: [] }] }).status).toBe("conflict");
});
it("F022 set order and already-present or absent tags retain the exact post-state", () => {
  expect(fixture("contacts.tags.add", ["a", "b"]).check({ tags: ["b", "a"] }).status).toBe("applied");
  expect(fixture("contacts.tags.remove", ["b"]).check({ tags: ["b"] }).status).toBe("applied");
});
it("F022 all operations declare a confirmation policy; only tag mutations use tag sets", async () => {
  const { HIGHLEVEL_RETURNED_CONFIRMATION_SCHEMAS: schemas } = await import("./operations/returned-confirmation-schemas.ts");
  const { HIGHLEVEL_OPERATION_MANIFEST: rows } = await import("./operations/manifest.ts");
  expect(Object.keys(schemas).sort()).toEqual(rows.map(row => row.id).sort());
  expect(Object.entries(schemas).filter(([, s]) => s.kind === "tag_post_state").map(([id]) => id).sort()).toEqual(["contacts.tags.add", "contacts.tags.remove"]);
  for (const schema of Object.values(schemas)) expect(Object.isFrozen(schema)).toBe(true);
});
