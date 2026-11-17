import { expect, it } from "vitest";
import { HIGHLEVEL_OPERATION_MANIFEST } from "./registry.ts";
import { HIGHLEVEL_ENDPOINTS, HIGHLEVEL_CRM_SCOPES } from "../provider-contract.ts";
import { z } from "zod";
const row = (id: string) => HIGHLEVEL_OPERATION_MANIFEST.find(r => r.id === id)!;
it("r3 every row has a strict schema and a closed projection", () => {
  for (const r of HIGHLEVEL_OPERATION_MANIFEST) {
    expect(r.argsSchema).toBeDefined();
    expect(r.projection.every(k => typeof k === "string")).toBe(true);
    if (r.disposition === "ready") {
      const shape = z.toJSONSchema(r.argsSchema, { io: "input" });
      expect(shape.type, r.id).toBe("object"); expect(shape.additionalProperties, r.id).toBe(false);
    }
  }
});
it("r3 ready endpoints and scope set only; no legacy keys or S risk", () => {
  const ready = HIGHLEVEL_OPERATION_MANIFEST.filter(r => r.disposition === "ready");
  expect(Object.keys(HIGHLEVEL_ENDPOINTS).sort()).toEqual(ready.map(r => r.id).sort());
  expect(HIGHLEVEL_CRM_SCOPES).toEqual([...new Set(ready.map(r => r.scope))].sort());
  expect(HIGHLEVEL_OPERATION_MANIFEST.every(r => ["R", "C", "D"].includes(r.risk))).toBe(true);
});
it("r3 wire schemas bind send and draft discriminators", () => {
  const accepts = (id: string, key: string, value: unknown) => {
    const s = row(id).bodySchema as z.ZodObject;
    expect(s, id).not.toBeNull(); return s.shape[key].safeParse(value).success;
  };
  expect(accepts("conversations.send.sms", "type", "SMS")).toBe(true);
  expect(accepts("conversations.send.sms", "type", "Email")).toBe(false);
  expect(accepts("social.posts.updateDraft", "status", "published")).toBe(false);
  expect(accepts("blogs.posts.updateDraft", "status", "PUBLISHED")).toBe(false);
  expect(accepts("payments.invoice.update", "status", "sent")).toBe(false);
  expect(row("payments.invoice.update").risk).toBe("D");
});
it("r3 GET rejects bodies and contact custom fields remain closed", () => {
  expect(row("contacts.get").bodySchema).toBeNull();
  expect(row("contacts.create").argsSchema.safeParse({ name: "Ada", customFields: [{ name: "Tier", value: "Gold" }] }).success).toBe(true);
  expect(row("contacts.create").argsSchema.safeParse({ name: "Ada", authorization: "override" }).success).toBe(false);
});
it("F0 opportunities preserve family argument names and ownership proofs", () => {
  expect(row("opportunities.search").argsSchema.safeParse({ query: "Deal" }).success).toBe(true);
  expect(row("opportunities.create").preflight).toContain("users.get");
});
it("F0 only the shared workspace reference schema can admit a file path", async () => {
  const { strictOperationArgs } = await import("./registry.ts");
  const { workspaceFileRefSchema } = await import("../../../shared/highlevel.ts");
  expect(() => strictOperationArgs(z.strictObject({ file: z.strictObject({ workspaceFile: z.string() }) }))).toThrow(/workspace/);
  expect(() => strictOperationArgs(z.strictObject({ file: workspaceFileRefSchema }))).not.toThrow();
});

it('R4 shared validation derives identifier-array paths from the supplied schema and checks every element', async () => {
  const { strictOperationArgs } = await import('./schemas/common.ts');
  // Intentionally weak element schemas prove the shared policy itself enforces IDs.
  const schema = strictOperationArgs(z.strictObject({
    filter: z.strictObject({ contactId: z.array(z.string()) }),
    rows: z.array(z.strictObject({ userId: z.array(z.string()) })),
    contactId: z.string().optional(),
  }));
  const valid = { filter: { contactId: ['one', 'two'] }, rows: [{ userId: ['user1', 'user2'] }] };
  expect(schema.safeParse(valid).success).toBe(true);
  for (const invalid of ['..', '%252f', '%2f', 'has space', 'x'.repeat(181)]) {
    expect(schema.safeParse({ ...valid, filter: { contactId: ['one', invalid] } }).success).toBe(false);
    expect(schema.safeParse({ ...valid, rows: [{ userId: ['user1', invalid] }] }).success).toBe(false);
  }
  expect(schema.safeParse({ ...valid, contactId: ['one'] }).success).toBe(false);
  expect(schema.safeParse({ ...valid, contactId: '../other' }).success).toBe(false);
});
