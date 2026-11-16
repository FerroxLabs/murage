// SPDX-License-Identifier: AGPL-3.0-or-later
// Frozen released sources used only by downgrade/restore tests. Never loaded
// by production. CI may fetch the exact commits during preparation; tests run
// offline and never substitute current source for a released inspector.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const HISTORICAL_TEST_PINS = Object.freeze({
  '.v101-ref': 'd950cbf67bd3b7dddc7f562a3d75f5ca71e0c340',
  // Public 1.0.2 release: identical runtime/fixture bytes to the former private pin.
  '.v102-ref': '9eabbd81029129ca666d86ab0768ce260d12b6fc',
  '.vrel-ref': 'fc3782abe834bb0a62c96437bff78ac4dbd96eeb',
});
const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
export function prepareHistoricalTestFixtures({repository=root,destination=repository,allowFetch=false,pins=HISTORICAL_TEST_PINS}={}) {
  for(const [directory,revision] of Object.entries(pins)) {
    if(!/^\.v(?:[0-9]{3}|rel)-ref$/.test(directory)||!/^[a-f0-9]{40}$/.test(revision))throw Error('Invalid historical fixture pin');
    const run=(args,env=process.env)=>{
      const result=spawnSync('git',['-C',repository,...args],{env,encoding:'utf8',maxBuffer:64*1024**2});
      if(result.status!==0)throw Error(`Historical fixture Git failed (${args[0]}): ${result.stderr}`);return result.stdout;
    };
    const available=spawnSync('git',['-C',repository,'cat-file','-e',revision+'^{commit}'],{stdio:'ignore'}).status===0;
    if(!available){if(!allowFetch)throw Error(`Historical fixture ${revision} is absent; prepare with --allow-fetch before offline tests`);run(['fetch','--no-tags','--depth=1','origin',revision]);}
    const target=join(destination,directory),scratch=mkdtempSync(join(tmpdir(),'murage-historical-index-'));
    mkdirSync(target,{recursive:true});
    try {
      const env={...process.env,GIT_INDEX_FILE:join(scratch,'index')};
      run(['read-tree',revision],env);
      run(['-c','core.autocrlf=false','checkout-index','-a','-f',`--prefix=${target.replaceAll('\\','/')}/`],env);
      const entries=run(['ls-tree','-r','-z',revision]).split('\0').filter(Boolean);
      let checked=0;
      for(const entry of entries) {
        const [metadata,path]=entry.split('\t');const [mode,kind,oid]=metadata.split(' ');
        if(kind!=='blob'||mode==='120000')continue;
        const bytes=readFileSync(join(target,path));const actual=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if(actual!==oid)throw Error(`Historical fixture differs from pinned Git bytes: ${directory}/${path}`);checked++;
      }
      writeFileSync(join(target,'.fixture-revision'),revision+'\n');
      console.log(JSON.stringify({directory,revision,checked}));
    } finally {rmSync(scratch,{recursive:true,force:true});}
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.slice(2).some(arg=>arg!=='--allow-fetch'))throw Error('usage: prepare-historical-test-fixtures.mjs [--allow-fetch]');
  prepareHistoricalTestFixtures({allowFetch:process.argv.includes('--allow-fetch')});
}
