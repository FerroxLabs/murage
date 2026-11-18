// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { contactsOperations } from "./contacts.ts";
import { operationSpec, familyOperations, HIGHLEVEL_OPERATION_MANIFEST, assertRegistryCompleteness } from "./registry.ts";
import { schemas } from "./schemas/contacts.ts";
import type { OperationSpec as ContactOperationSpec } from './registry.ts';
import type { Gate, ManifestRow, PreflightRequester, SpecBase } from './registry.ts';
import type { HighLevelMethod } from '../provider-contract.ts';
import type { fakeHighLevelRequester } from '../fake-provider.ts';
type HighLevelRequester = Pick<ReturnType<typeof fakeHighLevelRequester>, 'request'>;
const ctx = { locationId: 'loc1' };
const pre = (crm: HighLevelRequester): PreflightRequester => ({ read: (id, draft) => crm.request(id, providerOperation(id)!.method!, draft.path, draft.body, draft.query) });
const run = async (op: ContactOperationSpec, crm: HighLevelRequester, args: Record<string, unknown>) => {
  const draft = op.risk === 'R' ? await op.prepareRead(args, ctx) : await op.prepare(pre(contactFake()), args, ctx);
  const raw = await crm.request(op.id, op.endpoint.method, draft.path, jsonBody(draft), draft.query);
  const frozen = freezeContactDraft(op, draft, ctx).frozen;
  const recordId = op.risk !== 'R' ? op.recordId!(raw, frozen) : undefined;
  return { value: op.project(raw, frozen), ...(op.risk !== 'R' ? { recordId } : {}) };
};

function spec(id: string) {
  const found = operationSpec(`contacts.${id}`);
  expect(found, `missing contacts.${id}`).toBeDefined();
  return { ...contactsOperations.find(op => op.id === `contacts.${id}`)!, args: found!.args };
}

describe("F1 Contacts", () => {
  it("contacts.deleteIsD", () => {
    expect(spec("delete").risk).toBe("D");
    expect(spec("notes.delete").risk).toBe("D");
    expect(spec("tasks.delete").risk).toBe("D");
    expect(spec("tags.bulk").risk).toBe("D");
  });
  it("contacts.notesNestedOwnership", async () => {
    const op = spec("notes.update");
    expect(typeof op.ownership).toBe("function");
    const request = vi.fn().mockResolvedValue({ contact: { id: "c1", locationId: "elsewhere" } });
    await expect(op.ownership!({ read: request }, { contactId: "c1", noteId: "n1", body: "private" }, { locationId: "loc1" })).rejects.toThrow(/location|ownership/i);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]!.slice(0, 3)).toEqual(["contacts.get", { path: "/contacts/c1" }]);
  });
  it("contacts.upsertFieldsNamesOnly", () => {
    const op = spec("upsert");
    const args = { firstName: "SECRET_VALUE", email: "SECRET_VALUE@example.test", customFields: [{ id: "cf1", value: "SECRET_VALUE" }], tags: ["SECRET_VALUE"] };
    expect(op.fields(args)).toEqual(["customFields", "email", "firstName", "tags"]);
    expect(op.recordRefs(args)).toEqual([]);
    expect(JSON.stringify([op.fields(args), op.recordRefs(args)])).not.toContain("SECRET_VALUE");
  });
  it("contacts.legacyNamesMap", () => {
    const legacy = Object.fromEntries(Object.entries(LEGACY_TOOL_TO_OPERATION).filter(([, value]) => value.startsWith("contacts.")));
    for (const value of Object.values(legacy)) spec(value.slice("contacts.".length));
    expect(legacy).toEqual({
      HIGHLEVEL_SEARCH_CONTACTS: "contacts.search", HIGHLEVEL_GET_CONTACT: "contacts.get",
      HIGHLEVEL_CREATE_CONTACT: "contacts.create", HIGHLEVEL_UPDATE_CONTACT: "contacts.update",
      HIGHLEVEL_ADD_TAGS: "contacts.tags.add", HIGHLEVEL_REMOVE_TAGS: "contacts.tags.remove",
      HIGHLEVEL_LIST_NOTES: "contacts.notes.list", HIGHLEVEL_ADD_NOTE: "contacts.notes.create",
      HIGHLEVEL_LIST_TASKS: "contacts.tasks.list", HIGHLEVEL_ADD_TASK: "contacts.tasks.create",
    });
  });
});

// Independent wire expectations, taken from the versioned provider reference.
const cases: Array<[string, string, string, string, Record<string, unknown>]> = [
  ["search", "R", "POST", "/contacts/search", { query: "SECRET_VALUE" }],
  ["get", "R", "GET", "/contacts/c1", { contactId: "c1" }],
  ["create", "C", "POST", "/contacts/", { firstName: "SECRET_VALUE" }],
  ["update", "C", "PUT", "/contacts/c1", { contactId: "c1", firstName: "SECRET_VALUE" }],
  ["upsert", "C", "POST", "/contacts/upsert", { firstName: "SECRET_VALUE" }],
  ["delete", "D", "DELETE", "/contacts/c1", { contactId: "c1" }],
  ["tags.add", "C", "POST", "/contacts/c1/tags", { contactId: "c1", tags: ["SECRET_VALUE"] }],
  ["tags.remove", "C", "DELETE", "/contacts/c1/tags", { contactId: "c1", tags: ["SECRET_VALUE"] }],
  ["tags.bulk", "D", "POST", "/contacts/bulk/tags/update/add", { contacts: ["c1", "c2"], type: "add", tags: ["SECRET_VALUE"] }],
  ["notes.list", "R", "GET", "/contacts/c1/notes", { contactId: "c1" }],
  ["notes.get", "R", "GET", "/contacts/c1/notes/n1", { contactId: "c1", noteId: "n1" }],
  ["notes.create", "C", "POST", "/contacts/c1/notes", { contactId: "c1", body: "SECRET_VALUE" }],
  ["notes.update", "C", "PUT", "/contacts/c1/notes/n1", { contactId: "c1", noteId: "n1", body: "SECRET_VALUE" }],
  ["notes.delete", "D", "DELETE", "/contacts/c1/notes/n1", { contactId: "c1", noteId: "n1" }],
  ["tasks.list", "R", "GET", "/contacts/c1/tasks", { contactId: "c1" }],
  ["tasks.get", "R", "GET", "/contacts/c1/tasks/t1", { contactId: "c1", taskId: "t1" }],
  ["tasks.create", "C", "POST", "/contacts/c1/tasks", { contactId: "c1", title: "SECRET_VALUE", dueDate: "2026-11-20T10:00:00Z" }],
  ["tasks.update", "C", "PUT", "/contacts/c1/tasks/t1", { contactId: "c1", taskId: "t1", title: "SECRET_VALUE", dueDate: "2026-11-20T10:00:00Z" }],
  ["tasks.complete", "C", "PUT", "/contacts/c1/tasks/t1/completed", { contactId: "c1", taskId: "t1", completed: true }],
  ["tasks.delete", "D", "DELETE", "/contacts/c1/tasks/t1", { contactId: "c1", taskId: "t1" }],
  ["appointments.list", "R", "GET", "/contacts/c1/appointments", { contactId: "c1" }],
  ["followers.add", "C", "POST", "/contacts/c1/followers", { contactId: "c1", followers: ["u1"] }],
  ["followers.remove", "C", "DELETE", "/contacts/c1/followers", { contactId: "c1", followers: ["u1"] }],
];

import { contactFake, contactsRoutes, reviewedContactFake, freezeContactDraft, jsonBody } from "../fake/contacts.ts";
import { providerOperation } from "../provider-manifest.ts";
import { LEGACY_TOOL_TO_OPERATION, levelCovers } from "../../../shared/highlevel.ts";

for (const [verb, risk, method, path, args] of cases) describe(`contacts.${verb}`, () => {
  it("strict schema refuses extra keys, URL values, credentials and path escapes", () => {
    const op = spec(verb);
    expect(op.args.safeParse(args).success).toBe(true);
    for (const key of ["extra", "url", "headers", "token", "path", "connectionId"]) expect(op.args.safeParse({ ...args, [key]: "secret" }).success).toBe(false);
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string" || Array.isArray(value)) expect(op.args.safeParse({ ...args, [key]: Array.isArray(value) ? ["https://attacker.test/x"] : "https://attacker.test/x" }).success).toBe(false);
    }
    if (args.contactId) for (const v of ["..", "%2e%2e", "%252f", "../other", "x?foo=1", "x#y", "x/y"]) expect(op.args.safeParse({ ...args, contactId: v }).success).toBe(false);
  });
  it("matches provider route, scope, version, retry class and design risk", async () => {
    const op = spec(verb);
    expect(op.risk).toBe(risk);
    expect(op.endpoint).toMatchObject({ method, scope: risk === "R" ? "contacts.readonly" : "contacts.write", version: "2021-07-28", retry: risk === "R" ? "read" : "write" });
    expect(op.endpoint.path.test(path)).toBe(true);
    const frozen = providerOperation(op.id)!;
    expect(frozen.status).toBe("qualified");
    expect(op.endpoint).toMatchObject({ method: frozen.method, scope: frozen.scope, version: frozen.Version, retry: frozen.retryClass });
    expect(op.endpoint.path.test(path)).toBe(true);
    const fixture = await reviewedContactFake(op, args);
    const raw = await fixture.held.send();
    expect(op.project(raw, fixture.held.frozen)).toBeDefined();
    expect(fixture.wire.calls.at(-1)).toMatchObject({ operation: op.id, method, path });
    expect(contactsRoutes.some((r) => r.operation === op.id)).toBe(true);
  });
  it("runs R at read; refuses C/S/D at read and D at change", async () => {
    const op = spec(verb);
    expect(levelCovers("read", op.risk)).toBe(risk === "R");
    expect(levelCovers("change", op.risk)).toBe(risk !== "D");
    expect(levelCovers("off", op.risk)).toBe(false);
    expect(levelCovers("full", op.risk)).toBe(true);
    if (levelCovers("read", op.risk)) await expect(run(op, contactFake(), args)).resolves.toHaveProperty("value");
  });
  it("metadata holds record ids and field names only", () => {
    const op = spec(verb);
    expect(JSON.stringify([op.fields(args), op.recordRefs(args)])).not.toContain("SECRET_VALUE");
    expect(op.recordRefs({ ...args, customFields: { SECRET_VALUE: "SECRET_VALUE" }, body: "SECRET_VALUE" })).not.toContain("SECRET_VALUE");
    expect(op.fields({ ...args, SECRET_VALUE: "SECRET_VALUE" })).not.toContain("SECRET_VALUE");
  });
  it("refuses a foreign or unknown owning location before dispatch", async () => {
    const op = spec(verb);
    const crm = contactFake({ locationId: "elsewhere" });
    await expect(op.ownership!(pre(crm), args, { locationId: op.nested ? "loc1" : "../invalid" })).rejects.toThrow(/ownership|location/i);
    expect(crm.calls.every((c) => c.operation === "contacts.get")).toBe(true);
  });
  it("provider error values cannot enter family receipt metadata", async () => {
    const op = spec(verb);
    const crm = contactFake({ failOperation: op.id, errorText: "SECRET_PROVIDER_ERROR" });
    await expect(run(op, crm, args)).rejects.toThrow("SECRET_PROVIDER_ERROR");
    // Family output is the metadata handed to C2. Its action lifecycle is
    // tested by C2 once the F0 implementation stubs are replaced.
    const stored = JSON.stringify({ recordRefs: op.recordRefs(args), fields: op.fields(args) });
    expect(stored).not.toContain("SECRET_PROVIDER_ERROR");
    expect(stored).not.toContain("SECRET_VALUE");
  });
});

it("has the complete contacts operation set", () => {
  expect(contactsOperations.map((op) => op.id).sort()).toEqual(cases.map(([verb]) => `contacts.${verb}`).sort());
  expect(familyOperations("contacts").map((op) => op.id)).toEqual(contactsOperations.map((op) => op.id));
});
for (const verb of ["notes.get", "notes.update", "notes.delete", "tasks.get", "tasks.update", "tasks.complete", "tasks.delete"]) {
  it(`${verb} refuses a nested record belonging to another contact`, async () => {
    const args = cases.find(([v]) => v === verb)![4];
    const crm = contactFake({ nestedContactId: "other-contact" });
    await expect(spec(verb).ownership!(pre(crm), args, { locationId: "loc1" })).rejects.toThrow(/ownership/);
    expect(crm.calls.every((c) => c.method === "GET")).toBe(true);
  });
}
it("contact custom fields resolve by id and refuse ambiguous names before a write", async () => {
  const op = spec("upsert");
  const args = { firstName: "Secret", customFields: [{ id: "cf1", value: "PRIVATE_CUSTOM_VALUE" }] };
  const crm = contactFake();
  await op.ownership!(pre(crm), args, ctx);
  await run(op, crm, args);
  expect(crm.calls.at(-1)?.body).toEqual({ locationId: "loc1", firstName: "Secret", customFields: [{ id: "cf1", field_value: "PRIVATE_CUSTOM_VALUE" }] });
  const request = vi.fn().mockResolvedValue({ customFields: [{ id: "cf1", name: "duplicate" }, { id: "cf2", name: "duplicate" }] });
  await expect(op.ownership!({ read: request }, { ...args, customFields: [{ name: "duplicate", value: "PRIVATE_CUSTOM_VALUE" }] }, ctx)).rejects.toThrow(/cf1, cf2/);
  expect(request).toHaveBeenCalledTimes(1);
});
it("bounded projections discard provider metadata and oversized arrays/strings", () => {
  const value = spec("search").project({ contacts: Array.from({ length: 80 }, () => ({ id: "c1", firstName: "x".repeat(5000), token: "PRIVATE_TOKEN", unrelated: "PRIVATE_EXTRA" })), providerDebug: "PRIVATE_DEBUG" });
  expect(JSON.stringify(value)).not.toContain("PRIVATE_");
  expect((value as { contacts: unknown[] }).contacts.length).toBeLessThanOrEqual(50);
  expect((value as { contacts: { firstName: string }[] }).contacts[0]!.firstName).toHaveLength(4000);
  expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(65_536);
  for (const [verb, risk] of cases) {
    if (risk === "R") expect(spec(verb).project({ providerDebug: "PRIVATE_DEBUG" })).toEqual({});
    else expect(() => spec(verb).project({ providerDebug: "PRIVATE_DEBUG" })).toThrow();
  }
});
it("bulk counts contacts, and a task patch never resets its completion", async () => {
  expect(spec("tags.bulk").targets({ contacts: ["c1", "c2", "c2"] })).toBe(2);
  const crm = contactFake();
  await run(spec("tasks.update"), crm, { contactId: "c1", taskId: "t1", title: "Changed" });
  expect(crm.calls.at(-1)?.body).toEqual({ title: "Changed" });
});

it("contact custom field arrays remain available to the engine projection", () => {
  expect(spec("get").project({ contact: { id: "c1", customFields: [{ id: "cf1", value: ["One", "Two"] }] } })).toEqual({ contact: { id: "c1", customFields: [{ id: "cf1", value: ["One", "Two"] }] } });
});
it("unknown ownership and malformed success never produce a saved record receipt", async () => {
  const missingOwner = { request: vi.fn().mockResolvedValue({ contact: { id: "c1" } }) };
  await expect(spec("notes.get").ownership!({ read: missingOwner.request }, { contactId: "c1", noteId: "n1" }, { locationId: "loc1" })).rejects.toThrow(/ownership/);
  expect(missingOwner.request).toHaveBeenCalledTimes(1);
  for (const [verb, , , , args] of cases.filter(([, risk]) => risk !== "R")) {
    const crm = { request: vi.fn().mockResolvedValue({ providerMessage: "SECRET_PROVIDER_ERROR" }) };
    await expect(run(spec(verb), crm, args)).rejects.toMatchObject({ outcome: "outcome_unknown" });
    expect(crm.request).toHaveBeenCalledTimes(1);
  }
});
it("custom field credentials, URL values, empty changes and oversized bodies are refused before requests", async () => {
  const crm = { request: vi.fn() };
  for (const args of [
    { contactId: "c1" },
    { contactId: "c1", customFields: [{ id: "cf1", value: "test", token: "secret" }] },
    { contactId: "c1", customFields: [{ id: "cf1", value: "https://example.test" }] },
    { contactId: "c1", customFields: Array.from({ length: 40 }, (_, i) => ({ id: `cf${i}`, value: "a".repeat(4000) })) },
  ]) await expect(run(spec("update"), crm, args)).rejects.toThrow();
  expect(crm.request).not.toHaveBeenCalled();
});
it("search translates legacy exact filters and task completion sends only its reviewed flag", async () => {
  const crm = contactFake();
  await run(spec("search"), crm, { tag: "lead", email: "fixture@example.test", page: 2, limit: 10 });
  expect(crm.calls.at(-1)?.body).toEqual({ locationId: "loc1", page: 2, pageLimit: 10, filters: [{ field: "email", operator: "eq", value: "fixture@example.test" }, { field: "tags", operator: "eq", value: "lead" }] });
  await run(spec("tasks.complete"), crm, { contactId: "c1", taskId: "t1", completed: false });
  expect(crm.calls.at(-1)?.body).toEqual({ completed: false });
});

for (const [verb, risk, , , args] of cases) describe(`amended contacts.${verb}`, () => {
  it('retryClassMatchesRisk', () => {
    expect(spec(verb).endpoint.retry).toBe(risk === 'R' ? 'read' : 'write');
    for (const id of spec(verb).preflight) expect(providerOperation(id)?.risk).toBe('R');
  });
  it('boundRequester.pathMismatchRefused', async () => {
    const fixture = await reviewedContactFake(spec(verb), args);
    expect(() => freezeContactDraft(spec(verb), { ...fixture.draft, path: '/contacts/another-record' }, ctx)).toThrow(/mismatch/i);
    expect(fixture.leases).toBe(0);
  });
  if (risk !== 'R') it('boundRequester.secondSendRefused', async () => {
    const op = spec(verb), fixture = await reviewedContactFake(op, args);
    await fixture.held.send();
    await expect(fixture.held.send()).rejects.toThrow('one_send');
    expect(fixture.leases).toBe(1);
  });
  if (args.contactId || args.contacts) it('ownership.refusedBeforeLease', async () => {
    const op = spec(verb);
    expect(op.nested).toBe(true);
    const crm = contactFake({ locationId: 'foreign' });
    const lease = vi.fn();
    await expect((async () => {
      await op.ownership!(pre(crm), args, ctx);
      lease();
      await run(op, crm, args);
    })()).rejects.toThrow(/ownership/);
    expect(lease).not.toHaveBeenCalled();
    expect(crm.calls.every(call => call.method === 'GET')).toBe(true);
  });
});
it('location comes only from trusted context and legacy calls fail closed', async () => {
  const op = spec('create');
  expect(op.args.safeParse({ firstName: 'Name', locationId: 'foreign' }).success).toBe(false);
  const crm = contactFake();
  expect(contactsOperations.find(item => item.id === op.id)).not.toHaveProperty('run');
  expect(crm.calls).toEqual([]);
  await run(op, crm, { firstName: 'Name' });
  expect(crm.calls[0]?.body).toEqual({ firstName: 'Name', locationId: 'loc1' });
});
it('custom field names resolve during preparation before a frozen send', async () => {
  const op = spec('upsert'), crm = contactFake();
  if (op.risk === 'R') throw new Error('Expected mutation');
  const args = { firstName: 'Name', customFields: [{ name: 'Fixture field', value: 'PRIVATE' }] };
  const draft = await op.prepare(pre(crm), args, ctx);
  expect(crm.calls.map(call => call.operation)).toEqual(['location.customFields.list']);
  expect(jsonBody(draft)).toEqual({ firstName: 'Name', locationId: 'loc1', customFields: [{ id: 'cf1', field_value: 'PRIVATE' }] });
  const held = freezeContactDraft(op, draft, ctx, crm);
  await held.send();
  expect(crm.calls.map(call => call.operation)).toEqual(['location.customFields.list', 'contacts.upsert']);
});
it('reviewed body and same-route record cannot change before dispatch', async () => {
  const op = spec('update'), fixture = await reviewedContactFake(op, { contactId: 'c1', firstName: 'Reviewed' });
  expect(() => freezeContactDraft(op, { ...fixture.draft, path: '/contacts/c2' }, ctx)).toThrow(/mismatch/i);
  const changed = freezeContactDraft(op, { ...fixture.draft, body: { kind: 'json', value: { firstName: 'Changed' } } }, ctx);
  await expect(changed.send(fixture.held.frozen.requestDigest)).rejects.toThrow(/mismatch/);
  expect(changed.leases).toBe(0);
  const copy = fixture.held.sendCopy();
  (copy.body as Record<string, unknown>).firstName = 'Changed';
  expect(fixture.held.sendCopy().body).toEqual({ firstName: 'Reviewed' });
  expect(fixture.leases).toBe(0);
});
it('normalized custom fields survive the host shallow argument copy', async () => {
  const op = spec('upsert'), crm = contactFake();
  const args = { firstName: 'Name', customFields: [{ name: 'Fixture field', value: 'PRIVATE' }] };
  const hostArgs = { ...args };
  await op.ownership!(pre(crm), args, ctx);
  expect(hostArgs.customFields).toEqual([{ id: 'cf1', value: 'PRIVATE' }]);
  await run(op, crm, hostArgs);
  expect(crm.calls.at(-1)?.body).toEqual({ firstName: 'Name', locationId: 'loc1', customFields: [{ id: 'cf1', field_value: 'PRIVATE' }] });
});

for (const [verb, risk, , , args] of cases) describe(`frozen contacts.${verb}`, () => {
  it(risk === 'R' ? 'prepareRead exists for every read' : 'freeze.otherContactIdRefused', async () => {
    const op = spec(verb);
    expect(contactsOperations.find(item => item.id === op.id)).not.toHaveProperty('run');
    const fixture = await reviewedContactFake(op, args);
    if (op.risk === 'R') {
      expect(typeof op.prepareRead).toBe('function');
      expect(await op.prepareRead(args, ctx)).toEqual(fixture.draft);
      return;
    }
    expect(typeof op.prepare).toBe('function');
    if (args.contactId) {
      // Same endpoint pattern, different parent; retaining the reviewed resource
      // rejects at freeze even before an action/digest exists.
      expect(() => freezeContactDraft(op, { ...fixture.draft, path: fixture.draft.path.replace('/c1', '/c2') }, ctx)).toThrow(/mismatch/i);
      if (verb === 'tags.add' || verb === 'tags.remove') {
        expect(() => freezeContactDraft(op, { ...fixture.draft, path: fixture.draft.path.replace('/c1', '/c2'), resource: 'contacts:contact:c2' }, ctx)).toThrow(/pre-state/);
        expect(fixture.leases).toBe(0);
        return;
      }
      const changed = freezeContactDraft(op, { ...fixture.draft, path: fixture.draft.path.replace('/c1', '/c2'), resource: 'contacts:contact:c2' }, ctx);
      await expect(changed.send(fixture.held.frozen.requestDigest)).rejects.toThrow(/mismatch/);
      expect(changed.leases).toBe(0);
    } else {
      const changed = freezeContactDraft(op, { ...fixture.draft, body: { kind: 'json', value: { ...(jsonBody(fixture.draft) as Record<string, unknown>), ...(verb === 'tags.bulk' ? { contacts: ['c3'] } : { firstName: 'Another' }) } } }, ctx);
      await expect(changed.send(fixture.held.frozen.requestDigest)).rejects.toThrow(/mismatch/);
      expect(changed.leases).toBe(0);
    }
    expect(fixture.leases).toBe(0);
  });
});
it('POST search prepares its schema-bound body with the trusted location', async () => {
  const op = spec('search');
  if (op.risk !== 'R') throw new Error('Expected read');
  expect(await op.prepareRead({ query: 'Reviewed', limit: 5 }, ctx)).toEqual({ path: '/contacts/search', resource: 'location:loc1', body: { kind: 'json', value: { locationId: 'loc1', page: 1, pageLimit: 5, query: 'Reviewed' } } });
});

for (const [verb, risk, , , args] of cases.filter(([, risk]) => risk === 'R')) describe(`r4 contacts.${verb}`, () => {
  it('registry.everyReadHasPrepareRead', () => {
    const op = spec(verb);
    expect(op.risk).toBe(risk);
    expect(op).toHaveProperty('maxReads', 1);
    expect(typeof (op as unknown as { prepareRead: unknown }).prepareRead).toBe('function');
  });
  it('freeze.acceptsReadSpec', async () => {
    const op = spec(verb), fixture = await reviewedContactFake(op, args);
    expect(fixture.held.frozen.operation).toBe(op.id);
    expect(() => freezeContactDraft(op, { ...fixture.draft, query: { locationId: 'foreign' } }, ctx)).toThrow(/location/i);
    expect(fixture.leases).toBe(0);
  });
});
it('digest.requestDigestV2BindsContentType', async () => {
  const fixture = await reviewedContactFake(spec('search'), { query: 'Reviewed' });
  expect(fixture.held.frozen).toHaveProperty('contentType', 'application/json');
  expect(fixture.held.frozen).toHaveProperty('upload', null);
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const bodyHash = sha('{"locationId":"loc1","page":1,"pageLimit":20,"query":"Reviewed"}');
  expect(fixture.held.frozen.bodySha256).toBe(bodyHash);
  expect(fixture.held.frozen.requestDigest).toBe(sha(JSON.stringify(['highlevel-request', 2, 'contacts.search', 'POST', '/contacts/search', 'location:loc1', [], 'json', 'application/json', bodyHash, null])));
});

it('freeze refuses undeclared body fields and bodies on GET rows', async () => {
  const update = spec('update'), fixture = await reviewedContactFake(update, { contactId: 'c1', firstName: 'Reviewed' });
  expect(() => freezeContactDraft(update, { ...fixture.draft, body: { kind: 'json', value: { firstName: 'Reviewed', unrelated: true } } }, ctx)).toThrow();
  const get = spec('get'), read = await reviewedContactFake(get, { contactId: 'c1' });
  expect(() => freezeContactDraft(get, { ...read.draft, body: { kind: 'json', value: {} } }, ctx)).toThrow(/bodyless/);
});

it('freeze retains the reviewed operation and method after caller mutation', async () => {
  const source = spec('update');
  if (source.risk === 'R') throw new Error('Expected mutation');
  const op = { ...source, endpoint: { ...source.endpoint } };
  const wire = contactFake();
  const draft = await op.prepare(pre(wire), { contactId: 'c1', firstName: 'Reviewed' }, ctx);
  const held = freezeContactDraft(op, draft, ctx, wire);
  op.id = 'contacts.delete';
  op.endpoint.method = 'DELETE';
  await held.send();
  expect(wire.calls.at(-1)).toMatchObject({ operation: 'contacts.update', method: 'PUT', path: '/contacts/c1', body: { firstName: 'Reviewed' } });
});

it('r4 manifest distinguishes ready endpoints from unknown absent endpoints', () => {
  // Checked by the server tsc gate as well as Vitest. No invented endpoint is
  // needed merely to describe a provider-absent operation.
  const absent: ManifestRow = { ...spec('get').row, disposition: 'provider_absent', method: null, path: null, version: null, scope: null };
  expect(absent.disposition).toBe('provider_absent');
  expectTypeOf<Extract<ManifestRow, { disposition: 'ready' }>['method']>().toEqualTypeOf<HighLevelMethod>();
  expectTypeOf<Extract<ManifestRow, { disposition: 'provider_absent' }>['method']>().toEqualTypeOf<HighLevelMethod | null>();
  expectTypeOf<Gate>().toEqualTypeOf<'R' | 'GC' | 'GC+' | 'GD' | 'GDp'>();
  expectTypeOf<SpecBase['ownership']>().toEqualTypeOf<ContactOperationSpec['ownership']>();
});

// Independent inventory for S0's F0 reconciliation (odes4-hl D). This includes
// self/bulk ownership and child lookups, not just the incomplete r3 Pre column.
const requiredPreparation = {
  search: [], get: ['contacts.get'], create: ['location.customFields.list'],
  update: ['contacts.get', 'location.customFields.list'], upsert: ['location.customFields.list'],
  delete: ['contacts.get'], 'tags.add': ['contacts.get'], 'tags.remove': ['contacts.get'], 'tags.bulk': ['contacts.get'],
  'notes.list': ['contacts.get'], 'notes.get': ['contacts.get', 'contacts.notes.get'], 'notes.create': ['contacts.get'],
  'notes.update': ['contacts.get', 'contacts.notes.get'], 'notes.delete': ['contacts.get', 'contacts.notes.get'],
  'tasks.list': ['contacts.get'], 'tasks.get': ['contacts.get', 'contacts.tasks.get'], 'tasks.create': ['contacts.get'],
  'tasks.update': ['contacts.get', 'contacts.tasks.get'], 'tasks.complete': ['contacts.get', 'contacts.tasks.get'],
  'tasks.delete': ['contacts.get', 'contacts.tasks.get'], 'appointments.list': ['contacts.get'],
  'followers.add': ['contacts.get'], 'followers.remove': ['contacts.get'],
} as const;
const requiredPreflight = {
  ...requiredPreparation,
  // S0's reviewed reconciliation adds target-bound create recovery and the
  // bounded bulk census. Keep these independent of the generated manifest.
  create: ['location.customFields.list', 'contacts.search', 'contacts.get'],
  'tags.bulk': ['contacts.get', 'contacts.search'],
  upsert: ['location.customFields.list', 'contacts.get', 'contacts.search'],
  'notes.create': ['contacts.get', 'contacts.notes.list'],
  'tasks.create': ['contacts.get', 'contacts.tasks.list'],
} as const;

for (const [verb, , , , input] of cases) describe(`r4 preflight contacts.${verb}`, () => {
  const op: ContactOperationSpec = contactsOperations.find(item => item.id === `contacts.${verb}`)!;
  const args = ['create', 'update', 'upsert'].includes(verb)
    ? { ...input, customFields: [{ name: 'Fixture field', value: 'Reviewed' }] } : input;
  it('manifest preflight inventory covers every ownership and custom-field read', async () => {
    expect(Object.keys(requiredPreflight)).toHaveLength(cases.length);
    expect(op.preflight).toEqual(requiredPreflight[verb as keyof typeof requiredPreflight]);
    expect(op.preflight).toBe(op.row.preflight);
    expect(op.args).toBe(op.row.argsSchema);
    expect(op.row.gate).toBe(op.risk === 'R' ? 'R' : op.risk === 'D' ? 'GD' : 'GC');
    const fixture = await reviewedContactFake(op, args);
    expect([...new Set(fixture.wire.calls.map(call => call.operation))]).toEqual(requiredPreparation[verb as keyof typeof requiredPreparation]);
    expect(fixture.leases).toBe(0);
  });
  it('fixture refuses a divergent manifest preflight list before preparation', async () => {
    const ownership = vi.fn(op.ownership);
    await expect(reviewedContactFake({ ...op, ownership, row: { ...op.row, preflight: [...op.preflight] } }, args)).rejects.toThrow(/preflight/i);
    expect(ownership).not.toHaveBeenCalled();
  });
  for (const missing of requiredPreflight[verb as keyof typeof requiredPreflight]) {
    it(`missing ${missing} refuses before freeze or mutation`, async () => {
      const preflight = op.preflight.filter(id => id !== missing);
      await expect(reviewedContactFake({ ...op, preflight, row: { ...op.row, preflight } }, args)).rejects.toThrow(/preflight/i);
    });
  }
  it('fixture refuses provider-absent rows before ownership or a lease', async () => {
    const ownership = vi.fn(op.ownership);
    const absent = { ...op, ownership, row: { ...op.row, disposition: 'provider_absent' as const } };
    await expect(reviewedContactFake(absent, args)).rejects.toThrow(/absent/i);
    expect(ownership).not.toHaveBeenCalled();
    const fixture = await reviewedContactFake(op, args);
    expect(() => freezeContactDraft(absent, fixture.draft, ctx)).toThrow(/absent/i);
    expect(fixture.leases).toBe(0);
  });
});


describe("F0 contacts integration", () => {
  it("uses frozen manifest rows, schemas and preflight lists by identity", () => {
    for (const op of contactsOperations) {
      const row = HIGHLEVEL_OPERATION_MANIFEST.find(row => row.id === op.id)!;
      const schema = schemas[op.id as keyof typeof schemas];
      expect(op.row).toBe(row);
      expect(op.args).toBe(schema.argsSchema);
      expect(op.row.bodySchema).toBe(schema.bodySchema);
      expect(op.row.projection).toEqual(schema.projection);
      expect(op.preflight).toBe(row.preflight);
      expect(operationSpec(op.id)).toBe(op);
      expect(Object.isFrozen(op)).toBe(true);
    }
  });
  it("satisfies contacts wave completeness without changing the integration list", () => {
    expect(() => assertRegistryCompleteness(contactsOperations, ["contacts"])).not.toThrow();
    expect(() => assertRegistryCompleteness(contactsOperations.slice(1), ["contacts"])).toThrow(/Missing HighLevel spec/);
  });
});
