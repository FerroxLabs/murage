// Feature witnesses deliberately import only modules present at the exact
// redsp3 start commit, so the baseline REDs fail on behavior, never imports.
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {beforeEach,afterEach,expect,test} from 'vitest';
import {DATA_DIR} from '../../config.ts';
import {database,closeDatabase} from '../../database.ts';
import {downgradeInstallationMemorySchema} from '../../installation-memory-downgrade.ts';
import {removeTempDirSync} from '../../testing/cleanup.ts';
const fence={lease:()=> 'fixture-lease',discover:()=>true,host:()=> 'fixture',boot:()=> 'boot',uptime:()=>1};
const put=(file:string,value:unknown)=>{mkdirSync(dirname(file),{recursive:true,mode:0o700});writeFileSync(file,JSON.stringify(value),{mode:0o600});};
beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true,mode:0o700});});
afterEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);});
for(const target of [10,13] as const)for(const witness of ['auth','channel','connector'] as const)test(`FEATURE exact-start RED target ${target}: physical ${witness} custody`,()=>{
 database();closeDatabase();put(join(DATA_DIR,'install-id.json'),{installId:randomUUID()});
 put(join(DATA_DIR,'signal/auth/key'),{fake:'auth'});put(join(DATA_DIR,'channels/signal/connection.json'),{version:1,connectionId:'feature',generation:3,enabled:false,paused:true,revoking:false,binding:null,account:null});
 const names=['connector-health.json','connector-health.json.journal',`connector-health.json.123.${randomUUID()}.tmp`,'connector-notice-receipts.json','connector-notice-receipts.json.123.tmp'];for(const name of names)put(join(DATA_DIR,name),{fake:name});
 let refused:unknown;try{downgradeInstallationMemorySchema(DATA_DIR,target,{...{signal:{fence}}});}catch(error){refused=error;}
 // Independent physical assertions precede the result check: an older
 // classifier refusal cannot mask live credentials or retained C/connector names.
 if(witness==='auth')expect(existsSync(join(DATA_DIR,'signal')),'live auth must be parked before older release opens').toBe(false);
 if(witness==='channel')expect(existsSync(join(DATA_DIR,'channels/signal')),'live C must be absent from downgraded backups').toBe(false);
 if(witness==='connector')for(const name of names)expect(existsSync(join(DATA_DIR,name)),`connector source ${name} must be set aside`).toBe(false);
 expect(refused).toBeUndefined();
});
