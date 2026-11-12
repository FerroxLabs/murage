// SPDX-License-Identifier: AGPL-3.0-or-later
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {extraGitWipe} from './no-limits-wipe-git.ts';
import {removeTempDirSync} from './testing/cleanup.ts';
for(const [branch,defaultBranch,card]of [['main','main',true],['feature','main',false],['trunk','trunk',true]] as const)it(`W5 bare force resolves ${branch} against default ${defaultBranch}`,()=>{
 const root=mkdtempSync(join(tmpdir(),'murage-wipe-git-'));
 try{mkdirSync(join(root,'.git','refs','remotes','origin'),{recursive:true});writeFileSync(join(root,'.git','HEAD'),`ref: refs/heads/${branch}\n`);writeFileSync(join(root,'.git','refs','remotes','origin','HEAD'),`ref: refs/remotes/origin/${defaultBranch}\n`);expect(extraGitWipe(['push','--force'],root)).toBe(card);}finally{removeTempDirSync(root);}
});
for(const args of [['clean','-fdx','old.txt'],['clean','-fdx','--','old.txt'],['push','--force','origin','feature'],['push','--force-with-lease','origin','main']])it(`W5 ordinary Git scope runs: ${args.join(' ')}`,()=>expect(extraGitWipe(args,'/w')).toBe(false));
it('W5 ignored-file clean in a temp directory stays a run',()=>expect(extraGitWipe(['clean','-fdx'],join(tmpdir(),'murage-scratch'))).toBe(false));
