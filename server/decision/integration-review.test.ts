// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { d, fixture, baseRun, card } from './fixture.ts';

for (const level of ['ask', 'full', 'unlimited'] as const) {
  for (const tail of ['rm -rf /', 'printf x > ~/.ssh/config']) {
    it(`H2 refuses incomplete ${level} capture before ${tail}`, async () => {
      const f = fixture(level);
      try {
        // The native engine still holds this complete command; only ingress is bounded.
        const handle = f.open('tail', { command: ' '.repeat(1_000_000) + '; ' + tail });
        // MAIN RULING 2026-11-13 MM-2: wipe-only at No limits (Sean 11-12).
        // Keep the original test ID; the authenticated owner retains the complete native input.
        const outcome = d.decide(handle, baseRun);
        if (level === 'unlimited' && tail === 'rm -rf /') {
          await d.presentApproval(card(outcome), { title: 'Wipe check', subtitle: 'Complete native input' });
          expect(d.readApproval(card(outcome).approvalId)?.why).toBe('wipe');
          expect(f.respond).not.toHaveBeenCalled();
          return;
        }
        expect(outcome.kind).toBe(level === 'unlimited' ? 'run' : 'refuse');
        await d.deliverRequest(handle);
        expect(f.respond).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ behavior: level === 'unlimited' ? 'allow' : 'deny' }), expect.anything());
      } finally { f.dispose(); }
    });
  }
}
for (const [name, input] of [
  ['aggregate budget', { padding: 'x'.repeat(999_900), command: ' '.repeat(200) + '; rm -rf /' }],
  ['key budget', Object.fromEntries([...Array.from({length:10_001}, (_,i)=>['k'+i, 0]), ['command', 'rm -rf /']])],
  ['content projection', { text: ' '.repeat(70_000) + '; rm -rf /' }],
] as const) it(`H2 refuses incomplete ${name}`, async () => {
  const f=fixture();
  // MAIN RULING 2026-11-13 MM-2: wipe-only at No limits (Sean 11-12).
  // The budget applies to the display projection; the owner input remains complete.
  try {
    const outcome = d.decide(f.open('cut', input), baseRun);
    if (name === 'content projection') expect(outcome.kind).toBe('run');
    else {
      await d.presentApproval(card(outcome), { title: 'Wipe check', subtitle: 'Complete native input' });
      expect(d.readApproval(card(outcome).approvalId)?.why).toBe('wipe');
    }
  }
  finally { f.dispose(); }
});
for (const [name, input] of [
  ['command budget', { command: ' '.repeat(1_000_000) + '; printf x > ~/.ssh/config' }],
  ['aggregate budget', { padding: 'x'.repeat(999_900), command: ' '.repeat(200) + '; printf x > ~/.ssh/config' }],
  ['key budget', Object.fromEntries([...Array.from({length:10_001}, (_,i)=>['k'+i, 0]), ['command', 'printf x > ~/.ssh/config']])],
] as const) it(`H2 runs authenticated owner non-wipe beyond ${name}`, () => {
  // MAIN RULING 2026-11-13 MM-2: wipe-only at No limits (Sean 11-12).
  const f = fixture();
  try { expect(d.decide(f.open('non-wipe', input), baseRun).kind).toBe('run'); }
  finally { f.dispose(); }
});
for (const origin of ['non-owner', 'other-human', 'guest', 'unauthenticated', 'unknown-origin'] as const) {
  it(`H2 refuses incomplete ${origin} No-limits capture`, () => {
    const f = fixture('unlimited', origin === 'other-human' || origin === 'guest' ? { k: origin } : { k: 'owner-typed' });
    try {
      if (origin === 'non-owner') f.setOwner(false);
      if (origin === 'unauthenticated' || origin === 'unknown-origin') d.installProvenanceReader({
        turnGenerationFor: () => 'g', provenance: () => undefined,
        live: () => origin === 'unauthenticated' ? undefined : ({botId:'b',turnId:'turn',providerInstanceId:'p',principal:'owner',owner:true,level:'unlimited'}),
      });
      expect(d.decide(f.open('excluded', { command: ' '.repeat(1_000_000) + '; printf x > ~/.ssh/config' }), baseRun).kind).toBe('refuse');
    } finally { f.dispose(); }
  });
}
it('H2 preserves ordinary complete capture', () => {
  const f=fixture();
  try { expect(d.decide(f.open(), baseRun).kind).toBe('run'); }
  finally { f.dispose(); }
});
