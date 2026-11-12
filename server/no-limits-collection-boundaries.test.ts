// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {collectNoLimits} from './no-limits-collect.ts';
import {autoVerdict} from './auto-approve.ts';
it('ambiguous Windows entry keeps cmd and PowerShell interpretations in one envelope',()=>{
 const text='rmdir .\\unused & mklink /J .\\h C:\\Windows & echo x > .\\h\\x';
 const envelope=collectNoLimits(text,{cwd:'C:/work'});
 expect(new Set(envelope.commands.map(record=>record.dialect))).toEqual(new Set(['cmd','pwsh']));
 expect(envelope.commands.some(record=>record.dialect==='cmd'&&record.command.name==='mklink')).toBe(true);
 expect(envelope.writes.some(record=>record.dialect==='cmd')).toBe(true);
});
it('ambiguous Windows ordinary literal twin retains RUN',()=>{
 const command='rmdir .\\unused & mklink /J .\\h C:\\work\\plain & echo x > .\\h\\x';
 expect(autoVerdict({autoApprove:true,fullAccess:true,noLimits:true},'shell',command,{ownerStarted:true,fullAccessOrigin:'owner',commandCwd:'C:/work',commandText:command,outsideRead:null}).approve).toBeTruthy();
});
