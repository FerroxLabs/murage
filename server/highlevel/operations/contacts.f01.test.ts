import type { OperationId } from "../../../shared/highlevel.ts";
import { expect, it } from "vitest";
import { operationSpec } from "./registry.ts";
import { contactFake, freezeContactDraft } from "../fake/contacts.ts";
import { providerOperation } from "../provider-manifest.ts";
import { HeldRequest } from "../held-request.ts";
import { HighLevelActions } from "../actions.ts";
import { reserveEffectiveRisk } from "../escalation.ts";
import { highLevelHarness } from "../../testing/fake-highlevel.ts";

const ctx = { locationId: "loc1" };
const updates = [
  ["update", { contactId: "c1", firstName: "Reviewed" }, "contact", "c2"],
  ["notes.update", { contactId: "c1", noteId: "n1", body: "Reviewed" }, "note", "n2"],
  ["tasks.update", { contactId: "c1", taskId: "t1", title: "Reviewed" }, "task", "t2"],
  ["tasks.complete", { contactId: "c1", taskId: "t1", completed: true }, "task", "t2"],
] as const;
for (const [verb, args, key, wrongId] of updates) {
  it(`P1 returned IDs: registered contacts.${verb} refuses another saved target`, async () => {
    const op = operationSpec(`contacts.${verb}`)!;
    if (op.risk === "R") throw new Error("Expected mutation");
    const fake = contactFake();
    const draft = await op.prepare({ read: (id, read) => fake.request(id, providerOperation(id)!.method!, read.path, read.body, read.query) }, { ...args }, ctx);
    const frozen = freezeContactDraft(op, draft, ctx).frozen;
    expect(draft.path).toContain("/contacts/c1");
    // The registered hooks receive the exact retained request context added by F0.1.
    expect(() => {
      const raw = { [key]: { id: wrongId, contactId: "c1", locationId: "loc1" } };
      op.recordId!(raw, frozen);
      op.project(raw, frozen);
    }).toThrow(expect.objectContaining({ outcome: "outcome_unknown" }));
  });
}
it("P1 lifecycle: production freeze retains the approved request", () => {
  const op = operationSpec("contacts.update")!;
  expect(() => HeldRequest.freeze(op, { path: "/contacts/c1", resource: "contacts:contact:c1", body: { kind: "json", value: { firstName: "Reviewed" } } }, ctx)).not.toThrow();
});
it("P1 lifecycle: production journal supports restart recovery", () => {
  expect(() => new HighLevelActions().recover()).not.toThrow();
});
it("P1 lifecycle: production risk reservation is implemented", () => {
  expect(() => reserveEffectiveRisk("fixture-turn", operationSpec("contacts.update")!, { contactId: "c1", firstName: "Reviewed" })).not.toThrow();
});
it("P2 legacy write cannot bypass registered production dispatch", async () => {
  const h = highLevelHarness();
  const call = h.host.call(h.claim, "HIGHLEVEL_UPDATE_CONTACT", { contactId: "contact_1", firstName: "Reviewed" });
  void call.catch(() => {});
  // Legacy tool names give migration guidance; real review/send coverage is in
  // contacts-dispatch.f01.test.ts through HIGHLEVEL_CONTACTS.
  await new Promise(resolve => setImmediate(resolve));
  h.stop();
  await expect(call).resolves.toMatchObject({ isError: true });
  expect(h.api.calls("PUT")).toHaveLength(0);
});

for (const [verb, args, key] of updates) {
  it(`contacts.${verb} refuses absent, swapped and conflicting response contexts in both hooks`, async () => {
    const op = operationSpec(`contacts.${verb}`)!;
    if (op.risk === 'R') throw new Error('Expected mutation');
    const fake = contactFake();
    const pre = { read: (operation: OperationId, read: { path: string }) => fake.request(operation, providerOperation(operation)!.method!, read.path) };
    const draft = await op.prepare(pre, { ...args }, ctx);
    const frozen = freezeContactDraft(op, draft, ctx).frozen;
    const expected = key === 'contact' ? 'c1' : key === 'note' ? 'n1' : 't1';
    const valid = { [key]: { id: expected, contactId: 'c1' } };
    for (const hook of [op.recordId!, op.project]) {
      expect(() => hook(valid)).toThrow();
      expect(() => hook(valid, { ...frozen, operation: 'contacts.delete' })).toThrow();
      expect(() => hook(valid, { ...frozen, resource: 'contacts:contact:c2' })).toThrow();
      expect(() => hook({ ...valid, id: 'conflict' }, frozen)).toThrow();
      expect(() => hook({ ...valid, [key]: { id: expected, contactId: 'c2' } }, frozen)).toThrow();
      expect(() => hook({ ...valid, [key]: { id: expected, contact: { id: 'c2' } } }, frozen)).toThrow();
      expect(() => hook({ ...valid, [key]: { id: expected, [`${key}Id`]: 'conflict' } }, frozen)).toThrow();
    }
    expect(op.recordId!(valid, frozen)).toBe(expected);
    expect(op.project(valid, frozen)).toEqual(valid);
  });
}
it('interleaved preparations never replace the retained target', async () => {
  const op = operationSpec('contacts.update')!; if (op.risk === 'R') throw new Error('Expected mutation');
  const fake = contactFake(); const pre = { read: (operation: OperationId, read: { path: string }) => fake.request(operation, providerOperation(operation)!.method!, read.path) };
  const one = freezeContactDraft(op, await op.prepare(pre, { contactId: 'c1', firstName: 'One' }, ctx), ctx).frozen;
  const two = freezeContactDraft(op, await op.prepare(pre, { contactId: 'c2', firstName: 'Two' }, ctx), ctx).frozen;
  expect(op.recordId!({ contact: { id: 'c1' } }, one)).toBe('c1');
  expect(op.recordId!({ contact: { id: 'c2' } }, two)).toBe('c2');
  expect(() => op.recordId!({ contact: { id: 'c2' } }, one)).toThrow();
});
