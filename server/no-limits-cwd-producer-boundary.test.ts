// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {autoVerdict} from './auto-approve.ts';
import {removeTempDirSync} from './testing/cleanup.ts';
it('existing receiving directory is not a producer-dependent cwd merely because extraction writes within it',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'nlsym-receiving-'));mkdirSync(join(cwd,'out'));writeFileSync(join(cwd,'a.tar'),'opaque fixture');
 try{
  const command='cd out && tar -xf ../a.tar';
  // A parent component in the archive INPUT is separately a producer taint;
  // use an absolute input to isolate the receiving-directory boundary.
  const text=command.replace('../a.tar',join(cwd,'a.tar'));
  expect(autoVerdict({autoApprove:true,fullAccess:true,noLimits:true},'Bash',text,{ownerStarted:true,fullAccessOrigin:'owner',commandCwd:cwd,commandText:text,outsideRead:null}).approve).toBeTruthy();
 }finally{removeTempDirSync(cwd);}
});
