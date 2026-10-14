// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Typed codes from the memory server, said in plain words (PROPOSAL-v2 section
// 8, item 0.15). The server's raw codes and error strings never reach a screen:
// a code is mapped here, and anything unmapped falls back to a calm sentence.

const CODE = /^[A-Z][A-Z0-9_]{3,}$/;

/** A sentence the server wrote for a person is kept; a code is never shown. */
export function plainOrFallback(text: string | null | undefined, fallback: string): string {
  const value = (text ?? "").trim();
  return value && !CODE.test(value) && !/\bMEMORY_[A-Z_]+\b/.test(value) ? value : fallback;
}

/** A status figure the server counted up to a limit: "1,000+" when there are more than it counted. */
export function countText(n: number, more?: boolean): string {
  return `${n.toLocaleString("en-US")}${more ? "+" : ""}`;
}

/** What the background worker last said about itself. */
export function workerSentence(code: string | null | undefined): string {
  switch ((code ?? "").trim()) {
    case "": return "";
    case "MEMORY_WORKER_UNAVAILABLE": return "Memory is catching up and will try again shortly.";
    case "MEMORY_INDEX_FAILED": return "Search is catching up. Recent items may take a few minutes to show up.";
    case "MEMORY_CONSOLIDATION_FAILED": return "Learning will try again shortly. Everything already learned still works.";
    default: return plainOrFallback(code, "Memory is catching up and will try again shortly.");
  }
}

/** Why the optional search model did not finish. */
export function modelSentence(error: string | null | undefined): string {
  return plainOrFallback(error, "The search model did not finish downloading. You can try again.");
}

/** Said when a notebook change cannot be applied yet because memory is still being made ready after an update. */
export const INDEX_BUILDING_SENTENCE = "Murage is still getting memory ready after the update. This notebook will update by itself in a few minutes.";
export function importSentence(code: string | null | undefined, fallback: string): string {
  return /MEMORY_IMPORT_INDEX_BUILDING/.test(code ?? "") ? INDEX_BUILDING_SENTENCE : fallback;
}
