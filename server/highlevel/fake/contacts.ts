// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { HighLevelError } from "../client.ts";
import type { FakeHighLevelRequest as Request, FakeHighLevelRoute as Route } from "../fake-provider.ts";
import type { HighLevelMethod } from "../provider-contract.ts";
import type { fakeHighLevelRequester } from "../fake-provider.ts";
type HighLevelRequester = Pick<ReturnType<typeof fakeHighLevelRequester>, "request">;

const contact = { id: "c1", locationId: "loc1", firstName: "Fixture contact", tags: [] };
const note = { id: "n1", contactId: "c1", body: "Fixture note" };
const task = { id: "t1", contactId: "c1", title: "Fixture task", dueDate: "2026-11-20T10:00:00Z", completed: false };
const routes: Array<[string, HighLevelMethod, string, unknown]> = [
  ["search", "POST", "/contacts/search", { contacts: [contact], total: 1 }],
  ["get", "GET", "/contacts/:id", { contact }],
  ["create", "POST", "/contacts/", { contact }], ["update", "PUT", "/contacts/:id", { contact }],
  ["upsert", "POST", "/contacts/upsert", { new: true, contact }], ["delete", "DELETE", "/contacts/:id", { succeeded: true }],
  ["tags.add", "POST", "/contacts/:id/tags", { tags: ["Fixture tag"], succeeded: true }],
  ["tags.remove", "DELETE", "/contacts/:id/tags", { tags: [], succeeded: true }],
  ["tags.bulk", "POST", "/contacts/bulk/tags/update/(add|remove)", { succeeded: true, errorCount: 0 }],
  ["notes.list", "GET", "/contacts/:id/notes", { notes: [note] }],
  ["notes.get", "GET", "/contacts/:id/notes/:id", { note }],
  ["notes.create", "POST", "/contacts/:id/notes", { note }],
  ["notes.update", "PUT", "/contacts/:id/notes/:id", { note }],
  ["notes.delete", "DELETE", "/contacts/:id/notes/:id", { succeeded: true }],
  ["tasks.list", "GET", "/contacts/:id/tasks", { tasks: [task] }],
  ["tasks.get", "GET", "/contacts/:id/tasks/:id", { task }],
  ["tasks.create", "POST", "/contacts/:id/tasks", { task }],
  ["tasks.update", "PUT", "/contacts/:id/tasks/:id", { task }],
  ["tasks.complete", "PUT", "/contacts/:id/tasks/:id/completed", { task: { ...task, completed: true } }],
  ["tasks.delete", "DELETE", "/contacts/:id/tasks/:id", { succeeded: true }],
  ["appointments.list", "GET", "/contacts/:id/appointments", { events: [{ id: "a1", contactId: "c1", calendarId: "cal1" }] }],
  ["followers.add", "POST", "/contacts/:id/followers", { followers: ["u1"] }],
  ["followers.remove", "DELETE", "/contacts/:id/followers", { followers: ["u1"], followersRemoved: ["u1"] }],
];
export const contactsRoutes: readonly Route[] = routes.map(([verb, method, path, response]) => ({
  operation: `contacts.${verb}`, method, path: new RegExp(`^${path.replaceAll(":id", "[A-Za-z0-9_.~%-]+")}$`, "u"),
  handle: () => structuredClone(response),
}));

export function contactFake(options: { locationId?: string; nestedContactId?: string; failOperation?: string; errorText?: string } = {}): HighLevelRequester & { calls: Request[] } {
  const calls: Request[] = [];
  return { calls, async request(operation, method, path, body, query) {
    const call = { operation, method, path, body, query };
    calls.push(call);
    if (options.failOperation === operation) throw new HighLevelError(options.errorText ?? "Fixture failure", { status: 422 });
    if (operation === "location.customFields.list") return { customFields: [{ id: "cf1", name: "Fixture field", fieldKey: "contact.fixture_field" }] };
    const route = contactsRoutes.find((r) => r.operation === operation && r.method === method && r.path.test(path));
    if (!route) throw new Error("No contact fixture route");
    const result = route.handle(call) as Record<string, unknown>;
    if (operation === "contacts.get") result.contact = { ...contact, id: path.split("/")[2], locationId: options.locationId ?? "loc1" };
    if (operation === "contacts.notes.get") result.note = { ...note, contactId: options.nestedContactId ?? "c1" };
    if (operation === "contacts.tasks.get") result.task = { ...task, contactId: options.nestedContactId ?? "c1" };
    if (operation === "contacts.tags.add" && body && typeof body === 'object') result.tags = [...(body as { tags: string[] }).tags];
    if (operation === "contacts.tags.bulk" && body && typeof body === 'object') result.contacts = [...(body as { contacts: string[] }).contacts];
    if (['contacts.create', 'contacts.update', 'contacts.upsert'].includes(operation) && body && typeof body === 'object' && 'customFields' in body)
      (result.contact as Record<string, unknown>).customFields = structuredClone(body.customFields);
    return result;
  } };
}

export default contactsRoutes;

import { createHash } from 'node:crypto';
import type { OperationSpec as ContactOperationSpec } from '../operations/registry.ts';
import type { RequestDraft, PreflightRequester, OperationRunContext } from '../operations/registry.ts';
import { HeldRequest } from '../held-request.ts';
import { prepareContactConfirmation } from '../contact-confirmation.ts';
import { prepareReturnedIdentitySchema } from '../returned-identities.ts';
import { providerOperation } from '../provider-manifest.ts';
import { HIGHLEVEL_OPERATION_MANIFEST } from '../operations/manifest.ts';
const canonical = (value: unknown): string => JSON.stringify(value, function (_key, item: unknown) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item;
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

// The family fake uses production retained request bytes and F0.2 binding.
// Registered host tests cover the transport/approval boundary separately.
export const jsonBody = (draft: RequestDraft): unknown => draft.body?.kind === 'json' ? draft.body.value : undefined;
// Keep refusal coverage at the fake boundary as well as registry load.
// A family must not widen its row's preflight allowlist.
function readyContactRow(op: ContactOperationSpec) {
  if (op.row.disposition !== 'ready') throw new Error('Provider operation absent');
  if (op.preflight !== op.row.preflight || JSON.stringify(op.preflight) !== JSON.stringify(HIGHLEVEL_OPERATION_MANIFEST.find(row => row.id === op.id)?.preflight)) throw new Error('Manifest preflight mismatch');
  return op.row;
}
export function freezeContactDraft(op: ContactOperationSpec, draft: RequestDraft, ctx: OperationRunContext, wire = contactFake()) {
  readyContactRow(op);
  if (!op.endpoint.path.test(draft.path)) throw new Error('Request path mismatch');
  if (draft.resource.startsWith('contacts:contact:')) {
    if (decodeURIComponent(draft.path.split('/')[2] ?? '') !== draft.resource.slice('contacts:contact:'.length)) throw new Error('Resource mismatch');
  } else if (draft.resource !== `location:${ctx.locationId}`) throw new Error('Location mismatch');
  if (draft.query?.locationId !== undefined && draft.query.locationId !== ctx.locationId) throw new Error('Location mismatch');
  if (draft.body?.kind === 'multipart') throw new Error('Contacts do not upload');
  if (draft.body && !op.row.bodySchema) throw new Error('Body on a bodyless row');
  if (draft.body) op.row.bodySchema!.parse(draft.body.value);
  const body = draft.body?.value as Record<string, unknown> | undefined;
  if (body?.locationId !== undefined && body.locationId !== ctx.locationId) throw new Error('Location mismatch');
  const bytes = draft.body ? canonical(draft.body.value) : '';
  const query = Object.entries(draft.query ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const path = draft.path;
  const held = HeldRequest.freeze(op, draft, ctx);
  prepareContactConfirmation(held, draft, ctx.locationId);
  if (op.risk !== 'R') prepareReturnedIdentitySchema(held, ctx.locationId);
  const frozen = held.frozen;
  let leases = 0;
  const sendCopy = () => ({ path, body: bytes ? JSON.parse(bytes) as unknown : undefined, query: Object.fromEntries(query) });
  return { frozen, sendCopy, get leases() { return leases; }, async send(approvedDigest = frozen.requestDigest) {
    if (approvedDigest !== frozen.requestDigest) throw new Error('Reviewed request mismatch');
    if (leases >= 1) throw new Error('one_send');
    const out = sendCopy();
    const sentHash = hash(out.body === undefined ? '' : canonical(out.body));
    const sentDigest = hash(canonical(['highlevel-request', 2, frozen.operation, frozen.method, out.path, frozen.resource,
      Object.entries(out.query).sort(([a], [b]) => a.localeCompare(b)), frozen.bodyKind, frozen.contentType, sentHash, frozen.upload]));
    if (sentHash !== frozen.bodySha256 || sentDigest !== frozen.requestDigest || sentDigest !== approvedDigest) throw new Error('Reviewed request mismatch');
    leases++;
    return wire.request(frozen.operation, frozen.method, out.path, out.body, out.query);
  } };
}
export async function reviewedContactFake(op: ContactOperationSpec, input: Record<string, unknown>, options: Parameters<typeof contactFake>[0] = {}, ctx: OperationRunContext = { locationId: 'loc1' }) {
  const specRow = readyContactRow(op);
  const wire = contactFake(options), args = op.args.parse(structuredClone(input));
  const pre: PreflightRequester = { async read(id, draft) {
    const row = providerOperation(id);
    if (!specRow.preflight.includes(id) || row?.risk !== 'R' || row.retryClass !== 'read') throw new Error('Preflight operation refused');
    return wire.request(id, row.method!, draft.path, draft.body, draft.query);
  } };
  let draft: RequestDraft;
  if (op.risk === 'R') {
    await op.ownership!(pre, args, ctx);
    draft = await op.prepareRead(args, ctx);
  } else draft = await op.prepare(pre, args, ctx);
  const held = freezeContactDraft(op, draft, ctx, wire);
  return { args, ctx, draft, held, wire, get leases() { return held.leases; } };
}
