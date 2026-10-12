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
