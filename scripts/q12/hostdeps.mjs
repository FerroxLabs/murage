// Isolated tooling only. All resolution/integrity entries come from the repository lock.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {privateDirectory} from './runtime.mjs';
const repo=realpathSync(new URL('../..',import.meta.url));
const packages=['@playwright/test@1.57.0','playwright@1.57.0','playwright-core@1.57.0','fsevents@2.3.2'];
const hash=b=>createHash('sha256').update(b).digest('hex');
export function toolingFiles(lock=readFileSync(join(repo,'pnpm-lock.yaml'),'utf8')){
 const section=name=>{const text=lock.split('\n'+name+':\n');assert.equal(text.length,2);return text[1].split(/^\S/m)[0];};
 const block=(text,key)=>{const lines=text.split('\n'),start=lines.findIndex(l=>l===`  '${key}':`||l===`  ${key}:`||l===`  ${key}: {}`);assert(start>=0,'Missing pinned '+key);let end=start+1;while(end<lines.length&&!/^  \S/.test(lines[end]))end++;return lines.slice(start,end).join('\n').trimEnd()+'\n';};
 const entries=packages.map(k=>block(section('packages'),k));assert(entries.every(b=>/integrity: sha512-/.test(b)));
 const snapshots=packages.map(k=>block(section('snapshots'),k));
 assert(snapshots[0].includes('playwright: 1.57.0'));assert(snapshots[1].includes('playwright-core: 1.57.0')&&snapshots[1].includes('fsevents: 2.3.2'));
 return {'package.json':JSON.stringify({name:'murage-q12-hostdeps',private:true,packageManager:'pnpm@10.33.0',dependencies:{'@playwright/test':'1.57.0'}},null,2)+'\n','pnpm-lock.yaml':"lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n  .:\n    dependencies:\n      '@playwright/test':\n        specifier: 1.57.0\n        version: 1.57.0\n\npackages:\n\n"+entries.join('\n')+'\nsnapshots:\n\n'+snapshots.join('\n')};
}
export function stageHostdeps(root){privateDirectory(root);const host=join(root,'hostdeps');mkdirSync(host,{mode:0o700});for(const [name,bytes] of Object.entries(toolingFiles()))writeFileSync(join(host,name),bytes,{flag:'wx',mode:0o600});return host;}
export function verifyHostdeps(host){
 privateDirectory(host);for(const [name,bytes] of Object.entries(toolingFiles()))assert.equal(readFileSync(join(host,name),'utf8'),bytes,'Tooling lock changed');
 const require=createRequire(join(host,'package.json')),rows=[];let parent=require;
 for(const name of ['@playwright/test','playwright','playwright-core']){
  const file=realpathSync(parent.resolve(name+'/package.json'));assert(file.startsWith(host+sep),'Tooling resolved outside isolated hostdeps');const p=JSON.parse(readFileSync(file,'utf8'));assert.equal(p.name,name);assert.equal(p.version,'1.57.0');
  if(name==='@playwright/test')assert.deepEqual(p.dependencies,{playwright:'1.57.0'});
  if(name==='playwright'){assert.deepEqual(p.dependencies,{'playwright-core':'1.57.0'});assert.deepEqual(p.optionalDependencies,{fsevents:'2.3.2'});}
  rows.push({name,version:p.version,path:file,packageSha256:hash(readFileSync(file))});parent=createRequire(file);
 }
 assert.equal(typeof require('@playwright/test')._electron.launch,'function');
 return {require,receipt:{lockSha256:hash(readFileSync(join(host,'pnpm-lock.yaml'))),packages:rows}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const root=join(realpathSync(process.env.RUNNER_TEMP),'murage-q12');assert(['stage','verify'].includes(process.argv[2]));
 if(process.argv[2]==='stage')stageHostdeps(root);else writeFileSync(join(root,'evidence/hostdeps.json'),JSON.stringify(verifyHostdeps(join(root,'hostdeps')).receipt,null,2)+'\n',{mode:0o600});
}
