// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Learn about me: the label a kept line carries. The record id of a kept line is
// `owner-note:<provider>:<precision>:<hash>` (server/memory/authority.ts
// rememberMemory); the id carries the label only, never an access rule.
import { LAM_PROVIDERS, type LamProvider } from "./parse.ts";

/** d: dated to the day, m: to the month, y: to the year, u: undated. */
export type LamDatePrecision = "d" | "m" | "y" | "u";
export const OWNER_NOTE_PREFIX = "owner-note:";

export function ownerNoteId(provider: LamProvider | "typed", precision: LamDatePrecision, hash: string): string {
  return `${OWNER_NOTE_PREFIX}${provider}:${precision}:${hash}`;
}

/** Where a kept line came from, read back from its record id; null for every other memory. */
export function rememberedOrigin(id: string): { provider: LamProvider; precision: LamDatePrecision } | null {
  const match = /^owner-note:([a-z]+):([dmyu]):[0-9a-f]{32}$/.exec(id);
  if (!match || !(LAM_PROVIDERS as readonly string[]).includes(match[1]!)) return null;
  return { provider: match[1] as LamProvider, precision: match[2] as LamDatePrecision };
}

export const LAM_PROVIDER_NAMES: Record<LamProvider, string> = {
  chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", grok: "Grok", copilot: "Copilot", other: "",
};
