// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Risk } from '../../shared/highlevel.ts';
import { ActionRefused, normalizeArguments } from './actions.ts';
import type { Escalation } from './escalation.ts';
type Counters = { changes: number; sends: number; loops: Map<string, number[]> };
export class HighLevelEscalation {
  readonly #turns = new Map<string, Counters>();
  reserve(turnKey: string, spec: { id: string; risk: Risk; send?: boolean; targets(a: Record<string, unknown>): number }, args: Record<string, unknown>, now = Date.now(), noLimits = false): { risk: Risk; escalation: Escalation } {
    if (spec.risk === 'R') return { risk: 'R', escalation: 'none' };
    let counts = this.#turns.get(turnKey);
    if (!counts) { if (this.#turns.size >= 4096) throw new ActionRefused('busy', 'HighLevel is busy.'); counts = { changes: 0, sends: 0, loops: new Map() }; this.#turns.set(turnKey, counts); }
    if (!noLimits && counts.changes >= 200) throw new ActionRefused('busy', 'HighLevel is busy: this turn has reached 200 changes.');
    counts.changes++;
    let risk = spec.risk, escalation: Escalation = 'none';
    if (spec.targets(args) > 1) { risk = 'D'; escalation = 'targets'; }
    if ((spec.send === true || (spec.send === undefined && /(?:^|\.)send(?:\.|$)/.test(spec.id))) && ++counts.sends >= 6) { risk = 'D'; escalation = 'send_count'; }
    if (spec.risk === 'C') {
      const shape = (v: unknown): unknown => Array.isArray(v) ? v.map(shape) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /ids?$/i.test(k) ? '<id>' : shape(x)])) : v;
      const key = JSON.stringify([spec.id, normalizeArguments(shape(args) as Record<string, unknown>)]);
      const times = (counts.loops.get(key) ?? []).filter(time => now - time <= 60_000); times.push(now); counts.loops.set(key, times);
      if (times.length >= 4) { risk = 'D'; escalation = 'identical_loop'; }
    }
    return { risk, escalation };
  }
  drop(turnKey: string): void { this.#turns.delete(turnKey); }
}
