// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
/** The Web search row switch (Settings v10 T1), shared by the Tools page and the server.
 * Off writes `off` and remembers the provider it replaced; On restores it.
 * Restoring a paid provider asks first (`needsAsk`). Owner: sv10-tools. */
const PAID = new Set(["tavily", "exa", "firecrawl", "flux"]);
export type SearchSwitchPatch = { provider: string; lastProvider?: string; needsAsk?: boolean };
export function webSearchSwitch(current: { provider?: string; lastProvider?: string } | undefined, on: boolean): SearchSwitchPatch {
  const provider = current?.provider ?? "engine";
  if (!on) return provider === "off" ? { provider: "off", ...(current?.lastProvider ? { lastProvider: current.lastProvider } : {}) } : { provider: "off", lastProvider: provider };
  if (provider !== "off") return { provider };
  const restore = current?.lastProvider && current.lastProvider !== "off" ? current.lastProvider : "engine";
  return { provider: restore, ...(PAID.has(restore) ? { needsAsk: true } : {}) };
}
