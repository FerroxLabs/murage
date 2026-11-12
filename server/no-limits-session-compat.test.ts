// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {noLimitsProtectedWrite} from './no-limits-protected.ts';
it.each([true,false])('exact available shell script is inspected, ordinary twin retained protected=%s',held=>{
 const sessionEdits=new Set(['/tmp/nlsym-current.sh']);
 Object.defineProperty(sessionEdits,Symbol.iterator,{value:()=>{throw Error('history enumeration');}});
 const context={commandCwd:'/tmp',readOnlyHooks:{sessionEdits},sessionFile:()=>({text:`ln -s ${held?'/etc/hosts':'./ordinary'} ./h`})};
 expect(noLimitsProtectedWrite('sh ./nlsym-current.sh; tee ./h',context)!==null).toBe(held);
});
