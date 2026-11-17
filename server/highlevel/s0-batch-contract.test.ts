import { expect, it } from "vitest";
import rows from "./operations/manifest-data.json" with { type: "json" };
import { schemas, contactPreparationBatches, contactIdPreparationSearchBodySchema, matchesContactPreparationChunk } from "./operations/schemas/contacts.ts";
import { NO_RECONCILIATION_READ_EXCEPTIONS, importRecoveryBindingSchema, IMPORT_EXCEPTION_DIGEST, bulkPreparationAndRecoveryBounds } from "./recovery-contract.ts";
import { INVOCATION_DESCRIPTORS } from "./operations/invocation-plans.ts";
import { reconciliationReadsFor } from "./operations/reconciliation.ts";
import { schemas as funnels, redirectLocatorSchema, redirectSearch } from "./operations/schemas/funnels.ts";

const ids = (count: number, length = 75) => Array.from({ length: count }, (_, i) => String(i).padStart(length, "x"));
const digest = "a".repeat(64);
it.each([4, 5])("afix BLOCK 2 direct recovery resolves every approved array ID for %i targets", count => {
  const contacts = ["contact_a", "contact_b", "contact_c", "contact_d", "contact_e"].slice(0, count);
  const args = schemas["contacts.tags.bulk"].argsSchema.parse({ contacts, tags: ["x"], type: "add" });
  expect(args).not.toHaveProperty("contactId");
  const direct = INVOCATION_DESCRIPTORS.find(row => row.operation === "contacts.tags.bulk")!.readers.find(read => read.phase === "recovery")!;
  expect(direct.selectors).toEqual([{ kind: "connection", field: "locationId" }, { kind: "argument", field: "contacts" }]);
  expect([direct.operation, direct.when, direct.maxReads, direct.evidenceClass, direct.reuse])
    .toEqual(["contacts.get", "bulk-approved-ids", 5, "post-write-direct", "never"]);
  // Resolve the frozen selector from VALIDATED args; no nonexistent top-level contactId fallback.
  const values = direct.selectors.filter(source => source.kind === "argument")
    .flatMap(source => (args as Record<string, unknown>)[source.field]);
  expect(values).toEqual(contacts);
  const paths = values.map(value => direct.pathTemplate.replace(":contactId", encodeURIComponent(String(value))));
  expect(paths).toEqual(count === 4
    ? ["/contacts/contact_a", "/contacts/contact_b", "/contacts/contact_c", "/contacts/contact_d"]
    : ["/contacts/contact_a", "/contacts/contact_b", "/contacts/contact_c", "/contacts/contact_d", "/contacts/contact_e"]);
  const bounds = bulkPreparationAndRecoveryBounds(count);
  expect(bounds.canSettleImmediate).toBe(count === 4);
  expect(bounds.canSettleReplay).toBe(true);
});
it("0b shared-five-read arithmetic keeps six/500 uncertainty unknown and permits all-target small controls", () => {
  expect(bulkPreparationAndRecoveryBounds(6)).toEqual({ preparationReads: 1, immediateDirectReads: 4, replayDirectReads: 5, allTargetsRequired: 6, canSettleImmediate: false, canSettleReplay: false });
  expect(bulkPreparationAndRecoveryBounds(500)).toEqual({ preparationReads: 5, immediateDirectReads: 0, replayDirectReads: 5, allTargetsRequired: 500, canSettleImmediate: false, canSettleReplay: false });
  expect(bulkPreparationAndRecoveryBounds(4)).toEqual({ preparationReads: 1, immediateDirectReads: 4, replayDirectReads: 4, allTargetsRequired: 4, canSettleImmediate: true, canSettleReplay: true });
  expect(bulkPreparationAndRecoveryBounds(5)).toEqual({ preparationReads: 1, immediateDirectReads: 4, replayDirectReads: 5, allTargetsRequired: 5, canSettleImmediate: false, canSettleReplay: true });
  for (const count of [0, 501, 1.5, NaN]) expect(() => bulkPreparationAndRecoveryBounds(count)).toThrow();
});
it.each([1, 6, 100, 101, 500])("0b batches %i maximal approved IDs exactly, preserving public bounds", count => {
  const approved = ids(count);
  const batches = contactPreparationBatches("loc_1", approved);
  expect(batches).toHaveLength(Math.ceil(count / 100));
  expect(batches.flatMap(batch => batch.filters[0].filters.map(leaf => leaf.value))).toEqual([...approved].sort());
  for (const batch of batches) {
    expect(batch.page).toBe(1); expect(batch.pageLimit).toBe(batch.filters[0].filters.length);
    expect(batch.pageLimit).toBeLessThanOrEqual(100); expect(batch.filters).toHaveLength(1);
    expect(batch.filters[0].group).toBe("OR");
    expect(schemas["contacts.search"].bodySchema!.safeParse(batch).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(64 * 1024);
    expect(Object.isFrozen(batch.filters[0].filters)).toBe(true);
  }
  expect(schemas["contacts.tags.bulk"].argsSchema.safeParse({ contacts: approved, tags: ["x"], type: "add" }).success).toBe(true);
});
it("0b keeps ordinary search at 50 and refuses mixed/unbounded/extra internal filters", () => {
  const valid = contactPreparationBatches("loc_1", ["contact_1", "contact_2"])[0];
  const parse = (value: unknown) => schemas["contacts.search"].bodySchema!.safeParse(value).success;
  expect(parse({ locationId: "loc_1", page: 1, pageLimit: 50, query: "Ada" })).toBe(true);
  expect(parse({ locationId: "loc_1", page: 1, pageLimit: 51, query: "Ada" })).toBe(false);
  expect(schemas["contacts.search"].argsSchema.safeParse({ limit: 51 }).success).toBe(false);
  for (const patch of [{ page: 2 }, { pageLimit: 1 }, { pageLimit: 101 }, { query: "Ada" }, { extra: true },
    { filters: [] }, { filters: [...valid.filters, ...valid.filters] },
    { filters: [{ group: "AND", filters: valid.filters[0].filters }] },
    { filters: [{ group: "OR", filters: [{ field: "email", operator: "eq", value: "fixture@example.test" }] }] },
    { filters: [{ group: "OR", filters: [{ field: "id", operator: "contains", value: "contact_1" }] }] },
    { filters: [{ group: "OR", filters: [{ group: "OR", filters: valid.filters[0].filters }] }] },
    { filters: [{ group: "OR", filters: [valid.filters[0].filters[0], valid.filters[0].filters[0]] }] },
  ]) expect(contactIdPreparationSearchBodySchema.safeParse({ ...valid, ...patch }).success, JSON.stringify(patch)).toBe(false);
  // Ordinary search historically accepts an empty filter list; it cannot be admitted as an ID batch.
  expect(parse({ locationId: "loc_1", page: 1, pageLimit: 2, filters: [] })).toBe(true);
  expect(contactIdPreparationSearchBodySchema.safeParse({ ...valid, filters: [{ group: "OR", filters: [{ field: "id", operator: "eq", value: "x".repeat(76) }] }], pageLimit: 1 }).success).toBe(false);
  expect(schemas["contacts.search"].argsSchema.safeParse(valid).success).toBe(false);
});
it("0b refuses unsupported 76/128 selectors before any provider work; never clips or drops target 500", () => {
  for (const length of [76, 128]) {
    const approved = ids(6, length);
    expect(schemas["contacts.tags.bulk"].argsSchema.safeParse({ contacts: approved, tags: ["x"], type: "add" }).success).toBe(true);
    expect(() => contactPreparationBatches("loc_1", approved)).toThrow(/search limit/);
  }
  expect(() => contactPreparationBatches("loc_1", [])).toThrow();
  expect(() => contactPreparationBatches("loc_1", ids(501))).toThrow();
  expect(schemas["contacts.tags.bulk"].argsSchema.safeParse({ contacts: ids(501), tags: ["x"], type: "add" }).success).toBe(false);
  const input = ["z", "a", "z"];
  expect(contactPreparationBatches("loc_1", input)[0].filters[0].filters.map(leaf => leaf.value)).toEqual(["a", "z"]);
  expect(input).toEqual(["z", "a", "z"]);
});
it("0b a valid shape cannot authorize another location or an unapproved target", () => {
  const body = contactPreparationBatches("loc_1", ["a", "b"])[0];
  expect(matchesContactPreparationChunk(body, "loc_1", ["b", "a"])).toBe(true);
  expect(matchesContactPreparationChunk(body, "loc_2", ["a", "b"])).toBe(false);
  expect(matchesContactPreparationChunk(body, "loc_1", ["a", "c"])).toBe(false);
  expect(matchesContactPreparationChunk(body, "loc_1", ["a", "a"])).toBe(false);
  expect(matchesContactPreparationChunk(body, "loc_1", [])).toBe(false);
});
it("0b bulk separates preparation search and direct reconciliation; all planned readers are declared", () => {
  const bulk = rows.find(row => row.id === "contacts.tags.bulk")!;
  expect(bulk.preflight).toEqual(["contacts.get", "contacts.search"]);
  expect(bulk.reconciliation).toEqual(["contacts.get"]);
  expect(reconciliationReadsFor("contacts.tags.bulk")).toEqual(["contacts.get"]);
  for (const descriptor of INVOCATION_DESCRIPTORS) {
    const row = rows.find(row => row.id === descriptor.operation)!;
    for (const read of descriptor.readers) {
      expect(row.preflight, `${row.id} ${read.operation}`).toContain(read.operation);
      if (read.phase === "recovery") expect(row.reconciliation, row.id).toContain(read.operation);
    }
  }
});
it("0b owner-tip adoption pins conditional blog, parent and nested-recipient selector sources", () => {
  const descriptor = (id: string) => INVOCATION_DESCRIPTORS.find(row => row.operation === id)!;
  for (const id of ["blogs.posts.createDraft", "blogs.posts.createPublished", "blogs.posts.updateDraft", "blogs.posts.publish", "blogs.posts.updatePublished"]) {
    expect(descriptor(id).readers.map(read => [read.operation, read.when])).toEqual(expect.arrayContaining([
      ["blogs.authors.list", "explicit-blog-author"], ["blogs.categories.list", "explicit-blog-category"], ["blogs.slug.check", "explicit-blog-slug"],
    ]));
  }
  expect(descriptor("documents.send").readers.find(read => read.operation === "contacts.get")?.selectors)
    .toContainEqual({ kind: "argument", field: "ccRecipients.id" });
  expect(descriptor("payments.invoice.create").readers.find(read => read.operation === "contacts.get")?.selectors)
    .toContainEqual({ kind: "argument", field: "contactDetails.id" });
  expect(descriptor("calendars.appointmentNotes.create").readers.find(read => read.operation === "calendars.appointment.get")?.selectors)
    .toContainEqual({ kind: "argument", field: "appointmentId" });
  expect(descriptor("conversations.schedule.cancel").readers.find(read => read.operation === "conversations.get")?.selectors)
    .toContainEqual({ kind: "dependency", slot: "prepare.conversations.message.get", field: "conversationId" });
  expect(descriptor("users.update").readers.find(read => read.operation === "users.get")?.when).toBe("always");
  expect(descriptor("users.update").readers.some(read => read.operation === "users.list")).toBe(false);
});
it("0b pins exactly one durable empty-reader exception, with its kind and digest", () => {
  expect(NO_RECONCILIATION_READ_EXCEPTIONS).toEqual(["courses.import"]);
  const row = rows.find(row => row.id === "courses.import")!;
  expect(row.preflight).toEqual([]); expect(row.reconciliation).toEqual([]);
  expect("approvalBlocked" in row).toBe(false);
  expect(reconciliationReadsFor("courses.import")).toEqual([]);
  const value = { version: 2, operation: "courses.import", recoveryKind: "no-reader-import", exceptionDigest: IMPORT_EXCEPTION_DIGEST,
    approvalId: "approval_1", requestDigest: digest, authorityDigest: digest, planDigest: digest, readTargets: [],
    outcome: "outcome_unknown", resend: false };
  expect(importRecoveryBindingSchema.safeParse(value).success).toBe(true);
  for (const patch of [{ operation: "contacts.update" }, { recoveryKind: "target-scoped" }, { exceptionDigest: digest },
    { resend: true }, { outcome: "applied" }, { readTargets: [{ operation: "courses.list", path: "/courses/" }] }, { rawSelector: "private" }]) {
    expect(importRecoveryBindingSchema.safeParse({ ...value, ...patch }).success).toBe(false);
  }
});
it("0b redirect selectors are the approved domain/path, never a redirect ID used as search", () => {
  const locator = { domain: "fixture.example", path: "/approved" };
  expect(redirectSearch(locator)).toBe("fixture.example/approved");
  expect(redirectLocatorSchema.safeParse({ redirectId: "redirect_251" }).success).toBe(false);
  expect(redirectLocatorSchema.safeParse({ ...locator, path: "//other.example" }).success).toBe(false);
  expect(redirectLocatorSchema.safeParse({ ...locator, path: "/%252fescape" }).success).toBe(false);
  expect(funnels["funnels.redirects.delete"].argsSchema.safeParse({ locationId: "loc_1", redirectId: "redirect_251", ...locator }).success).toBe(true);
  expect(funnels["funnels.redirects.delete"].argsSchema.safeParse({ locationId: "loc_1", redirectId: "redirect_251" }).success).toBe(false);
  expect(funnels["funnels.redirects.create"].argsSchema.safeParse({ locationId: "loc_1", ...locator, target: "https://target.example/next", action: "url" }).success).toBe(true);
  expect(funnels["funnels.redirects.create"].argsSchema.safeParse({ locationId: "loc_1", ...locator, target: "https://target.example/next", action: "url", headers: { authorization: "private" } }).success).toBe(false);
  for (const id of ["funnels.redirects.create", "funnels.redirects.update", "funnels.redirects.delete"]) {
    const descriptor = INVOCATION_DESCRIPTORS.find(row => row.operation === id)!;
    for (const read of descriptor.readers) expect(read.selectors).toContainEqual({ kind: "sealed-locator", selector: "approved-domain-path" });
  }
});
