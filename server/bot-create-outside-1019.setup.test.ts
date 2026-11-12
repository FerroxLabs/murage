import { expect, it, vi } from 'vitest';
import { Ledger } from './turn-settle.ts';
import { SetupAtSettle } from './setup-at-settle.ts';
for (const variant of ['clean', 'outside', 'option-off', 'owner-first', 'unsettled']) it(`D6 ${variant}: never apply at filing, notify when settlement keeps a suppressed card`, () => {
  const ledger = new Ledger(); ledger.open('G', 'T', 'fuigo', 'own');
  let open = true, option = true; const apply = vi.fn(() => { open = false; return true; }), push = vi.fn();
  const setup = new SetupAtSettle(ledger);
  expect(setup.file('G', { req: 'R', option: true, push_suppressed: true }, { open: () => open, option: () => option, apply, push })).toBe(true);
  expect(apply).not.toHaveBeenCalled(); expect(push).not.toHaveBeenCalled();
  if (variant === 'option-off') option = false;
  if (variant === 'owner-first') open = false;
  setup.settle('G', variant === 'outside' ? 'outside' : variant === 'unsettled' ? 'unsettled' : 'clean');
  expect(apply).toHaveBeenCalledTimes(variant === 'clean' ? 1 : 0);
  expect(push).toHaveBeenCalledTimes(['outside', 'option-off', 'unsettled'].includes(variant) ? 1 : 0);
  setup.settle('G', 'clean'); expect(apply).toHaveBeenCalledTimes(variant === 'clean' ? 1 : 0);
});
