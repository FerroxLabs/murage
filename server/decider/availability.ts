// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Whether the hosted decision model can be used with the key in hand. Flux
// answers 403 `paid_plan_required` to a plan that does not include it. We
// remember that for one key, in memory only, for a cooldown, so the app stops
// asking (and stops offering Auto) without a call per message, and asks again
// later in case the plan changed. The key itself is never stored: only a hash.
import { createHash } from "node:crypto";

export const PLAN_COOLDOWN_MS = 6 * 60 * 60 * 1_000;
const MAX_ENTRIES = 16;
const until = new Map<string, number>();

const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);

export function markDeciderUnavailable(key: string, now = Date.now()): void {
  if (until.size >= MAX_ENTRIES) until.delete(until.keys().next().value as string);
  until.set(fingerprint(key), now + PLAN_COOLDOWN_MS);
}

export function deciderUnavailable(key: string | null | undefined, now = Date.now()): boolean {
  if (!key) return false;
  const id = fingerprint(key);
  const limit = until.get(id);
  if (limit === undefined) return false;
  if (limit <= now) {
    until.delete(id);
    return false;
  }
  return true;
}

export function resetDeciderAvailability(): void {
  until.clear();
}
