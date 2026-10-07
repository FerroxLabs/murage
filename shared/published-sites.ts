// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The sites a bot has put online, kept in that bot's own record so "update my
// site" goes to the same address. A bot may only update or take down a site it
// created or that the owner explicitly assigned to it.
export interface PublishedSite {
  siteId: string;
  /** The address label the owner chose, such as "my-shop". */
  name: string;
  url: string;
  lastPublishedAt: number;
  lastFileCount: number;
  /** "created": this bot published it. "assigned": the owner handed it to this bot. */
  origin: "created" | "assigned";
  /** Set when a publish failed after the site was made and Murage could not remove it:
   * it stays in the list, with a Take down button, so it is never public and untracked. */
  needsAttention?: true;
}

const ID = /^[A-Za-z0-9-]{1,64}$/;

function one(value: unknown): PublishedSite | null {
  if (!value || typeof value !== "object") return null;
  const site = value as Partial<PublishedSite>;
  if (typeof site.siteId !== "string" || !ID.test(site.siteId)) return null;
  if (typeof site.name !== "string" || site.name.length === 0 || site.name.length > 128) return null;
  if (typeof site.url !== "string" || site.url.length > 2048 || !/^https:\/\//.test(site.url)) return null;
  if (typeof site.lastPublishedAt !== "number" || !Number.isFinite(site.lastPublishedAt)) return null;
  if (typeof site.lastFileCount !== "number" || !Number.isInteger(site.lastFileCount) || site.lastFileCount < 0) return null;
  if (site.origin !== "created" && site.origin !== "assigned") return null;
  return { siteId: site.siteId, name: site.name, url: site.url, lastPublishedAt: site.lastPublishedAt, lastFileCount: site.lastFileCount, origin: site.origin, ...(site.needsAttention === true ? { needsAttention: true as const } : {}) };
}

/** The well-formed records in a stored list, one per site id (the newest wins). */
export function readPublishedSites(value: unknown): PublishedSite[] {
  if (!Array.isArray(value)) return [];
  const bySite = new Map<string, PublishedSite>();
  for (const item of value.slice(0, 200)) { const site = one(item); if (site) bySite.set(site.siteId, site); }
  return [...bySite.values()];
}

/** The name of the hidden entry that holds a Netlify access token the owner pasted. It is not a server
 * the bots use: it only gives the desktop shell's secret store a place to keep the value. */
export const NETLIFY_TOKEN_ENTRY = "publish-netlify";
/** The link entry Connect Netlify adds so the owner can sign in. */
export const NETLIFY_LINK_ENTRY = "netlify";
/** Where an owner makes a personal access token. */
export const NETLIFY_TOKEN_PAGE = "https://app.netlify.com/user/applications#personal-access-tokens";

/** Netlify's own MCP server. Murage uses it only to sign in: its tools deploy without the owner's
 * approval card, so a link to it is never mounted for a bot or relayed, switched on or off. */
export const NETLIFY_MCP_HOST = "netlify-mcp.netlify.app";
export function isNetlifyMcpUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  try { return new URL(url).hostname.toLowerCase().replace(/\.$/, "") === NETLIFY_MCP_HOST; } catch { return false; }
}
