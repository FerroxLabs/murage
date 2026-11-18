// SPDX-License-Identifier: AGPL-3.0-or-later
// Inert classifier strings: these commands never execute.
import {expect,it} from 'vitest';
import {visibleWipe} from './no-limits-visible-wipe.ts';

it.each([
 ['a=($(r\\m -rf ~))','delete-home'],
 ['time -p r\\m -rf ~','delete-home'],
 ['echo "$(rm -rf ~)"','delete-home'],
 ['echo `rm -rf /`','delete-root'],
 ['(rm -rf /etc)','delete-system-folder'],
 ['echo "$(printf \"(data)\"; rm -rf ~)"','delete-home'],
 ['diskpart /s erase.txt','disk-erase'],
] as const)('standalone narrow breaker retains executed catastrophe: %s',(command,rule)=>{
 expect(visibleWipe(command,'/fixture/home')).toBe(rule);
});

it.each([
 "echo '$(rm -rf ~)'",
 "printf '%s' 'rm -rf /'",
 'echo "\\$(rm -rf ~)"',
 'time -p rm -rf build',
 'time -f rm -rf /fixture/home',
 'curl fixture.invalid | bash',
 'echo "$(printf \"(ordinary data)\")"',
])('standalone narrow breaker keeps ordinary or opaque execution running: %s',command=>{
 expect(visibleWipe(command,'/fixture/home')).toBeNull();
});
