import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import ts from 'typescript';
import {afterEach,expect,test} from 'vitest';
import {ZipFile} from 'yazl';
import * as yauzl from 'yauzl';
import * as backup from '../../../shared/installation-backup.ts';
import * as limits from '../../../shared/backup-limits.ts';
import * as archive from '../../installation-archive.ts';
import {InstallationSnapshotError,type OfflineInstallation} from '../../installation-database-snapshot.ts';
import {inventoryFidelity} from '../../installation-fidelity-snapshot.ts';
import type {StateSnapshotManifest} from '../../installation-state-snapshot.ts';
import {prepareInstallationRestore} from '../../installation-restore-preparation.ts';
import * as old102 from '../../testing/frozen/inventory-102.ts';
import * as old117 from '../../testing/frozen/inventory-117.ts';
import {removeTempDirSync} from '../../testing/cleanup.ts';
import {preserveSignalForDowngrade} from './park-downgrade.ts';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(root=>removeTempDirSync(root)));
const pins:Record<string,string>={'fidelity-102.source.txt':'2cfbd5ec79a341ad209e771d24274f27c353afdd8eeb7fafd56e7a10f5dbdb50','fidelity-117.source.txt':'723a67e8afcdc5b9d9c2c22c3776c1d9b1dd1ec37bf5918f3681205c797eac4e','restore-102.source.txt':'b06a652811e2ba72edf423d2d73161042f3747a05d5fc239cf08a91afd2d0a4f','restore-117.source.txt':'27110c1a3ab94248ce7b9bbf72165753eb107f83d50f71d16ebdde3f9a7ce42b'};
function frozen(name:string,inventory:unknown){
 const source=fs.readFileSync(new URL(`../../testing/frozen/${name}`,import.meta.url),'utf8');expect(crypto.createHash('sha256').update(source).digest('hex')).toBe(pins[name]);
 const exports:Record<string,unknown>={},native=createRequire(import.meta.url);
 const deps:Record<string,unknown>={'../shared/installation-backup.ts':backup,'../shared/backup-limits.ts':limits,'./installation-archive.ts':archive,'./installation-database-snapshot.ts':{InstallationSnapshotError},'./data-dir-inventory.ts':inventory,
 '../electron/restore-review.mjs':{RESTORE_REVIEW_FILE:'restore-review.json'},'../electron/restored-connections.mjs':{RESTORED_CONNECTIONS_FILE:'restored-connections.json'}};
 const require=(id:string)=>id.startsWith('node:')?native(id):deps[id]??new Proxy({},{get:()=>()=>{throw new Error(`unexpected frozen dependency ${id}`);}});
 new Function('require','exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(require,exports);return exports;
}
function put(file:string,data:string){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,data,{mode:0o600});}
const fence={lease:()=>"fixture-lease",discover:()=>true,host:()=> 'fixture',boot:()=> 'boot',uptime:()=>1};
function manifest(files:StateSnapshotManifest['files']):StateSnapshotManifest{return{format:'murage.installation-stage',version:1,snapshotId:crypto.randomUUID(),createdAt:new Date().toISOString(),restorePolicy:'paused-review-required',files,omitted:[],missing:[],database:{status:'absent'}};}
async function zipNames(sources:Array<{source:string;path:string}>){const zip=new ZipFile(),chunks:Buffer[]=[];for(const item of sources)zip.addFile(item.source,item.path);zip.outputStream.on('data',chunk=>chunks.push(Buffer.from(chunk)));const ready=new Promise<void>((yes,no)=>zip.outputStream.on('end',yes).on('error',no));zip.end();await ready;
 return new Promise<string[]>((yes,no)=>yauzl.fromBuffer(Buffer.concat(chunks),{lazyEntries:true},(error,file)=>{if(error||!file)return no(error);const names:string[]=[];file.on('entry',entry=>{names.push(entry.fileName);file.readEntry();});file.on('end',()=>yes(names));file.on('error',no);file.readEntry();}));}
test('RED27 physical parked paths and exact frozen/current selectors produce archives without either live component',async()=>{
 const root=fs.mkdtempSync(path.join(tmpdir(),'park-archive-'));roots.push(root);const stage=fs.mkdtempSync(path.join(tmpdir(),'park-stage-'));roots.push(stage);
 put(path.join(root,'install-id.json'),JSON.stringify({installId:crypto.randomUUID()}));put(path.join(root,'bots.json'),'[]');put(path.join(root,'messages.db'),'fake selector database');
 put(path.join(root,'channels/signal/connection.json'),JSON.stringify({version:1,connectionId:'one',generation:3,enabled:false,paused:true,revoking:false,binding:null,account:null}));put(path.join(root,'channels/signal/one/receipts.json'),'fake receipt');put(path.join(root,'signal/auth/key'),'fake auth');put(path.join(root,'connector-health.json.journal'),'fake health journal');
 const old=frozen('fidelity-102.source.txt',old102).inventoryFidelity as typeof inventoryFidelity;
 const staged={directory:stage,manifest:manifest([])},installation={dataDir:root} as OfflineInstallation;
 await expect(old(installation,staged,{scope:'application-data',credentialPolicy:'preserve-in-encrypted-fidelity'})).rejects.toMatchObject({code:'BACKUP_UNCLASSIFIED_COMPONENT'});
 preserveSignalForDowngrade(root,{fence});expect(fs.existsSync(path.join(root,'signal'))).toBe(false);expect(fs.existsSync(path.join(root,'channels/signal'))).toBe(false);
 for(const name of fs.readdirSync(root)){expect(old102.classifyDataDirEntry(name),name).toBeDefined();expect(old102.classifyDataDirEntry(name)?.backup,name).not.toBe('refused');}
 for(const select of [old,frozen('fidelity-117.source.txt',old117).inventoryFidelity as typeof inventoryFidelity,inventoryFidelity]){
  const selected=await select(installation,staged,{scope:'application-data',credentialPolicy:'preserve-in-encrypted-fidelity'});
  const names=await zipNames(selected.sources);expect(names.some(n=>/^(signal\/|channels\/signal\/|recovery-quarantine\/)/.test(n))).toBe(false);expect(selected.coverage.components.find(c=>c.path==='recovery-quarantine')?.status).toBe('excluded');
 }
});
test('RED27 incoming quarantine archive is refused by current and exact frozen restore preparations',async()=>{
 const root=fs.mkdtempSync(path.join(tmpdir(),'park-incoming-'));roots.push(root);const relative='recovery-quarantine/signal-parked/one.g3/signal/auth/key',bytes=Buffer.from('fake'),stage=fs.mkdtempSync(path.join(root,'stage-'));put(path.join(stage,'state',relative),bytes.toString());
 const entry={path:relative,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};const zip=path.join(root,'input.zip');await archive.writeInstallationStageArchive({directory:stage,manifest:manifest([entry])},zip);
 for(const prepare of [prepareInstallationRestore,frozen('restore-102.source.txt',old102).prepareInstallationRestore as typeof prepareInstallationRestore,frozen('restore-117.source.txt',old117).prepareInstallationRestore as typeof prepareInstallationRestore]){let error:unknown;try{await prepare(zip,root);}catch(caught){error=caught;}expect((error as {code?:string})?.code,String(error)).toBe('RESERVED_RESTORE_COMPONENT');}
});
test('RED27 archive C exclusion executes independently of physical and classifier assertions',async()=>{
 const root=fs.mkdtempSync(path.join(tmpdir(),'park-archive-independent-'));roots.push(root);const stage=fs.mkdtempSync(path.join(tmpdir(),'park-stage-independent-'));roots.push(stage);
 put(path.join(root,'install-id.json'),JSON.stringify({installId:crypto.randomUUID()}));put(path.join(root,'bots.json'),'[]');put(path.join(root,'messages.db'),'fake selector database');
 put(path.join(root,'channels/signal/connection.json'),JSON.stringify({version:1,connectionId:'one',generation:3,enabled:false,paused:true,revoking:false,binding:null,account:null}));put(path.join(root,'channels/signal/one/receipts.json'),'fake receipt');put(path.join(root,'signal/auth/key'),'fake auth');
 preserveSignalForDowngrade(root,{fence});
 for(const select of [frozen('fidelity-102.source.txt',old102).inventoryFidelity as typeof inventoryFidelity,frozen('fidelity-117.source.txt',old117).inventoryFidelity as typeof inventoryFidelity,inventoryFidelity]){
  const selected=await select({dataDir:root} as OfflineInstallation,{directory:stage,manifest:manifest([])},{scope:'application-data',credentialPolicy:'preserve-in-encrypted-fidelity'});
  expect(await zipNames(selected.sources)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^channels\/signal\//)]));
 }
});
