// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { locationOperations, f6Record } from "../operations/location.ts";
import type { FakeHighLevelRequest, FakeHighLevelRoute } from "../fake-provider.ts";
export type { FakeHighLevelRequest, FakeHighLevelRoute };
import type { OperationId } from '../../../shared/highlevel.ts';
import type { HighLevelMethod } from '../provider-contract.ts';
type F6FakeRequester = { request(operation: OperationId, method: HighLevelMethod, path: string, body?: unknown, query?: Record<string, string>): Promise<unknown> };
export const locationRoutes: readonly FakeHighLevelRoute[] = locationOperations.map(spec => ({
  operation: spec.id, method: spec.endpoint.method, path: spec.endpoint.path,
  handle(request) {
    const [, , loc, resource, id] = request.path.split("/");
    const locationId = decodeURIComponent(loc!);
    if (!resource) return { location: { id: locationId, name: "Fixture location", timezone: "UTC" } };
    if (request.method === "DELETE") return { succeeded: true };
    if (resource === "tasks") return { tasks: [{ id: "task1", locationId, title: "Fixture task", completed: false }] };
    if (resource === "templates") return { templates: [{ id: "template1", locationId, name: "Fixture template", type: "sms", template: { body: "Fixture message" } }] };
    const singular = resource === "customFields" ? "customField" : resource === "customValues" ? "customValue" : "tag";
    const record = { id: id ?? (resource === "customFields" ? "field1" : resource === "customValues" ? "value1" : "tag1"), locationId, name: "Fixture name", ...(resource === "customFields" ? { fieldKey: "contact.fixture", dataType: "TEXT" } : {}), ...f6Record(request.body) };
    return request.method === "GET" && !id ? { [resource!]: [record] } : { [singular]: record };
  },
}));
export function f6FakeRequester(routes: readonly FakeHighLevelRoute[] = locationRoutes): F6FakeRequester & { calls: FakeHighLevelRequest[] } {
  const calls: FakeHighLevelRequest[] = [];
  return { calls, async request(operation, method, path, body, query) {
    const call = { operation, method, path, body, query }; calls.push(call);
    const route = routes.find(entry => entry.operation === operation && entry.method === method && entry.path.test(path));
    if (!route) throw new Error("No F6 fixture route");
    return route.handle(call);
  } };
}
export default locationRoutes;

// Test-only adapter: preparation, immutable wire bytes and shared identity gate
// mirror the host boundary without credentials or a live provider.
import { HeldRequest } from '../held-request.ts';
import { prepareReturnedIdentitySchema } from '../returned-identities.ts';
import { operationSpec, type OperationSpec, type PreflightRequester } from '../operations/registry.ts';
export function f6Preflight(crm: F6FakeRequester, spec: Pick<OperationSpec, 'preflight'>, locationId = 'loc1'): PreflightRequester {
  let reads = 0;
  return { async read(id, draft) {
    const target = operationSpec(id);
    if (!spec.preflight.includes(id) || !target || target.risk !== 'R' || target.endpoint.retry !== 'read' || ++reads > 5)
      throw new Error('This preflight read is not allowed.');
    const segment = target.row.pathResourceSegment;
    const resource = segment === null ? `location:${locationId}` : `${target.family}:record:${decodeURIComponent(draft.path.split('/')[segment] ?? '')}`;
    const held = HeldRequest.freeze(target, { path: draft.path, query: draft.query, resource,
      ...(draft.body === undefined ? {} : { body: { kind: 'json', value: draft.body } as const }) }, { locationId });
    const copy = held.sendCopy();
    return crm.request(id, copy.method, copy.url.pathname, copy.body ? JSON.parse(Buffer.from(copy.body).toString()) : undefined,
      copy.url.search ? Object.fromEntries(copy.url.searchParams) : undefined);
  } };
}
export async function f6Execute(spec: OperationSpec, crm: F6FakeRequester, args: Record<string, unknown>, locationId = 'loc1') {
  const ctx = { locationId }, pre = f6Preflight(crm, spec, locationId);
  args = spec.args.parse(args) as Record<string, unknown>;
  await spec.ownership?.(pre, args, ctx);
  const draft = spec.risk === 'R' ? await spec.prepareRead(args, ctx) : await spec.prepare(pre, args, ctx);
  const held = HeldRequest.freeze(spec, draft, ctx), copy = held.sendCopy();
  if (spec.risk !== 'R') prepareReturnedIdentitySchema(held, locationId);
  const raw = await crm.request(spec.id, copy.method, copy.url.pathname, copy.body ? JSON.parse(Buffer.from(copy.body).toString()) : undefined, copy.url.search ? Object.fromEntries(copy.url.searchParams) : undefined);
  const recordId = spec.risk === 'R' ? undefined : spec.recordId?.(raw, held.frozen);
  return { value: spec.risk === 'R' ? spec.project(raw) : spec.project(raw, held.frozen), recordId };
}
