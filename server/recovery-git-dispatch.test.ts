// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { recoveryExecutesScript } from './no-limits-wipe-scripts.ts';

// An unknown subcommand may resolve to alias.cleanup=!sh cleanup.sh or a
// git-cleanup executable on PATH. Neither script has authenticated turn writes.
it.each(['git cleanup', 'git -C work cleanup', 'git custom-helper', 'git difftool', 'git submodule foreach cleanup'])
('unauthenticated Git dispatch reaches recovery: %s', command => {
  // MAIN RULING 2026-11-14 INT-CONFLICT-DEFAULT 5b504b4368/a80c9d550d and SEAN WIPE-GATE-BAR: opaque Git dispatch is ordinary submitted work; the breaker is an accident guard.
  expect(recoveryExecutesScript(command)).toBe(false);
});

it.each(["rm -rf /", "rm -rf ~"])("submitted catastrophic roots still reach recovery: %s", command => {
  expect(recoveryExecutesScript(command)).toBe(true);
});
