import assert from 'node:assert/strict';
import {lstatSync, realpathSync, readdirSync, readFileSync} from 'node:fs';
import {resolve, dirname, join, relative, isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function assertPhysicalPath(file,root) {
 const full=resolve(file),base=resolve(root),rel=relative(base,full);
 assert(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../')&&!rel.startsWith('..\\'),'path outside gate root');
 for(let current=full;;current=dirname(current)) {
  try {assert(!lstatSync(current).isSymbolicLink(),'reparse/link ancestor refused');assert.equal(realpathSync(current).toLowerCase(),current.toLowerCase(),'resolved ancestor changed');}
  catch(e){if(e.code!=='ENOENT')throw e;}
  if(dirname(current)===current)break;
 }
 return full;
}
export function appManifest(root) {
 assertPhysicalPath(root,root);
 const files=[];
 function walk(dir) {for(const name of readdirSync(dir).sort()) {
  const file=assertPhysicalPath(join(dir,name),root),s=lstatSync(file);
  if(s.isDirectory())walk(file);else {assert(s.isFile()&&s.nlink===1,'regular single-link staged files only');files.push({path:relative(root,file).replaceAll('\\','/'),sha256:hash(readFileSync(file))});}
 }}
 walk(root);return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
export function validateIdentity(identity) {
 assert.match(identity.commit,/^[a-f0-9]{40}$/i,'package provenance commit');
 assert.match(identity.packageSha256,/^[a-f0-9]{64}$/i,'verified ZIP digest');
 assert(Array.isArray(identity.appManifest)&&identity.appManifest.length>=3,'full staged app manifest');
 let prior='';const names=new Set();
 for(const f of identity.appManifest){assert.equal(typeof f.path,'string');assert(!/[\\:\x00-\x1f]/.test(f.path)&&!f.path.split('/').some(p=>!p||p==='.'||p==='..'),'safe manifest path');assert(f.path>prior,'sorted unique manifest');prior=f.path;assert(!names.has(f.path.toLowerCase()),'case alias');names.add(f.path.toLowerCase());assert.match(f.sha256,/^[a-f0-9]{64}$/i);}
 for(const name of ['murage.exe','resources/app.asar','resources/build-provenance.json'])assert(names.has(name),`missing ${name}`);
 return identity;
}
export function verifyStagedPackage(root,stage) {
 validateIdentity(stage);
 const actual=appManifest(root);assert.deepEqual(actual,stage.appManifest,'staged package changed');
 const provenance=JSON.parse(readFileSync(join(root,'resources/build-provenance.json'),'utf8').replace(/^\uFEFF/,''));
 assert.equal(provenance.commit,stage.commit,'commit must come from packaged build provenance');
 return {commit:provenance.commit,packageSha256:stage.packageSha256.toLowerCase(),appManifest:actual};
}
