// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { HighLevelError } from "../errors.ts";
import { HIGHLEVEL_ENDPOINTS } from "../provider-contract.ts";
import type { OperationSpec, ReadSpec, MutationSpec } from "./registry.ts";
import { HIGHLEVEL_OPERATION_MANIFEST } from "./manifest.ts";
import { bindReturnedIdentities, returnedIdentitySchemaFor } from "../returned-identities.ts";
import type { FrozenRequest } from "../held-request.ts";

export const f5Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.~%-]+$/u).refine((value) => {
  // Reject dot segments, encoded routing characters and double encoding before
  // either ownership or dispatch. The client applies the same routing fence.
  if (value === "." || value.includes("..")) return false;
  try { return /^[A-Za-z0-9_~.-]+$/u.test(decodeURIComponent(value)) && !/%(?:2e|2f|5c|25)/iu.test(value); }
  catch { return false; }
});
export const f5Text = (max: number) => z.string().max(max).refine((value) => !/(?:[a-z][a-z\d+.-]*:\/\/|\/\/)/iu.test(value), "Use text without web links here.");
const time = z.string().datetime({ offset: true });
const campaignId = f5Id.refine((id) => !["removeAll", "remove-all"].includes(decodeURIComponent(id)), "Choose the action to remove from every campaign instead.");
export const f5Object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const f5Refs = (args: Record<string, unknown>, keys: string[]) => keys.flatMap((key) => f5Id.safeParse(args[key]).success ? [String(args[key])] : []);
export const f5Query = (args: Record<string, unknown>) => Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
export function f5Location(args: Record<string, unknown>, locationId: string): void {
  if (!f5Id.safeParse(locationId).success || args.locationId !== locationId) throw new HighLevelError("Choose the HighLevel business connected here.");
}

// The shared, versioned manifest is the only route authority.
export const F5_AUTOMATION_ENDPOINTS = Object.fromEntries(
  HIGHLEVEL_OPERATION_MANIFEST.filter(row => row.family === "automations").map(row => [row.id, HIGHLEVEL_ENDPOINTS[row.id]!]),
);

/** Reject oversized reads as a whole: a normal result always contains every
 * allowlisted scalar and row. The provider offers no automation continuation. */
export function f5TooLarge(): never {
  throw new HighLevelError("This HighLevel result is too large to show in full. Narrow the request or check it in HighLevel.");
}
export function f5ProjectionBudget() {
  let remaining = 40_000;
  return (value: unknown): string | number | boolean | null | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" && typeof value !== "boolean" && value !== null && !(typeof value === "number" && Number.isFinite(value))) {
      throw new HighLevelError("This HighLevel answer cannot be shown in full. Check it in HighLevel.");
    }
    remaining -= Buffer.byteLength(JSON.stringify(value)) + 1;
    if (remaining < 0) f5TooLarge();
    return value;
  };
}
/** Final byte fence includes field names, punctuation and empty containers. */
export function f5BoundProjection(value: Record<string, unknown>, _key: string): Record<string, unknown> {
  if (Buffer.byteLength(JSON.stringify(value)) > 65_536) f5TooLarge();
  return value;
}
export function f5ListProjection(value: unknown, key: string, keys: readonly string[]) {
  const root = f5Object(value);
  const rows = Array.isArray(root[key]) ? root[key] : [];
  if (rows.length > 50) f5TooLarge();
  const scalar = f5ProjectionBudget();
  return f5BoundProjection({ [key]: rows.map((row) => {
    const source = f5Object(row);
    return Object.fromEntries(keys.flatMap((field) => {
      const projected = scalar(source[field]);
      return projected === undefined ? [] : [[field, projected]];
    }));
  }) }, key);
}

const list = (kind: "workflows" | "campaigns", title: string): ReadSpec => {
  const id = `automations.${kind}.list` as const;
  const row = HIGHLEVEL_OPERATION_MANIFEST.find(row => row.id === id)!;
  const validation = z.object({ locationId: f5Id, ...(kind === "campaigns" ? { status: f5Text(64).optional() } : {}) }).strict();
  return {
    id, family: "automations", risk: "R", title, row, endpoint: F5_AUTOMATION_ENDPOINTS[id]!, args: row.argsSchema as z.ZodType<Record<string, unknown>>,
    preflight: row.preflight, nested: false, maxReads: 1,
    recordRefs: (a) => f5Refs(a, ["locationId"]), fields: () => [], targets: () => 1,
    ownership: async (_pre, a, ctx) => f5Location(validation.parse(row.argsSchema.parse(a)), ctx.locationId),
    prepareRead: async (a, ctx) => {
      const parsed = validation.parse(row.argsSchema.parse(a));
      f5Location(parsed, ctx.locationId);
      return { path: `/${kind}/`, query: f5Query(parsed), resource: `location:${ctx.locationId}` };
    },
    project: (value) => f5ListProjection(value, kind, ["id", "name", "status", "locationId", ...(kind === "workflows" ? ["version", "createdAt", "updatedAt"] : [])]),
  };
};

const mutation = (verb: "workflow.addContact" | "workflow.removeContact" | "campaign.addContact" | "campaign.removeContact" | "campaign.removeAll", title: string): MutationSpec => {
  const id = `automations.${verb}` as const;
  const workflow = verb.startsWith("workflow.");
  const all = verb === "campaign.removeAll";
  const ref = workflow ? "workflowId" : "campaignId";
  const row = HIGHLEVEL_OPERATION_MANIFEST.find(row => row.id === id)!;
  const validation = z.object({ contactId: f5Id, ...(workflow ? { workflowId: f5Id, eventStartTime: time.optional() } : all ? {} : { campaignId }) }).strict();
  const endpoint = F5_AUTOMATION_ENDPOINTS[id]!;
  const parse = (a: unknown) => validation.parse(row.argsSchema.parse(a));
  return {
    id, family: "automations", risk: all ? "D" : "C", title, row, endpoint, args: row.argsSchema as z.ZodType<Record<string, unknown>>,
    nested: true, preflight: row.preflight, gate: all ? "GD" : "GC", send: false, precondition: "none",
    recordRefs: (a) => f5Refs(a, all ? ["contactId"] : ["contactId", ref]),
    fields: (a) => all ? ["campaigns"] : [ref, ...(workflow && a.eventStartTime !== undefined ? ["eventStartTime"] : [])],
    targets: () => 1,
    ownership: async (pre, a, { locationId }) => {
      const parsed = parse(a);
      if (!f5Id.safeParse(locationId).success) throw new HighLevelError("Choose the HighLevel business connected here.");
      const contact = f5Object(f5Object(await pre.read("contacts.get", { path: `/contacts/${encodeURIComponent(parsed.contactId)}` })).contact);
      if (contact.id !== parsed.contactId || contact.locationId !== locationId) throw new HighLevelError("Choose a contact from the HighLevel business connected here.");
      if (all) return;
      const kind = workflow ? "workflows" : "campaigns";
      const response = f5Object(await pre.read(`automations.${kind}.list`, { path: `/${kind}/`, query: { locationId } }));
      const records = response[kind];
      if (!Array.isArray(records)) throw new HighLevelError("Choose a workflow or campaign from the HighLevel business connected here.");
      const matches = records.filter((record) => f5Object(record).id === a[ref]);
      if (matches.length !== 1 || f5Object(matches[0]).locationId !== locationId) throw new HighLevelError("Choose a workflow or campaign from the HighLevel business connected here.");
    },
    prepare: async (_pre, a, { locationId }) => {
      if (!f5Id.safeParse(locationId).success) throw new HighLevelError("Choose the HighLevel business connected here.");
      const parsed = parse(a) as Record<string, unknown>;
      const path = row.path!.replace(/:([A-Za-z]+)/gu, (_match, key: string) => encodeURIComponent(String(parsed[key])));
      const value = workflow ? (parsed.eventStartTime === undefined ? {} : { eventStartTime: parsed.eventStartTime }) : {};
      return { path, resource: `automations:contact:${parsed.contactId}`,
        ...(row.bodySchema ? { body: { kind: "json" as const, value } } : {}) };
    },
    project: (value, frozen?: FrozenRequest) => {
      if (!frozen || frozen.operation !== id) throw new HighLevelError("HighLevel did not confirm the automation change.", { outcome: "outcome_unknown" });
      const response = f5Object(value);
      // A contact lookup proves ownership, never workflow or campaign membership.
      // In particular its success flag must not confirm an interrupted write.
      if (Object.keys(response).some(key => !["succeeded", "succeded", "message"].includes(key))) {
        throw new HighLevelError("HighLevel did not confirm the automation change.", { outcome: "outcome_unknown" });
      }
      const bound = bindReturnedIdentities(value, frozen, returnedIdentitySchemaFor(frozen));
      if (bound.status !== "applied") throw new HighLevelError("HighLevel did not confirm the automation change.", { outcome: bound.status === "not_applied" ? "not_applied" : "outcome_unknown" });
      if (response.succeeded !== true && response.succeded !== true) throw new HighLevelError("HighLevel did not confirm the automation change.", { outcome: "outcome_unknown" });
      return { succeeded: true };
    },
  };
};

export const automationsOperations: readonly OperationSpec[] = [
  list("workflows", "List workflows"), list("campaigns", "List campaigns"),
  mutation("workflow.addContact", "Add to a workflow"),
  mutation("workflow.removeContact", "Remove from a workflow"),
  mutation("campaign.addContact", "Add to a campaign"),
  mutation("campaign.removeContact", "Remove from a campaign"),
  mutation("campaign.removeAll", "Remove from every campaign"),
];
export default automationsOperations;
