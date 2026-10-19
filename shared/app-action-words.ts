// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Connected-app actions in plain words, and which remembered grants are in a
// shape the current key builder writes. Small on purpose: the approval card
// and Settings read it on first paint, so it never pulls in the call readers
// (shared/connected-app-calls.ts). What a grant is keyed by is decided in
// shared/app-action-grant.ts.

import { CONNECTED_APPS_SERVER, canonicalConnectedAppToolName, exposedToolName, isConnectedAppsServer } from "./connected-app-names.ts";
import { ACP_TOOL_V2_PREFIX, parseAcpToolKey } from "./mount-identity.ts";

/** A grant over one connected-app action: `app-action:GMAIL_SEND_EMAIL`. */
export const APP_ACTION_PREFIX = "app-action:";
/** A grant over one MCP tool on a custom or external mount, by the mount's
 * identity and the tool, Rule 59 encoded: `acp-tool:v2:custom%3Agithub/create%5Fissue`.
 * The r1 shape `acp-tool:mcp:<name>` is never written (Rule 42). */
export const ACP_TOOL_PREFIX = ACP_TOOL_V2_PREFIX;

const APP_WORDS: Record<string, string> = {
  GMAIL: "Gmail", GOOGLECALENDAR: "Google Calendar", GOOGLEDRIVE: "Google Drive", GOOGLEDOCS: "Google Docs",
  GOOGLESHEETS: "Google Sheets", GOOGLESUPER: "Google", OUTLOOK: "Outlook", SLACK: "Slack", NOTION: "Notion",
  GITHUB: "GitHub", LINEAR: "Linear", HUBSPOT: "HubSpot", SALESFORCE: "Salesforce", DISCORD: "Discord",
  TWITTER: "X", LINKEDIN: "LinkedIn", DROPBOX: "Dropbox", ASANA: "Asana", TRELLO: "Trello", JIRA: "Jira",
};

/** "GMAIL_FETCH_EMAILS" said as an app and an action. */
export function appAction(slug: string): { app: string; action: string } | null {
  const parts = slug.trim().toUpperCase().split("_").filter(Boolean);
  if (parts.length < 2 || !/^[A-Z0-9_]+$/.test(slug.trim().toUpperCase())) return null;
  const head = parts[0]!;
  const app = APP_WORDS[head] ?? `${head.charAt(0)}${head.slice(1).toLowerCase()}`;
  return { app, action: parts.slice(1).join(" ").toLowerCase() };
}

/** Tool names that say nothing about which action runs: ACP's catch-all kind,
 * the driver's fallback, a wrapper that runs any tool by name, the label the
 * Pi driver files every connected-app ask under, and an engine's own name
 * (what a driver files an ask under when it could not read the call). None
 * of these is ever a grant key: a grant over "pi" would answer every ask
 * that engine could not name (Astra r3). */
const GENERIC_TOOLS = new Set(["other", "tool", "use_tool", "connected app", "", "pi", "claude", "codex", "fuigo", "acp", "engine", "permission"]);

export function isGenericTool(tool: string): boolean {
  return GENERIC_TOOLS.has(tool.trim().toLowerCase());
}

/** Connected-app tools that only look something up. Their name is the one
 * thing they do, so their grant stays the tool. */
export const APP_LOOKUPS: Readonly<Record<string, string>> = {
  COMPOSIO_SEARCH_TOOLS: "find app tools",
  COMPOSIO_GET_TOOL_SCHEMAS: "read how an app tool works",
  COMPOSIO_WAIT_FOR_CONNECTIONS: "wait for an app to connect",
  CHECK_CONNECTED_APP_ACTION: "check on an app action",
};

/** The bare service id of one of Murage's own connected-app tools, in any
 * name a release or engine gave it; undefined for every other tool. */
export function ownAppTool(name: string): string | undefined {
  const canonical = canonicalConnectedAppToolName(name.trim());
  const served = /^(?:mcp__composio__|composio(?:__|_|[:/.]\s*))(.+)$/i.exec(canonical);
  if (served) return served[1]!.toUpperCase();
  return /^COMPOSIO_[A-Z0-9_]+$/i.test(canonical) ? canonical.toUpperCase() : undefined;
}

const SLUG = /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/;
/** The one spelling of each lookup grant the key builder writes. */
const LOOKUP_KEYS = new Set(Object.keys(APP_LOOKUPS).map((app) => `mcp__${CONNECTED_APPS_SERVER}__${exposedToolName(app)}`));
/** Murage's connector named at the front of a key, in any engine's joiner. */
const OWN_SERVER_PREFIX = /^(?:mcp__)?(?:composio|murage_connectors)(?:__|_|[:/.]|$)/i;

/** Whether a server name is, or is spelled to pass for, Murage's connector:
 * such a mount gets no standing grant of its own either. */
export function namesOwnServer(server: string): boolean {
  return isConnectedAppsServer(server) || OWN_SERVER_PREFIX.test(server);
}

/** Whether a key is one of the three shapes shared/app-action-grant.ts
 * writes for the connected-app domain, exactly. */
export function isCurrentAppGrant(key: string): boolean {
  if (key.startsWith(APP_ACTION_PREFIX)) {
    const slug = key.slice(APP_ACTION_PREFIX.length);
    return SLUG.test(slug) && ownAppTool(slug) === undefined;
  }
  if (key.startsWith(ACP_TOOL_PREFIX)) {
    const parsed = parseAcpToolKey(key);
    // the builder writes only custom and external mounts this way, never an own one
    return !!parsed && !isGenericTool(parsed.tool) && /^(custom|external):/.test(parsed.mountId);
  }
  return LOOKUP_KEYS.has(key);
}

/** Whether a key names the connected-app domain in any spelling: a generic
 * kind, Murage's connector or a service tool id under any name an engine or
 * release used, or one of this lane's prefixes. Wide on purpose: a key this
 * over-matches is dropped and the owner is asked once more, which is the
 * direction this may fail in. */
function touchesAppDomain(key: string): boolean {
  return isGenericTool(key)
    || ownAppTool(key) !== undefined
    || canonicalConnectedAppToolName(key) !== key
    || OWN_SERVER_PREFIX.test(key)
    || key.startsWith(APP_ACTION_PREFIX)
    || key.startsWith("acp-tool:")
    || /connected[ _-]?apps?/i.test(key);
}

/** Whether a remembered grant that names the connected-app domain is not in
 * a shape the current key builder writes (an allowlist of shapes, not a
 * denylist of old ones): the bare kind "other", the execute tool under any
 * release's name, Pi's "Connected app", a lookup in an engine's own
 * spelling. Such a grant is never stored; one an older release saved is
 * dropped at load. A key outside the domain is left as it is. */
export function isStaleGrant(key: string): boolean {
  const bare = key.replace(/^local-computer:/, "");
  return touchesAppDomain(bare) && !isCurrentAppGrant(bare);
}

export function withoutStaleGrants(keys: string[]): string[] {
  return keys.filter((key) => !isStaleGrant(key));
}

/** Rule 57b (APP-GRANT-DESIGN-FINAL.AGREED-r10.md): the grant schema the key
 * builder writes. A bot record carries it only once the builder has stored a
 * key of the three app shapes for it. */
export const GRANT_SCHEMA = 2;

/** Whether a key is one of the three app shapes this lane introduced, in any
 * spelling: an action key, a stamped-tool key of any version, or a
 * connected-app lookup under any server name. */
export function isAppShapeKey(key: string): boolean {
  const bare = key.replace(/^local-computer:/, "");
  return bare.startsWith(APP_ACTION_PREFIX) || bare.startsWith("acp-tool:") || /^mcp__.+__apps_/i.test(bare);
}

/** Rule 57b: none of this lane's shapes is carried over. On a record without
 * `grantSchema: 2` every key of the three shapes is dropped at load. */
export function withoutPreSchemaGrants(keys: string[], grantSchema: unknown): string[] {
  return grantSchema === GRANT_SCHEMA ? keys : keys.filter((key) => !isAppShapeKey(key));
}

/** A connected-app grant in plain words, "Gmail: send email"; undefined for
 * any other key. */
export function actionGrantWords(key: string): string | undefined {
  if (key.startsWith(APP_ACTION_PREFIX)) {
    const named = appAction(key.slice(APP_ACTION_PREFIX.length));
    return named ? `${named.app}: ${named.action}` : undefined;
  }
  const parsed = parseAcpToolKey(key);
  if (parsed) return `The tool ${parsed.tool} on ${parsed.mountId.replace(/^custom:/, "").replace(/^external:[^:]+:[0-9a-f]+:/, "")}`;
  const app = ownAppTool(key);
  return app !== undefined && APP_LOOKUPS[app] !== undefined ? `Connected apps: ${APP_LOOKUPS[app]}` : undefined;
}
