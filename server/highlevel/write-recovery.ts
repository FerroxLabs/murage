import { operationExtension, frozenOperationExtension, type OperationExtension } from './operation-extension.ts';
import { calendarContextFor, retainCalendarDraft, type CalendarContext } from "./calendar-context.ts";
import { heldOperationHooks } from './operation-hooks.ts';
import { isReturnedIdentityKey } from './operations/returned-identity-schemas.ts';
import { completeReconciliationCollection, recoveryConfirmationSafe } from './reconciliation-read.ts';
import { readReconciliation, readReconciliationPage } from './reconciliation-read.ts';
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { heldRequestBody } from './held-body.ts';
import { join } from 'node:path';
import type { OperationId } from '../../shared/highlevel.ts';
import type { ActionIntent } from './actions.ts';
import { FileApprovalJournal, type ApprovalJournal, type ApprovalOutcome } from './approval-idempotency.ts';
import { canonicalBindingJson } from './binding-json.ts';
import { HeldRequest, type FrozenRequest } from './held-request.ts';
import { HIGHLEVEL_OPERATION_MANIFEST, type OperationSpec, type PreflightRequester, type ReadDraft } from './operations/registry.ts';
import { reconciliationReadsFor } from './operations/reconciliation.ts';
import { prepareReturnedIdentitySchema, bindReturnedIdentities } from './returned-identities.ts';
import { tagPostStateFor, retainTagPostState, validTagSet } from './returned-confirmation-state.ts';
import { highlevelIdSchema } from './operations/schemas/common.ts';

type Shape = null | Shape[] | { [key: string]: Shape };
type Target = { operation: OperationId; path: string; query?: Record<string, string> };
export interface WriteRecoveryPlan {
  version: 1;
  approvedIdentities?: Record<string, readonly string[]>;
  calendarContext?: CalendarContext;
  /** A send or upload cannot be proven by a later list or matching message body. */
  conservative?: true;
  frozen: FrozenRequest;
  locationId: string;
  readTargets: Target[];
  selector: Shape;
  effectDigest: string;
  wireLocation: boolean;
  upsertControls: boolean;
  tags: boolean;
  collection: string | null;
  recordId: string | null;
  create: boolean;
  beforeIds: string[] | null;
  // Invoice list dates are coarse provider filters. Confirmation additionally
  // requires the exact createdAt window and every approved effect field.
  invoiceLookup?: { createdAfter: number; createdBefore: number; contactId: string };
  /** Journal time bounds a create witness; legacy plans have no such proof. */
  createdAfter?: number;
  lookupIdentity?: { field: string; digest: string };
  lookupFilters?: Record<string, string>;
  incompletePreState?: boolean;
  lookupUnavailable?: boolean;
}
interface Association { plan: WriteRecoveryPlan; actionId: string; approvalId: string; authorityDigest: string; rpcDigest: string }
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const hash = (v: unknown) => createHash('sha256').update(canonicalBindingJson(v)).digest('hex');
const refuse = (): never => { throw new Error('The approved change has no usable recovery plan. Nothing was sent.'); };

export const RECOVERY_PAGE_LIMIT = 50;
export const RECOVERY_PAGE_CAP = 3;
export const RECOVERY_WINDOW_MS = 15 * 60_000;
type RecoveryRecord = Record<string, any>;
export type RecoveryLookupScope =
  | { kind: 'reference'; field: string; value: string }
  | { kind: 'window'; after: number; before: number };
export interface BoundedRecoveryLookup {
  scope: RecoveryLookupScope;
  collection: string;
  /** Only qualified, operation-specific drafts belong here. Pagination is by
   * fixed page number; a provider-supplied URL is never followed. */
  read(page: number, limit: number, scope: RecoveryLookupScope): Promise<unknown>;
  /** All approved exact identity fields, not a fuzzy search result. Undefined
   * means missing evidence and must not be interpreted as a non-match. */
  exactIdentity(record: RecoveryRecord): boolean | undefined;
  createdAt?(record: RecoveryRecord): unknown;
  unpaginated?: boolean;
  /** A provider primary key is unique even in a partial list. Absence still
   * requires exhausting the bounded result. Never enable for fuzzy identities. */
  uniquePrimaryId?: boolean;
}
export type BoundedRecoveryResult =
  | { status: 'outcome_unknown' }
  | { status: 'matched'; record: RecoveryRecord; envelopes: RecoveryRecord[] }
  | { status: 'absent'; envelopes: RecoveryRecord[] };
const unknownLookup = (): BoundedRecoveryResult => ({ status: 'outcome_unknown' });
function time(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value
    : typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN;
}
/** Shared read-only create recovery. A reference/idempotency lookup is preferred;
 * otherwise require a new record in a short journal-time window. Neither an
 * incomplete lookup nor a matching first page can authorize a resend or receipt. */
export async function boundedRecoveryLookup(input: BoundedRecoveryLookup): Promise<BoundedRecoveryResult> {
  const { scope, read } = input;
  if (scope.kind === 'window' ? !Number.isFinite(scope.after) || !Number.isFinite(scope.before)
    || scope.before < scope.after || scope.before - scope.after > RECOVERY_WINDOW_MS
    : !scope.field || !scope.value) return unknownLookup();
  const seen = new Set<string>(), matches: RecoveryRecord[] = [], envelopes: RecoveryRecord[] = [];
  let total: number | undefined;
  try {
    for (let page = 1; page <= RECOVERY_PAGE_CAP; page++) {
      const raw = await read(page, RECOVERY_PAGE_LIMIT, scope);
      if (!recoveryConfirmationSafe(raw) || !object(raw) || !Array.isArray(raw[input.collection]) || (raw.meta !== undefined && !object(raw.meta))) return unknownLookup();
      const records = raw[input.collection] as unknown[];
      if (records.length > RECOVERY_PAGE_LIMIT || !records.every(object)) return unknownLookup();
      const metadata = [raw, ...(object(raw.meta) ? [raw.meta] : [])];
      const totals = metadata.filter(m => Object.hasOwn(m, 'total')).map(m => m.total);
      if (totals.some(n => !Number.isSafeInteger(n) || n < 0 || n !== totals[0])
        || (total !== undefined && totals.some(n => n !== total))) return unknownLookup();
      if (totals.length) total = totals[0];
      const next = metadata.some(m => m.nextPage || m.nextPageUrl || m.nextCursor || m.next || m.hasMore);
      envelopes.push(raw);
      for (const record of records as RecoveryRecord[]) {
        if (!highlevelIdSchema.safeParse(record.id).success || seen.has(record.id)) return unknownLookup();
        seen.add(record.id);
        if (scope.kind === 'reference' && record[scope.field] !== scope.value) {
          if (input.uniquePrimaryId && scope.field === 'id') continue;
          return unknownLookup();
        }
        const exact = input.exactIdentity(record);
        if (exact === undefined) return unknownLookup();
        if (!exact) continue;
        if (scope.kind === 'window') {
          const created = time(input.createdAt?.(record));
          if (!Number.isFinite(created)) return unknownLookup();
          if (created <= scope.after || created > scope.before) return unknownLookup();
        }
        matches.push(record);
        if (matches.length > 1) return unknownLookup();
      }
      if (total !== undefined && (total < seen.size || (next && total === seen.size))) return unknownLookup();
      if (input.uniquePrimaryId && scope.kind === 'reference' && scope.field === 'id' && matches.length === 1)
        return { status: 'matched', record: matches[0]!, envelopes };
      const complete = !next && (total === seen.size || (input.unpaginated === true && total === undefined));
      if (complete) return matches.length ? { status: 'matched', record: matches[0]!, envelopes } : { status: 'absent', envelopes };
      if (!records.length || input.unpaginated || total === undefined) return unknownLookup();
    }
  } catch { /* Transport/schema/authority uncertainty never becomes absence. */ }
  return unknownLookup();
}

// The response itself cannot claim that a bounded lookup completed. Only this
// module's read path can attach that proof to the exact returned object.
const boundedEvidence = new WeakMap<object, { plan: WriteRecoveryPlan; result: BoundedRecoveryResult }>();
function shape(value: unknown): Shape {
  if (Array.isArray(value)) return value.map(shape);
  return object(value) ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shape(child)])) : null;
}
function select(value: unknown, selector: Shape): unknown {
  if (selector === null) { if (value === undefined) throw new Error('Missing approved field'); return value; }
  if (Array.isArray(selector)) {
    if (!Array.isArray(value) || value.length !== selector.length) throw new Error('Incomplete approved collection');
    return selector.map((s, i) => select(value[i], s));
  }
  if (!object(value)) throw new Error('Missing approved object');
  return Object.fromEntries(Object.entries(selector).map(([key, s]) => [key, select(value[key], s)]));
}
function collectionFor(operation: string): string | null {
  return ({ 'opportunities.pipelines.list': 'pipelines', 'opportunities.search': 'opportunities',
    'payments.invoices.list': 'invoices', 'calendars.list': 'calendars', 'calendars.events.list': 'events', 'calendars.blockSlots.list': 'events', 'calendars.appointmentNotes.list': 'notes',
    'contacts.search': 'contacts', 'contacts.notes.list': 'notes', 'contacts.tasks.list': 'tasks', 'location.customFields.list': 'customFields', 'location.customValues.list': 'customValues', 'location.tags.list': 'tags', 'users.list': 'users' } as Record<string, string>)[operation] ?? null;
}
/** Values stay in the held request. Persist only selectors, effect hashes and the
 * concrete authorized targets; no response or replay argument creates a target. */
export function prepareWriteRecovery(held: HeldRequest, locationId: string): WriteRecoveryPlan {
  prepareReturnedIdentitySchema(held, locationId); // verifies the exact held bytes
  const frozen = held.frozen;
  const targets = heldOperationHooks.get(frozen);
  const observations = targets?.risk !== 'R' ? targets?.recoveryTargets?.(held) : undefined;
  if (observations) {
    if (!observations.length || observations.some(t => !reconciliationReadsFor(frozen.operation).includes(t.operation))) return refuse();
    return { version: 1, conservative: true, frozen, locationId, readTargets: observations.map(t => ({ ...t })), selector: {}, effectDigest: frozen.bodySha256,
      wireLocation: false, upsertControls: false, tags: false, collection: null, recordId: null, create: false, beforeIds: null };
  }
  const body = heldRequestBody(frozen, held.sendCopy()) as Record<string, any>;
  const extension = frozenOperationExtension(frozen);
  const row = extension?.row ?? HIGHLEVEL_OPERATION_MANIFEST.find(r => r.id === frozen.operation)!;
  const ids: Record<string, string> = { locationId };
  row.path!.split('/').forEach((part, index) => {
    const key = part.startsWith(':') ? part.slice(1) : part.match(/^\{(.+)\}$/)?.[1];
    if (key) ids[key] = decodeURIComponent(frozen.path.split('/')[index]!);
  });
  if (typeof body.id === 'string') ids[row.family === 'opportunities' ? 'opportunityId' : 'contactId'] = body.id;
  if (frozen.bodyKind === 'multipart' && frozen.operation === 'conversations.attachment.upload') ids.conversationId = body.conversationId;
  const calendarContext = calendarContextFor(frozen);
  const reads = extension?.reconciliation ?? reconciliationReadsFor(frozen.operation);
  const candidates = reads.flatMap(operation => {
    const read = extension?.readRow(operation) ?? HIGHLEVEL_OPERATION_MANIFEST.find(r => r.id === operation)!;
    let usable = true;
    const path = read.path!.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_, key) => {
      const id = ids[key]; if (!highlevelIdSchema.safeParse(id).success) { usable = false; return ''; }
      return encodeURIComponent(id);
    });
    return usable ? [{ operation, path }] : [];
  });
  const target = calendarContext?.recoveryOperation ? candidates.find(t => t.operation === calendarContext.recoveryOperation) : candidates.find(t => t.operation.endsWith('.get')) ?? candidates[0];
  if (!target) return refuse();
  const collection = collectionFor(target.operation);
  const create = collection !== null && /\.(?:create|upsert|book|text2pay)$/.test(frozen.operation);
  const recordId = ids.invoiceId ?? ids.pipelineId ?? ids.opportunityId ?? ids.noteId ?? ids.taskId ?? ids.eventId ?? ids.calendarId ?? ids.contactId ?? ids.fieldId ?? ids.valueId ?? ids.tagId ?? ids.userId ?? null;
  if (!collection && !target.operation.endsWith('.get') && frozen.bodyKind !== 'multipart') return refuse();
  const tags = tagPostStateFor(frozen);
  const effect: Record<string, any> = { ...body, ...(frozen.bodyKind === 'multipart' ? { upload: frozen.upload } : {}) };
  const wireLocation = Object.hasOwn(effect, 'locationId'); delete effect.locationId;
  const upsertControls = frozen.operation === 'opportunities.upsert';
  if (upsertControls) {
    // Other follower deltas require a separately retained expected set.
    if (body.followersActionType !== 'add' || body.isRemoveAllFollowers !== false || body.followers?.length) return refuse();
    delete effect.followersActionType; delete effect.isRemoveAllFollowers;
  }
  if (tags) effect.tags = [...tags].sort();
  if (row.family === "calendars") { delete effect.ignoreDateRange; delete effect.ignoreFreeSlotValidation; }
  // The provider calendar listing has no qualified per-operation bound. Missing
  // selectors must never turn a crash into a whole-location collection scan.
  const lookupUnavailable = row.family === 'calendars' && !!collection &&
    (target.operation === 'calendars.list' || !calendarContext?.recoveryQuery);
  let invoiceLookup: WriteRecoveryPlan['invoiceLookup'];
  if (create && collection === 'invoices') {
    if (!highlevelIdSchema.safeParse(body.contactDetails?.id).success) return refuse();
    const createdAfter = Date.now();
    invoiceLookup = { createdAfter, createdBefore: createdAfter + 30 * 60_000, contactId: body.contactDetails.id };
  }
  // Uploads are never reconstructed for sending; retain their binding digest,
  // keeping the reviewed filename out of the durable recovery index.
  const retained = frozen.bodyKind === 'multipart' ? { ...frozen, upload: null } : frozen;
  const identityField = collection === 'contacts' ? ['email', 'phone', 'name', 'firstName', 'lastName']
    .find(field => typeof body[field] === 'string' && body[field].trim()) : undefined;
  return { version: 1, ...(lookupUnavailable ? { lookupUnavailable: true } : {}), ...(calendarContext ? { calendarContext } : {}), ...(invoiceLookup ? { invoiceLookup } : {}), approvedIdentities: held.approvalContextCopy()?.identities ?? {}, frozen: retained, locationId, readTargets: lookupUnavailable ? [] : [target], selector: shape(effect), effectDigest: hash(effect),
    wireLocation, upsertControls, tags: !!tags, collection, recordId, create, beforeIds: null,
    ...(create ? { createdAfter: Date.now() } : {}),
    ...(identityField ? { lookupIdentity: { field: identityField, digest: hash(body[identityField]) } } : {}),
    ...(target.operation === 'opportunities.search' ? { lookupFilters: Object.fromEntries(['pipelineId', 'contactId']
      .filter(field => typeof body[field] === 'string').map(field => [field, hash(body[field])])) } : {}) };
}
export function recoveryReadDraft(plan: WriteRecoveryPlan, target: Target): ReadDraft {
  if (plan.calendarContext?.recoveryQuery) return { path: target.path, query: { ...plan.calendarContext.recoveryQuery } };
  if (plan.create && plan.collection === 'invoices') {
    const lookup = plan.invoiceLookup;
    if (!lookup) return refuse(); // Legacy collection snapshots cannot authorize a scan.
    return { path: target.path, query: { altId: plan.locationId, altType: 'location',
      contactId: lookup.contactId, startAt: new Date(lookup.createdAfter).toISOString().slice(0, 10),
      endAt: new Date(lookup.createdBefore).toISOString().slice(0, 10), limit: '100', offset: '0' } };
  }
  if (target.operation.startsWith('payments.invoices.')) return { path: target.path, query: { altId: plan.locationId, altType: 'location', ...(plan.collection ? { limit: '100', offset: '0' } : {}) } };
  if (target.operation === 'media.files.list') return { path: target.path, query: { altId: plan.locationId, altType: 'location', sortBy: 'createdAt', sortOrder: 'desc', type: 'file', limit: '50' } };
  if (target.operation === 'conversations.messages.list') return { path: target.path, query: { limit: '50' } };
  if (target.operation === 'contacts.search') return { path: target.path, body: { locationId: plan.locationId, page: 1, pageLimit: 50 } };
  if (target.operation === 'opportunities.search') return { path: target.path, query: { location_id: plan.locationId, page: '1', limit: '50' } };
  return { path: target.path, ...(target.query ? { query: target.query } : {}), ...(['pipelines', 'users'].includes(plan.collection ?? '') ? { query: { locationId: plan.locationId } } : {}) };
}
function recordIdentity(plan: WriteRecoveryPlan, record: Record<string, any>): unknown {
  if (plan.collection !== 'invoices') return record.id;
  if (record.id !== undefined && record._id !== undefined && record.id !== record._id) return undefined;
  return record._id ?? record.id;
}
function collectionItems(plan: WriteRecoveryPlan, value: unknown): Record<string, any>[] | undefined {
  if (!object(value) || !plan.collection || !Array.isArray(value[plan.collection]) || !value[plan.collection].every(object)) return;
  const items = value[plan.collection] as Record<string, any>[];
  if (plan.frozen.operation.startsWith('calendars.') && items.length > 100) return;
  if (plan.invoiceLookup && items.length > 100) return;
  if (!completeReconciliationCollection(value, items.length, plan.readTargets[0]!.operation.endsWith('.search') || plan.collection === 'invoices')) return;
  if (value.nextPage || value.nextPageUrl || value.nextCursor || value.hasMore || value.meta?.nextPage || value.meta?.nextPageUrl || value.meta?.nextCursor || value.meta?.hasMore) return;
  // Pipeline and contact child lists are unpaginated. Searches need an explicit total.
  if (plan.readTargets[0]!.operation.endsWith('.search') && (value.total ?? value.meta?.total) !== items.length) return;
  if (typeof value.total === 'number' && value.total !== items.length) return;
  if (!items.every(item => highlevelIdSchema.safeParse(recordIdentity(plan, item)).success) || new Set(items.map(item => recordIdentity(plan, item))).size !== items.length) return;
  return items;
}
function completeEnvelope(plan: WriteRecoveryPlan, value: unknown): boolean {
  if (!object(value)) return false;
  const allowed = [plan.collection, 'total', 'count', 'locationId', 'altId', 'altType', 'meta', ...(plan.frozen.operation.startsWith('calendars.') ? ['hasMore'] : [])];
  if (value.hasMore !== undefined && value.hasMore !== false) return false;
  if (Object.keys(value).some(key => !allowed.includes(key)) || (Object.hasOwn(value, 'locationId') && value.locationId !== plan.locationId) || (Object.hasOwn(value, 'altId') && value.altId !== plan.locationId) || (Object.hasOwn(value, 'altType') && value.altType !== 'location')) return false;
  return value.meta === undefined || (object(value.meta) && Object.keys(value.meta).every(key => ['total', 'count', 'page', 'limit'].includes(key))
    && Object.values(value.meta).every(v => typeof v === 'number' && Number.isFinite(v)));
}
export async function captureRecoveryPreState(plan: WriteRecoveryPlan, pre: PreflightRequester, initialInventory?: unknown): Promise<void> {
  // Preserve bounded/no-snapshot recovery for the existing contact, opportunity
  // and invoice paths. The reviewed F6/user adapters retain their own inventory.
  if (!plan.create || !(plan.frozen.operation.startsWith('calendars.') || ['users', 'customFields', 'customValues', 'tags'].includes(plan.collection ?? ''))) return;
  if (plan.lookupUnavailable) { plan.beforeIds = []; plan.incompletePreState = true; return; }
  const target = plan.readTargets[0]!;
  const value = initialInventory ?? await readReconciliation(pre, target.operation, recoveryReadDraft(plan, target));
  const items = collectionItems(plan, value);
  if (plan.frozen.operation.startsWith('calendars.') && (!items || !completeEnvelope(plan, value)
    || (target.operation === 'calendars.appointmentNotes.list' && plan.calendarContext?.recoveryQuery?.offset !== '0'))) {
    // Qualified but incomplete observations must not prevent a normal write.
    // They can never prove a new ID after a crash; recovery stays unknown.
    const members = object(value) && plan.collection ? value[plan.collection] : undefined;
    if (!Array.isArray(members) || !members.every(item => object(item) && highlevelIdSchema.safeParse(item.id).success)) return refuse();
    plan.beforeIds = []; plan.incompletePreState = true; return;
  }
  if (!items || !completeEnvelope(plan, value)) return refuse();
  plan.beforeIds = items.map(item => hash(item.id));
}
function storage(journal: ApprovalJournal): ApprovalJournal {
  if (journal.key.startsWith('/')) return new FileApprovalJournal(join(journal.key, 'recovery'));
  // Non-filesystem adapters keep the same durability guarantees as their own
  // approval journal; a process-local map must never stand in for persistence.
  const key = (id: string) => `highlevel-recovery:${id}`;
  return { key: `${journal.key}:recovery`, get: id => journal.get(key(id)),
    claim: (id, digest) => journal.claim(key(id), digest),
    settle: (id, digest, outcome) => journal.settle(key(id), digest, outcome) };
}
export function saveWriteRecovery(journal: ApprovalJournal, row: ActionIntent, plan: WriteRecoveryPlan): void {
  if (!row.approvalId || !row.requestDigest || plan.frozen.requestDigest !== row.requestDigest) return refuse();
  if (plan.create) plan.createdAfter = row.createdAt;
  if (plan.invoiceLookup) {
    // Bind the window to the durable action journal, before any dispatch.
    plan.invoiceLookup.createdAfter = row.createdAt;
    plan.invoiceLookup.createdBefore = row.expiresAt + 60_000;
  }
  const association: Association = { plan, actionId: row.actionId, approvalId: row.approvalId, authorityDigest: row.reviewDigest, rpcDigest: row.argumentsDigest };
  const store = storage(journal);
  if (!store.claim(row.actionId, row.requestDigest)) {
    const existing = loadWriteRecovery(journal, row);
    if (!existing || hash(existing) !== hash(plan)) return refuse();
    return;
  }
  store.settle(row.actionId, row.requestDigest, { status: 'applied', result: association });
}
export function loadWriteRecovery(journal: ApprovalJournal, row: ActionIntent): WriteRecoveryPlan | undefined {
  return loadRecoveryEntry(journal, row);
}
/** Opt-in recovery verifies persisted targets against the caller's new contract. */
export function loadWriteRecoveryForSpec(journal: ApprovalJournal, row: ActionIntent, spec: OperationSpec): WriteRecoveryPlan | undefined {
  return loadRecoveryEntry(journal, row, operationExtension(spec.row));
}
function loadRecoveryEntry(journal: ApprovalJournal, row: ActionIntent, extension?: OperationExtension): WriteRecoveryPlan | undefined {
  const entry = storage(journal).get(row.actionId);
  const saved = (entry?.state === 'applied' && entry.requestDigest === row.requestDigest ? entry.result : undefined) as Association | undefined;
  if (!saved) return;
  const p = saved.plan;
  if (saved.actionId !== row.actionId || saved.approvalId !== row.approvalId || saved.authorityDigest !== row.reviewDigest
    || saved.rpcDigest !== row.argumentsDigest || p.version !== 1 || p.frozen.requestDigest !== row.requestDigest
    || p.frozen.operation !== row.operation || p.locationId !== row.locationId
    || (!p.readTargets.length && !(p.lookupUnavailable && p.frozen.operation.startsWith('calendars.')))) return refuse();
  if (p.create && p.createdAfter !== undefined && p.createdAfter !== row.createdAt) return refuse();
  const declared = extension?.reconciliation ?? reconciliationReadsFor(row.operation);
  for (const target of p.readTargets) {
    const read = extension?.readRow(target.operation) ?? HIGHLEVEL_OPERATION_MANIFEST.find(r => r.id === target.operation);
    const actual = target.path.split('/');
    if (!declared.includes(target.operation) || !read?.path || actual.length !== read.path.split('/').length
      || read.path.split('/').some((part, i) => part.startsWith(':') ? !highlevelIdSchema.safeParse(actual[i]).success : part !== actual[i])) return refuse();
  }
  return structuredClone(p);
}
function witness(plan: WriteRecoveryPlan, value: Record<string, any>): Record<string, any> {
  // HighLevel returns invoiceItems for the items submitted at creation.
  if (plan.collection === 'invoices' && object(plan.selector) && Object.hasOwn(plan.selector, 'items') && !Object.hasOwn(value, 'items')) value = { ...value, items: value.invoiceItems };
  const selected = select(value, plan.selector) as Record<string, any>;
  if (plan.tags) { if (!validTagSet(selected.tags)) throw new Error('Invalid tag set'); selected.tags = [...selected.tags].sort(); }
  return selected;
}
/** C2 adapter over the shared bounded helper. Replay input supplies only a
 * digest-checked search value; it cannot change an approved target or effect. */
export async function readWriteRecovery(plan: WriteRecoveryPlan, pre: PreflightRequester, args: Record<string, unknown>): Promise<unknown> {
  if (plan.lookupUnavailable || !plan.readTargets.length) return {};
  const target = plan.readTargets[0]!;
  if (plan.frozen.operation.startsWith('calendars.') && plan.collection) {
    if (!plan.calendarContext?.recoveryQuery) return {};
    return readReconciliation(pre, target.operation, recoveryReadDraft(plan, target));
  }
  if (!plan.collection || ['invoices', 'users', 'customFields', 'customValues', 'tags'].includes(plan.collection)) return readReconciliation(pre, target.operation, recoveryReadDraft(plan, target));
  // Only these adapters have qualified provider-side bounds. Pipeline and
  // contact note/task lists have no supported window/reference/page controls;
  // checking their size after reading would already enumerate the collection.
  if (target.operation !== 'contacts.search' && target.operation !== 'opportunities.search') return {};
  if (plan.create ? !Number.isFinite(plan.createdAfter) : !highlevelIdSchema.safeParse(plan.recordId).success) return {};
  let identity: { field: string; value: string } | undefined;
  if (target.operation === 'contacts.search') {
    const retained = plan.lookupIdentity;
    const value = retained && args[retained.field];
    if (!retained || typeof value !== 'string' || hash(value) !== retained.digest) return {};
    identity = { field: retained.field, value };
    if (!['email', 'phone'].includes(identity.field) && identity.value.length > 75) return {};
  }
  const after = plan.createdAfter!;
  if (plan.create && Date.now() > after + RECOVERY_WINDOW_MS) return {};
  const opportunityFilters: Record<string, string> = {};
  if (target.operation === 'opportunities.search') {
    for (const [field, digest] of Object.entries(plan.lookupFilters ?? {})) {
      const value = args[field];
      if (typeof value !== 'string' || hash(value) !== digest) return {};
      opportunityFilters[field === 'pipelineId' ? 'pipeline_id' : 'contact_id'] = value;
    }
    if (!Object.keys(opportunityFilters).length) return {};
  }
  const result = await boundedRecoveryLookup({
    collection: plan.collection,
    scope: plan.create ? { kind: 'window', after, before: after + RECOVERY_WINDOW_MS }
      : { kind: 'reference', field: 'id', value: plan.recordId! },
    uniquePrimaryId: !plan.create,
    read: (page, limit) => {
      const draft = recoveryReadDraft(plan, target);
      if (target.operation === 'contacts.search') draft.body = { locationId: plan.locationId, page, pageLimit: limit,
        ...(['email', 'phone'].includes(identity!.field)
          ? { filters: [{ field: identity!.field, operator: 'eq', value: identity!.value }] }
          : { query: identity!.value }) };
      if (target.operation === 'opportunities.search') draft.query = { ...draft.query, page: String(page), limit: String(limit), ...opportunityFilters };
      return readReconciliationPage(pre, target.operation, draft);
    },
    exactIdentity: record => { try { return hash(witness(plan, record)) === plan.effectDigest; } catch { return undefined; } },
    createdAt: record => record.dateAdded ?? record.createdAt ?? record.createdAtTimestamp,
  });
  const response = { [plan.collection]: result.status === 'matched' ? [result.record] : [],
    ...(result.status !== 'outcome_unknown' ? { recoveryPages: result.envelopes.map(raw => {
      const { [plan.collection!]: _records, ...envelope } = raw; return envelope;
    }) } : {}) };
  boundedEvidence.set(response, { plan, result });
  return response;
}
// Keep provider fields intact, even when they use our former synthetic key.
// The fresh sibling holds only the envelope; no original field is replaced.
function withReadEnvelope(record: Record<string, any>, envelope: Record<string, unknown>): Record<string, unknown> {
  let key = 'recoveryEnvelope';
  while (Object.hasOwn(record, key)) key = `_${key}`;
  return { ...record, [key]: envelope };
}
export type RecoveryWitness = { outcome: ApprovalOutcome } | { held: HeldRequest; value: unknown };
/** Reconstruct a confirmation-only request from a digest-verified effect. This
 * object is never dispatched and never obtains authority from replay arguments. */
export function compareWriteRecovery(plan: WriteRecoveryPlan, response: unknown, spec: OperationSpec, absent = false): RecoveryWitness {
  if (plan.frozen.operation.startsWith('calendars.')) return compareCalendarRecovery(plan, response, spec, absent);
  const conflict = (reason: 'unconfirmed' | 'negative_confirmation' | 'identity_conflict' = 'unconfirmed'): RecoveryWitness => ({ outcome: { status: 'conflict', reason } });
  // List metadata cannot attest the reviewed file bytes. The declared read is
  // still performed, but an interrupted upload stays unknown rather than being
  // inferred from a matching filename or resent from the changed workspace.
  if (plan.frozen.bodyKind === 'multipart') return conflict();
  const deleting = plan.frozen.operation.endsWith('.delete');
  if (!recoveryConfirmationSafe(response)) return conflict();
  if (absent && !deleting) return conflict();
  // A removed follower delta is not the remaining follower set. Without a
  // retained post-set, observing that delta must never confirm removal.
  if (plan.frozen.operation.endsWith('.followers.remove')) return conflict();
  let value = response;
  let record: Record<string, any> | undefined;
  if (plan.collection) {
    if (['invoices', 'users', 'customFields', 'customValues', 'tags'].includes(plan.collection)) {
    const items = collectionItems(plan, response);
    if (!items) return conflict();
    if (plan.create) {
      if (!plan.beforeIds && !plan.invoiceLookup) return conflict();
      const matches = items.filter(item => { try {
        if (plan.invoiceLookup) {
          const created = typeof item.createdAt === 'string' ? Date.parse(item.createdAt) : NaN;
          if (!Number.isFinite(created) || created <= plan.invoiceLookup.createdAfter || created > plan.invoiceLookup.createdBefore
            || item.contactDetails?.id !== plan.invoiceLookup.contactId) return false;
        }
        return hash(witness(plan, item)) === plan.effectDigest;
      } catch { return false; } });
      if (!matches.length) {
        // A bounded invoice lookup can never prove absence or authorize resend.
        if (plan.invoiceLookup) return conflict();
        if (!completeEnvelope(plan, response)) return conflict();
        // Missing approved fields make an absence claim inconclusive.
        if (items.some(item => { try { witness(plan, item); return false; } catch { return true; } })) return conflict();
        // A nonmatching member still needs whole-response validation. Without
        // retained approved identity fields, it cannot supply new authority.
        const hasIdentity = (v: unknown): boolean => Array.isArray(v) ? v.some(hasIdentity)
          : object(v) && Object.entries(v).some(([key, child]) => isReturnedIdentityKey(key) || hasIdentity(child));
        const { [plan.collection]: _members, ...envelope } = response as Record<string, unknown>;
        for (const item of items) {
          try {
            const effect = witness(plan, item);
            if (hasIdentity(effect)) return conflict();
            const held = HeldRequest.freeze(spec, { approvalContext: { values: {}, identities: plan.approvedIdentities ?? {} }, path: plan.frozen.path, resource: plan.frozen.resource,
              query: Object.fromEntries(plan.frozen.query), body: { kind: 'json', value: {
                ...effect, ...(plan.wireLocation ? { locationId: plan.locationId } : {}) } } }, { locationId: plan.locationId, companyId: typeof effect.companyId === 'string' ? effect.companyId : undefined });
            const singular = plan.collection === 'pipelines' ? 'pipeline' : plan.collection.slice(0, -1);
            const checked = bindReturnedIdentities({ [singular]: item, readEnvelope: envelope }, held.frozen, prepareReturnedIdentitySchema(held, plan.locationId));
            if (checked.status !== 'applied') return conflict();
          } catch { return conflict(); }
        }
        return conflict(plan.frozen.operation === 'users.create' ? 'unconfirmed' : 'negative_confirmation');
      }
      if (matches.length !== 1 || plan.beforeIds?.includes(hash(recordIdentity(plan, matches[0]!)))) return conflict();
      record = matches[0];
    } else record = items.find(item => recordIdentity(plan, item) === plan.recordId);
    if (!record && deleting && completeEnvelope(plan, response)) { absent = true; record = { success: true }; }
    } else {
    const proof = object(response) ? boundedEvidence.get(response) : undefined;
    if (!proof || proof.plan !== plan) return conflict();
    const evidence = proof.result;
    if (evidence.status === 'outcome_unknown') return conflict();
    if (evidence.status === 'absent') {
      // Unknown siblings and foreign envelope identities invalidate absence.
      if (!evidence.envelopes.every(raw => completeEnvelope(plan, raw))) return conflict();
      if (!deleting) return conflict('negative_confirmation');
      absent = true; record = { success: true };
    } else {
      record = evidence.record;
    }
    }
    if (!record) return conflict();
    // Preserve all envelope siblings through the structural binder. Other list
    // records are unrelated observations; the selected effect is the witness.
    const { [plan.collection]: _items, ...envelope } = response as Record<string, unknown>;
    const singular = plan.collection === 'pipelines' ? 'pipeline' : plan.collection.slice(0, -1);
    value = absent && deleting ? { success: true, readEnvelope: envelope } : { [singular]: record, readEnvelope: envelope };
  } else if (object(response)) {
    record = ['contact', 'opportunity', 'note', 'task', 'invoice', 'customField', 'customValue', 'tag', 'user'].map(key => response[key]).find(object) ?? response;
  }
  if (!record) return conflict();
  let effect: Record<string, any>;
  try { effect = witness(plan, record); } catch { return conflict(); }
  if (hash(effect) !== plan.effectDigest) return conflict();
  const body: Record<string, unknown> = { ...effect, ...(plan.wireLocation ? { locationId: plan.locationId } : {}),
    ...(plan.upsertControls ? { followersActionType: 'add', isRemoveAllFollowers: false } : {}) };
  // A tag delta cannot be recovered from the current set. Bind only the durable
  // target with a harmless synthetic non-identity delta, then install the exact
  // post-set whose digest has already matched the approved expectation.
  if (plan.tags) body.tags = ['recovery-confirmation'];
  let held: HeldRequest;
  try {
    held = HeldRequest.freeze(spec, { approvalContext: { values: {}, identities: plan.approvedIdentities ?? {} }, path: plan.frozen.path, resource: plan.frozen.resource, query: Object.fromEntries(plan.frozen.query),
      ...(plan.frozen.bodyKind === 'none' ? {} : { body: { kind: 'json', value: body } as const }) }, { locationId: plan.locationId, companyId: typeof body.companyId === 'string' ? body.companyId : undefined });
    if (!plan.tags && held.frozen.requestDigest !== plan.frozen.requestDigest) return conflict();
    const bound = prepareReturnedIdentitySchema(held, plan.locationId);
    if (plan.tags) {
      retainTagPostState(held.frozen, effect.tags);
      // The contact read wraps tags; preserve that whole response while exposing
      // the digest-verified set in the tag confirmation schema's root slot.
      value = { ...(value as Record<string, unknown>), tags: [...effect.tags] };
    }
    if (plan.collection) {
      const { [plan.collection]: members, ...envelope } = response as Record<string, unknown>;
      const singular = plan.collection === 'pipelines' ? 'pipeline' : plan.collection.slice(0, -1);
      // Every member and every original envelope field reaches the same binder.
      // No provider field is replaced by a synthesized confirmation.
      for (const member of members as unknown[]) {
        const whole = { [singular]: member, readEnvelope: envelope };
        if (bindReturnedIdentities(whole, held.frozen, bound).status !== 'applied') return conflict();
      }
    }
    const result = bindReturnedIdentities(value, held.frozen, bound);
    if (result.status !== 'applied') return conflict();
  } catch { return conflict(); }
  if (deleting && !absent) return conflict('negative_confirmation');
  return { held, value };
}

function compareCalendarRecovery(plan: WriteRecoveryPlan, response: unknown, spec: OperationSpec, absent = false): RecoveryWitness {
  const conflict = (reason: 'unconfirmed' | 'negative_confirmation' | 'identity_conflict' = 'unconfirmed'): RecoveryWitness => ({ outcome: { status: 'conflict', reason } });
  if (plan.conservative) return conflict();
  const deleting = plan.frozen.operation.endsWith('.delete');
  if (!recoveryConfirmationSafe(response)) return conflict();
  if (absent && !deleting) return conflict();
  if (plan.lookupUnavailable || plan.incompletePreState) return conflict();
  // A removed follower delta is not the remaining follower set. Without a
  // retained post-set, observing that delta must never confirm removal.
  if (plan.frozen.operation.endsWith('.followers.remove')) return conflict();
  let value = response;
  let record: Record<string, any> | undefined;
  if (plan.collection) {
    const items = collectionItems(plan, response);
    if (!items) return conflict();
    if (plan.create) {
      if (!plan.beforeIds) return conflict();
      const matches = items.filter(item => { try { return hash(witness(plan, item)) === plan.effectDigest; } catch { return false; } });
      if (!matches.length) {
        if (!completeEnvelope(plan, response)) return conflict();
        // Missing approved fields make an absence claim inconclusive.
        if (items.some(item => { try { witness(plan, item); return false; } catch { return true; } })) return conflict();
        // A nonmatching member still needs whole-response validation. Without
        // retained approved identity fields, it cannot supply new authority.
        const hasIdentity = (v: unknown): boolean => Array.isArray(v) ? v.some(hasIdentity)
          : object(v) && Object.entries(v).some(([key, child]) => isReturnedIdentityKey(key) || hasIdentity(child));
        const { [plan.collection]: _members, ...envelope } = response as Record<string, unknown>;
        for (const item of items) {
          try {
            const effect = witness(plan, item);
            if (hasIdentity(effect)) return conflict();
            const held = HeldRequest.freeze(spec, { path: plan.frozen.path, resource: plan.frozen.resource,
              query: Object.fromEntries(plan.frozen.query), body: { kind: 'json', value: {
                ...effect, ...(plan.wireLocation ? { locationId: plan.locationId } : {}) } } }, { locationId: plan.locationId, companyId: typeof effect.companyId === 'string' ? effect.companyId : undefined });
            const singular = plan.collection === 'pipelines' ? 'pipeline' : plan.collection.slice(0, -1);
            const checked = bindReturnedIdentities({ [singular]: item, readEnvelope: envelope }, held.frozen, prepareReturnedIdentitySchema(held, plan.locationId));
            if (checked.status !== 'applied') return conflict();
          } catch { return conflict(); }
        }
        return conflict(plan.frozen.operation === 'users.create' ? 'unconfirmed' : 'negative_confirmation');
      }
      if (matches.length !== 1 || plan.beforeIds.includes(hash(matches[0]!.id))) return conflict();
      record = matches[0];
    } else record = items.find(item => item.id === plan.recordId);
    if (!record && deleting && (plan.readTargets[0]?.operation === 'calendars.blockSlots.list'
      || (plan.readTargets[0]?.operation === 'calendars.appointmentNotes.list' && plan.calendarContext?.recoveryQuery?.offset !== '0'))) return conflict();
    if (!record && deleting && completeEnvelope(plan, response)) { absent = true; record = { [plan.frozen.operation === 'calendars.event.delete' ? 'succeeded' : 'success']: true }; }
    if (!record) return conflict();
    // Preserve all envelope siblings through the structural binder. Other list
    // records are unrelated observations; the selected effect is the witness.
    const { [plan.collection]: _items, ...envelope } = response as Record<string, unknown>;
    const singular = plan.collection === 'pipelines' ? 'pipeline' : plan.collection.slice(0, -1);
    value = absent && deleting ? { [plan.frozen.operation === 'calendars.event.delete' ? 'succeeded' : 'success']: true, readEnvelope: envelope } : plan.collection === 'events' ? withReadEnvelope(record!, envelope) : { [singular]: record, readEnvelope: envelope };
  } else if (object(response)) {
    record = ['contact', 'opportunity', 'note', 'task', 'calendar', 'event', 'customField', 'customValue', 'tag', 'user'].map(key => response[key]).find(object) ?? response;
    if (plan.frozen.operation.startsWith('calendars.') && object(response.event)) {
      const { event: _event, ...envelope } = response;
      value = withReadEnvelope(record!, envelope);
    }
  }
  if (!record) return conflict();
  let effect: Record<string, any>;
  try { effect = witness(plan, record); } catch { return conflict(); }
  if (hash(effect) !== plan.effectDigest) return conflict();
  const body: Record<string, unknown> = { ...effect, ...(plan.wireLocation ? { locationId: plan.locationId } : {}),
    ...(plan.upsertControls ? { followersActionType: 'add', isRemoveAllFollowers: false } : {}),
    ...(plan.frozen.operation === 'calendars.appointment.book' || plan.frozen.operation === 'calendars.appointment.reschedule' ? { ignoreDateRange: false, ignoreFreeSlotValidation: false } : {}) };
  // A tag delta cannot be recovered from the current set. Bind only the durable
  // target with a harmless synthetic non-identity delta, then install the exact
  // post-set whose digest has already matched the approved expectation.
  if (plan.tags) body.tags = ['recovery-confirmation'];
  let held: HeldRequest;
  try {
    const draft = { approvalContext: { values: {}, identities: plan.approvedIdentities ?? {} }, path: plan.frozen.path, resource: plan.frozen.resource, query: Object.fromEntries(plan.frozen.query),
      ...(plan.frozen.bodyKind === 'none' ? {} : { body: { kind: 'json', value: body } as const }) };
    if (plan.calendarContext) retainCalendarDraft(draft, plan.calendarContext);
    held = HeldRequest.freeze(spec, draft, { locationId: plan.locationId, companyId: typeof body.companyId === 'string' ? body.companyId : undefined });
    if (!plan.tags && held.frozen.requestDigest !== plan.frozen.requestDigest) return conflict();
    const bound = prepareReturnedIdentitySchema(held, plan.locationId);
    if (plan.tags) {
      retainTagPostState(held.frozen, effect.tags);
      // The contact read wraps tags; preserve that whole response while exposing
      // the digest-verified set in the tag confirmation schema's root slot.
      value = { ...(value as Record<string, unknown>), tags: [...effect.tags] };
    }
    if (plan.collection) {
      const { [plan.collection]: members, ...envelope } = response as Record<string, unknown>;
      const singular = plan.collection === 'pipelines' ? 'pipeline' : plan.collection.slice(0, -1);
      // Every member and every original envelope field reaches the same binder.
      // No provider field is replaced by a synthesized confirmation.
      for (const member of members as unknown[]) {
        const whole = plan.collection === 'events' ? withReadEnvelope(member as Record<string, unknown>, envelope) : { [singular]: member, readEnvelope: envelope };
        if (bindReturnedIdentities(whole, held.frozen, bound).status !== 'applied') return conflict();
      }
    }
    const result = bindReturnedIdentities(value, held.frozen, bound);
    if (result.status !== 'applied') return conflict();
  } catch { return conflict(); }
  if (deleting && !absent) return conflict('negative_confirmation');
  return { held, value };
}
