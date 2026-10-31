// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GET /api/help/search?q=<words>[&limit=1-5] (UX overhaul slice 4, lane L4A).
// The help panel's "Search help": the same local search over the shipped
// documentation that a bot's murage_help tool reads (shared/help-search.ts).
// No engine, no network and no owner data: the corpus is the docs this build
// shipped with, so it answers on a machine with nothing to think with, on the
// phone through the Door and in a Cloud window alike.
import { searchHelp, type HelpResult } from "../shared/help-search.ts";

export const HELP_SEARCH_PATH = "/api/help/search";
/** Longer than any real question; anything past it is cut, not refused. */
export const HELP_QUERY_MAX = 200;

export interface HelpRouteAnswer { status: number; body: unknown }
export interface HelpSearchAnswer { query: string; results: HelpResult[] }

/** The route, or null when the request is not for it. Pure: no state, no I/O. */
export function helpRoute(req: { method: string; url: URL }): HelpRouteAnswer | null {
  if (req.url.pathname !== HELP_SEARCH_PATH) return null;
  if (req.method !== "GET") return { status: 405, body: { error: "Use GET to search the help.", code: "METHOD" } };
  const query = (req.url.searchParams.get("q") ?? "").replace(/\s+/g, " ").trim().slice(0, HELP_QUERY_MAX);
  const rawLimit = req.url.searchParams.get("limit");
  const limit = rawLimit === null ? 5 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) return { status: 400, body: { error: "limit is a whole number from 1 to 5", code: "INVALID_LIMIT" } };
  // "constructor" names an Object.prototype member, which the shared search's
  // alias table (a plain object) would read as an alias list and throw on.
  // It is no help word either, so it is left out of the search, not refused.
  // Split the way shared/help-search.ts tokenize() splits, so no spelling
  // (`_constructor_`, `x.constructor`) reaches the table.
  const words = query.split(/[^A-Za-z0-9]+/).filter((word) => word && word.toLowerCase() !== "constructor").join(" ");
  const body: HelpSearchAnswer = { query, results: words ? searchHelp(words, { limit }) : [] };
  return { status: 200, body };
}
