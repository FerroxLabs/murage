// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import * as invocation from './invocation.ts';
import * as evidence from './evidence.ts';
import { wipeBreaker } from '../wipe-breaker.ts';

afterEach(()=>vi.restoreAllMocks());
const context={platform:'win32' as const,project:'C:\\work\\sample',cwd:'C:\\work\\sample',home:'C:\\Users\\member'};
it.each([undefined,'pwsh'] as const)('WINREVIEW-H1 hidden cleanup runs with dialect %s',dialect=>{
 expect(wipeBreaker('Get-ChildItem C:\\work\\sample -Hidden | Remove-Item -Recurse -Force',{...context,dialect})).toBeNull();
});
it('WINREVIEW-H1 explicit false and Force still retain a whole project wipe',()=>{
 // MAIN RULING 1114-WIPE-REVIEW-BOUND: the existing classifier reports project wipes as delete-system-folder.
 for(const flag of ['-Hidden:$false','-Force'])expect(wipeBreaker(`Get-ChildItem C:\\work\\sample ${flag} | Remove-Item -Recurse -Force`,{...context,dialect:'pwsh'})?.rule).toBe('delete-system-folder');
});
it.each(['echo "Remove-Partition -DiskNumber 0"','Initialize-Disk -Number 0','Remove-Partition -DiskNumber 0 -WhatIf','Remove-Partition -DiskNumber 0 -?'])('WINREVIEW-H2 harmless double fault runs: %s',text=>{
 vi.spyOn(invocation,'parse').mockImplementation(()=>{throw Error('parser fixture');});
 vi.spyOn(evidence,'evidenceScan').mockImplementation(()=>{throw Error('recovery fixture');});
 expect(wipeBreaker(text,context)).toBeNull();
});
it.each([undefined,'pwsh'] as const)('WINREVIEW-H2 plain partition deletion double fault cards with dialect %s',dialect=>{
 vi.spyOn(invocation,'parse').mockImplementation(()=>{throw Error('parser fixture');});
 vi.spyOn(evidence,'evidenceScan').mockImplementation(()=>{throw Error('recovery fixture');});
 expect(wipeBreaker('Remove-Partition -DiskNumber 0 -PartitionNumber 1 -Confirm:$false',{...context,dialect})?.rule).toBe('wipe-check-fault');
});
it('WINREVIEW-M2 alternate reader double fault cards after harmless first recovery',()=>{
 vi.spyOn(invocation,'parse').mockImplementation(()=>{throw Error('parser fixture');});
 const recovery=vi.spyOn(evidence,'evidenceScan').mockImplementation((_text,state)=>{
  if(state.dialect==='sh')return [];
  throw Error('alternate recovery fixture');
 });
 expect(wipeBreaker('rd -r -fo ~',{cwd:'/work/project',home:'/home/member'})?.rule).toBe('wipe-check-fault');
 expect(recovery.mock.calls.map(call=>call[1].dialect)).toEqual(['sh','pwsh']);
});
