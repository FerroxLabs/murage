// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { z } from "zod";
import { HighLevelError } from "../client.ts";
import { HIGHLEVEL_ENDPOINTS } from "../provider-contract.ts";
import { HIGHLEVEL_OPERATION_MANIFEST } from "./manifest.ts";
import type { OperationSpec, SpecBase, PreflightRequester, OperationRunContext, RequestDraft } from "./registry.ts";
import type { FrozenRequest } from "../held-request.ts";
import { f6BoundProjection, f6Confirmed, f6Id, f6Record, f6Pick, f6Location, type FamilyLevel } from "./location.ts";
import { completeReconciliationCollection } from "../reconciliation-read.ts";
export const usersDefaultLevel: FamilyLevel = "off";
const permissionNames = ["campaignsEnabled", "campaignsReadOnly", "contactsEnabled", "workflowsEnabled", "workflowsReadOnly", "triggersEnabled", "funnelsEnabled", "websitesEnabled", "opportunitiesEnabled", "dashboardStatsEnabled", "bulkRequestsEnabled", "appointmentsEnabled", "reviewsEnabled", "onlineListingsEnabled", "phoneCallEnabled", "conversationsEnabled", "assignedDataOnly", "adwordsReportingEnabled", "membershipEnabled", "facebookAdsReportingEnabled", "attributionsReportingEnabled", "settingsEnabled", "tagsEnabled", "leadValueEnabled", "marketingEnabled", "agentReportingEnabled", "botService", "socialPlanner", "bloggingEnabled", "invoiceEnabled", "affiliateManagerEnabled", "contentAiEnabled", "refundsEnabled", "recordPaymentEnabled", "cancelSubscriptionEnabled", "paymentsEnabled"] as const;
export const USERS_PROVIDER_LIMITATIONS = {
  create: { status: "recipient_verification_required", reason: "Add this user in HighLevel to finish setting up their access.", doc: "https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/users/create-user/index.html" },
} as const;
const userKeys = ['id', 'name', 'firstName', 'lastName', 'email', 'phone', 'type', 'role'];
function projectUser(value: unknown): unknown {
  const raw = f6Record(value);
  return { ...f6Pick(raw, userKeys), roles: f6Pick(raw.roles, ['type', 'role', 'locationIds']), permissions: f6Pick(raw.permissions, permissionNames) };
}
function checkedUser(value: unknown, userId: unknown, locationId: string, write: boolean): void {
  const raw = f6Record(value), user = f6Record(raw.user ?? raw), roles = f6Record(user.roles);
  const declarations = [raw, f6Record(raw.roles), user, roles];
  const locations = declarations.filter(row => row.locationIds !== undefined).map(row => row.locationIds);
  const types = declarations.filter(row => row.type !== undefined).map(row => row.type);
  const ids = roles.locationIds ?? user.locationIds;
  if (user.id !== userId || !Array.isArray(ids) || !ids.includes(locationId)
    || locations.some(value => !Array.isArray(value) || value.length !== ids.length || new Set(value).size !== value.length || value.some(id => !f6Id.safeParse(id).success || !ids.includes(id)))
    || declarations.some(row => row.locationId !== undefined && row.locationId !== locationId)
    || types.some(type => type !== types[0]))
    throw new HighLevelError('Could not verify HighLevel user ownership.', { status: 403 });
  if (write && (types.length === 0 || types[0] !== 'account' || ids.length !== 1 || ids[0] !== locationId))
    throw new HighLevelError("This user's access extends beyond the connected HighLevel location.", { status: 403 });
}
async function requireLocationMember(pre: PreflightRequester, userId: unknown, locationId: string, write: boolean): Promise<void> {
  const response = f6Record(await pre.read('users.list', { path: '/users/', query: { locationId } }));
  if (!Array.isArray(response.users) || response.users.length > 10000 || !completeReconciliationCollection(response, response.users.length, false))
    throw new HighLevelError('Could not verify HighLevel user ownership.', { status: 403 });
  const matches = response.users.map(f6Record).filter(user => user.id === userId);
  if (matches.length !== 1) throw new HighLevelError('This user is not in the connected HighLevel location.', { status: 403 });
  checkedUser(matches[0], userId, locationId, write);
}
function userOperation(row: (typeof HIGHLEVEL_OPERATION_MANIFEST)[number]): OperationSpec {
  const id = row.id, verb = id.split('.')[1]!, args = row.argsSchema as z.ZodType<Record<string, unknown>>;
  const nested = row.pathResourceSegment !== null;
  const ownership = async (pre: PreflightRequester, input: Record<string, unknown>, ctx: OperationRunContext) => {
    f6Location({}, ctx.locationId);
    const a = args.parse(input) as Record<string, unknown>; f6Location(a, ctx.locationId);
    if (verb === 'create' && (!ctx.companyId || a.companyId !== ctx.companyId || a.type !== 'account'
      || !['admin', 'user'].includes(String(a.role)) || !Array.isArray(a.locationIds) || a.locationIds.length !== 1 || a.locationIds[0] !== ctx.locationId))
      throw new HighLevelError('User changes must stay in this location.', { status: 403 });
    if (nested) await requireLocationMember(pre, a.userId, ctx.locationId, verb !== 'get');
    if (nested && verb !== 'get') {
      const value = await pre.read('users.get', { path: `/users/${encodeURIComponent(String(a.userId))}` });
      checkedUser(value, a.userId, ctx.locationId, true);
      if (a.companyId !== undefined || (a.role !== undefined && !['admin', 'user'].includes(String(a.role))) || (a.type !== undefined && a.type !== 'account')) throw new HighLevelError('User changes must stay in this location.', { status: 403 });
      if (a.locationIds !== undefined && (!Array.isArray(a.locationIds) || a.locationIds.length !== 1 || a.locationIds[0] !== ctx.locationId))
        throw new HighLevelError('User changes must stay in this location.', { status: 403 });
    }
  };
  const draft = (input: Record<string, unknown>, ctx: OperationRunContext): RequestDraft => {
    const a = args.parse(input) as Record<string, unknown>; f6Location(a, ctx.locationId);
    const { userId, ...body } = a;
    return { path: nested ? `/users/${encodeURIComponent(String(userId))}` : '/users/', resource: nested ? `users:record:${userId}` : `location:${ctx.locationId}`,
      ...(verb === 'list' ? { query: { locationId: ctx.locationId } } : {}),
      ...(row.bodySchema ? { body: { kind: 'json', value: body } as const } : {}) };
  };
  const project = (value: unknown) => {
    const raw = f6Record(value);
    return f6BoundProjection(verb === 'list' ? { users: (Array.isArray(raw.users) ? raw.users : []).slice(0, 50).map(projectUser) }
      : verb === 'delete' ? { succeeded: raw.succeeded === true || raw.succeded === true || raw.success === true } : { user: projectUser(raw.user ?? raw) });
  };
  const base: SpecBase = { id, family: 'users', title: ({ list: 'List users', get: 'Read a user', create: 'Add a user', update: 'Update a user', delete: 'Delete a user' } as Record<string, string>)[verb]!,
    row, args, endpoint: HIGHLEVEL_ENDPOINTS[id]!, nested, preflight: row.preflight, ownership,
    fields: a => row.risk === 'R' || verb === 'delete' ? [] : Object.keys(args.parse(a)).filter(key => !['userId', 'locationId'].includes(key)).sort(),
    recordRefs: a => nested ? [String(args.parse(a).userId)] : [], targets: () => 1, project };
  if (row.risk === 'R') return { ...base, risk: 'R', maxReads: 1, async prepareRead(input, ctx) { return draft(input, ctx); } };
  const recordId = (value: unknown, frozen?: FrozenRequest) => {
    f6Confirmed(id, value, frozen);
    if (verb === 'delete') return undefined;
    const raw = f6Record(value), result = f6Record(raw.user ?? raw).id;
    if (!f6Id.safeParse(result).success) throw new HighLevelError('HighLevel did not return the changed user.', { outcome: 'outcome_unknown' });
    return String(result);
  };
  return { ...base, risk: 'D', gate: 'GD', send: false, precondition: 'none', recordId,
    async prepare(pre, input, ctx) { await ownership(pre, input, ctx); return draft(input, ctx); },
    project(value, frozen?: FrozenRequest) { recordId(value, frozen); return project(value); } };
}
export const usersOperations: readonly OperationSpec[] = HIGHLEVEL_OPERATION_MANIFEST.filter(row => row.family === 'users' && row.disposition === 'ready').map(userOperation);
export default usersOperations;
