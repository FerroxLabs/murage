import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnifiedBrowserController } from './browser-control.ts';
import { browserOwnerId } from './browser-owner-api.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex').slice(0,32);
for(const cloudHome of [false,true])for(const kind of ['desktop','companion'] as const)it(`S1 T4 hold migration cloud=${cloudHome} ${kind}`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'murage-hold-'));try{
 const file=join(dir,'state.json'),legacy=hash('realm:'+kind);writeFileSync(file,JSON.stringify([['held',{held:true,owner:legacy,generation:4}]]));
 const c=new UnifiedBrowserController({stateFile:file,ownerMigration:{realm:'realm',cloudHome}}),owner=browserOwnerId('desktop','realm');
 expect(owner).toBe(hash('realm:owner'));expect(browserOwnerId('companion','realm')).toBe(owner);
 const ambiguous=cloudHome&&kind==='companion';expect(c.holdState('held')).toMatchObject({held:true,legacy:ambiguous});expect(c.blocksCommit('held')).toBe('held');
 expect(c.status('held').owner).toBe(ambiguous?legacy:owner);expect(JSON.parse(readFileSync(file,'utf8'))[0][1].owner).toBe(ambiguous?legacy:owner);
 await c.register('held',{command:'fixture',args:[],env:{}});
 if(ambiguous){await expect(c.release('held',owner,c.status('held').generation)).rejects.toMatchObject({status:409});await c.sessionGate.run(['held'],token=>{c.reclaimLocked(token,'held',owner);});expect(c.holdState('held')?.legacy).toBe(false);}
 await c.sessionGate.run(['held'],token=>{c.releaseLocked(token,'held',owner,c.status('held').generation);});expect(c.holdState('held')?.held).toBe(false);
 }finally{removeTempDirSync(dir);}
});
