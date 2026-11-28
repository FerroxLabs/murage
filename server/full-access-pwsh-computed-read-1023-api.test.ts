// secret-scan: fixture (fake paths, policy test rows)
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.23 q1023-nolimits-fix (ASTRA review of 1317c58c66, High 3): at Full access the key guard stays. PowerShell inline code
// is not read, so a file read whose name the code computes (chr(46)+chr(101)+chr(110)+chr(118) is .env) keeps its card;
// unreadable PowerShell that reads no computed name still runs (MAIN-RULING NOLIMITS-1022 H1). At No limits the key guard
// does not ask (correction 18:57:03Z). Booted server, the owner's proven send, a PowerShell tool question.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { permToolRig, type PermToolRig } from './testing/perm-tool-rig-1023.ts';

const COMPUTED_READS = [`python -c 'print(open(chr(46)+chr(101)+chr(110)+chr(118)).read())'`,
  `node -e 'console.log(require("fs").readFileSync(String.fromCharCode(46,101,110,118),"utf8"))'`];
const RUNS = ['& $cmd', `python -c 'print(1)'`];

let rig: PermToolRig;
beforeAll(async () => { rig = await permToolRig('PowerShell'); }, 120000);
afterAll(async () => { await rig?.close(); });

it('Full access, PowerShell: unread code that opens a file whose name it computes keeps its card', async () => {
  const rows = await rig.outcomes('Q23 pwsh computed', 'full', COMPUTED_READS);
  expect(rows.map(row => row.replace(/:[^:]*$/, ''))).toEqual(COMPUTED_READS.map(command => `${command} => card-shown`));
}, 200000);

it('Full access, PowerShell: unreadable code that reads no computed name still runs', async () => {
  expect(await rig.outcomes('Q23 pwsh runs', 'full', RUNS)).toEqual(RUNS.map(command => `${command} => auto-approved:full-access`));
}, 200000);

it('No limits, PowerShell: the computed read runs (no key guard at No limits)', async () => {
  expect(await rig.outcomes('Q23 pwsh nolimits', 'no-limits', COMPUTED_READS.slice(0, 1))).toEqual(COMPUTED_READS.slice(0, 1).map(command => `${command} => auto-approved:no-limits`));
}, 200000);
