// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { HighLevelError } from "../errors.ts";
import { highlevelCrmResult } from "../tools.ts";
import type { OperationSpec, PreflightRequester } from "../operations/registry.ts";
import type { OperationId } from "../../../shared/highlevel.ts";
import type { HighLevelMethod } from "../provider-contract.ts";
import { HeldRequest } from "../held-request.ts";
import { prepareReturnedIdentitySchema } from "../returned-identities.ts";
import type { FakeHighLevelRoute } from "../fake-provider.ts";
interface FixtureRequester {
  request(op: OperationId, method: HighLevelMethod, path: string, body?: unknown, query?: Record<string, string>): Promise<unknown>;
}

// Fixture routes only. No sockets or provider credentials.
export const automationRoutes = [
  { operation: "automations.workflows.list", method: "GET", path: /^\/workflows\/$/u, value: { workflows: [{ id: "workflow_1", locationId: "location_1", name: "Welcome", status: "published" }] } },
  { operation: "automations.campaigns.list", method: "GET", path: /^\/campaigns\/$/u, value: { campaigns: [{ id: "campaign_1", locationId: "location_1", name: "Welcome", status: "published" }] } },
  { operation: "automations.workflow.addContact", method: "POST", path: /^\/contacts\/contact_1\/workflow\/workflow_1$/u, value: { succeeded: true } },
  { operation: "automations.workflow.removeContact", method: "DELETE", path: /^\/contacts\/contact_1\/workflow\/workflow_1$/u, value: { succeeded: true } },
  { operation: "automations.campaign.addContact", method: "POST", path: /^\/contacts\/contact_1\/campaigns\/campaign_1$/u, value: { succeeded: true } },
  { operation: "automations.campaign.removeContact", method: "DELETE", path: /^\/contacts\/contact_1\/campaigns\/campaign_1$/u, value: { succeeded: true } },
  { operation: "automations.campaign.removeAll", method: "DELETE", path: /^\/contacts\/contact_1\/campaigns\/remove-all$/u, value: { succeeded: true } },
] as const;

// Shared fake-provider route contract. Keep the literal fixtures inspectable.
export const automationsRoutes = automationRoutes.map((route) => ({ ...route, handle: () => structuredClone(route.value) })) satisfies readonly FakeHighLevelRoute[];
export default automationsRoutes;

export type FakeRoute = { operation: string; method: string; path: RegExp; value: unknown };
export function fakeF5Provider(routes: readonly FakeRoute[] = automationRoutes) {
  const calls: Parameters<FixtureRequester["request"]>[] = [];
  const crm: FixtureRequester = {
    async request(...call) {
      calls.push(call);
      if (call[0] === "contacts.get" && call[1] === "GET" && call[2] === "/contacts/contact_1") {
        return { contact: { id: "contact_1", locationId: "location_1" } };
      }
      const route = routes.find((r) => r.operation === call[0] && r.method === call[1] && r.path.test(call[2]));
      if (!route) throw new HighLevelError("No fixture route", { status: 404 });
      return structuredClone(route.value);
    },
  };
  return { crm, calls };
}

// Unit fixture for preparation/projection only. Production host integration is
// exercised separately; this helper is never used by production dispatch.
export async function exerciseF5(spec: OperationSpec, crm: FixtureRequester, args: unknown, level: "off" | "read" | "change" | "full", locationId = "location_1") {
  if (level === "off" || (spec.risk !== "R" && level === "read") || (spec.risk === "D" && level !== "full")) {
    throw new Error("not_granted");
  }
  const parsed = spec.args.parse(args);
  const ctx = { locationId };
  const pre: PreflightRequester = { read: (op, draft) => crm.request(op, "GET", draft.path, draft.body, draft.query) };
  await spec.ownership?.(pre, parsed, ctx);
  const draft = spec.risk === "R" ? await spec.prepareRead(parsed, ctx) : await spec.prepare(pre, parsed, ctx);
  const held = HeldRequest.freeze(spec, draft, ctx);
  if (spec.risk !== "R") prepareReturnedIdentitySchema(held, locationId);
  try {
    const copy = held.sendCopy();
    const value = await crm.request(spec.id, copy.method, copy.url.pathname,
      copy.body ? JSON.parse(Buffer.from(copy.body).toString()) : undefined, draft.query);
    return { result: highlevelCrmResult(spec.project(value, held.frozen)), receipt: spec.risk === "R" ? undefined : { operation: spec.id, outcome: "applied", recordIds: spec.recordRefs(parsed), fields: spec.fields(parsed) } };
  } catch (error) {
    if (spec.risk === "R") return { result: { ...highlevelCrmResult({ error: error instanceof Error ? error.message : "HighLevel read failed" }), isError: true }, receipt: undefined };
    return { receipt: { operation: spec.id, outcome: error instanceof HighLevelError ? error.outcome : "outcome_unknown", status: error instanceof HighLevelError ? error.status : undefined, recordIds: spec.recordRefs(parsed), fields: spec.fields(parsed) } };
  }
}
