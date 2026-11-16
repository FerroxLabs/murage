import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { ParkFs, parkReason } from './park-fs.ts';
import { preserveSignalForDowngrade } from './park-downgrade.ts';
import { removeTempDirSync } from '../../testing/cleanup.ts';
const roots:string[]=[],sid='S-1-5-21-1-2-3-1001';
afterEach(()=>{for(const root of roots.splice(0))removeTempDirSync(root);});
const fence={lease:()=> 'fixture',discover:()=>true,host:()=> 'fixture',boot:()=> 'boot',uptime:()=>1};
function fixture(){
 const root=fs.mkdtempSync(join(tmpdir(),'signal-release-'));roots.push(root);
 fs.mkdirSync(join(root,'signal/auth'),{recursive:true,mode:0o700});fs.writeFileSync(join(root,'signal/auth/key'),'SYNTHETIC',{mode:0o600});
 fs.mkdirSync(join(root,'channels/signal'),{recursive:true,mode:0o700});
 fs.writeFileSync(join(root,'channels/signal/connection.json'),JSON.stringify({version:1,connectionId:'one',generation:3,enabled:false,paused:true,revoking:false,binding:null,account:null}),{mode:0o600});
 fs.writeFileSync(join(root,'install-id.json'),JSON.stringify({installId:randomUUID()}),{mode:0o600});return root;
}
test('Windows unsupported directory fsync completes preservation and reports the durability limit',()=>{
 const root=fixture();
 const result=preserveSignalForDowngrade(root,{platform:'win32',sync:()=> 'unsupported',windowsSid:()=>sid,
  windowsEntry:path=>({path,attributes:fs.lstatSync(path).isDirectory()?16:0,sddl:`O:${sid}D:P(A;;FA;;;${sid})`}),protectNewWindowsEntries:()=>true,fence});
 expect(result).toMatchObject({signalDirectoryDurability:'unsupported'});expect(result.signalKept).toBeDefined();
 expect(fs.existsSync(join(root,'signal'))).toBe(false);expect(fs.existsSync(join(root,'channels/signal'))).toBe(false);
});
for(const failure of ['unsupported','throw'] as const)test(`POSIX ${failure} directory sync still refuses required preservation`,()=>{
 const root=fixture(),io=new ParkFs(root,{platform:'darwin',uid:fs.lstatSync(root).uid,sync:()=>{if(failure==='throw')throw new Error('sync failed');return 'unsupported';}});
 let error:unknown;try{io.barrier(root,true);}catch(caught){error=caught;}
 expect(error).toBeDefined();expect(parkReason(error)).toBe('durability');
 expect(fs.existsSync(join(root,'signal/auth/key'))).toBe(true);
});
