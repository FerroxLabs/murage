// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The release notes of an update, as plain text for the renderer. electron-updater hands over the feed's notes as a
// string (often HTML) or a list of { version, note }. Nothing from the feed is ever rendered as markup: tags are
// removed here, the renderer shows text only, and the text is capped so one broadcast stays small.
// Idea from OpenMaus (Apache-2.0, updater-coordinator `releaseNotesText`).

export const RELEASE_NOTES_MAX = 8000;

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

function asText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry : typeof entry?.note === "string" ? entry.note : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function releaseNotesText(value) {
  let text = asText(value);
  if (!text) return undefined;
  text = text
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\s*li\b[^>]*>/gi, "\n- ")
    .replace(/<\s*(br|\/p|\/div|\/h[1-6]|\/ul|\/ol)\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|nbsp|#39);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return undefined;
  return text.length > RELEASE_NOTES_MAX ? text.slice(0, RELEASE_NOTES_MAX) : text;
}
