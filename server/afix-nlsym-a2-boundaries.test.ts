// SPDX-License-Identifier: AGPL-3.0-or-later
// Review regression inputs only; no command is executed.
import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDirSync } from './testing/cleanup.ts';
import { inspectNoLimits } from './no-limits-taint.ts';
import { commandRoles } from './shell/roles.ts';
import { autoVerdict } from './auto-approve.ts';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))removeTempDirSync(root);});
function setup(){const cwd=mkdtempSync(join(tmpdir(),'nlsym-a2-'));roots.push(cwd);mkdirSync(join(cwd,'out'));writeFileSync(join(cwd,'plain'),'fixture');return cwd;}
const inspect=(text:string,cwd:string)=>inspectNoLimits({kind:'exec',dialect:'sh',text,cwd,cwdInvalid:false});
it('A2 gawk extension is a protected read, inplace is a protected writer',()=>{
 const cwd=setup();
 for(const [extension,held] of [['extension',false],['inplace',true]] as const){
  const command=`gawk -i ${extension} '1' /etc/hosts`;
  const result=autoVerdict({autoApprove:true,fullAccess:true,noLimits:true},'Bash',command,{ownerStarted:true,fullAccessOrigin:'owner',commandCwd:cwd,commandText:command,outsideRead:null});
  expect(!!result.approve).toBe(!held);
 }
});
it.each([false,true])('A2 archive receiving root retains cwd protected=%s',protectedPath=>{
 const cwd=setup();
 const command=`cd ${protectedPath?'/etc':join(cwd,'out')} && tar -xf ${join(cwd,'ordinary.tar')}`;
 expect(inspect(command,cwd).verdict).toBe(protectedPath?'hold':'run');
});
it.each([false,true])('A2 rsync --backup retains receiver anchor protected=%s',protectedPath=>{
 const cwd=setup();symlinkSync(protectedPath?'/etc':join(cwd,'out'),join(cwd,'out','ref'));
 const result=inspect('rsync --backup --backup-dir=ref plain out/notes',cwd);
 expect(result.operations[0]?.operands).toContainEqual(expect.objectContaining({role:'backup',value:'ref',cwd:join(cwd,'out')}));
 expect(result.verdict).toBe(protectedPath?'hold':'run');
 expect(commandRoles(['rsync','--backup','--backup-dir=ref','plain','out/notes']).slots).toContainEqual(expect.objectContaining({key:'--backup',role:'flag'}));
});
it('A2 receiving children remain cwd dependencies after extraction',()=>{
 const cwd=setup();mkdirSync(join(cwd,'out','child'));
 const result=inspect(`tar -xf ${join(cwd,'ordinary.tar')} -C out; cd out/child; touch .ssh/config`,cwd);
 expect(result.decisions.some(d=>d.reason==='unknown-cwd-protected-suffix')).toBe(true);
});
