// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { reconciliationReadsFor } from '../highlevel/operations/reconciliation.ts';
import { providerOperation } from '../highlevel/provider-manifest.ts';
import type { OperationSpec, RequestDraft } from '../highlevel/operations/registry.ts';
import { HIGHLEVEL_ENDPOINTS } from '../highlevel/provider-contract.ts';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export function fixtureSpec(input: any, prepare: (a: any, ctx: any) => RequestDraft): OperationSpec<any> {
  if (input.family === 'contacts' && input.risk !== 'R') input = { ...input,
    preflight: [...new Set([...(input.preflight ?? []), ...reconciliationReadsFor(input.id)])] };
  const row = providerOperation(input.id)!;
  const endpoint = HIGHLEVEL_ENDPOINTS[input.id]!;
  const spec: any = { ...input, endpoint, gate: input.risk === 'R' ? 'R' : 'GC', send: input.send ?? input.risk === 'S', precondition: 'none' };
  if (spec.risk === 'S') spec.risk = 'C';
  const template = row.path!;
  const parts = template.split('/');
  const segment = parts.findLastIndex(p => /^(?:\{|:)/.test(p) && p !== '{locationId}' && p !== ':locationId');
  spec.row = { id: input.id, family: input.family, method: endpoint.method, path: template, version: endpoint.version, scope: endpoint.scope, risk: spec.risk, gate: spec.gate,
    send: spec.send, precondition: 'none', disposition: 'ready', docUrl: row.docUrl, pathResourceSegment: segment > 0 ? segment : null, preflight: input.preflight,
    argsSchema: input.args, bodySchema: endpoint.method === 'GET' || endpoint.method === 'DELETE' ? null : z.record(z.string(), z.unknown()), projection: [] };
  const draft = (a: any, ctx: any) => { const out = prepare(a, ctx); return { ...out, resource: segment > 0 ? `${input.family}:record:${decodeURIComponent(out.path.split('/')[segment]!)}` : `location:${ctx.locationId}` }; };
  delete spec.run;
  if (spec.risk === 'R') { spec.maxReads ??= 1; spec.prepareRead = async (a: any, ctx: any) => draft(a, ctx); }
  else spec.prepare = async (_pre: any, a: any, ctx: any) => draft(a, ctx);
  return spec;
}
/** Only for tests with owned static files. Production receives hlc3's anchored reader. */
export function fixtureFileReader(root: string, parts: readonly string[], maxBytes: number) {
  let path = root;
  for (const part of parts) { path = join(path, part); const s = lstatSync(path); if (s.isSymbolicLink()) throw new Error('fixture link'); }
  const stat = lstatSync(path); if (!stat.isFile() || stat.size > maxBytes) throw new Error('fixture must be a regular file');
  const bytes = readFileSync(path); return { bytes, size: bytes.length, volume: String(stat.dev), fileId: String(stat.ino) };
}

export function fixtureReadSpec(id: string): OperationSpec<any> {
  const row = providerOperation(id)!;
  return fixtureSpec({ id, family: row.family, risk: 'R', nested: false, preflight: [], args: z.object({}).strict(), recordRefs: () => [], fields: () => [], targets: () => 1, project: (v: unknown) => v }, () => ({ path: row.path!, resource: '' }));
}

import { HeldRequest, sendFrozen } from '../highlevel/held-request.ts';
import type { HighLevelClient } from '../highlevel/client.ts';
/** A concrete request for action-library fixtures which do not exercise a family. */
export function fixtureHeld(id = 'contacts.update', locationId = 'loc') {
  const row = providerOperation(id)!;
  const path = row.path!.replace(/\{locationId\}|:locationId/g, locationId).replace(/\{[^}]+\}|:[A-Za-z][A-Za-z0-9]*/g, 'record_1');
  const s = fixtureSpec({ id, family: row.family, risk: row.risk, args: z.object({}).strict(), preflight: [] }, () => ({ path, resource: '' }));
  const segment = s.row.pathResourceSegment;
  return HeldRequest.freeze(s, { path, resource: segment === null ? `location:${locationId}` : `${s.family}:record:${path.split('/')[segment]}`,
    ...(s.endpoint.method === 'GET' || s.endpoint.method === 'DELETE' ? {} : { body: { kind: 'json', value: {} } as const }) }, { locationId });
}
/** Existing CRM method tests keep their projections, but writes now exercise the held transport. */
export function freezeFixtureWrites(client: HighLevelClient) {
  const request = client.request.bind(client);
  client.request = async (ctx, id, path, options = {}) => {
    const canonical = ({ 'contacts.notes.add': 'contacts.notes.create', 'contacts.tasks.add': 'contacts.tasks.create' } as Record<string, string>)[id] ?? id;
    if (HIGHLEVEL_ENDPOINTS[canonical]?.retry !== 'write') return request(ctx, canonical, path, options);
    const row = providerOperation(canonical)!;
    const s = fixtureSpec({ id: canonical, family: row.family, risk: row.risk, args: z.object({}).strict(), preflight: [] }, () => ({ path, resource: '' }));
    const segment = s.row.pathResourceSegment;
    const held = HeldRequest.freeze(s, { path, resource: segment === null ? `location:${ctx.connection.locationId}` : `${s.family}:record:${path.split('/')[segment]}`,
      ...(options.body === undefined ? {} : { body: { kind: 'json', value: options.body } as const }) }, { locationId: ctx.connection.locationId });
    return sendFrozen(client, ctx, held, held.frozen.requestDigest);
  };
}

import { highLevelHarness } from './fake-highlevel.ts';
import { HighLevelHost } from '../highlevel/host.ts';
import { HIGHLEVEL_FAMILY_TOOLS, LEGACY_TOOL_TO_OPERATION, type Family } from '../../shared/highlevel.ts';
import { authorizeHighLevelCall } from '../highlevel/access.ts';
import { checkToolArguments, highlevelErrorResult } from '../highlevel/tools.ts';
/** Migration fixture for the original authority/Stop cases. Legacy test spellings select
 * real r4 family calls; grants are explicit v2 fixture grants. No production fallback. */
export function r4HighLevelHarness(options: Parameters<typeof highLevelHarness>[0] = {}) {
  const h = highLevelHarness(options);
  const translatedBot = () => {
    const original: any = h.bot.highlevelAccess;
    if (!original || original.grantsVersion === 2) return h.bot;
    return { ...h.bot, highlevelAccess: { ...original, grantsVersion: 2, grants: original.grants.map((g: any) => {
      const operations: Record<string, string[]> = {}, families: Record<string, string> = {};
      for (const tool of g.tools ?? []) { const op = LEGACY_TOOL_TO_OPERATION[tool]; if (!op) continue; const family = op.split('.')[0]!; (operations[family] ??= []).push(op); families[family] = g.ceiling === 'propose' ? 'full' : 'read'; }
      return { ...g, families, operations };
    }) } };
  };
  let pendingRecoveryRead: string | undefined;
  const specs = new Map<string, OperationSpec<any>>();
  const resolve = (id: string): OperationSpec<any> | undefined => {
    if (specs.has(id)) return specs.get(id);
    const row = providerOperation(id); if (!row || row.status !== 'qualified') return;
    const s: any = fixtureSpec({ id, family: row.family, risk: row.risk, title: id, nested: false,
      preflight: [...(id === 'contacts.create' ? ['location.customFields.list'] : []), ...(row.risk !== 'R' && row.family === 'contacts' ? reconciliationReadsFor(id as any) : [])], args: z.record(z.string(), z.unknown()),
      recordRefs: (a: any) => Object.entries(a).flatMap(([k, v]) => /Id$/.test(k) && typeof v === 'string' ? [`${k}:${v}`] : []),
      fields: (a: any) => Object.keys(a).filter(k => !/Id$/.test(k)), targets: () => 1,
      project: (v: unknown) => v, recordId: (v: any) => v.note?.id ?? v.contact?.id ?? v.task?.id ?? v.opportunity?.id ?? '',
    }, (a, ctx) => {
      const path = row.path!.replace(/\{([^}]+)\}|:([A-Za-z][A-Za-z0-9]*)/g, (_part, brace, colon) => encodeURIComponent(String((brace ?? colon) === 'locationId' ? ctx.locationId : a[brace ?? colon] ?? a.contactId ?? a.opportunityId ?? 'record_1')));
      const body = Object.fromEntries(Object.entries(a).filter(([k]) => !/Id$/.test(k)));
      return { path, resource: '', ...(row.method === 'GET' ? {} : { body: { kind: 'json', value: row.operation === 'contacts.search' || row.operation === 'contacts.create' ? { ...body, locationId: ctx.locationId } : body } }) };
    });
    if (id === 'contacts.create') {
      const prepare = s.prepare;
      s.prepare = async (pre: any, a: any, ctx: any) => { if (a.customFields) await pre.read('location.customFields.list', { path: `/locations/${ctx.locationId}/customFields` }); return prepare(pre, a, ctx); };
    }
    const recoveryRead = id === 'contacts.create' ? 'contacts.search' : undefined;
    if (recoveryRead) {
      const prepare = s.prepare;
      s.prepare = async (...args: any[]) => { const draft = await prepare(...args); pendingRecoveryRead = recoveryRead; return draft; };
    }
    specs.set(id, s); return s;
  };
  // These historical authority/rate tests intentionally use local preflight
  // fixtures. The real contact host suites exercise collection transport and
  // crash recovery; supplying known empty pre-state here keeps the rate boundary
  // under test at the approved write, without bypassing production recovery plans.
  const sendHeld = h.client.sendHeld.bind(h.client);
  h.client.sendHeld = async (ctx, held, approvedDigest) => {
    const plural = held.frozen.operation === 'contacts.search' ? 'contacts'
      : held.frozen.operation === 'contacts.notes.list' ? 'notes' : held.frozen.operation === 'contacts.tasks.list' ? 'tasks' : undefined;
    if (plural && pendingRecoveryRead === held.frozen.operation) { pendingRecoveryRead = undefined; ctx.assertActive(); return { [plural]: [], total: 0 }; }
    return sendHeld(ctx, held, approvedDigest);
  };
  const host = new HighLevelHost({ ...h, bot: translatedBot, operationSpec: resolve, familyOperations: family => [...new Set(Object.values(LEGACY_TOOL_TO_OPERATION))].map(resolve).filter((s): s is OperationSpec<any> => !!s && s.family === family), operationScopes: () => Object.values(HIGHLEVEL_ENDPOINTS).map(e => e.scope), onReview: (_claim, review) => h.reviews.push(review) });
  const call = host.call.bind(host);
  host.call = async (claim, name, input) => {
    const op = typeof name === 'string' ? LEGACY_TOOL_TO_OPERATION[name] : undefined;
    if (!op || !h.capabilities.isActive(claim) || claim.kind !== 'highlevel' || claim.notOwnerAudience) return call(claim, name, input);
    const problem = checkToolArguments(name, input); if (problem) return highlevelErrorResult(problem);
    const args = input as Record<string, unknown>;
    const decision = await authorizeHighLevelCall({ bot: () => h.bot, tool: String(name), connectionId: typeof args.connectionId === 'string' ? args.connectionId : undefined, connection: id => h.leases.connection(id) });
    if (!decision.ok) return highlevelErrorResult(decision.text, { code: decision.code });
    const { connectionId, ...values } = args;
    return call(claim, HIGHLEVEL_FAMILY_TOOLS[op.split('.')[0] as Family], { operation: op, args: values, ...(connectionId === undefined ? {} : { connectionId }) });
  };
  return { ...h, host };
}

import type { ActionContext, ProposeDetail } from '../highlevel/actions.ts';
import type { PreparedUpload } from '../highlevel/uploads.ts';
/** Explicit F0 proposals for historical lifecycle fixtures. */
export function fixtureActionDetail(input: Partial<ProposeDetail> & { operation?: string; prepared?: PreparedUpload }, context: ActionContext & { basis?: ProposeDetail['basis'] }): ProposeDetail {
  let held = input.held;
  if (!held && input.prepared) {
    const s = fixtureSpec({ id: 'media.files.upload', family: 'media', risk: 'C', args: z.object({}).strict(), preflight: [] }, () => ({ path: '/medias/upload-file', resource: '' }));
    held = HeldRequest.freeze(s, { path: '/medias/upload-file', resource: `location:${context.locationId}`, body: { kind: 'multipart', fields: {}, file: { field: 'file', upload: input.prepared } } }, { locationId: context.locationId });
  }
  held ??= fixtureHeld(input.operation ?? 'contacts.update', context.locationId);
  const risk = input.risk ?? (HIGHLEVEL_ENDPOINTS[held.frozen.operation]!.retry === 'read' ? 'R' : 'C');
  return { held, kind: input.kind ?? (risk === 'R' ? 'read' : 'change'), risk, escalation: input.escalation ?? 'none',
    basis: input.basis ?? context.basis ?? 'owner_exact_review', fields: input.fields ?? [], recordRefs: input.recordRefs ?? [] };
}
