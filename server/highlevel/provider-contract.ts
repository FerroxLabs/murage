// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The positive endpoint manifest (GAP-HIGHLEVEL-109 sections 6 and 7): every request the native client may send is
// one of these method and path shapes, on the fixed provider host, with the listed Version header and scope. A path
// not listed here is refused before any credential is touched, so no tool can grow a route to messages, campaigns,
// workflows, payments, appointment writes or record deletion. Versions are the port starting point from OpenMausBot
// server/highlevel/client.ts; each is qualified against the provider in HIGHLEVEL-PROVIDER-MANIFEST.

/** The only host the native client talks to. There is no override, in production or in tests. */
export const HIGHLEVEL_API_ORIGIN = "https://services.leadconnectorhq.com";
export const HIGHLEVEL_VERSION = "2021-07-28";
export const HIGHLEVEL_CONVERSATIONS_VERSION = "2021-04-15";

export type HighLevelMethod = "GET" | "POST" | "PUT" | "DELETE";
/** read: may be sent again once after a failure. write: sent once; after a possible send its outcome is unknown. */
export type RetryClass = "read" | "write";

export interface HighLevelEndpoint {
  method: HighLevelMethod;
  /** The whole path, anchored. Ids are already percent-encoded by the caller. */
  path: RegExp;
  version: string;
  scope: string;
  retry: RetryClass;
}

const SEG = "[A-Za-z0-9_.~%-]+";
const p = (shape: string) => new RegExp(`^${shape.replaceAll(":id", SEG)}$`, "u");
const read = (method: HighLevelMethod, shape: string, scope: string, version = HIGHLEVEL_VERSION): HighLevelEndpoint =>
  ({ method, path: p(shape), version, scope, retry: "read" });
const write = (method: HighLevelMethod, shape: string, scope: string): HighLevelEndpoint =>
  ({ method, path: p(shape), version: HIGHLEVEL_VERSION, scope, retry: "write" });

export const HIGHLEVEL_ENDPOINTS = {
  "contacts.search": read("POST", "/contacts/search", "contacts.readonly"),
  "contacts.get": read("GET", "/contacts/:id", "contacts.readonly"),
  "contacts.create": write("POST", "/contacts/", "contacts.write"),
  "contacts.update": write("PUT", "/contacts/:id", "contacts.write"),
  "contacts.tags.add": write("POST", "/contacts/:id/tags", "contacts.write"),
  "contacts.tags.remove": write("DELETE", "/contacts/:id/tags", "contacts.write"),
  "contacts.notes.list": read("GET", "/contacts/:id/notes", "contacts.readonly"),
  "contacts.notes.add": write("POST", "/contacts/:id/notes", "contacts.write"),
  "contacts.tasks.list": read("GET", "/contacts/:id/tasks", "contacts.readonly"),
  "contacts.tasks.add": write("POST", "/contacts/:id/tasks", "contacts.write"),
  "pipelines.list": read("GET", "/opportunities/pipelines", "opportunities.readonly"),
  "opportunities.search": read("GET", "/opportunities/search", "opportunities.readonly"),
  "opportunities.get": read("GET", "/opportunities/:id", "opportunities.readonly"),
  "opportunities.create": write("POST", "/opportunities/", "opportunities.write"),
  "opportunities.update": write("PUT", "/opportunities/:id", "opportunities.write"),
  "conversations.search": read("GET", "/conversations/search", "conversations.readonly", HIGHLEVEL_CONVERSATIONS_VERSION),
  "conversations.messages": read("GET", "/conversations/:id/messages", "conversations/message.readonly", HIGHLEVEL_CONVERSATIONS_VERSION),
  "calendars.list": read("GET", "/calendars/", "calendars.readonly"),
  "calendars.events": read("GET", "/calendars/events", "calendars/events.readonly"),
  "locations.get": read("GET", "/locations/:id", "locations.readonly"),
  "locations.customFields": read("GET", "/locations/:id/customFields", "locations/customFields.readonly"),
} as const satisfies Record<string, HighLevelEndpoint>;

export type HighLevelOperation = keyof typeof HIGHLEVEL_ENDPOINTS;

/** The CRM scopes the twenty tools need, in one place for the Marketplace app registration (section 6). */
export const HIGHLEVEL_CRM_SCOPES: readonly string[] = [...new Set(Object.values(HIGHLEVEL_ENDPOINTS).map((entry) => entry.scope))].sort();

/** What HighLevel's permission pages call each scope, so a person can find the box to tick. */
export const HIGHLEVEL_PERMISSION_NAMES: Record<string, string> = {
  "contacts.readonly": "View Contacts", "contacts.write": "Edit Contacts",
  "opportunities.readonly": "View Opportunities", "opportunities.write": "Edit Opportunities",
  "conversations.readonly": "View Conversations", "conversations/message.readonly": "View Conversation Messages",
  "calendars.readonly": "View Calendars", "calendars/events.readonly": "View Calendar Events",
  "locations.readonly": "View Locations", "locations/customFields.readonly": "View Custom Fields",
};

/** The manifest entry for an operation and the exact path it will send, or null when the pair is not listed. A path
 * with a dot segment, query or fragment never matches. */
export function endpointFor(operation: string, method: string, path: string): HighLevelEndpoint | null {
  if (!Object.hasOwn(HIGHLEVEL_ENDPOINTS, operation)) return null;
  const entry: HighLevelEndpoint = HIGHLEVEL_ENDPOINTS[operation as HighLevelOperation];
  if (entry.method !== method) return null;
  if (path.includes("..") || path.includes("?") || path.includes("#") || /%2e|%2f|%5c/iu.test(path)) return null;
  return entry.path.test(path) ? entry : null;
}
