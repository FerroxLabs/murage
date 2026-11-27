// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.20 busy-engines (shared mount admission: claude, codex, pi and agy mounts): the mount capacity and the mount rules are the driver's own
// refusals. They reach the lease as ENGINE_OWN_REFUSAL (driverRaised), the verdict the direct turn's lease reads at its seal to end the turn
// at once, as on 1.0.19, instead of rebuilding it into the same refusal (index.ts admitLedgerLease). A disposed admission (the turn is over)
// keeps the plain verdict.
import { expect, it } from 'vitest';
import { fixtureMountTurn } from '../testing/mcp-admission-fixture.ts';
import { fixtureBotFolder } from '../testing/bot-folder-fixture.ts';
import type { LineageVerdict } from '../memory/lineage-types.ts';
import type { SendTurnInput } from '../contracts.ts';

const ENGINE_OWN = { state: 'checking', reason: 'not-built', driverRaised: true };
let n = 0;
const mounted = () => {
  const verdicts: LineageVerdict[] = [];
  const turn = fixtureMountTurn({ cwd: fixtureBotFolder(), threadId: `be-mount-${++n}`, text: 'go' } as SendTurnInput, v => verdicts.push(v));
  return { verdicts, admission: turn.mountAdmission! };
};
const refusal = (work: () => unknown): unknown => { try { work(); } catch (error) { return error; } return undefined; };

// MAIN-RULING cause22-no-transport-caps (2026-11-22): no count of mounts refuses a turn, so the 1.0.20 "65th mount" refusal is gone.
it('busy-engines mounts: no count of mounts refuses the turn (cause22-no-transport-caps); the rules still do', () => {
  const { verdicts, admission } = mounted();
  for (let i = 0; i < 65; i++) expect(() => admission.mount({ command: 'fixture-mcp', args: [String(i)] }), `mount ${i + 1}`).not.toThrow();
  expect(verdicts, 'a mount past the old capacity tells the lease nothing').toEqual([]);
});

it('busy-engines mounts: a mount the relay cannot carry is refused with the driverRaised verdict', () => {
  const { verdicts, admission } = mounted();
  expect(refusal(() => admission.mount({ command: 'fixture-mcp', env: { BAD: 1 } }))).toMatchObject({ code: 'MEMORY_CONTEXT_REVOKED', fence: ENGINE_OWN });
  expect(verdicts).toEqual([ENGINE_OWN]);
});

it('busy-engines mounts: a disposed admission keeps the plain verdict (not the engine\'s refusal)', () => {
  const { verdicts, admission } = mounted();
  admission.dispose();
  expect(refusal(() => admission.mount({ command: 'fixture-mcp' }))).toMatchObject({ code: 'MEMORY_CONTEXT_REVOKED' });
  expect(verdicts).toEqual([{ state: 'checking', reason: 'not-built' }]);
});
