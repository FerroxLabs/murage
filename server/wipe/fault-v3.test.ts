// SPDX-License-Identifier: AGPL-3.0-or-later
// OWNER checker: wipe-v3. OWNER fault consumer: wipe-v3-tests.
import {afterEach,expect,it,vi} from 'vitest';
import {evidenceScan} from './evidence.ts';
import {known} from './types.ts';
import {hungFilesystemScenario,mountQueryFailureScenario,freshMountScenario,registryFaultScenario,walkerFaultScenario,tolerantFaultScenario,contextFaultScenario,executionDriveScenario} from './v3-fault-scenarios.fixture.ts';
afterEach(()=>vi.restoreAllMocks());
it('V3-FAULT-1 hung keys retain healthy protection and respect quarantine ceiling',hungFilesystemScenario,15000);
it('V3-FAULT-2 mount query throw and timeout preserve independent realpath',mountQueryFailureScenario);
it('V3-FAULT-3 fresh mount confirmation distinguishes data mount, firmlink and timeout',freshMountScenario);
it('V3-FAULT-4 registry isolates owners and never retries failed boot per query',registryFaultScenario);
it('V3-FAULT-5 statement recovery preserves later effects and bounds nesting',walkerFaultScenario);
it('V3-FAULT-6 tolerant seeded fuzz, linear megabyte scan and evidence-only double fault',tolerantFaultScenario,30000);
it('V3-FAULT-7 throwing context reader remains inside autoVerdict containment',contextFaultScenario);
it('V3-FAULT-8 execution drive and UNC share roots',executionDriveScenario);


it.each([
 ['echo data > /fixture/out','>','/fixture/out'],
 ['echo data 2> /fixture/out','>','/fixture/out'],
 ['echo data >> /fixture/out','>>','/fixture/out'],
 ['echo data &> /fixture/out','&>','/fixture/out'],
 ['echo data <> /fixture/out','<>','/fixture/out'],
 ['echo data 2>&1','>&','1'],
])('recovery recognizes each redirection prefix: %s',(source,op,target)=>{
 const rows=evidenceScan(source,{env:new Map(),cwd:known('/fixture/project'),home:'/fixture/home',dialect:'sh',depth:0});
 expect(rows.flatMap(row=>row.redirects)).toEqual([{op,target:known(target!)}]);
});
it.each(["echo '2>/fixture/out'",'echo data123data'])('recovery keeps literal text out of redirections: %s',source=>{
 const rows=evidenceScan(source,{env:new Map(),cwd:known('/fixture/project'),home:'/fixture/home',dialect:'sh',depth:0});
 expect(rows.flatMap(row=>row.redirects)).toEqual([]);expect(rows[0]?.program).toBe('echo');
});
