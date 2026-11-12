// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {collectNoLimits} from './no-limits-collect.ts';
import {literalText} from './shell/lex.ts';
import * as protection from './no-limits-protected.ts';
it('H4 literal plus stays an operand until the real find terminator',()=>{
 const text='find . -maxdepth 0 -exec touch + /etc/hosts \\;';
 const touch=collectNoLimits(text,{cwd:'/tmp'}).commands.find(row=>row.command.name==='touch');
 expect(touch?.command.args.map(literalText)).toEqual(['+','/etc/hosts']);
 expect(protection.noLimitsProtectedWrite(text,{commandCwd:'/tmp'})).toMatchObject({rule:'protected-path',classification:'deny'});
 const result=protection.inspectNoLimits({kind:'exec',dialect:'sh',text,cwd:'/tmp',cwdInvalid:false});
 expect(result.decisions).toContainEqual(expect.objectContaining({reason:'direct-path',op:'write',lexical:'/etc/hosts'}));
});
it('H4 ordinary find batch terminates at braces plus and stays a read',()=>{
 const text='find . -exec ls {} +';
 expect(protection.noLimitsProtectedWrite(text,{commandCwd:'/tmp'})).toBeNull();
});
