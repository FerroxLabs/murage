import {runNodeFixture} from './native-launcher.mjs';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {appManifest} from './package-identity.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { safeWipeSync } from '../../server/testing/safe-wipe.mjs';
import { validateFeed, fixtureEngineEntry } from './fixture-feed.mjs';
const hash=(b,algorithm='sha256',encoding='hex')=>createHash(algorithm).update(b).digest(encoding);
function fixture(){const dir=mkdtempSync(join(tmpdir(),'winscen-feed-'));const bytes=Buffer.from('signed bytes stand-in for parser test');const app=join(dir,'app');mkdirSync(join(app,'resources'),{recursive:true});writeFileSync(join(app,'resources/app.asar'),'asar');writeFileSync(join(app,'resources/build-provenance.json'),JSON.stringify({commit:'a'.repeat(40)}));const base=join(app,'Murage.exe');writeFileSync(base,'base');writeFileSync(join(dir,'stage.json'),JSON.stringify({commit:'a'.repeat(40),packageSha256:'b'.repeat(64),appManifest:appManifest(app)}));writeFileSync(join(dir,'update.exe'),bytes);
 const manifest={commit:'a'.repeat(40),candidateVersion:'1.0.19',candidateSha256:hash('base'),version:'1.0.190',feedUrl:'http://127.0.0.1:18919/',installer:'update.exe',updateSha256:hash(bytes),published:false};
 const yaml={version:manifest.version,path:manifest.installer,sha512:hash(bytes,'sha512','base64'),files:[{url:manifest.installer,sha512:hash(bytes,'sha512','base64'),size:bytes.length}]};
 return {dir,base,manifest,yaml,save(){writeFileSync(join(dir,'fixture-update.json'),JSON.stringify(this.manifest));writeFileSync(join(dir,'latest.yml'),JSON.stringify(this.yaml));},check(){this.save();return validateFeed(this.dir,this.base,'a'.repeat(40));}};
}
test('local same-commit feed metadata and digests',()=>{const f=fixture();try{assert.equal(f.check().version,'1.0.190');}finally{safeWipeSync(f.dir);}});
for(const [name,mutate] of Object.entries({publicFeed:f=>f.manifest.feedUrl='https://example.com/',publicAsset:f=>f.yaml.files[0].url='https://example.com/update.exe',prerelease:f=>f.manifest.version='1.0.19-gate.1',sameVersion:f=>f.manifest.version='1.0.19',wrongCommit:f=>f.manifest.commit='b'.repeat(40),badHash:f=>f.manifest.updateSha256='0'.repeat(64),wrongMetadata:f=>f.yaml.version='1.0.191',badSha512:f=>f.yaml.files[0].sha512='no',traversal:f=>f.manifest.installer='../update.exe',published:f=>f.manifest.published=true})) {
 test(`refuses ${name}`,()=>{const f=fixture();try{mutate(f);assert.throws(()=>f.check());}finally{safeWipeSync(f.dir);}});
}
test('generated wrapper is valid and records only fixture mounts',async()=>{

 const dir=mkdtempSync(join(tmpdir(),'winscen-wrapper-'));try{
  const fake=join(dir,'fake.mjs'),wrapper=join(dir,'entry.mjs'),log=join(dir,'mounts');writeFileSync(fake,"console.log('existing fake executed')");writeFileSync(wrapper,fixtureEngineEntry(pathToFileURL(fake).href,log));
  const arg='mcp_servers.gateecho.args=["-e","launcher","murage-env-launch"]';
  const result=runNodeFixture([wrapper,arg,'mcp_servers.unrelated.args=["not captured"]'],{encoding:'utf8',env:{WINSCEN_ENGINE_KIND:'direct'}});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/existing fake executed/);assert.deepEqual(JSON.parse(readFileSync(log,'utf8')).mounts,[arg]);
 }finally{safeWipeSync(dir);}
});
test('packaged driver dependencies load, then refuse Linux before any launch',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'winscen-load-'));
 try {const request=join(dir,'request.json');writeFileSync(request,'{}');const result=runNodeFixture(['--experimental-strip-types','scripts/windows/packaged-scenario.mjs',request],{encoding:'utf8',env:{...process.env,HOME:dir,USERPROFILE:dir,MURAGE_DATA_DIR:dir}});
  assert.notEqual(result.status,0);assert.match(result.stderr,/AssertionError/);assert.match(result.stderr,/'win32'/);assert.doesNotMatch(result.stderr,/ERR_MODULE_NOT_FOUND|Cannot find package/);
 }finally{safeWipeSync(dir);}
});
