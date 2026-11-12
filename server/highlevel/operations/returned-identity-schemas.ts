import { z } from "zod";
import type { OperationId } from "../../../shared/highlevel.ts";
import { HIGHLEVEL_OPERATION_MANIFEST } from "./manifest.ts";
import policy from "./returned-identity-policy.json" with { type: "json" };

export interface CreatedIdentitySlot {
  readonly path: string;
  readonly role: string;
  readonly when: "always" | "new" | "missing_request_id";
}
export interface ApprovedIdentitySource { readonly path: string; readonly role: string }
export interface ReturnedIdentitySchema {
  readonly operation: OperationId;
  readonly primary: string;
  readonly identities: Readonly<Record<string, string>>;
  readonly sources: readonly ApprovedIdentitySource[];
  readonly created: readonly CreatedIdentitySlot[];
  readonly passThrough: Readonly<{ locationId: "connectedLocation" }>;
  readonly followers: boolean;
}
// Bare `id` is scoped to its nearest declared resource container, never to a
// union of unrelated approved identities. Unrecognized containers use the op's
// primary role, and NEW IDs still require an exact declared response position.
const contexts: Readonly<Record<string, string>> = Object.freeze({
  taxes: "taxId", contactDetails: "contactId", contact: "contactId", contacts: "contactId", opportunity: "opportunityId", opportunities: "opportunityId",
  pipeline: "pipelineId", pipelines: "pipelineId", stages: "pipelineStageId", stage: "pipelineStageId",
  note: "noteId", notes: "noteId", task: "taskId", tasks: "taskId", user: "userId", users: "userId",
  followers: "followerId", followersAdded: "followerId", followersRemoved: "followerId",
  customFields: "fieldId", customField: "fieldId", customValues: "valueId", customValue: "valueId",
  calendar: "calendarId", calendars: "calendarId", event: "eventId", events: "eventId", appointment: "eventId",
  conversation: "conversationId", message: "messageId", invoice: "invoiceId", post: "postId",
  file: "fileId", uploadedFiles: "fileId", document: "documentId", redirect: "redirectId", course: "courseId",
  tag: "tagId", tags: "tagId", availabilities: "availabilityId",
  location: "locationId", locations: "locationId", company: "companyId", companies: "companyId",
  account: "accountId", accounts: "accountId", group: "groupId", groups: "groupId", resource: "resourceId", resources: "resourceId",
  order: "orderId", orders: "orderId", transaction: "transactionId", transactions: "transactionId",
  subscription: "subscriptionId", subscriptions: "subscriptionId", product: "productId", products: "productId",
  category: "categoryId", categories: "categoryId", author: "authorId", authors: "authorId",
  blog: "blogId", site: "blogId", form: "formId", forms: "formId", survey: "surveyId", surveys: "surveyId",
  template: "templateId", templates: "templateId", workflow: "workflowId", campaign: "campaignId",
  funnel: "funnelId", page: "pageId", snapshot: "snapshotId",
});
const explicit: Readonly<Record<string, string>> = Object.freeze({
  assignedTo: "assignedTo", followers: "followerId", followersAdded: "followerId", followersRemoved: "followerId",
  contacts: "contactId", selectedUsers: "userId", mentions: "userId", accountIds: "accountId", userIds: "userId",
  followerIds: "followerId", messageIds: "messageId",
});
export function isReturnedIdentityKey(key: string): boolean {
  return key === "id" || /(?:Id|Ids|_id|_ids)$/u.test(key) || Object.hasOwn(explicit, key) || /^(?:user|follower)$/u.test(key);
}
export function returnedIdentityRole(key: string, path: readonly string[], primary: string): string {
  const parentRole = [...path].reverse().map(p => contexts[p]).find(Boolean);
  if (key === "altId") return "locationId";
  if (key === "id" || key === "_id") return parentRole ?? primary;
  if (parentRole === "followerId" && ["userId", "user_id", "followerId", "follower_id"].includes(key)) return "followerId";
  return explicit[key] ?? key.replace(/_([a-z])/gu, (_, c: string) => c.toUpperCase()).replace(/Ids$/u, "Id");
}
// Enumerate the actual frozen Zod schemas, including optional/default/array
// wrappers. These are declarations, not a scan of untrusted returned values.
function sources(schema: z.ZodTypeAny | null, primary: string, path: string[] = []): ApprovedIdentitySource[] {
  if (!schema) return [];
  if (schema instanceof z.ZodObject) return Object.entries(schema.shape).flatMap(([key, value]) => {
    const child = value as z.ZodTypeAny;
    const own = isReturnedIdentityKey(key) ? [{ path: [...path, key].join("."), role: returnedIdentityRole(key, path, primary) }] : [];
    return [...own, ...sources(child, primary, [...path, key])];
  });
  if (schema instanceof z.ZodArray) return sources(schema.element as z.ZodTypeAny, primary, [...path, "*"]);
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) return sources(schema.unwrap() as z.ZodTypeAny, primary, path);
  if (schema instanceof z.ZodUnion) return schema.options.flatMap(s => sources(s as z.ZodTypeAny, primary, path));
  return [];
}
const schemas = HIGHLEVEL_OPERATION_MANIFEST.map(row => {
  const p = policy[row.id as keyof typeof policy];
  if (!p) throw new Error("Missing HighLevel identity policy");
  const declared = [...sources(row.argsSchema, p.primary), ...sources(row.bodySchema, p.primary)];
  const identities: Record<string, string> = { id: p.primary, [p.primary]: p.primary, locationId: "locationId" };
  for (const source of declared) identities[source.path.split(".").at(-1)!] = source.role;
  for (const match of row.path?.matchAll(/:([A-Za-z][A-Za-z0-9]*)/gu) ?? []) if (isReturnedIdentityKey(match[1])) identities[match[1]] = match[1];
  for (const slot of p.created) identities[slot.path.split(".").filter(k => k !== "*").at(-1)!] = slot.role;
  for (const key of row.projection) if (isReturnedIdentityKey(key) && !Object.hasOwn(identities, key)) identities[key] = returnedIdentityRole(key, [], p.primary);
  if (row.family === "payments") Object.assign(identities, { _id: p.primary, altId: "locationId", contactId: "contactId" });
  identities.id = p.primary;
  // Schema-known aliases share one role. Arbitrary *_id keys are still unknown.
  for (const [key, role] of Object.entries(identities)) if (/Id$/u.test(key)) identities[key.replace(/Id$/u, "_id")] = role;
  const followers = row.id.includes(".followers.") || declared.some(s => s.path === "followers");
  if (followers) Object.assign(identities, { followers: "followerId", followersAdded: "followerId", followersRemoved: "followerId", followerId: "followerId", follower_id: "followerId", followerIds: "followerId", userId: "userId", user_id: "userId" });
  return [row.id, Object.freeze({ operation: row.id, primary: p.primary, identities: Object.freeze(identities), sources: Object.freeze(declared.map(s => Object.freeze(s))), created: Object.freeze(p.created.map(s => Object.freeze(s as CreatedIdentitySlot))), passThrough: Object.freeze({ locationId: "connectedLocation" as const }), followers })];
});
export const HIGHLEVEL_RETURNED_IDENTITY_SCHEMAS: Readonly<Record<OperationId, ReturnedIdentitySchema>> = Object.freeze(Object.fromEntries(schemas));
