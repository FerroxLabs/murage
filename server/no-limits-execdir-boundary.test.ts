// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {collectNoLimits} from './no-limits-collect.ts';
import {noLimitsProtectedWrite} from './no-limits-protected.ts';
it('find execdir exposes its changed cwd before inspecting a protected relative suffix',()=>{
 const text='find /etc -execdir tee ./hosts \\;';
 expect(collectNoLimits(text,{cwd:'/tmp'}).commands.some(record=>record.command.name==='cd'&&record.syntaxId.includes('execdir-cwd'))).toBe(true);
 expect(noLimitsProtectedWrite(text,{commandCwd:'/tmp'})).toMatchObject({rule:'protected-path',classification:'deny'});
});
it('find execdir ordinary suffix remains RUN and does not change the enclosing cwd',()=>{
 expect(noLimitsProtectedWrite('find /etc -execdir tee ./notes \\; ; tee ./notes',{commandCwd:'/tmp'})).toBeNull();
});

it('a submitted binding cannot turn the collector execdir marker into a known cwd',()=>{
 expect(noLimitsProtectedWrite('MURAGE_COLLECTOR_UNKNOWN_CWD=/tmp; find /etc -execdir tee ./hosts \\;',{commandCwd:'/tmp'})).toMatchObject({rule:'protected-path'});
});
