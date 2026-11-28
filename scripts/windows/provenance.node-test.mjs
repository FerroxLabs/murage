import test from 'node:test';
import assert from 'node:assert/strict';
import {readLinuxFixture} from './native-launcher.mjs';
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
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

test('generated package receipts are ignored while new source still refuses provenance',()=>{const f=fixture();try{
 writeFileSync(join(f.repo,'.gitignore'),readFileSync(new URL('../../.gitignore',import.meta.url)));
 f.git(['add','.gitignore']);f.git(['-c','user.name=ci','-c','user.email=fixture@example.test','commit','-qm','ignore generated outputs']);
 mkdirSync(join(f.repo,'qualification-evidence'));
 for(const name of ['gepa-package-metadata.json','gepa-windows-signatures.json'])writeFileSync(join(f.repo,'qualification-evidence',name),'{}');
 assert.equal(f.git(['status','--porcelain']),'');
 writePackageBuildProvenance(f.repo,f.resources);
 writeFileSync(join(f.repo,'unexpected.mjs'),'fixture');
 assert.throws(()=>writePackageBuildProvenance(f.repo,f.resources),/uncommitted source or untracked input/);
}finally{safeWipeSync(f.root);}});

// RC0 rehearsal (release.yml Windows job): "Write and check the ring build floor" left electron/rings-floor.json untracked, so
// the after-pack gate refused a clean commit. The first row is that output, written by the real release-guard CLI (only its
// network read is replaced: 404 = floor 0); the other rows keep the already-ignored Windows build outputs ignored.
const releaseGuard=fileURLToPath(new URL('../release-guard.mjs',import.meta.url));
const offlineFloor='data:text/javascript,globalThis.fetch=async()=>new Response(null,{status:404})';
test('the release job and the packaged updater use the floor path this test writes',()=>{
 const workflow=readFileSync(new URL('../../.github/workflows/release.yml',import.meta.url),'utf8');
 assert.equal(workflow.match(/release-guard\.mjs rings-floor electron\/rings-floor\.json\n/g)?.length,3);
 assert.match(readFileSync(new URL('../../electron/updater.mjs',import.meta.url),'utf8'),/new URL\("\.\/rings-floor\.json", import\.meta\.url\)/);
});
const windowsBuildOutputs=[
 ['electron/rings-floor.json',f=>{const r=spawnSync(process.execPath,['--import',offlineFloor,releaseGuard,'rings-floor','electron/rings-floor.json'],{cwd:f.repo,encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(readFileSync(join(f.repo,'electron','rings-floor.json'),'utf8'),'{"seq":0}\n');}],
 ['build/release-notes.md',f=>{mkdirSync(join(f.repo,'build'));writeFileSync(join(f.repo,'build','release-notes.md'),'notes\n');}],
 ['qualification-evidence/gepa-windows-sign-list.txt',f=>{mkdirSync(join(f.repo,'qualification-evidence'));writeFileSync(join(f.repo,'qualification-evidence','gepa-windows-sign-list.txt'),'x\n');}],
 ['dist-native/gepa/win32-x64/manifest.json',f=>{mkdirSync(join(f.repo,'dist-native','gepa','win32-x64'),{recursive:true});writeFileSync(join(f.repo,'dist-native','gepa','win32-x64','manifest.json'),'{}');}],
 ['native/gepa/__pycache__/fixture.cpython-313.pyc',f=>{mkdirSync(join(f.repo,'native','gepa','__pycache__'),{recursive:true});writeFileSync(join(f.repo,'native','gepa','__pycache__','fixture.cpython-313.pyc'),'');}],
];
function releaseFixture(){const f=fixture();
 writeFileSync(join(f.repo,'.gitignore'),readFileSync(new URL('../../.gitignore',import.meta.url)));
 mkdirSync(join(f.repo,'electron'));writeFileSync(join(f.repo,'electron','updater.mjs'),'export {};\n');
 f.git(['add','.']);f.git(['-c','user.name=ci','-c','user.email=fixture@example.test','commit','-qm','release tree']);return f;}
for(const [output,write] of windowsBuildOutputs)test(`Windows release build output ${output} leaves provenance clean`,()=>{const f=releaseFixture();try{
 write(f);writeFileSync(join(f.repo,'package.json'),JSON.stringify({name:'fixture',version:'1.0.240'}));
 assert.doesNotThrow(()=>writePackageBuildProvenance(f.repo,f.resources),`${output} must be an ignored build output`);
}finally{safeWipeSync(f.root);}});

test('provenance refusal names every offending status row and still refuses new source beside the floor',()=>{const f=releaseFixture();try{
 writeFileSync(join(f.repo,'electron','updater.mjs'),'export const changed = 1;\n');
 writeFileSync(join(f.repo,'electron','rings-floor.mjs'),'new source\n');
 writeFileSync(join(f.repo,'unexpected.mjs'),'new source\n');
 assert.throws(()=>writePackageBuildProvenance(f.repo,f.resources),error=>error instanceof assert.AssertionError
  &&/^uncommitted source or untracked input:\n M electron\/updater\.mjs\n\?\? electron\/rings-floor\.mjs\n\?\? unexpected\.mjs$/.test(error.message));
}finally{safeWipeSync(f.root);}});
