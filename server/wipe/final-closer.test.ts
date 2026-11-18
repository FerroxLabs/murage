// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: wipe final closer (dev/1019-wipe-hybrid). Commands are data only; nothing here is executed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as invocation from './invocation.ts';
import * as evidence from './evidence.ts';
import { wipeBreaker } from '../wipe-breaker.ts';

afterEach(()=>vi.restoreAllMocks());
const win={platform:'win32' as const,project:'C:\\work\\sample',cwd:'C:\\work\\sample',home:'C:\\Users\\member'};
const posix={home:'/fixture/home'};

describe('PowerShell host text with backslash-quoted inner quotes',()=>{
 it.each([
  ['powershell -Command "Remove-Item -Recurse -Force \\"C:\\Users\\member\\""',{...win,dialect:'cmd' as const}],
  ['powershell -NoProfile -Command "Remove-Item -Recurse -Force \\"$env:USERPROFILE\\*\\""',{...win,dialect:'cmd' as const}],
  ['pwsh -Command "Remove-Item -Recurse -Force \\"C:/Users/member/*\\""',{...win,dialect:'sh' as const}],
  ['pwsh -Command "Remove-Item -Recurse -Force \\"C:/Users/member/*\\""',win],
  ['pwsh -Command "Remove-Item -Recurse -Force -Path \\"$env:USERPROFILE/*\\""',posix],
  ['pwsh -Command "rd -Recurse -Force -Path \\"$env:USERPROFILE\\\\*\\" -Exclude \\"-LiteralPath\\""',posix],
 ] as const)('cards a whole-home delete: %s',(text,context)=>{
  expect(wipeBreaker(text,context)?.rule).toBe('delete-home');
 });
 it.each([
  ['powershell -Command "Write-Output \\"Remove-Item -Recurse -Force C:\\Users\\member\\""',{...win,dialect:'cmd' as const}],
  ['powershell -Command "Remove-Item -Recurse -Force \\"C:\\work\\sample\\dist\\""',{...win,dialect:'cmd' as const}],
  ['pwsh -Command "Remove-Item -Recurse -Force \\"./build/*\\""',posix],
 ] as const)('keeps printed text and ordinary targets running: %s',(text,context)=>{
  expect(wipeBreaker(text,context)).toBeNull();
 });
});

describe('Windows system folder spellings',()=>{
 it.each([
  ['Remove-Item -Recurse -Force C:\\Windows\\System32',{...win,dialect:'pwsh' as const}],
  ['rd /s /q "C:\\Windows\\System32"',{...win,dialect:'cmd' as const}],
  ['cmd /c \'rd /s /q "\\Windows\\System32"\'',{home:'C:/Users/fixture',platform:'win32' as const}],
  ['pwsh -Command \'Remove-Item -Recurse -Force "\\Windows\\System32"\'',posix],
  ['Remove-Item -Recurse "\\\\?\\C:\\Windows"',{...win,dialect:'pwsh' as const}],
 ] as const)('cards: %s',(text,context)=>{
  expect(wipeBreaker(text,context)?.rule).toBe('delete-system-folder');
 });
 it('cards the device-namespace spelling of the home folder',()=>{
  expect(wipeBreaker('Remove-Item -Recurse "\\\\?\\C:\\Users\\member"',{...win,dialect:'pwsh'})?.rule).toBe('delete-home');
 });
 it.each([
  'Remove-Item -Force C:\\Windows\\System32\\drivers\\etc\\hosts.bak',
  'Remove-Item -Recurse -Force C:\\work\\sample\\System32',
  'Remove-Item -Recurse -Force \\work\\sample\\dist',
 ])('keeps ordinary targets running: %s',text=>{
  expect(wipeBreaker(text,{...win,dialect:'pwsh'})).toBeNull();
 });
});

describe('PowerShell pipelines',()=>{
 it.each([
  'Get-ChildItem C:\\Users\\member |\nRemove-Item -Recurse -Force',
  'Get-ChildItem C:\\Users\\member |\r\n    Remove-Item -Recurse -Force',
  'Get-ChildItem -Recurse -File C:\\Users\\member | Remove-Item -Force',
  'Get-ChildItem -Recurse -File C:\\Users\\member |\nRemove-Item',
 ])('cards a whole-home pipeline: %s',text=>{
  expect(wipeBreaker(text,{...win,dialect:'pwsh'})?.rule).toBe('delete-home');
 });
 it('cards the same pipeline inside a child host with no caller dialect',()=>{
  expect(wipeBreaker('pwsh -Command \'Get-ChildItem -Recurse -File "$HOME" |\nRemove-Item\'',posix)?.rule).toBe('delete-home');
 });
 it.each([
  'Get-ChildItem C:\\work\\sample\\dist |\nRemove-Item -Recurse -Force',
  'Get-ChildItem -Recurse -File C:\\work\\sample\\dist | Remove-Item -Force',
  'Get-ChildItem C:\\Users\\member -File | Remove-Item -Force',
  'Get-ChildItem C:\\work\\sample -Hidden | Remove-Item -Recurse -Force',
  'Get-ChildItem C:\\Users\\member |\nSelect-Object Name',
 ])('keeps ordinary cleanup running: %s',text=>{
  expect(wipeBreaker(text,{...win,dialect:'pwsh'})).toBeNull();
 });
});

describe('array assignment substitutions execute',()=>{
 it.each(['a=($(rm -rf ~))','a=(x $(rm -rf ~))','a=($(r\\m -rf ~))'])('cards: %s',text=>{
  expect(wipeBreaker(text,posix)?.rule).toBe('delete-home');
 });
 it.each(['a=($(ls build))','files=(src/a.o src/b.o); rm -f "${files[@]}"','a=(rm -rf "~")'])('runs: %s',text=>{
  expect(wipeBreaker(text,{...posix,cwd:'/fixture/home/work'})).toBeNull();
 });
});

const plain=[
 'Remove-Partition -DiskNumber 0 -PartitionNumber 1 -Confirm:$false',
 'Remove-Partition -DiskNumber 0 -PartitionNumber 1 -Confirm:$false # -WhatIf',
 'Format-Volume -DriveLetter D',
 'Clear-Disk -Number 1 -RemoveData',
 'diskpart /s wipe.txt',
 'format D: /q',
 'rd /s /q C:\\',
 'Remove-Item -Recurse -Force C:\\',
 'Remove-Item -Recurse -Force $HOME',
 'rd /s /q %USERPROFILE%',
];
describe('a fault on a plain in-scope form cards',()=>{
 it.each(plain)('parser and recovery fault: %s',text=>{
  vi.spyOn(invocation,'parse').mockImplementation(()=>{throw Error('parser fixture');});
  vi.spyOn(evidence,'evidenceScan').mockImplementation(()=>{throw Error('recovery fixture');});
  expect(wipeBreaker(text,win)?.rule).toBe('wipe-check-fault');
 });
 it.each(plain)('parser fault alone: %s',text=>{
  vi.spyOn(invocation,'parse').mockImplementation(()=>{throw Error('parser fixture');});
  expect(wipeBreaker(text,win)).not.toBeNull();
 });
 it.each([
  'echo "example; Remove-Partition -DiskNumber 0"',
  "Write-Output 'Clear-Disk -Number 1 -RemoveData'",
  "Write-Output 'diskpart'",
  'echo "format D: /q"',
  '# Clear-Disk -Number 1',
  '<# Format-Volume -DriveLetter D #> Get-Date',
  'Remove-Partition -DiskNumber 0 -WhatIf',
  'diskpart /?',
  'Get-Date',
 ])('parser and recovery fault keeps data and harmless text running: %s',text=>{
  vi.spyOn(invocation,'parse').mockImplementation(()=>{throw Error('parser fixture');});
  vi.spyOn(evidence,'evidenceScan').mockImplementation(()=>{throw Error('recovery fixture');});
  expect(wipeBreaker(text,win)).toBeNull();
 });
});

describe('the one bounded review (arev-wg-final) Highs',()=>{
 it.each([
  ["$p='C:\\Users\\member'; powershell -Command \"Remove-Item -Recurse -Force '$p'\"",'delete-home'],
  ["$p='C:\\Windows'; pwsh -Command \"Remove-Item -Recurse -Force $p\"",'delete-system-folder'],
 ] as const)('child PowerShell text keeps the caller expansion: %s',(text,rule)=>{
  expect(wipeBreaker(text,{...win,dialect:'pwsh'})?.rule).toBe(rule);
 });
 it('child PowerShell text with an ordinary caller value runs',()=>{
  expect(wipeBreaker("$p='C:\\work\\sample\\dist'; powershell -Command \"Remove-Item -Recurse -Force '$p'\"",{...win,dialect:'pwsh'})).toBeNull();
 });
 const linux={platform:'linux' as const,cwd:'/work/project/pkg',home:'/home/member',env:{HOME:'/home/member'}};
 it.each(['p=/home/member; rm -rf "$p"','d=/etc && rm -rf $d','rm -rf /opt'])('parser fault alone cards: %s',text=>{
  vi.spyOn(invocation,'parse').mockImplementation(()=>{throw Error('parser fixture');});
  expect(wipeBreaker(text,linux)).not.toBeNull();
 });
 it.each(['rm -rf build','b=build; rm -rf "$b"','rm -rf "$HOME/project/node_modules"','echo "$p"'])('parser fault alone keeps ordinary work running: %s',text=>{
  vi.spyOn(invocation,'parse').mockImplementation(()=>{throw Error('parser fixture');});
  expect(wipeBreaker(text,linux)).toBeNull();
 });
 it.each([
  ['rm -rf /opt',linux],['sudo rm -rf /boot',linux],['rm -rf /Library',{...linux,platform:'darwin' as const}],
  ['powershell -Command "Clear-Disk -Number 1 -RemoveData -Confirm:$false"',{...win,dialect:'cmd' as const}],
  ['cmd /c "format D: /q"',win],
 ] as const)('parser and recovery fault cards: %s',(text,context)=>{
  vi.spyOn(invocation,'parse').mockImplementation(()=>{throw Error('parser fixture');});
  vi.spyOn(evidence,'evidenceScan').mockImplementation(()=>{throw Error('recovery fixture');});
  expect(wipeBreaker(text,context)?.rule).toBe('wipe-check-fault');
 });
 it.each(['rm -rf build/bin','rm -rf ./opt/cache','echo "powershell -Command Clear-Disk"',"Write-Output 'cmd /c format D:'"])('parser and recovery fault keeps ordinary work running: %s',text=>{
  vi.spyOn(invocation,'parse').mockImplementation(()=>{throw Error('parser fixture');});
  vi.spyOn(evidence,'evidenceScan').mockImplementation(()=>{throw Error('recovery fixture');});
  expect(wipeBreaker(text,linux)).toBeNull();
 });
});
// secret-scan: fixture (generic fixture home names only; no host data)
