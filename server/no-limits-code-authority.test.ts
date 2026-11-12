// SPDX-License-Identifier: AGPL-3.0-or-later
// Public S1 seam exists at the pinned baseline; RED cannot be an import failure.
import {expect,it} from 'vitest';
import * as action from './decision/action.ts';
const inspect=(action as any).describeOwnerNoLimits??action.describe;
it.each([
 ['python',{code:"open('/etc/hosts','w').write('fixture')",cwd:'/tmp'}],
 ['node',{code:"require('fs').writeFileSync('/etc/hosts','fixture')",cwd:'/tmp'}],
 ['Bash',{command:'python3 -c "open(\'/etc/hosts\',\'w\').write(\'fixture\')"',cwd:'/tmp'}],
 ['Bash',{command:'node -e "require(\'fs\').writeFileSync(\'/etc/hosts\',\'fixture\')"',cwd:'/tmp'}],
])('%s retains a structured code API write',(tool,input)=>{
 const result=inspect({tool,input});
 expect(result.ownerAuthority?.decisions.some((d:any)=>d.protectedDecision?.op==='write'&&d.protectedDecision.physical==='/etc/hosts')).toBe(true);
});

it.each([
 ['python',"import os; os.chdir('/etc'); open('hosts','w').write('fixture')"],
 ['node',"process.chdir('/etc'); require('fs').writeFileSync('hosts','fixture')"],
])('%s retains code cwd invalidation at S1',(tool,code)=>{
 expect(inspect({tool,input:{code,cwd:'/tmp'}}).ownerAuthority?.decisions.some((d:any)=>d.protectedDecision?.physical==='/etc/hosts')).toBe(true);
});
