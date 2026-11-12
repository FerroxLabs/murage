import { strictOperationArgs } from "./common.ts";
import { z } from "zod";
import type { HighLevelMethod } from "../../provider-contract.ts";
type Args = Record<string, unknown>;
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.~%-]+$/u)
  .refine((v) => !v.includes("..") && !/%(?:2e|2f|5c|25)/iu.test(v) && v !== ".", "Invalid record id");
const text = (max: number) => z.string().max(max);
const tags = z.array(text(100).min(1)).min(1).max(50);
const date = z.iso.datetime({ offset: true });
const value = z.union([text(4000), z.number().finite(), z.boolean(), z.array(text(1000)).max(50)]);
const forbiddenKey = /^(authorization|auth|token|access_?token|refresh_?token|api_?key|apikey|secret|password|bearer|cookie|url|uri|href|link|endpoint|host|base_?url|headers?|path|attachments?|files?)$/iu;
function safeInput(v: unknown): boolean {
  if (typeof v === "string") return !/(?:[a-z][a-z\d+.-]*:\/\/|\b(?:file|data|javascript):|^\s*\/\/)/iu.test(v);
  if (Array.isArray(v)) return v.every(safeInput);
  if (v && typeof v === "object") return Object.entries(v).every(([k, child]) => !forbiddenKey.test(k) && safeInput(k) && safeInput(child));
  return true;
}
// PROVISIONAL INTERFACE: keep the existing strict family schemas until S0 publishes
// operations/schemas/contacts.ts; replace by identity imports at integration.
const schema = <T extends z.ZodRawShape>(shape: T) => z.strictObject(shape).refine(safeInput, "URLs and request overrides are not allowed")
  .refine((a) => Buffer.byteLength(JSON.stringify(a)) <= 64 * 1024, "Arguments exceed 64 KiB");
// Ported bounds and field names from tools.ts CONTACT_FIELDS / client.ts #contactBody.
const contactFields = {
  firstName: text(200).optional(), lastName: text(200).optional(), name: text(400).optional(), email: text(320).optional(),
  phone: text(50).optional(), companyName: text(200).optional(), tags: z.array(text(100).min(1)).max(50).optional(),
  source: text(200).optional(), address1: text(400).optional(), city: text(200).optional(), state: text(200).optional(),
  postalCode: text(40).optional(), country: text(8).optional(), website: text(400).optional(), timezone: text(100).optional(),
  assignedTo: id.optional(), dateOfBirth: z.iso.date().optional(), dnd: z.boolean().optional(),
  customFields: z.array(z.strictObject({ id: id.optional(), name: text(128).min(1).optional(), value }).refine((field) => (field.id !== undefined) !== (field.name !== undefined), "Choose a field id or name")).max(50).optional(),
};
const contact = { contactId: id };
const note = { ...contact, noteId: id };
const task = { ...contact, taskId: id };
const taskFields = { title: text(500).min(1), dueDate: date, body: text(5000).optional(), assignedTo: id.optional(), completed: z.boolean().default(false) };
const identity = (a: Args) => ["email", "phone", "firstName", "lastName", "name"].some((k) => typeof a[k] === "string" && (a[k] as string).trim().length > 0);
const writeNames = Object.keys(contactFields);
const hasChange = (a: Args) => writeNames.some((k) => a[k] !== undefined);
const create = schema({ ...contactFields }).refine(identity, "Give an email, phone or name");
const update = schema({ ...contact, ...contactFields }).refine(hasChange, "Give at least one field to change");

/** HL-BATCH-1: the original public search branch remains unchanged. The OR/id branch is internal preparation only. */
export const ordinaryContactSearchBodySchema = schema({ locationId: id, page: z.number().int().min(1).max(1000), pageLimit: z.number().int().min(1).max(50), query: text(75).optional(), filters: z.array(z.strictObject({ field: z.enum(["email", "phone", "tags"]), operator: z.literal("eq"), value: text(320) })).max(3).optional() });
export const contactIdPreparationSearchBodySchema = schema({ locationId: id, page: z.literal(1), pageLimit: z.number().int().min(1).max(100),
  filters: z.tuple([z.strictObject({ group: z.literal("OR"), filters: z.array(z.strictObject({ field: z.literal("id"), operator: z.literal("eq"), value: id.max(75) })).min(1).max(100) })]),
}).refine(body => body.pageLimit === body.filters[0].filters.length
  && new Set(body.filters[0].filters.map(leaf => leaf.value)).size === body.filters[0].filters.length, "Invalid exact-ID preparation batch");
export type ContactIdPreparationSearchBody = z.infer<typeof contactIdPreparationSearchBodySchema>;
export const BATCH_PREPARATION_PROFILE = Object.freeze({ maxTargets: 500, chunkSize: 100, maxBatches: 5, maxSelectorCharacters: 75, recovery: "direct-only" } as const);
/** Pure schema constructor. Long public IDs are refused before credentials; public syntax/count remains unchanged.
 * Consumers must map this refusal to highlevel.contract.contactIdTooLong in the locale inventory. */
export function contactPreparationBatches(locationId: string, approvedIds: readonly string[]): readonly ContactIdPreparationSearchBody[] {
  const checked = z.array(id).min(1).max(500).parse(approvedIds);
  id.parse(locationId);
  if (checked.some(value => value.length > 75)) throw new Error("HighLevel contact ID exceeds search limit");
  const sorted = [...new Set(checked)].sort();
  const batches: ContactIdPreparationSearchBody[] = [];
  for (let offset = 0; offset < sorted.length; offset += 100) {
    const chunk = sorted.slice(offset, offset + 100);
    const body = contactIdPreparationSearchBodySchema.parse({ locationId, page: 1, pageLimit: chunk.length,
      filters: [{ group: "OR", filters: chunk.map(value => ({ field: "id", operator: "eq", value })) }] });
    body.filters[0].filters.forEach(leaf => Object.freeze(leaf));
    Object.freeze(body.filters[0].filters); Object.freeze(body.filters[0]); Object.freeze(body.filters); Object.freeze(body);
    batches.push(body);
  }
  return Object.freeze(batches);
}
/** Shape validation alone is insufficient: concrete client admission must match the exact host-approved chunk. */
export function matchesContactPreparationChunk(body: unknown, locationId: string, approvedChunk: readonly string[]): boolean {
  if (!approvedChunk.length || approvedChunk.length > 100 || new Set(approvedChunk).size !== approvedChunk.length) return false;
  const parsed = contactIdPreparationSearchBodySchema.safeParse(body);
  if (!parsed.success) return false;
  try {
    const expected = contactPreparationBatches(locationId, approvedChunk)[0]!;
    return parsed.data.locationId === expected.locationId && parsed.data.pageLimit === expected.pageLimit
      && parsed.data.filters[0].filters.every((leaf, index) => leaf.value === expected.filters[0].filters[index]!.value);
  } catch { return false; }
}

function wireSchema(verb: string, method: HighLevelMethod): z.ZodTypeAny | null {
  if (method === "GET" || verb === "delete" || verb.endsWith(".delete")) return null;
  const fields = { ...contactFields, customFields: z.array(z.strictObject({ id, field_value: value })).max(50).optional() };
  if (verb === "search") return z.union([ordinaryContactSearchBodySchema, contactIdPreparationSearchBodySchema]);
  if (verb === "create" || verb === "upsert") return schema({ locationId: id, ...fields }).refine(identity);
  if (verb === "update") return schema(fields).refine(hasChange);
  if (verb === "tags.add" || verb === "tags.remove") return schema({ tags });
  if (verb === "tags.bulk") return schema({ locationId: id, contacts: z.array(id).min(1).max(500), tags, removeAllTags: z.boolean().optional() });
  if (verb.startsWith("notes.")) return schema({ body: text(10_000).min(1), userId: id.optional() });
  if (verb === "tasks.create") return schema(taskFields);
  if (verb === "tasks.update") return schema({ title: taskFields.title.optional(), dueDate: date.optional(), body: taskFields.body, assignedTo: taskFields.assignedTo, completed: z.boolean().optional() }).refine(a => Object.keys(taskFields).some(key => a[key as keyof typeof a] !== undefined));
  if (verb === "tasks.complete") return schema({ completed: z.boolean() });
  if (verb.startsWith("followers.")) return schema({ followers: z.array(id).min(1).max(50) });
  throw new Error("Missing contact wire schema");
}

export const schemas = {
  "contacts.search": { argsSchema: strictOperationArgs(schema({ query: text(75).optional(), tag: text(100).optional(), email: text(320).optional(), phone: text(50).optional(), page: z.number().int().min(1).max(1000).optional(), limit: z.number().int().min(1).max(50).optional() })), bodySchema: wireSchema("search", "POST"), projection: ["contacts", "total"] },
  "contacts.get": { argsSchema: strictOperationArgs(schema(contact)), bodySchema: wireSchema("get", "GET"), projection: ["contact"] },
  "contacts.create": { argsSchema: strictOperationArgs(create), bodySchema: wireSchema("create", "POST"), projection: ["contact"] },
  "contacts.update": { argsSchema: strictOperationArgs(update), bodySchema: wireSchema("update", "PUT"), projection: ["succeeded", "succeded", "contact"] },
  "contacts.upsert": { argsSchema: strictOperationArgs(create), bodySchema: wireSchema("upsert", "POST"), projection: ["new", "contact", "traceId"] },
  "contacts.delete": { argsSchema: strictOperationArgs(schema(contact)), bodySchema: wireSchema("delete", "DELETE"), projection: ["succeeded", "succeded"] },
  "contacts.tags.add": { argsSchema: strictOperationArgs(schema({ ...contact, tags })), bodySchema: wireSchema("tags.add", "POST"), projection: ["tags"] },
  "contacts.tags.remove": { argsSchema: strictOperationArgs(schema({ ...contact, tags })), bodySchema: wireSchema("tags.remove", "DELETE"), projection: ["tags"] },
  "contacts.tags.bulk": { argsSchema: strictOperationArgs(schema({ contacts: z.array(id).min(1).max(500), type: z.enum(["add", "remove"]), tags, removeAllTags: z.boolean().optional() }).refine((a) => !a.removeAllTags || a.type === "remove", "Removing all tags requires remove")), bodySchema: wireSchema("tags.bulk", "POST"), projection: ["succeeded", "succeded", "errorCount", "responses"] },
  "contacts.notes.list": { argsSchema: strictOperationArgs(schema(contact)), bodySchema: wireSchema("notes.list", "GET"), projection: ["notes"] },
  "contacts.notes.get": { argsSchema: strictOperationArgs(schema(note)), bodySchema: wireSchema("notes.get", "GET"), projection: ["note"] },
  "contacts.notes.create": { argsSchema: strictOperationArgs(schema({ ...contact, body: text(10_000).min(1), userId: id.optional() })), bodySchema: wireSchema("notes.create", "POST"), projection: ["note"] },
  "contacts.notes.update": { argsSchema: strictOperationArgs(schema({ ...note, body: text(10_000).min(1), userId: id.optional() })), bodySchema: wireSchema("notes.update", "PUT"), projection: ["note"] },
  "contacts.notes.delete": { argsSchema: strictOperationArgs(schema(note)), bodySchema: wireSchema("notes.delete", "DELETE"), projection: ["succeeded", "succeded"] },
  "contacts.tasks.list": { argsSchema: strictOperationArgs(schema(contact)), bodySchema: wireSchema("tasks.list", "GET"), projection: ["tasks"] },
  "contacts.tasks.get": { argsSchema: strictOperationArgs(schema(task)), bodySchema: wireSchema("tasks.get", "GET"), projection: ["task"] },
  "contacts.tasks.create": { argsSchema: strictOperationArgs(schema({ ...contact, ...taskFields })), bodySchema: wireSchema("tasks.create", "POST"), projection: ["task"] },
  "contacts.tasks.update": { argsSchema: strictOperationArgs(schema({ ...task, title: taskFields.title.optional(), dueDate: date.optional(), body: taskFields.body, assignedTo: taskFields.assignedTo, completed: z.boolean().optional() }).refine((a) => Object.keys(taskFields).some((key) => (a as Args)[key] !== undefined), "Give at least one field to change")), bodySchema: wireSchema("tasks.update", "PUT"), projection: ["task"] },
  "contacts.tasks.complete": { argsSchema: strictOperationArgs(schema({ ...task, completed: z.boolean() })), bodySchema: wireSchema("tasks.complete", "PUT"), projection: ["task"] },
  "contacts.tasks.delete": { argsSchema: strictOperationArgs(schema(task)), bodySchema: wireSchema("tasks.delete", "DELETE"), projection: ["succeeded", "succeded"] },
  "contacts.appointments.list": { argsSchema: strictOperationArgs(schema(contact)), bodySchema: wireSchema("appointments.list", "GET"), projection: ["events"] },
  "contacts.followers.add": { argsSchema: strictOperationArgs(schema({ ...contact, followers: z.array(id).min(1).max(50) })), bodySchema: wireSchema("followers.add", "POST"), projection: ["followers", "followersAdded"] },
  "contacts.followers.remove": { argsSchema: strictOperationArgs(schema({ ...contact, followers: z.array(id).min(1).max(50) })), bodySchema: wireSchema("followers.remove", "DELETE"), projection: ["followers", "followersRemoved"] },
} as const;
export const argsSchema = Object.fromEntries(Object.entries(schemas).map(([id, row]) => [id, row.argsSchema])) as { [K in keyof typeof schemas]: typeof schemas[K]["argsSchema"] };
export const bodySchema = Object.fromEntries(Object.entries(schemas).map(([id, row]) => [id, row.bodySchema])) as { [K in keyof typeof schemas]: typeof schemas[K]["bodySchema"] };
export const projection = Object.fromEntries(Object.entries(schemas).map(([id, row]) => [id, row.projection])) as { [K in keyof typeof schemas]: typeof schemas[K]["projection"] };
