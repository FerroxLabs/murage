// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {inspectNoLimits} from './no-limits-taint.ts';
import {noLimitsProtectedWrite} from './no-limits-protected.ts';
it.each([true,false])('available exact script body joins the envelope without history enumeration protected=%s',held=>{
 const cwd='/tmp',path='/tmp/nlsym-current.sh',sessionEdits=new Set([path]);
 Object.defineProperty(sessionEdits,Symbol.iterator,{value:()=>{throw Error('history enumeration');}});
 let reads=0;
 const sessionFile=(selected:string)=>{expect(selected).toBe(path);reads++;return {text:`ln -s ${held?'/etc/hosts':'./ordinary'} ./h`};};
 const text='sh ./nlsym-current.sh; tee ./h';
 const result=inspectNoLimits({kind:'exec',dialect:'sh',text,cwd,cwdInvalid:false},{sessionEdits,sessionFile});
 expect(reads).toBe(1);
 if(held)expect(result.decisions).toContainEqual(expect.objectContaining({reason:'alias-taint',op:'write',lexical:'/tmp/h',operandId:expect.stringContaining('root/1/')}));
 else expect(result.decisions).toEqual([]);
 const hit=noLimitsProtectedWrite(text,{commandCwd:cwd,readOnlyHooks:{sessionEdits},sessionFile});
 expect(hit!==null).toBe(held);
});
