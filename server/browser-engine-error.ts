// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The browser engine's own failures, apart from the relay so that test
// fixtures which stand in for the relay leave this classification real.
/** What the owner sees when the bot's browser engine fails. The engine's own
 * reason goes to the server log only: it can name local paths and pages. */
export const BROWSER_ENGINE_COPY = {
  start: "Murage's browser could not start. Take control, then choose Reopen blank page to try again.",
  failed: "Murage's browser stopped working. Take control, then choose Reopen blank page to restart it.",
  timeout: "Murage's browser stopped responding. Take control, then choose Reopen blank page to restart it.",
  overflow: "Murage's browser sent back more than it can read. Take control, then choose Reopen blank page to restart it.",
  refused: "Murage's browser could not finish that step. Try it again, or take control and choose Reopen blank page.",
} as const;
export class BrowserEngineError extends Error {
  readonly kind: keyof typeof BROWSER_ENGINE_COPY;
  constructor(kind: keyof typeof BROWSER_ENGINE_COPY) { super(BROWSER_ENGINE_COPY[kind]); this.name = "BrowserEngineError"; this.kind = kind; }
}
/** The engine is not running or not answering: its command line failed, or
 * the page guard could not reach Chrome at all. This says nothing about the
 * page, so it never locks one as sensitive (browser-control.ts). */
const GUARD_CONNECTION_FAILURES = new Set(["Browser guard unavailable", "Browser guard disconnected", "Browser document guard disconnected"]);
export function browserEngineDown(error: unknown): boolean {
  return error instanceof BrowserEngineError || (error instanceof Error && GUARD_CONNECTION_FAILURES.has(error.message));
}
