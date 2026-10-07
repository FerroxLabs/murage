// SPDX-License-Identifier: AGPL-3.0-or-later
// T21: no mode, category, grant, routine flag or verdict is ever less strict than the floor, and a looser mode never asks for more.
import { describe, expect, it } from 'vitest';
import { classifyLevel, type ApprovalMode, type LevelInput, type SiteCategory } from './browser-levels.ts';
import { decide } from './browser-extension-decide.ts';
import { classifyFloor } from './browser-floor.ts';

// A small seeded generator, so a failure replays.
const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const pick = <T,>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)]!;
const MODES: ApprovalMode[] = ['step', 'task', 'full'];
const CATEGORIES: SiteCategory[] = ['handover', 'neverDefault', 'askEveryStep', 'normal'];
const FACTS = [
  { operation: 'click', tag: 'button', role: 'button', name: 'Send message' }, { operation: 'click', tag: 'button', role: 'button', name: 'Save' },
  { operation: 'click', tag: 'input', type: 'checkbox', role: 'checkbox', name: 'I agree to the terms of service' },
  { operation: 'click', tag: 'button', role: 'button', name: 'Place your order', page: { hasPaymentRequestButton: true } },
  { operation: 'fill', tag: 'input', type: 'password', role: 'textbox', name: 'Password' }, { operation: 'fill', tag: 'input', type: 'text', role: 'textbox', name: 'Notes' },
  { operation: 'click', tag: 'div', role: 'checkbox', name: "I'm not a robot" }, { operation: 'snapshot' }, { operation: 'scroll' },
] as const;

const input = (r: () => number, mode: ApprovalMode, shared: { facts: (typeof FACTS)[number]; category: SiteCategory; routine: boolean; l1: boolean; l2: boolean; always: boolean; intent: 'pass' | 'card' | 'refuse'; checker: 'allow' | 'ask' | 'block' }): LevelInput => {
  void r;
  const facts = { ...shared.facts } as never as LevelInput['facts'];
  const floor = classifyFloor(facts);
  return { operation: shared.facts.operation, facts, floor: floor.floor ? floor : null, category: shared.category, mode, routine: shared.routine,
    grants: { l1: shared.l1, l2: shared.l2 }, siteAllowedAlways: shared.always, intent: shared.intent, checker: shared.checker };
};
const strictness = (r: ReturnType<typeof classifyLevel>) => r.level === 'floor' ? 4 : r.refuse ? 3 : r.skip ? 3 : r.needsCard ? 2 : 0;

describe('T21 property: the mode never loosens the floor or the refusals', () => {
  it('for 4000 random situations the floor, every refusal and every skip are the same in step, task and full', () => {
    const r = rng(2101);
    for (let n = 0; n < 4000; n++) {
      const shared = { facts: pick(r, FACTS), category: pick(r, CATEGORIES), routine: r() < 0.3, l1: r() < 0.5, l2: r() < 0.5, always: r() < 0.3,
        intent: pick(r, ['pass', 'card', 'refuse'] as const), checker: pick(r, ['allow', 'ask', 'block'] as const) };
      const results = MODES.map(mode => classifyLevel(input(r, mode, shared)));
      const floor = classifyFloor(shared.facts as never);
      for (const result of results) {
        if (floor.floor) { expect(result.level, JSON.stringify(shared)).toBe('floor'); expect(result.needsCard).toBe(false); }
        // A refusal or a skip is a property of the site and the verdicts, not of the mode.
        expect(!!result.refuse, JSON.stringify(shared)).toBe(!!results[0]!.refuse);
        expect(!!result.skip, JSON.stringify(shared)).toBe(!!results[0]!.skip);
        expect(result.level, JSON.stringify(shared)).toBe(results[0]!.level);
      }
      // Looser modes never ask for more: step >= task >= full.
      expect(strictness(results[0]!), JSON.stringify(shared)).toBeGreaterThanOrEqual(strictness(results[1]!));
      expect(strictness(results[1]!), JSON.stringify(shared)).toBeGreaterThanOrEqual(strictness(results[2]!));
      // Ask-every-step sites and a failed verdict never lose the card to Full permissive.
      if (shared.category === 'askEveryStep' && results[2]!.level !== 'floor' && results[2]!.level !== 'L1' && !results[2]!.refuse && !results[2]!.skip) expect(results[2]!.needsCard, JSON.stringify(shared)).toBe(true);
      if (results[2]!.level === 'L3' && !results[2]!.refuse && !results[2]!.skip && shared.checker !== 'allow') expect(results[2]!.needsCard, JSON.stringify(shared)).toBe(true);
    }
  });

  it('decide() answers floor for every mode when the floor has a result, whatever else says pass', async () => {
    const floor = classifyFloor({ operation: 'click', tag: 'input', type: 'checkbox', role: 'checkbox', name: 'I agree to the terms of service' } as never);
    expect(floor.floor).not.toBeNull();
    for (const mode of MODES) for (const category of CATEGORIES.filter(c => c === 'normal' || c === 'askEveryStep')) {
      const decision = await decide({
        bindingActive: true, ownerAudience: true, siteAccess: 'allow', category, floor, operation: 'click', facts: { operation: 'click', tag: 'input', type: 'checkbox', role: 'checkbox', name: 'I agree to the terms of service' } as never,
        mode, routine: false, grants: { l1: true, l2: true }, siteAllowedAlways: true, probeFlagged: false,
        intent: { ownerWords: [], taskSites: new Set(), readOrigins: new Map(), counters: { hits: 0 }, action: { operation: 'click', origin: 'https://a.test' } },
      } as never, { classifyLevel, checkIntent: () => ({ result: 'pass' }), checkAction: async () => ({ decision: 'allow', code: 'ok', stage: 2, reason: 'ok' }) } as never);
      expect(decision.outcome, `${mode} ${category}`).toBe('floor');
    }
  });

  it('the floor module has no way to read a mode', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./browser-floor.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\b(browserApproval|approvalMode|ApprovalMode)\b/);
    expect(classifyFloor.length).toBe(1);
  });
});
