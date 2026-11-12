import { readReconciliation, UnconfirmedReconciliation, completeReconciliationCollection } from './reconciliation-read.ts';
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { canonicalBindingJson } from './binding-json.ts';
import { HeldRequest } from './held-request.ts';
import type { MutationSpec, PreflightRequester } from './operations/registry.ts';
import type { ActionIntent } from './actions.ts';
import type { RpcApprovalBinding } from './rpc-approval-replay.ts';
import type { ApprovalJournal, ApprovalOutcome } from './approval-idempotency.ts';
import { tagPostStateFor, retainTagPostState, validTagSet } from './returned-confirmation-state.ts';
import { reconciliationReadsFor } from './operations/reconciliation.ts';
import { bindReturnedIdentities, prepareReturnedIdentitySchema } from './returned-identities.ts';
import { highlevelIdSchema } from './operations/schemas/common.ts';
import { HighLevelError } from './errors.ts';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const hash = (v: unknown) => createHash('sha256').update(canonicalBindingJson(v)).digest('hex');
const refuse = (): never => { throw new Error('Contact recovery could not be prepared'); };
const conflict = (reason: 'unconfirmed' | 'identity_conflict' | 'negative_confirmation' = 'unconfirmed'): ApprovalOutcome => ({ status: 'conflict', reason });
const ids = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => highlevelIdSchema.safeParse(x).success) && new Set(v).size === v.length;
function effect(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).map(([key, value]) => [key,
    (key === 'tags' || key === 'followers') && Array.isArray(value) ? [...value].sort() : value]));
}
interface RecoveryState {
  version: 1;
  approvedFollowers?: string[];
  authorityDigest?: string;
  path: string;
  fields: string[];
  targets: RpcApprovalBinding['readTargets'];
  effects: string[];
  // New contact plans bind a scoped lookup hash, never raw search values.
  // Missing property denotes a legacy location-wide plan; null disables proof.
  contactLookupDigest?: string | null;
  // Complete pre-write candidate IDs prove that a matching create is new.
  beforeIds: string[] | null;
}
const prepared = new WeakMap<HeldRequest, RecoveryState>();
const keyFor = (approvalId: string) => `contact-recovery:${approvalId}`;
const collection = (op: string) => op === 'contacts.create' || op === 'contacts.upsert' ? 'contacts'
  : op === 'contacts.notes.create' ? 'notes' : op === 'contacts.tasks.create' ? 'tasks' : undefined;
const singular = (op: string) => op.startsWith('contacts.notes.') ? 'note' : op.startsWith('contacts.tasks.') ? 'task' : 'contact';
const deletion = (op: string) => op.endsWith('.delete');
const delta = (op: string) => op.startsWith('contacts.tags.') ? 'tags' : op.startsWith('contacts.followers.') ? 'followers' : undefined;

/** Qualified POST search uses a schema-checked body, never replay arguments.
 * Collection pagination is bounded; an incomplete collection cannot prove absence. */
async function readCollection(pre: PreflightRequester, target: RpcApprovalBinding['readTargets'][number], locationId: string, plural: string): Promise<{ raw: Record<string, unknown>; records: Record<string, unknown>[] }[]> {
  const value = await readReconciliation(pre, target.operation, { path: target.path,
    ...(target.operation === 'contacts.search' ? { body: { locationId, page: 1, pageLimit: 50 } } : {}) });
  if (!object(value) || !Array.isArray(value[plural]) || !(value[plural] as unknown[]).every(object)) return refuse();
  const records = value[plural] as Record<string, unknown>[];
  if (!completeReconciliationCollection(value, records.length, target.operation.endsWith('.search'))) return refuse();
  return [{ raw: value, records }];
}
// Use a qualified exact identity filter, or a bounded name query. A broad or
// unavailable lookup cannot prove a crash outcome, but must not block a create.
function contactLookup(body: Record<string, unknown>, locationId: string): Record<string, unknown> | undefined {
  for (const field of ['email', 'phone']) {
    if (typeof body[field] === 'string' && body[field].trim())
      return { locationId, page: 1, pageLimit: 50, filters: [{ field, operator: 'eq', value: body[field] }] };
  }
  const query = ['name', 'firstName', 'lastName'].map(field => body[field]).find(value => typeof value === 'string' && value.trim());
  if (typeof query === 'string' && query.length <= 75) return { locationId, page: 1, pageLimit: 50, query };
}
async function readContactCandidates(pre: PreflightRequester, lookup: Record<string, unknown>) {
  let raw: unknown;
  try { raw = await readReconciliation(pre, 'contacts.search', { path: '/contacts/search', body: lookup }); }
  catch (error) { if (error instanceof UnconfirmedReconciliation) return; throw error; }
  if (!object(raw) || !Array.isArray(raw.contacts) || !raw.contacts.every(object)) return;
  const contacts = raw.contacts, metadata = [raw, ...(object(raw.meta) ? [raw.meta] : [])];
  // Every declared total must prove the same complete page; neither envelope wins.
  const totals = metadata.filter(page => Object.hasOwn(page, 'total')).map(page => page.total);
  if (!totals.length || totals.some(total => !Number.isSafeInteger(total) || total !== contacts.length)) return;
  const next = metadata.some(page => page.nextPage || page.nextPageUrl || page.next);
  if (contacts.length > 50 || next || !ids(contacts.map(r => r.id))) return;
  return [{ raw, records: raw.contacts }];
}
function selected(record: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> | undefined {
  const body: Record<string, unknown> = {};
  for (const field of fields) {
    if (!Object.hasOwn(record, field)) return;
    body[field] = record[field];
    if (field === 'customFields') {
      if (!Array.isArray(record[field]) || record[field].some(v => !object(v) || !Object.hasOwn(v, 'id'))) return;
      body[field] = record[field].map(v => ({ id: v.id, field_value: v.field_value ?? v.value }));
    }
  }
  return body;
}
function targetsFor(spec: MutationSpec, held: HeldRequest, body: Record<string, unknown>): RpcApprovalBinding['readTargets'] {
  const path = held.frozen.path, plural = collection(spec.id);
  const targets: RpcApprovalBinding['readTargets'] = plural ? [{ operation: plural === 'contacts' ? 'contacts.search' : plural === 'notes' ? 'contacts.notes.list' : 'contacts.tasks.list', path: plural === 'contacts' ? '/contacts/search' : path }]
    : spec.id === 'contacts.tags.bulk' && ids(body.contacts) ? body.contacts.map(id => ({ operation: 'contacts.get' as const, path: `/contacts/${encodeURIComponent(id)}` }))
    : [{ operation: spec.id.startsWith('contacts.notes.') ? 'contacts.notes.get' : spec.id.startsWith('contacts.tasks.') ? 'contacts.tasks.get' : 'contacts.get',
      path: path.replace(/\/(?:tags|followers|completed)$/u, '') }];
  const allowed = reconciliationReadsFor(spec.id);
  if (!targets.length || targets.length > (spec.id === 'contacts.tags.bulk' ? 500 : 100) || targets.some(t => !allowed.includes(t.operation) || !spec.preflight.includes(t.operation))) return refuse();
  return targets;
}
/** Called before review. Durable metadata contains routes, IDs, selectors and
 * hashes only. No reviewed values or response payloads are retained on disk. */
export async function prepareContactRecovery(spec: MutationSpec, held: HeldRequest, pre: PreflightRequester, locationId: string): Promise<void> {
  const body = held.frozen.bodyKind === 'json' ? JSON.parse(Buffer.from(held.sendCopy().body!).toString()) as Record<string, unknown> : {};
  const targets = targetsFor(spec, held, body), plural = collection(spec.id), kind = delta(spec.id);
  const state: RecoveryState = { version: 1, path: held.frozen.path, fields: Object.keys(body).sort(), targets, effects: [], beforeIds: null };
  if (kind === 'followers') { if (!ids(body.followers)) return refuse(); state.approvedFollowers = [...body.followers]; }
  if (plural === 'contacts') {
    const lookup = contactLookup(body, locationId);
    state.contactLookupDigest = lookup ? hash(lookup) : null;
    const pages = lookup ? await readContactCandidates(pre, lookup) : undefined;
    state.beforeIds = pages ? pages.flatMap(p => p.records.map(r => r.id as string)) : null;
  } else if (plural) {
    const pages = await readCollection(pre, targets[0], locationId, plural);
    const records = pages.flatMap(p => p.records);
    const before = records.map(r => r.id);
    if (!ids(before)) return refuse();
    state.beforeIds = before;
  }
  for (const target of targets) {
    let expected = body;
    if (kind) {
      if (kind === 'tags' && spec.id !== 'contacts.tags.bulk') {
        const tags = tagPostStateFor(held.frozen);
        if (!tags) return refuse();
        expected = { tags };
      } else {
        const raw = await readReconciliation(pre, target.operation, { path: target.path });
        const id = decodeURIComponent(target.path.split('/')[2]);
        if (!object(raw) || !object(raw.contact) || raw.contact.id !== id || raw.contact.locationId !== locationId) return refuse();
        const before = raw.contact[kind], change = body[kind];
        if (!(kind === 'tags' ? validTagSet(before) && validTagSet(change) : ids(before) && ids(change))) return refuse();
        const old = before as string[], values = change as string[];
        const remove = spec.id.endsWith('.remove') || state.path.endsWith('/remove');
        expected = { [kind]: body.removeAllTags === true ? [] : remove ? old.filter(v => !values.includes(v)) : [...new Set([...old, ...values])] };
      }
    }
    state.effects.push(hash(effect(expected)));
  }
  prepared.set(held, state);
}
export function contactRecoveryPlan(spec: MutationSpec, held: HeldRequest): Pick<RpcApprovalBinding, 'readTargets' | 'effectDigest'> {
  const state = prepared.get(held);
  if (!state || held.frozen.operation !== spec.id || !state.targets.length) return refuse();
  return { readTargets: state.targets, effectDigest: hash(state) };
}
export function saveContactRecovery(journal: ApprovalJournal, approvalId: string, held: HeldRequest, authorityDigest: string): void {
  const state = prepared.get(held);
  if (!state) return refuse();
  state.authorityDigest = authorityDigest;
  const key = keyFor(approvalId), digest = held.frozen.requestDigest;
  const original = journal.get(key), approval = journal.get(approvalId);
  // A different RPC may reuse an already-seen approval. Its recovery plan is
  // immutable even if preparation observed a newer provider collection/state.
  // Pending/terminal approvalJournal never dispatch again, so keep the original plan.
  if (original?.state === 'applied' && original.requestDigest === digest && approval) {
    if (approval.requestDigest !== digest) return refuse();
    const saved = original.result as RecoveryState;
    if (saved.version !== 1 || saved.authorityDigest !== authorityDigest || saved.path !== held.frozen.path || !saved.targets?.length) return refuse();
    prepared.set(held, saved);
    return;
  }
  if (journal.claim(key, digest)) journal.settle(key, digest, { status: 'applied', result: state });
  const saved = journal.get(key);
  if (!saved || saved.requestDigest !== digest || saved.state !== 'applied' || hash(saved.result) !== hash(state)) return refuse();
}
function load(journal: ApprovalJournal, binding: RpcApprovalBinding): RecoveryState | undefined {
  const saved = journal.get(keyFor(binding.approvalId));
  if (!saved || saved.state !== 'applied' || saved.requestDigest !== binding.requestDigest || hash(saved.result) !== binding.effectDigest) return;
  const state = saved.result as RecoveryState;
  if (state.version !== 1 || state.authorityDigest !== binding.authorityDigest || hash(state.targets) !== hash(binding.readTargets) || state.effects.length !== state.targets.length) return;
  return state;
}
/** A synthetic effect witness is never dispatched. Ordinary writes reconstruct
 * the exact wire digest; deltas instead prove the saved expected-set digest.
 * Only then is the full read passed through the shared identity/negative gate. */
function witness(spec: MutationSpec, row: ActionIntent, state: RecoveryState, body: Record<string, unknown>, kind?: 'tags' | 'followers'): HeldRequest {
  const synthetic = kind ? spec.id === 'contacts.tags.bulk'
    ? { contacts: state.targets.map(t => decodeURIComponent(t.path.split('/')[2])), locationId: row.locationId, tags: ['recovery-witness'] }
    : { [kind]: kind === 'followers' ? state.approvedFollowers : ['recovery-witness'] } : body;
  const held = HeldRequest.freeze(spec, { path: state.path, resource: row.resource,
    ...(deletion(spec.id) ? {} : { body: { kind: 'json', value: synthetic } as const }) }, { locationId: row.locationId });
  if (!kind && held.frozen.requestDigest !== row.requestDigest) return refuse();
  if (kind === 'tags' && spec.id !== 'contacts.tags.bulk') retainTagPostState(held.frozen, body.tags as string[]);
  if (kind === 'followers' && held.frozen.requestDigest !== row.requestDigest) return refuse();
  return held;
}
function checked(raw: unknown, held: HeldRequest, locationId: string): ApprovalOutcome | undefined {
  const gate = bindReturnedIdentities(raw, held.frozen, prepareReturnedIdentitySchema(held, locationId));
  if (gate.status !== 'applied') return conflict(gate.status === 'not_applied' ? 'negative_confirmation' : 'identity_conflict');
}
function collectionEnvelopeWitness(spec: MutationSpec, row: ActionIntent, state: RecoveryState): HeldRequest {
  // Absence has no matching record from which to reconstruct reviewed bytes.
  // This unsendable witness permits only the original route/location and the
  // schema-declared newly-created primary ID slots, never response-supplied references.
  const body = spec.id.startsWith('contacts.notes.') ? { body: 'recovery-witness' }
    : spec.id.startsWith('contacts.tasks.') ? { title: 'recovery-witness', dueDate: '1970-01-01T00:00:00Z', completed: false }
    : { firstName: 'recovery-witness', locationId: row.locationId };
  return HeldRequest.freeze(spec, { path: state.path, resource: row.resource, body: { kind: 'json', value: body } }, { locationId: row.locationId });
}
async function reconcileLegacy(spec: MutationSpec, row: ActionIntent, binding: RpcApprovalBinding, pre: PreflightRequester): Promise<{ held: HeldRequest; value: unknown } | ApprovalOutcome> {
  // F0.2.2 only persisted PUT targets. Retain that proven reconstruction path
  // for old nonempty associations; never invent a plan for an empty legacy RPC.
  if (spec.endpoint.method !== 'PUT' || binding.readTargets.length !== 1) return conflict();
  const target = binding.readTargets[0], value = await readReconciliation(pre, target.operation, { path: target.path });
  const record = object(value) ? value[singular(spec.id)] : undefined;
  if (!object(record)) return conflict();
  const body = selected(record, row.fields);
  if (!body || hash(effect(body)) !== binding.effectDigest) return conflict();
  const path = target.path + (spec.id === 'contacts.tasks.complete' ? '/completed' : '');
  const held = witness(spec, row, { path } as RecoveryState, body);
  return checked(value, held, row.locationId) ?? { held, value };
}
export async function reconcileContactEffect(spec: MutationSpec, row: ActionIntent, binding: RpcApprovalBinding, journal: ApprovalJournal,
  pre: PreflightRequester, retained?: HeldRequest, replayArgs?: Record<string, unknown>): Promise<{ held: HeldRequest; value: unknown } | ApprovalOutcome> {
  const state = load(journal, binding);
  if (!state) return journal.get(keyFor(binding.approvalId)) ? conflict() : reconcileLegacy(spec, row, binding, pre);
  const plural = collection(spec.id), kind = delta(spec.id), key = singular(spec.id);
  if (plural) {
    // Replay arguments are RPC-digest checked by the host. Bind the selector
    // again to durable metadata before using any value in a read request.
    const scoped = plural === 'contacts' && Object.hasOwn(state, 'contactLookupDigest');
    const lookup = scoped && replayArgs ? contactLookup(replayArgs, row.locationId) : undefined;
    if (scoped && (!state.beforeIds || !lookup || hash(lookup) !== state.contactLookupDigest)) return conflict();
    const pages = scoped ? await readContactCandidates(pre, lookup!) : await readCollection(pre, state.targets[0], row.locationId, plural);
    if (!pages) return conflict();
    const records = pages.flatMap(p => p.records);
    if (!ids(records.map(r => r.id)) || !state.beforeIds) return conflict();
    if (records.some(record => !selected(record, state.fields))) return conflict();
    const matches = records.flatMap(record => {
      const body = selected(record, state.fields);
      return body && hash(effect(body)) === state.effects[0] ? [{ record, body }] : [];
    });
    const held = matches.length === 1 ? witness(spec, row, state, matches[0].body) : collectionEnvelopeWitness(spec, row, state);
    // Validate every page/envelope and every member, preserving all siblings.
    // Collection primary IDs occupy the schema's declared created singular slot.
    for (const page of pages) {
      const { [plural]: _records, ...envelope } = page.raw;
      const envelopes = page.records.length ? page.records.map(record => ({ ...envelope, [key]: record })) : [envelope];
      for (const value of envelopes) {
        // Keep provider flags under read, so inferred evidence cannot overwrite a negative.
        const failure = checked({ succeeded: true, ...(spec.id === 'contacts.upsert' ? { new: true } : {}), ...value,
          readEnvelope: structuredClone(envelope) }, held, row.locationId);
        if (failure) return failure;
      }
    }
    if (!matches.length) return conflict('negative_confirmation');
    if (matches.length !== 1 || state.beforeIds.includes(String(matches[0].record.id))) return conflict();
    return { held, value: { ...(spec.id === 'contacts.upsert' ? { new: true } : {}), [key]: matches[0].record } };
  }
  const observations: unknown[] = [];
  let finalHeld: HeldRequest | undefined;
  let failure: ApprovalOutcome | undefined;
  for (const [i, target] of state.targets.entries()) {
    let raw: unknown;
    try { raw = await readReconciliation(pre, target.operation, { path: target.path }); }
    catch (error) {
      if (error instanceof UnconfirmedReconciliation) { failure = conflict(); continue; }
      if (deletion(spec.id) && error instanceof HighLevelError && error.status === 404) {
        const held = witness(spec, row, state, {});
        return { held, value: { succeeded: true } };
      }
      throw error;
    }
    if (failure) continue;
    if (retained && !kind) { failure = checked(raw, retained, row.locationId); if (failure) continue; }
    if (!object(raw) || !object(raw[key])) { failure = conflict(); continue; }
    if (deletion(spec.id)) {
      const held = witness(spec, row, state, {}), failure = checked(raw, held, row.locationId);
      return failure ?? conflict('negative_confirmation');
    }
    const body = selected(raw[key], kind ? [kind] : state.fields);
    if (!body || hash(effect(body)) !== state.effects[i]) { failure = conflict(); continue; }
    const held = witness(spec, row, state, body, kind);
    const value = spec.id === 'contacts.tags.bulk' ? { succeeded: true, errorCount: 0,
      contacts: state.targets.map(t => decodeURIComponent(t.path.split('/')[2])), observed: raw }
      : kind ? { ...raw, [kind]: [...body[kind] as string[]] } : raw;
    failure = checked(value, held, row.locationId);
    if (failure) continue;
    finalHeld = held; observations.push(value);
  }
  if (failure) return failure;
  if (!finalHeld) return conflict();
  return { held: finalHeld, value: spec.id === 'contacts.tags.bulk' ? { succeeded: true, errorCount: 0,
    contacts: state.targets.map(t => decodeURIComponent(t.path.split('/')[2])), observations } : observations[0] };
}
