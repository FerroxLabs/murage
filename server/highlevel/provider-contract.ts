// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// HL-WRITES-1019: routes are qualified against the versioned provider reference and scope table.
// The Location-token manifest includes unavailable rows explicitly; only qualified rows can dispatch.
import { HIGHLEVEL_PROVIDER_MANIFEST } from "./provider-manifest.ts";

/** The only host the native client talks to. There is no override, in production or in tests. */
export const HIGHLEVEL_API_ORIGIN = "https://services.leadconnectorhq.com";
export const HIGHLEVEL_VERSION = "2021-07-28";
export const HIGHLEVEL_CONVERSATIONS_VERSION = "2021-04-15";

export type HighLevelMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
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
/** Compile literal path segments, replacing only documented placeholders. */
export function highlevelEndpointPattern(shape: string): RegExp {
  return new RegExp("^" + shape.split(/(:[A-Za-z][A-Za-z0-9]*|\{[^}]+\})/u).map(part => /^(?::[A-Za-z][A-Za-z0-9]*|\{[^}]+\})$/u.test(part) ? SEG : part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("") + "$", "u");
}
export const HIGHLEVEL_ENDPOINTS: Readonly<Record<string, HighLevelEndpoint>> = Object.freeze({
  ...Object.fromEntries(HIGHLEVEL_PROVIDER_MANIFEST.filter(row => row.status === "qualified").map(row => [row.operation, {
    method: row.method!, path: highlevelEndpointPattern(row.path!), version: row.Version, scope: row.scope!, retry: row.retryClass,
  }])),
});
export type HighLevelOperation = keyof typeof HIGHLEVEL_ENDPOINTS;

/** The qualified Location-token scopes all frozen families need, in one place for the Marketplace app registration (section 6). */
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
  if (path.includes("..") || path.includes("?") || path.includes("#") || /%(?![0-9a-f]{2})|%25|%2e|%2f|%5c/iu.test(path)) return null;
  return entry.path.test(path) ? entry : null;
}

// Human permission labels for the complete frozen scope list. Existing labels above are retained.
for (const scope of HIGHLEVEL_CRM_SCOPES) {
  if (!HIGHLEVEL_PERMISSION_NAMES[scope]) {
    const [resource, permission] = scope.split(".");
    const label = resource!.replaceAll("/", " ").replaceAll("_", " ").replace(/([a-z])([A-Z])/gu, "$1 $2");
    HIGHLEVEL_PERMISSION_NAMES[scope] = `${permission === "readonly" || permission === "read" ? "View" : "Edit"} ${label}`;
  }
}
