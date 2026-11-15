// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source-fixture runtime only. Release helpers still use build-engine-exclusion.mjs and its glibc floor.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateEngineExclusionResource } from '../engine-exclusion-resource.mjs';
import { safeWipeSync } from '../../server/testing/safe-wipe.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const target = () => `${process.platform}-${process.arch}`;
const addonDirectory = work => join(work,'dist-native/engine-exclusion',target());
function sourceSha(work) {
  const files=['exclusion.c',...(process.platform==='win32'?['exclusion-lsa.c','exclusion-lsa.h','anchored-win.c','anchored-win.h']:[])];
  return sha(Buffer.concat(files.map(file=>readFileSync(join(work,'native/engine-exclusion',file)))));
}
export async function preflightSourceNative({ work, expectedSha256, env=process.env }={}) {
  work=resolve(work);
  for(const key of ['MURAGE_RESOURCES_PATH','OMB_RESOURCES_PATH','MURAGE_ENGINE_EXCLUSION_PATH'])if(env[key])throw Error(`SMOOTH_NATIVE_OVERRIDE: ${key}`);
  const dir=addonDirectory(work), file=join(dir,'engine-exclusion.node');
  const receipt=JSON.parse(readFileSync(join(dir,'build.json'),'utf8'));
  if(receipt.version!==1||receipt.target!==target()||receipt.napiVersion!==9||receipt.sourceSha256!==sourceSha(work))throw Error('SMOOTH_NATIVE_SOURCE');
  const sha256=sha(readFileSync(file));
  if(receipt.sha256!==sha256||(expectedSha256&&sha256!==expectedSha256))throw Error('SMOOTH_NATIVE_HASH');
  validateEngineExclusionResource(dir,process.platform,process.arch,join(dir,'build.json'));
  // A separate process has the same loader environment as the server, without the rig's module cache.
  // It must open the exact hashed file and demonstrate a real no-replace move of a dangling old-root link.
  const code=`
    import {createRequire} from 'node:module'; import {mkdtempSync,symlinkSync,readlinkSync,lstatSync,realpathSync} from 'node:fs';
    import {join} from 'node:path'; import {tmpdir} from 'node:os';
    const {safeWipeSync}=await import(${JSON.stringify(new URL('../../server/testing/safe-wipe.mjs', import.meta.url).href)});
    const {loadExclusionAddon}=await import(${JSON.stringify(pathToFileURL(join(work,'server/engine-exclusion.ts')).href)});
    const a=loadExclusionAddon(), files=Object.keys(createRequire(import.meta.url).cache).filter(f=>f.endsWith('engine-exclusion.node'));
    if(!a||files.length!==1||realpathSync(files[0])!==${JSON.stringify(realpathSync(file))}||!a.processes().some(p=>p.pid===process.pid))throw Error('SMOOTH_NATIVE_LOAD');
    const root=mkdtempSync(join(tmpdir(),'smooth-native-probe-'));
    try {
      const from=join(root,'from'),to=join(root,'to'),taken=join(root,'taken'),kind=process.platform==='win32'?'junction':'dir';
      symlinkSync(join(root,'old-root/missing'),from,kind);symlinkSync(join(root,'keep'),taken,kind);
      const oldText=readlinkSync(from),keptText=readlinkSync(taken);
      if(a.renameNoReplace(from,taken)!==1||readlinkSync(taken)!==keptText||readlinkSync(from)!==oldText)throw Error('SMOOTH_NATIVE_REPLACE');
      if(a.renameNoReplace(from,to)!==0||lstatSync(from,{throwIfNoEntry:false})||readlinkSync(to)!==oldText)throw Error('SMOOTH_NATIVE_MOVE');
      process.stdout.write(JSON.stringify({loaded:true,noReplace:true,version:a.version()}));
    } finally {safeWipeSync(root);}
  `;
  const proof=JSON.parse(execFileSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',code],{env,encoding:'utf8',timeout:30000}));
  return {path:file,sha256,sourceSha256:receipt.sourceSha256,target:target(),...proof};
}

/** Supply a source-fixture helper before measurements. An existing helper must verify; it is never silently replaced. */
export async function prepareSourceNative({work=process.cwd(),from=process.env.SMOOTH_NATIVE_FROM,expectedSha256=process.env.SMOOTH_ENGINE_EXCLUSION_SHA256,env=process.env}={}) {
  work=resolve(work);
  const dir=addonDirectory(work), file=join(dir,'engine-exclusion.node');
  if(from) {
    const supplied=join(resolve(from),target());
    mkdirSync(dir,{recursive:true});
    for(const name of ['engine-exclusion.node','build.json'])copyFileSync(join(supplied,name),join(dir,name));
  } else if(!existsSync(file)) {
    if(process.platform!=='linux')throw Error('SMOOTH_NATIVE_BUILD_REQUIRED');
    // The network-free Node fixture image carries gcc and its matching N-API headers.
    // This artifact is for that runtime, never a substitute for the release's AlmaLinux build.
    const scratch=mkdtempSync(join(tmpdir(),'smooth-native-build-'));
    try {
      const output=join(scratch,'engine-exclusion.node');
      const headers=resolve(dirname(realpathSync(process.execPath)),'../include/node');
      const compiler=execFileSync('gcc',['--version'],{encoding:'utf8'}).split('\n')[0];
      execFileSync('gcc',['-std=c11','-D_GNU_SOURCE','-O2','-Wall','-Werror','-fPIC','-shared','-DNAPI_VERSION=9','-I',headers,join(work,'native/engine-exclusion/exclusion.c'),'-o',output],{timeout:120000,stdio:'inherit'});
      mkdirSync(dir,{recursive:true});copyFileSync(output,file);
      const receipt={version:1,target:target(),napiVersion:9,sourceSha256:sourceSha(work),sha256:sha(readFileSync(file)),fixtureOnly:true,compiler};
      writeFileSync(join(dir,'build.json'),JSON.stringify(receipt,null,2)+'\n');
    } finally {safeWipeSync(scratch);}
  }
  return preflightSourceNative({work,expectedSha256,env});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify(await prepareSourceNative()));
