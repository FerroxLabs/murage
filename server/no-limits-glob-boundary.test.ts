// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {autoVerdict} from './auto-approve.ts';
import {removeTempDirSync} from './testing/cleanup.ts';
it('B07 ordinary write glob overflow alone stays RUN',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'nlsym-glob-'));
 try{
  for(let index=0;index<4097;index++)writeFileSync(join(cwd,`f${index}`),'fixture');
  const command='tee ./f*';
  expect(autoVerdict({autoApprove:true,fullAccess:true,noLimits:true},'Bash',command,{ownerStarted:true,fullAccessOrigin:'owner',commandCwd:cwd,commandText:command,outsideRead:null}).approve).toBeTruthy();
 }finally{removeTempDirSync(cwd);}
});
