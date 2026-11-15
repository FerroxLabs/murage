import test from 'node:test';
import assert from 'node:assert/strict';
import {readLinuxFixture} from './native-launcher.mjs';
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {writePackageBuildProvenance} from '../package-build-provenance.mjs';
import {safeWipeSync} from '../../server/testing/safe-wipe.mjs';
function fixture(){const root=mkdtempSync(join(tmpdir(),'winscen-build-')),repo=join(root,'repo'),resources=join(root,'resources');mkdirSync(repo);mkdirSync(resources);
 const git=args=>readLinuxFixture('git',args,{cwd:repo,encoding:'utf8'}).trim();git(['init','-q']);writeFileSync(join(repo,'package.json'),JSON.stringify({name:'fixture',version:'1.0.19'}));git(['add','.']);git(['-c','user.name=ci','-c','user.email=fixture@example.test','commit','-qm','fixture']);return {root,repo,resources,git};}
test('build provenance takes git HEAD and allows only fixture version change',()=>{const f=fixture();try{
 writeFileSync(join(f.repo,'package.json'),JSON.stringify({name:'fixture',version:'1.0.190'}));
 const p=writePackageBuildProvenance(f.repo,f.resources);assert.equal(p.commit,f.git(['rev-parse','HEAD']));assert.equal(p.version,'1.0.190');assert.deepEqual(JSON.parse(readFileSync(join(f.resources,'build-provenance.json'))),p);
}finally{safeWipeSync(f.root);}});
for(const change of ['source','untracked','package'])test(`provenance refuses uncommitted ${change}`,()=>{const f=fixture();try{
 if(change==='package')writeFileSync(join(f.repo,'package.json'),JSON.stringify({name:'tampered',version:'1.0.190'}));
 else {writeFileSync(join(f.repo,'unexpected.mjs'),'new source');if(change==='source')f.git(['add','.']);}
 assert.throws(()=>writePackageBuildProvenance(f.repo,f.resources));
}finally{safeWipeSync(f.root);}});
