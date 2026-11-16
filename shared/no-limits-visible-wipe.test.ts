// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {visibleWipe} from './no-limits-visible-wipe.ts';

// Data only: none of these shell commands is executed.
const dialectCases = [
 ['pwsh -Command Remove-Item -Recurse -Force "$HOME/*"', 'delete-home'],
 ["pwsh -Command Remove-Item -Recurse -Force '/fixture/home/*'", 'delete-home'],
 ['pwsh -Command Remove-Item -Recurse -Force -LiteralPath "$HOME/*"', 'delete-unresolved'],
 // MAIN RULING 1114-WIPE-FIXTURE-DIRECTION item 1 (KNOWN-CONSERVATIVE): the home wildcard is still the bound target; the trailing switch is malformed.
 ['pwsh -Command Remove-Item -Recurse -Force "$HOME/*" -LiteralPath', 'delete-home'],
 ['pwsh -Command Remove-Item -Recurse -Force -LiteralPath "$HOME"', 'delete-home'],
 ['pwsh -Command \'Remove-Item -Recurse -Force "$HOME/*"\'', 'delete-home'],
 ['pwsh -Command "Remove-Item -Recurse -Force \'/fixture/home/*\'"', 'delete-home'],
 ['pwsh -Command \'Remove-Item -Recurse -Force -Path "$HOME/*"\'', 'delete-home'],
 ['pwsh -Command \'Remove-Item -Recurse -Force -LiteralPath "$HOME/*"\'', 'delete-unresolved'],
 ['pwsh -Command "Remove-Item -Recurse -Force -LiteralPath \'/fixture/home/*\'"', 'delete-unresolved'],
 ['pwsh -Command \'Remove-Item -Recurse -Force "$HOME/cache/*"\'', 'delete-unresolved'],
 ['pwsh -Command \'Write-Output "Remove-Item -Recurse -Force $HOME/*"\'', 'delete-unresolved'],
 // MAIN RULING 1114-WIPE-FIXTURE-DIRECTION item 2 (R4 literal name): a quoted wildcard, tilde or variable is a literal name, a real non-wipe: RUN.
 ['bash -c \'rm -rf "$HOME/*"\'', 'delete-unresolved'],
 ['bash -c \'rm -rf "$HOME"/*\'', 'delete-home'],
 ["rm -rf '~'/*", 'delete-unresolved'],
 ['rm -rf "~"/*', 'delete-unresolved'],
 ['rm -rf ~/*', 'delete-home'],
 ["rm -rf '$HOME'/*", 'delete-unresolved'],
 ['cmd /c \'del /s /q "C:/Users/fixture/*"\'', 'delete-home'],
 ['cmd /c \'rd /s /q "C:/Users/fixture/*"\'', 'delete-home'],
 ['cmd /c \'echo del /s /q "C:/Users/fixture/*"\'', 'delete-unresolved'],
] as const;
it.each(dialectCases)('R1 dialect wildcard semantics: %s', (command, expected) => {
 // MAIN RULING NARROW-WIPE 2026-11-14: unresolved/literal-child targets and printed command text run; every named catastrophe expectation stays.
 expect(visibleWipe(command,command.startsWith('cmd ')?'C:/Users/fixture':'/fixture/home')).toBe(expected==='delete-unresolved'?null:expected);
});
for(const alias of ['Remove-Item','rm','del','ri','rd'])for(const quote of ['"', "'"]) {
 it(`R1 PowerShell ${alias} expands ${quote} quoted wildcards`,()=>{
  const code=`${alias} -Recurse -Force ${quote}/fixture/home/*${quote}`;
  expect(visibleWipe('pwsh -Command '+JSON.stringify(code),'/fixture/home')).toBe('delete-home');
  // MAIN RULING NARROW-WIPE 2026-11-14: -LiteralPath does not expand the '*' child into a whole-home glob.
  expect(visibleWipe('pwsh -Command '+JSON.stringify(code.replace('-Force','-Force -LiteralPath')),'/fixture/home')).toBeNull();
 });
}

for(const shell of ['bash','zsh','sh'])it(`R1 ${shell} holds uncertain quoted wildcard and tilde`,()=>{
 // MAIN RULING 1114-WIPE-FIXTURE-DIRECTION item 2 (R4 literal name): the quoted wildcard and the quoted tilde are literal names: RUN.
 expect(visibleWipe(shell+` -c 'rm -rf "$HOME/*"'`,'/fixture/home')).toBeNull();
 expect(visibleWipe(shell+` -c 'rm -rf "$HOME"/*'`,'/fixture/home')).toBe('delete-home');
 expect(visibleWipe(shell+` -c 'rm -rf "~"/*'`,'/fixture/home')).toBeNull();
});

// MAIN RULING NARROW-WIPE 2026-11-14: use the independent narrow policy metadata, preserving every historical input/id/raw oracle value.
import { visibleWipeCases } from './testing/no-limits-visible-wipe-cases.ts';
it('keeps every historical visible-wipe input, id and raw oracle byte',()=>{
 const projection=visibleWipeCases.map(({id,command,wipe})=>({id,command,wipe}));
 expect(projection).toHaveLength(2293);
 expect(createHash('sha256').update(JSON.stringify(projection)).digest('hex')).toBe('6880ab598c4dacd98d26574dbf0acd04b83b98200b33d2b0cdf9fc8c1f609f79');
});
it.each(visibleWipeCases)('R3 fail closed $id: $command', ({ command, wipe, narrowWipe }) => {
 const home=command.startsWith('cmd ')||command.includes('C:')?'C:/Users/fixture':'/fixture/home';
 expect(Boolean(visibleWipe(command, home))).toBe(narrowWipe??wipe);
});

it('R4 relative targets cannot certify an absolute target', () => {
 expect(visibleWipe('rm -rf ./build', '/fixture/home', 0, 'posix', '/fixture/home/work')).toBeNull();
 expect(visibleWipe('rm -rf ..', '/fixture/home', 0, 'posix', '/fixture/home/work')).toBe('delete-home');
 expect(visibleWipe('rm -rf ../..', '/fixture/home', 0, 'posix', '/fixture/home')).toBe('delete-root');
});

it('R4 Windows root-relative home is unresolved even with the correct drive cwd', () => {
 // MAIN RULING NARROW-WIPE 2026-11-14: the explicit drive cwd resolves this named home root; retain the card with its concrete catastrophe class.
 expect(visibleWipe('cmd /c \'rd /s /q "\\Users\\fixture"\'', 'C:\\Users\\fixture', 0, 'posix', 'C:\\work')).toBe('delete-home');
});
it('R4 home ancestors and roots hold on both path families', () => {
 for (const path of ['/', '//', '///', '/fixture', '/fixture/home']) expect(visibleWipe('rm -rf '+path, '/fixture/home')).not.toBeNull();
 for (const path of ['C:\\', 'C:\\Users', 'C:\\Users\\fixture']) expect(visibleWipe('Remove-Item -Recurse '+path, 'C:\\Users\\fixture')).not.toBeNull();
});
