// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 SL-I I2: when each engine's limit resets, from the refusals it gave
// (I1) and from a plan sign-in's pause (model-gateway). <dataDir>/limit-state.json
// `{[engineKey]: {resetsAt | null, at}}`, epoch ms only (a clock change or DST
// moves nothing). Read by the turn resolver, routine limit waits and the card.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

export const LIMIT_STATE_FILE = "limit-state.json";
/** No reset time known: try again after an hour. */
export const LIMIT_NO_RESET_MS = 60 * 60_000;

export interface LimitStateEntry { resetsAt: number | null; at: number }
export type LimitState = Record<string, LimitStateEntry>;

export { engineKey } from "../shared/limit-engine-key.ts";

export function limitUntil(entry: LimitStateEntry): number {
  return entry.resetsAt ?? entry.at + LIMIT_NO_RESET_MS;
}

export class LimitStateStore {
  private readonly dataDir: () => string;
  constructor(dataDir: () => string) { this.dataDir = dataDir; }
  private get file(): string { return join(this.dataDir(), LIMIT_STATE_FILE); }

  read(): LimitState {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
      const out: LimitState = {};
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const entry = value as Partial<LimitStateEntry> | null;
        if (!entry || typeof entry.at !== "number" || !Number.isFinite(entry.at)) continue;
        out[key] = { at: entry.at, resetsAt: typeof entry.resetsAt === "number" && Number.isFinite(entry.resetsAt) ? entry.resetsAt : null };
      }
      return out;
    } catch { return {}; }
  }

  get(key: string): LimitStateEntry | undefined { return this.read()[key]; }

  record(key: string, resetsAt: number | null | undefined, now: number): LimitStateEntry {
    const state = this.read();
    const entry = { resetsAt: resetsAt ?? null, at: now };
    state[key] = entry;
    // entries well past their reset are dropped as the file is written
    for (const [other, value] of Object.entries(state)) if (limitUntil(value) < now - 24 * 60 * 60_000) delete state[other];
    writeFileAtomic(this.file, JSON.stringify(state), { mode: 0o600 });
    return entry;
  }

  /** At its limit now: a known entry whose reset (or the hour after it was seen) is still ahead. */
  atLimit(key: string, now: number): boolean {
    const entry = this.get(key);
    return Boolean(entry && limitUntil(entry) > now);
  }
}
