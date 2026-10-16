// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Connected-app tools reach a person as words. Engines name them by ids
// ("murage_connectors__APPS_SEARCH_TOOLS"; releases before 1.0.2 used the
// connection service's own ids, still read here for older rows), and those
// ids were printed on approval cards, activity rows and the Inbox. Product
// copy never names the service, and an id is not a sentence.

const SERVICE_TOOLS: Array<[RegExp, string]> = [
  [/^SEARCH_TOOLS$|^TOOL_SEARCH$/, "Look up which app tools to use"],
  [/EXECUTE/, "Run a connected-app action"],
  [/CONNECTION/, "Manage a connected app's sign-in"],
  [/SCHEMA/, "Read a connected-app tool's details"],
  [/WORKBENCH|BASH|CODE/, "Run code for a connected app"],
];

// A bare APPS_ id is read only for the session tools: an APPS_ word in a
// command or a file is somebody's own.
const TOKEN = /\b(?:mcp__)?(?:composio|murage_connectors)__([A-Za-z0-9_]+)|\bCOMPOSIO_([A-Z0-9_]+)\b|\bAPPS_(SEARCH_TOOLS|GET_TOOL_SCHEMAS|MULTI_EXECUTE_TOOL|MANAGE_CONNECTIONS|WAIT_FOR_CONNECTIONS|REMOTE_WORKBENCH|REMOTE_BASH_TOOL)\b/g;
const SERVICE_PREFIX = /^(?:COMPOSIO|APPS)_/;

function plainName(id: string): string {
  const upper = id.toUpperCase();
  if (SERVICE_PREFIX.test(upper)) {
    const rest = upper.replace(SERVICE_PREFIX, "");
    return SERVICE_TOOLS.find(([pattern]) => pattern.test(rest))?.[1] ?? "Use your connected apps";
  }
  const words = id.toLowerCase().split("_").filter(Boolean).join(" ");
  return words ? `Connected app: ${words.charAt(0).toUpperCase()}${words.slice(1)}` : "Use your connected apps";
}

/** The same text with every connected-app tool id said in plain words. */
export function plainConnectedAppText(text: string): string {
  return text.replace(TOKEN, (_match, namespaced: string | undefined, bare: string | undefined, exposed: string | undefined) =>
    plainName(namespaced ?? `APPS_${bare ?? exposed}`));
}
