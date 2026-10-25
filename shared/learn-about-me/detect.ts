// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Learn about me: does a chat message read like an export from another
// assistant (PASTE-CAPTURE-FIX 3.1)? Pure code. A positive answer keeps the
// paste out of memory (capture.ts) and shows the owner a line that opens Learn
// about me with it filled in. Unsure means no: the message is captured as any
// other, with its numbers masked, and the owner loses nothing either way.
import { headingOf, opensWithDate } from "./parse.ts";

const MIN_LINES = 12;
const KEYED_MIN_LINES = 25;
const KEYS = new Set([
  "name", "born", "birthday", "lives", "location", "city", "address", "employer", "company", "title", "role", "email", "phone", "bank",
  "account", "spouse", "partner", "kids", "children", "allergies", "diet", "timezone", "language", "languages",
]);
const KEYED = /^\s*(?:[-*+]\s+)?([A-Za-z]+)\s*:\s*\S/;
const CODE_LIKE = /[{;]|=>|:\/\/|\b\d{1,2}:\d{2}:\d{2}\b/;

export function looksLikeExport(text: string): boolean {
  if (typeof text !== "string" || text.includes("```")) return false;
  // one count first: a short message is never split
  let breaks = 0;
  for (let at = text.indexOf("\n"); at !== -1 && breaks < MIN_LINES - 1; at = text.indexOf("\n", at + 1)) breaks++;
  if (breaks < MIN_LINES - 1) return false;
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map(line => line.trim()).filter(Boolean);
  if (lines.length < MIN_LINES) return false;
  let code = 0, headings = 0, dated = 0, keyed = 0;
  const seen = new Set<string>();
  for (const line of lines) {
    if (CODE_LIKE.test(line)) code++;
    const heading = headingOf(line);
    if (heading && !seen.has(heading)) { seen.add(heading); headings++; }
    if (opensWithDate(line)) dated++;
    const key = line.match(KEYED)?.[1]?.toLowerCase();
    if (key && KEYS.has(key)) keyed++;
  }
  // a log or a code paste is captured as any other message
  if (code * 5 > lines.length) return false;
  return headings >= 2 || dated >= 8 || (lines.length >= KEYED_MIN_LINES && keyed >= 5);
}
