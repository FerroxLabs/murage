// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The twenty HighLevel tools and two local helpers (GAP-HIGHLEVEL-109 section 7). Schemas ported from OpenMausBot
// server/highlevel/tools.ts. Each tool has a full input schema, which every call is held to before anything runs, and
// a compact advertised schema that only leaves out bounds the full check enforces (upstream a96950e01), so a shorter
// tool list never loosens a call. Inputs never carry a credential, URL, header, path or attachment: every object is
// closed, and a key shaped like one is refused at any depth.
import { HIGHLEVEL_HELPER_NAMES, HIGHLEVEL_TOOL_NAMES, isHighLevelWrite, type HighLevelAnyToolName, type HighLevelToolName } from "../../shared/highlevel.ts";
import { HighLevelError, PAGE_MAX, PAGE_NUMBER_MAX, type ContactFields, type HighLevelCrm } from "./client.ts";

type Schema = Record<string, unknown>;

const ID = { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-][A-Za-z0-9_.-]*$" };
const CONNECTION = { type: "string", minLength: 4, maxLength: 180, pattern: "^hl_[A-Za-z0-9_-]+$", description: "Which connected location (HIGHLEVEL_LIST_CONNECTIONS). Needed when this bot has more than one." };
const TEXT = (maxLength: number, description?: string): Schema => ({ type: "string", maxLength, ...(description ? { description } : {}) });
const TAGS = { type: "array", minItems: 1, maxItems: 50, items: { type: "string", minLength: 1, maxLength: 100 } };
const PAGE = { type: "integer", minimum: 1, maximum: PAGE_NUMBER_MAX, description: "Page number, from 1." };
const LIMIT = { type: "integer", minimum: 1, maximum: PAGE_MAX, description: `Results per page, at most ${PAGE_MAX}. Default 20.` };
const DATE = TEXT(64, "ISO 8601 date-time, e.g. 2026-10-20T15:00:00Z.");

const CONTACT_FIELDS: Record<string, Schema> = {
  firstName: TEXT(200), lastName: TEXT(200), name: TEXT(400, "Full name; use firstName and lastName when you have them."),
  email: TEXT(320), phone: TEXT(50, "With country code, e.g. +15551234567."), companyName: TEXT(200),
  tags: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 100 } },
  source: TEXT(200, "Where the contact came from."), address1: TEXT(400), city: TEXT(200), state: TEXT(200), postalCode: TEXT(40), country: TEXT(8, "Two-letter country code."),
  website: TEXT(400), timezone: TEXT(100), assignedTo: TEXT(128, "User id of the owner."), dateOfBirth: TEXT(32, "YYYY-MM-DD."),
  customFields: {
    type: "object", maxProperties: 50, description: "Custom field values by field name (HIGHLEVEL_GET_LOCATION lists them).",
    additionalProperties: { type: ["string", "number", "boolean", "array"], items: { type: "string", maxLength: 1000 }, maxItems: 50, maxLength: 4000 },
  },
};

export interface HighLevelToolDefinition { name: HighLevelAnyToolName; description: string; inputSchema: Schema }

const tool = (name: HighLevelAnyToolName, description: string, properties: Record<string, Schema>, required: string[] = [], crm = true): HighLevelToolDefinition =>
  ({ name, description, inputSchema: { type: "object", properties: crm ? { connectionId: CONNECTION, ...properties } : properties, required, additionalProperties: false } });

const CHANGE = " A change: the owner reviews this exact change before it runs, and it may run automations already set up in this CRM.";

export const HIGHLEVEL_TOOLS: readonly HighLevelToolDefinition[] = [
  tool("HIGHLEVEL_SEARCH_CONTACTS", "Search the CRM's contacts by free text (name, email, phone, company) with optional exact tag, email or phone filters. Returns trimmed contacts with ids.",
    { query: TEXT(500, "Free text to match."), tag: TEXT(100, "Only contacts with this tag."), email: TEXT(320, "Exact email."), phone: TEXT(50, "Exact phone with country code."), page: PAGE, limit: LIMIT }),
  tool("HIGHLEVEL_GET_CONTACT", "Read one contact by id, with its tags and custom fields by name.", { contactId: ID }, ["contactId"]),
  tool("HIGHLEVEL_CREATE_CONTACT", `Create a contact. Search first so you do not create a duplicate. Give at least an email, a phone or a name.${CHANGE}`, CONTACT_FIELDS),
  tool("HIGHLEVEL_UPDATE_CONTACT", `Change fields of an existing contact; only the fields given change. Tags given here replace the contact's tags: use HIGHLEVEL_ADD_TAGS to add.${CHANGE}`,
    { contactId: ID, ...CONTACT_FIELDS }, ["contactId"]),
  tool("HIGHLEVEL_ADD_TAGS", `Add tags to a contact.${CHANGE}`, { contactId: ID, tags: TAGS }, ["contactId", "tags"]),
  tool("HIGHLEVEL_REMOVE_TAGS", `Remove tags from a contact.${CHANGE}`, { contactId: ID, tags: TAGS }, ["contactId", "tags"]),
  tool("HIGHLEVEL_LIST_NOTES", "List the notes on a contact.", { contactId: ID }, ["contactId"]),
  tool("HIGHLEVEL_ADD_NOTE", `Add a note to a contact.${CHANGE}`, { contactId: ID, body: { type: "string", minLength: 1, maxLength: 10_000 } }, ["contactId", "body"]),
  tool("HIGHLEVEL_LIST_TASKS", "List the tasks on a contact.", { contactId: ID }, ["contactId"]),
  tool("HIGHLEVEL_ADD_TASK", `Add a task to a contact with a title and due date; optionally a description and an assignee (user id).${CHANGE}`,
    { contactId: ID, title: { type: "string", minLength: 1, maxLength: 500 }, dueDate: DATE, body: TEXT(5000, "Description."), assignedTo: TEXT(128, "User id.") }, ["contactId", "title", "dueDate"]),
  tool("HIGHLEVEL_LIST_PIPELINES", "List the location's pipelines with their stages (ids and names).", {}),
  tool("HIGHLEVEL_SEARCH_OPPORTUNITIES", "Search opportunities (deals) by pipeline, stage, contact, status or free text.",
    { query: TEXT(500), pipelineId: ID, stageId: ID, contactId: ID, status: { type: "string", enum: ["open", "won", "lost", "abandoned", "all"] }, page: PAGE, limit: LIMIT }),
  tool("HIGHLEVEL_GET_OPPORTUNITY", "Read one opportunity by id.", { opportunityId: ID }, ["opportunityId"]),
  tool("HIGHLEVEL_CREATE_OPPORTUNITY", `Create an opportunity for a contact in a pipeline (HIGHLEVEL_LIST_PIPELINES gives pipeline and stage ids).${CHANGE}`,
    { pipelineId: ID, stageId: ID, contactId: ID, name: { type: "string", minLength: 1, maxLength: 500 }, value: { type: "number", minimum: 0, description: "Monetary value." }, status: { type: "string", enum: ["open", "won", "lost", "abandoned"] } },
    ["pipelineId", "contactId", "name"]),
  tool("HIGHLEVEL_UPDATE_OPPORTUNITY", `Move an opportunity to a stage, change its status, value or name. Only the fields given change.${CHANGE}`,
    { opportunityId: ID, stageId: ID, status: { type: "string", enum: ["open", "won", "lost", "abandoned"] }, value: { type: "number", minimum: 0 }, name: TEXT(500) }, ["opportunityId"]),
  tool("HIGHLEVEL_SEARCH_CONVERSATIONS", "Find conversations by contact or free text; returns summaries with the last message. Read only.",
    { contactId: ID, query: TEXT(500), limit: LIMIT }),
  tool("HIGHLEVEL_READ_CONVERSATION", "Read the messages of one conversation, newest first. Read only: nothing can be sent.",
    { conversationId: ID, limit: LIMIT, lastMessageId: { ...ID, description: "Page on from this message id." } }, ["conversationId"]),
  tool("HIGHLEVEL_LIST_CALENDARS", "List the location's calendars. Read only.", {}),
  tool("HIGHLEVEL_LIST_EVENTS", "List calendar events (appointments) in a date range, optionally for one calendar or one user. Read only.",
    { startTime: DATE, endTime: DATE, calendarId: ID, userId: ID }, ["startTime", "endTime"]),
  tool("HIGHLEVEL_GET_LOCATION", "The connected location: name, timezone, contact details and its custom field definitions.", {}),
  tool("HIGHLEVEL_LIST_CONNECTIONS", "The HighLevel locations this bot may use, with the tools granted for each and whether changes may be proposed. Reads Murage, not the CRM.",
    { cursor: { type: "string", maxLength: 64, pattern: "^[0-9]+$" }, limit: LIMIT }, [], false),
  tool("HIGHLEVEL_ACTION_STATUS", "The status of one of this bot's own HighLevel changes: waiting for review, applied, not applied, or unknown. Reads Murage, not the CRM.",
    { actionId: { type: "string", minLength: 8, maxLength: 80, pattern: "^hla_[A-Za-z0-9-]+$" } }, ["actionId"], false),
];

if (HIGHLEVEL_TOOLS.length !== HIGHLEVEL_TOOL_NAMES.length + HIGHLEVEL_HELPER_NAMES.length) throw new Error("HighLevel tool table and names disagree");

const BY_NAME = new Map(HIGHLEVEL_TOOLS.map((entry) => [entry.name as string, entry]));
export const highlevelToolDefinition = (name: string): HighLevelToolDefinition | undefined => BY_NAME.get(name);

// ---- compact advertised schemas -----------------------------------------------------------------------------------------

/** The only keywords the advertised schema may leave out; checkToolArguments enforces each of them on every call. */
export const ENFORCED_KEYWORDS = ["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "maxProperties"] as const;
const GENEROUS_MAX_LENGTH = 200;
const GENEROUS_MAX_ITEMS = 32;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function leftOut(keyword: string, value: unknown, node: Record<string, unknown>, words: string): boolean {
  if (typeof value !== "number") return false;
  if (new RegExp(`(?<![\\d,.])${value}(?![\\d,])`, "u").test(words)) return true;
  if (keyword === "minLength" || keyword === "minItems") return value <= 1;
  if (keyword === "minimum") return node.type === "integer" && value <= 1;
  if (keyword === "maxLength") return value >= GENEROUS_MAX_LENGTH;
  if (keyword === "maxItems" || keyword === "maxProperties") return value >= GENEROUS_MAX_ITEMS;
  return false;
}

function compactNode(node: unknown, toolWords: string): unknown {
  if (!record(node)) return node;
  const words = `${typeof node.description === "string" ? node.description : ""} ${toolWords}`;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if ((ENFORCED_KEYWORDS as readonly string[]).includes(key) && leftOut(key, value, node, words)) continue;
    if (key === "properties" && record(value)) out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, compactNode(child, toolWords)]));
    else if ((key === "items" || key === "additionalProperties") && record(value)) out[key] = compactNode(value, toolWords);
    else out[key] = value;
  }
  return out;
}

/** What tools/list sends for a tool. */
export function advertisedTool(entry: HighLevelToolDefinition): HighLevelToolDefinition {
  return { name: entry.name, description: entry.description, inputSchema: compactNode(entry.inputSchema, entry.description) as Schema };
}

// ---- the full check ---------------------------------------------------------------------------------------------------

/** A key that would carry a credential, an address or a raw request part. Refused wherever it appears. */
const FORBIDDEN_KEY = /^(authorization|auth|token|access_?token|refresh_?token|api_?key|apikey|secret|password|bearer|cookie|url|uri|href|link|endpoint|host|base_?url|headers?|path|attachments?|file|files)$/iu;

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeMatches(declared: unknown, value: unknown): boolean {
  const actual = typeOf(value);
  const allowed = Array.isArray(declared) ? declared : [declared];
  return allowed.some((type) => type === actual || (type === "number" && actual === "integer"));
}

function check(node: unknown, value: unknown, at: string, problems: string[], depth: number): void {
  if (problems.length >= 8) return;
  if (!record(node)) { problems.push(`${at} is not accepted`); return; }
  if (depth > 6) { problems.push(`${at} is nested too deeply`); return; }
  if (node.type !== undefined && !typeMatches(node.type, value)) { problems.push(`${at} must be ${Array.isArray(node.type) ? node.type.join(" or ") : node.type}`); return; }
  if (Array.isArray(node.enum) && !node.enum.includes(value)) { problems.push(`${at} must be one of ${node.enum.join(", ")}`); return; }
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof node.minLength === "number" && length < node.minLength) problems.push(length === 0 ? `${at} must not be empty` : `${at} needs at least ${node.minLength} characters`);
    if (typeof node.maxLength === "number" && length > node.maxLength) problems.push(`${at} takes at most ${node.maxLength} characters (it has ${length})`);
    if (typeof node.pattern === "string" && !new RegExp(node.pattern, "u").test(value)) problems.push(`${at} has characters that are not allowed`);
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) problems.push(`${at} must be a finite number`);
    if (typeof node.minimum === "number" && value < node.minimum) problems.push(`${at} must be at least ${node.minimum}`);
    if (typeof node.maximum === "number" && value > node.maximum) problems.push(`${at} must be at most ${node.maximum}`);
  } else if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) problems.push(value.length === 0 ? `${at} must not be empty` : `${at} needs at least ${node.minItems} items`);
    if (typeof node.maxItems === "number" && value.length > node.maxItems) problems.push(`${at} takes at most ${node.maxItems} items (it has ${value.length})`);
    if (!record(node.items)) { if (value.length) problems.push(`${at} takes no items`); return; }
    value.forEach((item, index) => check(node.items, item, `${at}[${index}]`, problems, depth + 1));
  } else if (record(value)) {
    const declared = record(node.properties) ? node.properties : {};
    const keys = Object.keys(value);
    if (typeof node.maxProperties === "number" && keys.length > node.maxProperties) problems.push(`${at} takes at most ${node.maxProperties} fields`);
    for (const required of Array.isArray(node.required) ? node.required : []) if (!Object.hasOwn(value, required as string)) problems.push(`${at}.${required as string} is required`);
    for (const key of keys) {
      const where = at === "arguments" ? key : `${at}.${key}`;
      if (FORBIDDEN_KEY.test(key)) { problems.push(`${where} is not accepted: tools never take credentials, addresses or request parts`); continue; }
      if (Object.hasOwn(declared, key)) check(declared[key], value[key], where, problems, depth + 1);
      else if (record(node.additionalProperties)) check(node.additionalProperties, value[key], where, problems, depth + 1);
      else problems.push(`${where} is not a field of this tool`);
    }
  }
}

/** Why a call does not fit its tool's full schema, in words a model can act on; null when it fits. */
export function checkToolArguments(name: unknown, args: unknown): string | null {
  const entry = typeof name === "string" ? BY_NAME.get(name) : undefined;
  if (!entry) return `Unknown HighLevel tool. Use one of ${[...HIGHLEVEL_TOOL_NAMES, ...HIGHLEVEL_HELPER_NAMES].join(", ")}.`;
  if (!record(args)) return `${entry.name} was not run: its arguments must be an object.`;
  const problems: string[] = [];
  check(entry.inputSchema, args, "arguments", problems, 0);
  if (!problems.length) return null;
  return `${entry.name} was not run: ${problems.slice(0, 4).join("; ")}${problems.length > 4 ? `; and ${problems.length - 4} more` : ""}. Fix these and call it again.`;
}

// ---- running a checked call ---------------------------------------------------------------------------------------------

export interface HighLevelToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** What a receipt records for a change: the record id and the field names changed, never the values. */
export interface HighLevelWriteRecord {
  tool: HighLevelToolName;
  kind: "contact" | "note" | "task" | "opportunity" | "tags";
  recordId: string;
  fields: string[];
}

export function highlevelErrorResult(message: string, extra: Record<string, unknown> = {}): HighLevelToolResult {
  return { content: [{ type: "text", text: message }], structuredContent: { error: message, ...extra }, isError: true };
}

export function highlevelOk(value: unknown): HighLevelToolResult {
  const structured = record(value) ? value : { value };
  return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
}

const changed = (fields: object) => Object.entries(fields).filter(([key, value]) => value !== undefined && key !== "connectionId").map(([key]) => key).sort();

/** The field names a change would touch, for the review and the receipt. Empty means nothing to change. */
export function changedFields(name: HighLevelToolName, args: Record<string, unknown>): string[] {
  const { contactId: _c, opportunityId: _o, ...rest } = args;
  if (name === "HIGHLEVEL_ADD_TAGS" || name === "HIGHLEVEL_REMOVE_TAGS") return ["tags"];
  if (name === "HIGHLEVEL_ADD_NOTE") return ["body"];
  if (name === "HIGHLEVEL_CREATE_OPPORTUNITY") return changed(args);
  return changed(rest);
}

/** A change that cannot run as asked, said before review so the owner is never asked to approve nothing. */
export function changeProblem(name: HighLevelToolName, args: Record<string, unknown>): string | null {
  if (!isHighLevelWrite(name)) return null;
  if (name === "HIGHLEVEL_CREATE_CONTACT" && !args.email && !args.phone && !args.name && !args.firstName && !args.lastName) return "Give at least an email, a phone or a name to create a contact.";
  if ((name === "HIGHLEVEL_UPDATE_CONTACT" || name === "HIGHLEVEL_UPDATE_OPPORTUNITY") && changedFields(name, args).length === 0) return "Give at least one field to change.";
  return null;
}

/** Runs one checked, authorized CRM call. The write record is set only when a change succeeded. HighLevelError and
 * HighLevelStopped pass through so the caller can record the outcome. */
export async function runHighLevelTool(crm: HighLevelCrm, name: HighLevelToolName, args: Record<string, unknown>): Promise<{ value: unknown; write?: HighLevelWriteRecord }> {
  const { connectionId: _connection, ...a } = args as Record<string, any>;
  const problem = changeProblem(name, a);
  if (problem) throw new HighLevelError(problem, { status: 400 });
  switch (name) {
    case "HIGHLEVEL_SEARCH_CONTACTS": return { value: await crm.searchContacts(a) };
    case "HIGHLEVEL_GET_CONTACT": return { value: await crm.getContact(a.contactId) };
    case "HIGHLEVEL_CREATE_CONTACT": {
      const contact = await crm.createContact(a as ContactFields);
      return { value: contact, write: { tool: name, kind: "contact", recordId: contact.id, fields: changedFields(name, a) } };
    }
    case "HIGHLEVEL_UPDATE_CONTACT": {
      const { contactId, ...fields } = a;
      const contact = await crm.updateContact(contactId, fields as ContactFields);
      return { value: contact, write: { tool: name, kind: "contact", recordId: contactId, fields: changedFields(name, a) } };
    }
    case "HIGHLEVEL_ADD_TAGS": return { value: await crm.addTags(a.contactId, a.tags), write: { tool: name, kind: "tags", recordId: a.contactId, fields: ["tags"] } };
    case "HIGHLEVEL_REMOVE_TAGS": return { value: await crm.removeTags(a.contactId, a.tags), write: { tool: name, kind: "tags", recordId: a.contactId, fields: ["tags"] } };
    case "HIGHLEVEL_LIST_NOTES": return { value: await crm.listNotes(a.contactId) };
    case "HIGHLEVEL_ADD_NOTE": {
      const out = await crm.addNote(a.contactId, a.body);
      return { value: out, write: { tool: name, kind: "note", recordId: out.note.id, fields: ["body"] } };
    }
    case "HIGHLEVEL_LIST_TASKS": return { value: await crm.listTasks(a.contactId) };
    case "HIGHLEVEL_ADD_TASK": {
      const { contactId, ...task } = a;
      const out = await crm.addTask(contactId, task as { title: string; dueDate: string; body?: string; assignedTo?: string });
      return { value: out, write: { tool: name, kind: "task", recordId: out.task.id, fields: changedFields(name, a) } };
    }
    case "HIGHLEVEL_LIST_PIPELINES": return { value: await crm.listPipelines() };
    case "HIGHLEVEL_SEARCH_OPPORTUNITIES": return { value: await crm.searchOpportunities({ ...a, status: a.status === "all" ? undefined : a.status }) };
    case "HIGHLEVEL_GET_OPPORTUNITY": return { value: await crm.getOpportunity(a.opportunityId) };
    case "HIGHLEVEL_CREATE_OPPORTUNITY": {
      const out = await crm.createOpportunity(a as { pipelineId: string; stageId?: string; contactId: string; name: string; value?: number; status?: string });
      return { value: out, write: { tool: name, kind: "opportunity", recordId: out.id, fields: changedFields(name, a) } };
    }
    case "HIGHLEVEL_UPDATE_OPPORTUNITY": {
      const { opportunityId, ...fields } = a;
      const out = await crm.updateOpportunity(opportunityId, fields);
      return { value: out, write: { tool: name, kind: "opportunity", recordId: opportunityId, fields: changedFields(name, a) } };
    }
    case "HIGHLEVEL_SEARCH_CONVERSATIONS": return { value: await crm.searchConversations(a) };
    case "HIGHLEVEL_READ_CONVERSATION": return { value: await crm.readConversation(a.conversationId, a) };
    case "HIGHLEVEL_LIST_CALENDARS": return { value: await crm.listCalendars() };
    case "HIGHLEVEL_LIST_EVENTS": return { value: await crm.listEvents(a as { startTime: string; endTime: string; calendarId?: string; userId?: string }) };
    case "HIGHLEVEL_GET_LOCATION": return { value: await crm.getLocation() };
  }
}
