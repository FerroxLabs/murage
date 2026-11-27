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

it('busy-engines mounts: the 65th mount is refused with the driverRaised verdict', () => {
  const { verdicts, admission } = mounted();
  for (let i = 0; i < 64; i++) admission.mount({ command: 'fixture-mcp', args: [String(i)] });
  expect(verdicts).toEqual([]);
  expect(refusal(() => admission.mount({ command: 'fixture-mcp', args: ['65'] }))).toMatchObject({ code: 'MEMORY_CONTEXT_REVOKED', fence: ENGINE_OWN });
  expect(verdicts, 'the lease is told once, by the driver').toEqual([ENGINE_OWN]);
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
