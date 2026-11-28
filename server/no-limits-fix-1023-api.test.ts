// secret-scan: fixture (fake paths, policy test rows)
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.23 q1023-nolimits-fix (ASTRA and FABLE reviews of 1317c58c66; Sean 11-12 binding: No limits = only the wipe check may
// ask; MAIN-RULING NOLIMITS-1022 H1: at Full access protected paths, the key guard and the wipe list keep the card).
// Booted server, the owner's proven send, a POSIX shell question (server/testing/perm-tool-rig-1023.ts).
import { afterAll, beforeAll, expect, it } from 'vitest';
import { permToolRig, type PermToolRig } from './testing/perm-tool-rig-1023.ts';

const encodedPwsh = (script: string): string => `pwsh -ec ${Buffer.from(script, 'utf16le').toString('base64')}`;
// an encoded recursive delete of a scratch folder is no wipe: it runs at No limits (it asked: "decodes to a recursive delete")
// and so does a decoded listing handed to eval (`ls -la`)
const SCRATCH = [encodedPwsh('Remove-Item -Recurse -Force .\\scratch\\tmp'), encodedPwsh('rd -r .\\build\\out'), encodedPwsh('Remove-Item -Recurse -Force .\\scratch\\tmp').replace(/^pwsh/, '$PS'), 'eval "$(echo bHMgLWxh | base64 -d)"'];
// the same encoding of a home or drive wipe still asks
// also behind a host the text hides (`$PS -ec`), where only the decoded read sees PowerShell
const ENCODED_WIPES = [encodedPwsh('Remove-Item -Recurse -Force ~'), encodedPwsh('ri -r -fo C:\\'), encodedPwsh('Remove-Item -Recurse -Force ~').replace(/^pwsh/, '$PS')];
// a decoded wipe (`rm -rf /`, `rm -rf ~`) behind an apostrophe inside double quotes, or in the substitution eval or sh -c is handed
const DECODED_WIPES = [`echo "don't"; $(echo cm0gLXJmIC8= | base64 -d)`, 'eval "$(echo cm0gLXJmIC8= | base64 -d)"', 'bash -c "$(echo cm0gLXJmIH4= | base64 -d)"'];
// code the reader could not follow that names a system folder: a protected write nobody placed keeps its card at Full access
const PROTECTED = [`perl -e 'open(my $f, ">", "/etc/cron.d/pwn")'`, `python3 -c '__import__("ct"+"ypes").CDLL(None).syscall(87, b"/etc/passwd")'`];
// an unreadable everyday command that names no system folder still runs at Full access
const EVERYDAY = ['bash -c "$CMD"', 'sh -c "ls $HOME"'];

let rig: PermToolRig;
beforeAll(async () => { rig = await permToolRig('Bash'); }, 120000);
afterAll(async () => { await rig?.close(); });

it('No limits: an encoded recursive delete of a scratch folder and a decoded listing run', async () => {
  expect(await rig.outcomes('Q23 nolimits scratch', 'no-limits', SCRATCH)).toEqual(SCRATCH.map(command => `${command} => auto-approved:no-limits`));
}, 200000);

it('No limits: an encoded home or drive wipe asks', async () => {
  const rows = await rig.outcomes('Q23 nolimits encoded wipes', 'no-limits', ENCODED_WIPES);
  expect(rows.map(row => row.replace(/:[^:]*$/, ''))).toEqual(ENCODED_WIPES.map(command => `${command} => card-shown`));
}, 200000);

it('No limits: a decoded wipe behind a quoted apostrophe or handed to eval or sh -c asks', async () => {
  const rows = await rig.outcomes('Q23 nolimits decoded wipes', 'no-limits', DECODED_WIPES);
  expect(rows.map(row => row.replace(/:[^:]*$/, ''))).toEqual(DECODED_WIPES.map(command => `${command} => card-shown`));
}, 200000);

it('Full access: unreadable code that names a system folder runs on the owner own turn, as No limits runs it', async () => {
  // OVERREACH #6 (Sean 2026-11-26, merged after 1.0.23 q1023-nolimits-fix): the owner own Full access turn runs the protected-path run rule
  // exactly as No limits does (its wipe check finds no wipe in these); it used to keep its card here
  const rows = await rig.outcomes('Q23 full protected', 'full', PROTECTED);
  expect(rows.map(row => row.replace(/:[^:]*$/, ''))).toEqual(PROTECTED.map(command => `${command} => auto-approved`));
}, 200000);

it('Full access: an unreadable everyday command still runs', async () => {
  expect(await rig.outcomes('Q23 full everyday', 'full', EVERYDAY)).toEqual(EVERYDAY.map(command => `${command} => auto-approved:full-access`));
}, 200000);

// The decision layer hands the No limits read a POSIX shell question with dialect 'sh' (server/decision/implementation.ts
// describeNoLimits); text an -EncodedCommand decodes to is PowerShell all the same, also behind a host the text hides.
it('No limits wipe read: an encoded PowerShell wipe behind a hidden host is a wipe when the call is read as sh', async () => {
  const { noLimitsWipe } = await import('./no-limits-wipe.ts');
  const context = { home: '/home/owner', cwd: '/home/owner/repo', dialect: 'sh' as const };
  expect(ENCODED_WIPES.map(command => `${command} => ${noLimitsWipe(command, context)?.rule ?? 'runs'}`))
    .toEqual([`${ENCODED_WIPES[0]} => delete-home`, `${ENCODED_WIPES[1]} => delete-root`, `${ENCODED_WIPES[2]} => delete-home`]);
  expect(SCRATCH.map(command => noLimitsWipe(command, context)?.rule ?? 'runs')).toEqual(SCRATCH.map(() => 'runs'));
}, 60000);
