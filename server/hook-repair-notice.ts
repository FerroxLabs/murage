// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { engineHookRepairFailureLine } from "../shared/provider-error.ts";

export const hookRepairLine = engineHookRepairFailureLine;
let changed: (() => void) | undefined;
export function onHookRepairNeedsChanged(notify: () => void): void { changed = notify; }
const needs = new Map<string, { engine: string; at: number; sentence: string }>();
/** A single outstanding need per engine. Repeated failures never add another row. */
export function noteHookRepairFailure(engine: string, now = Date.now()): void {
  const prior = needs.get(engine);
  if (!prior || now - prior.at >= 3_600_000) { needs.set(engine, { engine, at: now, sentence: hookRepairLine(engine) }); try { changed?.(); } catch { /* A refresh failure cannot change the refusal. */ } }
}
export function hookRepairNeeds() { return [...needs.values()]; }
export function withHookRepairNeeds<T extends { decisions?: number }>(body: T, owner: boolean): T & { hookRepairNeeds?: ReturnType<typeof hookRepairNeeds> } {
  const rows = owner ? hookRepairNeeds() : [];
  return rows.length ? { ...body, hookRepairNeeds: rows, ...(typeof body.decisions === 'number' ? { decisions: body.decisions + rows.length } : {}) } : body;
}
