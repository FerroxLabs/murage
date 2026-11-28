// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The fixed-words refusal of a learning call (not the turn send fence of send-fence.ts). The gate that decides it is learning-send.ts
// (designs/MEM-LEARNING-FENCE-R8.md): a call whose words were forgotten, deleted, edited or withdrawn after it read them is dropped
// before anything is written to any engine, and the error and its one log line carry fixed words only.

export const MEMORY_SEND_FENCED = "MEMORY_SEND_FENCED";
export class MemorySendFenced extends Error {
  constructor() { super(MEMORY_SEND_FENCED); this.name = "memory-send-fenced"; }
}
export const isMemorySendFenced = (error: unknown): boolean =>
  error instanceof MemorySendFenced || (error as { message?: unknown } | null)?.message === MEMORY_SEND_FENCED;

/** The one log line of a dropped call: fixed words, the purpose label and the gate's fixed-word cause only, never the words it held. */
export function logFencedDrop(purpose: "extraction" | "grounding" | "evaluation" | "reflection" | "continuity", cause?: string): void {
  const why = cause && /^[a-z-]{1,24}$/.test(cause) ? cause : "unknown";
  try { console.info(`[memory] learning call dropped before send: reason=memory-changed purpose=${purpose} cause=${why}`); } catch { /* logging is best effort */ }
}
