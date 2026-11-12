import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {afterEach,beforeEach,expect,test} from 'vitest';
import {DATA_DIR} from '../../config.ts';
import {closeDatabase,database} from '../../database.ts';
import {downgradeInstallationMemorySchema,DATA_DIR_NAMES_AFTER_102,DATA_DIR_OWNER_NOTES_AFTER_102,DATA_DIR_DATABASES_AFTER_102,DATA_DIR_RECORDS_AFTER_102} from '../../installation-memory-downgrade.ts';
import {removeTempDirSync} from '../../testing/cleanup.ts';
import {recoverSignalPark} from './park.ts';
import * as old102 from '../../testing/frozen/inventory-102.ts';
import {signalDowngradeRefusal,preserveSignalForDowngrade} from './park-downgrade.ts';
const fence={lease:()=>"fixture-lease",discover:()=>true,host:()=> 'fixture',boot:()=> 'boot',uptime:()=>1};
beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true,mode:0o700});});afterEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);});
function put(file:string,value:unknown){mkdirSync(dirname(file),{recursive:true,mode:0o700});writeFileSync(file,Buffer.isBuffer(value)?value:JSON.stringify(value),{mode:0o600});}
for(const target of [10,13] as const)test(`RUN RED27 real downgrade target ${target} parks both components before restoration`,()=>{
 database();closeDatabase();put(join(DATA_DIR,'install-id.json'),{installId:randomUUID()});const auth=randomBytes(128);put(join(DATA_DIR,'signal/auth/deep/key'),auth);
 const binding={connectionId:'legacy',generation:3,ownAci:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ownDeviceId:2,linkedAt:1,chiefBotId:'chief'};
 const record={version:1,connectionId:'legacy',generation:3,enabled:true,paused:false,revoking:false,binding,account:'+15550001234'};
 put(join(DATA_DIR,'channels/signal/connection.json'),record);put(join(DATA_DIR,'channels/signal/legacy/receipts.json'),{fake:'receipt'});put(join(DATA_DIR,'channels/signal/legacy/outbox.json'),{fake:'outbox'});
 put(join(DATA_DIR,'signal/ingress/legacy.ndjson'),Buffer.from(''));put(join(DATA_DIR,'signal/ingress/legacy.tombstones.json'),[]);
 const names=['connector-health.json','connector-health.json.journal',`connector-health.json.123.${randomUUID()}.tmp`,'connector-notice-receipts.json','connector-notice-receipts.json.123.tmp'];for(const name of names)put(join(DATA_DIR,name),{fake:name});
 const ai=statSync(join(DATA_DIR,'signal')).ino,ci=statSync(join(DATA_DIR,'channels/signal')).ino;
 const result=downgradeInstallationMemorySchema(DATA_DIR,target,{signal:{fence}});
 expect(existsSync(join(DATA_DIR,'signal'))).toBe(false);expect(existsSync(join(DATA_DIR,'channels/signal'))).toBe(false);
 const ns=join(DATA_DIR,'recovery-quarantine/signal-parked'),[name]=readdirSync(ns),dir=join(ns,name!);
 expect(statSync(join(dir,'signal')).ino).toBe(ai);expect(statSync(join(dir,'channels-signal')).ino).toBe(ci);expect(readFileSync(join(dir,'signal/auth/deep/key'))).toEqual(auth);
 expect(result).toMatchObject({to:target,signalKept:expect.stringContaining('checks these files')});
 for(const source of names)expect(existsSync(join(DATA_DIR,source))).toBe(false);
 if(target===10)for(const name of readdirSync(DATA_DIR)){expect(old102.classifyDataDirEntry(name),name).toBeDefined();expect(old102.classifyDataDirEntry(name)?.backup,name).not.toBe('refused');}
 expect(recoverSignalPark(DATA_DIR,{fence})).toMatchObject({state:'ready'});expect(statSync(join(DATA_DIR,'signal')).ino).toBe(ai);expect(statSync(join(DATA_DIR,'channels/signal')).ino).toBe(ci);expect(JSON.parse(readFileSync(join(DATA_DIR,'channels/signal/connection.json'),'utf8'))).toEqual(record);
},120000);
test('RED26 refusal copy reflects read-only, metadata-only and moved stages',()=>{
 expect(signalDowngradeRefusal('read-only','unsafe')).toMatch(/^No Signal files were moved\./);
 expect(signalDowngradeRefusal('metadata','durability')).toMatch(/^Murage saved the recovery details\. No Signal files were moved\./);
 expect(signalDowngradeRefusal('moved','durability')).toMatch(/^Murage stopped after moving some Signal files\./);
 for(const stage of ['read-only','metadata','moved'] as const)expect(signalDowngradeRefusal(stage,'conflict')).not.toMatch(/Nothing was changed|two places|R[1-6]|H[1-3]/);
});
test('RED25 exact wipe implementation stays pinned',()=>{
 expect(createHash('sha256').update(readFileSync(new URL('./wipe.ts',import.meta.url))).digest('hex')).toBe('13edca28b698854b2a343b526684761ed50809688caebff22afc8570ac6d32c4');
});

test("RED25 removal arrays retain their exact literals",()=>{
 expect([...DATA_DIR_NAMES_AFTER_102]).toEqual(["browser-window", "model-catalogs", "claude-private", "claude-signin-answers.json", "draft-only-cwd", "email-capabilities.json", "email-capabilities.json.tmp", "env", "feedback-install-id", "frozen-replies-recovery.json", "learning-paused-left.json", "memory-model-adopted.json", "memory-model-adopted.json.tmp", "memory-repairs.json", "memory-repairs.json.tmp", "pending-grants.json", "setup-backup.json", "cloud-computer-turns.json", "cloud-computer-turns.json.unreadable", "news-signup.json", "health", "health-key", "sentinel-delivery.json", "power-guard-notice.json", "highlevel"]);
 expect([...DATA_DIR_OWNER_NOTES_AFTER_102]).toEqual([".threads-follow-model-v1", "owner-prefs.json", "outside-state.jsonl"]);
 expect([...DATA_DIR_DATABASES_AFTER_102]).toEqual(["phone-calls.db", "phone-calls.db-journal", "phone-calls.db-shm", "phone-calls.db-wal"]);
 expect([...DATA_DIR_RECORDS_AFTER_102]).toEqual(["browser-modes.json", ".murage-root.json"]);
});

test('RED26 connector-only interruption never claims that Signal credential files moved',()=>{
 put(join(DATA_DIR,'connector-health.json.journal'),{fake:true});let caught:unknown;
 try{preserveSignalForDowngrade(DATA_DIR,{after:op=>{if(op==='rename')throw new Error('crash');}});}catch(error){caught=error;}
 expect((caught as Error).message).toMatch(/^Murage saved the recovery details\. No Signal files were moved\./);expect(existsSync(join(DATA_DIR,'signal'))).toBe(false);expect(existsSync(join(DATA_DIR,'channels/signal'))).toBe(false);
});
