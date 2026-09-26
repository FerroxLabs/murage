// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Connected-app tools reach a person as words. Engines name them by the
// connection service's own ids ("composio__COMPOSIO_SEARCH_TOOLS"), and those
// ids were printed on approval cards, activity rows and the Inbox. Product
// copy never names the service, and an id is not a sentence.

const SERVICE_TOOLS: Array<[RegExp, string]> = [
  [/^SEARCH_TOOLS$|^TOOL_SEARCH$/, "Look up which app tools to use"],
  [/EXECUTE/, "Run a connected-app action"],
  [/CONNECTION/, "Manage a connected app's sign-in"],
  [/SCHEMA/, "Read a connected-app tool's details"],
  [/WORKBENCH|BASH|CODE/, "Run code for a connected app"],
];

const TOKEN = /\b(?:mcp__)?composio__([A-Za-z0-9_]+)|\bCOMPOSIO_([A-Z0-9_]+)\b/g;

function plainName(id: string): string {
  const upper = id.toUpperCase();
  if (upper.startsWith("COMPOSIO_")) {
    const rest = upper.slice("COMPOSIO_".length);
    return SERVICE_TOOLS.find(([pattern]) => pattern.test(rest))?.[1] ?? "Use your connected apps";
  }
  const words = id.toLowerCase().split("_").filter(Boolean).join(" ");
  return words ? `Connected app: ${words.charAt(0).toUpperCase()}${words.slice(1)}` : "Use your connected apps";
}

/** The same text with every connected-app tool id said in plain words. */
export function plainConnectedAppText(text: string): string {
  return text.replace(TOKEN, (_match, namespaced: string | undefined, bare: string | undefined) =>
    plainName(namespaced ?? `COMPOSIO_${bare}`));
}
