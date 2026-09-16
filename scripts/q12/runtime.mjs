import assert from 'node:assert/strict';
import {lstatSync,realpathSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';

export const GiB=1024**3;
const profiles=Object.freeze({
 SHARED_MAC:Object.freeze({name:'SHARED_MAC',prestartBytes:8*GiB,stopBytes:4*GiB,minPhysicalBytes:0,windowMs:30*60000,monitorMs:2000}),
 DISPOSABLE_GITHUB_MAC:Object.freeze({name:'DISPOSABLE_GITHUB_MAC',prestartBytes:3*GiB,stopBytes:1.5*GiB,minPhysicalBytes:6*GiB,windowMs:30*60000,monitorMs:2000}),
});
export function executionProfile(name='SHARED_MAC',context={}){
 assert(Object.hasOwn(profiles,name),'Unknown Q12 execution profile');
 if(name==='DISPOSABLE_GITHUB_MAC'){
  const e=context.env??{};
  assert.equal(context.platform,'darwin');assert.equal(context.arch,'arm64');
  assert.equal(e.GITHUB_ACTIONS,'true');assert.equal(e.RUNNER_ENVIRONMENT,'github-hosted');
  assert.equal(context.username,'runner');assert.equal(context.home,'/Users/runner');assert.equal(context.manager,'Aqua');
  assert.equal(e.MURAGE_Q12_CI_CONFIRM,'disposable-packaged-q12');assert.equal(e.RUNNER_OS,'macOS');
  assert(/^[0-9]+$/.test(e.GITHUB_RUN_ID??''));assert(/^[0-9]+$/.test(e.GITHUB_RUN_ATTEMPT??''));
  assert(e.RUNNER_TEMP&&e.GITHUB_WORKSPACE&&resolve(e.RUNNER_TEMP)===e.RUNNER_TEMP&&resolve(e.GITHUB_WORKSPACE)===e.GITHUB_WORKSPACE);
 }
 return profiles[name];
}
export function memoryReading(text,physical){
 const pageSize=Number(text.match(/page size of (\d+)/)?.[1]);
 const fields=key=>[...text.matchAll(new RegExp('^'+key+':\\s+(\\d+)\\.','gm'))];
 const free=fields('Pages free'),inactive=fields('Pages inactive');
 assert(Number.isSafeInteger(pageSize)&&pageSize>0&&free.length===1&&inactive.length===1,'Memory measurement invalid');
 const freePages=Number(free[0][1]),inactivePages=Number(inactive[0][1]),physicalBytes=Number(physical);
 assert([freePages,inactivePages,physicalBytes].every(Number.isSafeInteger)&&freePages>=0&&inactivePages>=0&&physicalBytes>0,'Memory measurement invalid');
 const reserveBytes=(freePages+inactivePages)*pageSize;
 assert(Number.isSafeInteger(reserveBytes)&&reserveBytes>=0&&reserveBytes<=physicalBytes,'Memory measurement invalid');
 return {physicalBytes,pageSize,freePages,inactivePages,reserveBytes};
}
export function assertPrestart(profile,reading){assert(reading.physicalBytes>=profile.minPhysicalBytes,'Physical memory below profile minimum');assert(reading.reserveBytes>=profile.prestartBytes,`${profile.name} prestart reserve required`);}
export function belowStop(profile,reading){return reading.physicalBytes<profile.minPhysicalBytes||reading.reserveBytes<profile.stopBytes;}
export function privateDirectory(directory,uid=process.getuid()){
 assert.equal(resolve(directory),directory,'Absolute canonical directory required');
 const s=lstatSync(directory);assert(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===uid&&(s.mode&0o077)===0,'Private owned directory required');
 assert.equal(realpathSync(directory),directory,'Directory may not resolve through a symlink');return directory;
}
export function ownedPath(root,file,{absent=false,uid=process.getuid()}={}){
 assert.equal(resolve(file),file,'Canonical task path required');assert(file.startsWith(root+sep),'Path outside task root');
 const parent=dirname(file);assert.equal(realpathSync(parent),parent,'Task path parent may not resolve through a symlink');
 try{const s=lstatSync(file);assert(!absent,'Task output already exists');assert(!s.isSymbolicLink()&&s.uid===uid,'Task path ownership required');assert.equal(realpathSync(file),file,'Task path may not resolve through a symlink');}
 catch(error){if(error.code!=='ENOENT'||!absent)throw error;}
 return file;
}
export function assertManifestIdentity(m,expected){
 assert.equal(m.rootApproved,true,'Root admission required before native launch');
 for(const key of ['sourceCommit','fixtureCommit'])assert(/^[a-f0-9]{40}$/.test(m[key]??''),'Exact source SHA required');
 assert.equal(m.sourceCommit,expected.sourceCommit,'Artifact source mismatch');assert.equal(m.fixtureCommit,expected.fixtureCommit,'Fixture source mismatch');assert.equal(m.fuigoVersion,expected.fuigoVersion,'Fuigo version mismatch');
 assert(/^\d+\.\d+\.\d+$/.test(m.fuigoVersion));
 assert(m.appHashes&&Object.keys(m.appHashes).length>=4,'App identity hashes required');
 assert(m.sourcePins&&Object.keys(m.sourcePins).length>=8,'Source seam pins required');
 for(const [file,hash] of [...Object.entries(m.appHashes),...Object.entries(m.sourcePins)]){assert(!file.startsWith('/')&&!file.split('/').includes('..'),'Unsafe identity path');assert(/^[a-f0-9]{64}$/.test(hash),'SHA256 required');}
 assert(/^[a-f0-9]{64}$/.test(m.driverSha256)&&/^[a-f0-9]{64}$/.test(m.pickerSha256));
 assert.equal(m.keygen?.sha256,'c16e229245123d0ad27442317461d63915416cad0294395cd19ca93feb3211ea');
}
export function safeEncryptedResponse(reply){
 const created=reply?.value;
 return {connectionClosed:reply?.connectionClosed===true,error:typeof created?.error==='string'&&/^[A-Z][A-Z0-9_]{0,100}$/.test(created.error)?created.error:null,operation:created?.result?.operation==='backup-encrypted'?'backup-encrypted':null,ok:created?.result?.ok===true};
}
export const sourceSeams=Object.freeze(['electron/backup-mode.mjs','electron/installation-recovery-window.mjs','electron/installation-recovery-controller.mjs','electron/recovery/preload.cjs','server/memory/settings.ts','server/installation-encrypted-backup.ts','server/memory/restore.ts','electron/installation-selection.mjs']);
