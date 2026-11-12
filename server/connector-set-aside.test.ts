import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,expect,test} from 'vitest';
import {setAsideConnectors} from './connector-set-aside.ts';
import {removeTempDirSync} from './testing/cleanup.ts';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(root=>removeTempDirSync(root)));
function seed(){const root=mkdtempSync(join(tmpdir(),'connector-setaside-'));roots.push(root);const names=['connector-health.json','connector-health.json.journal',`connector-health.json.123.${randomUUID()}.tmp`,'connector-notice-receipts.json','connector-notice-receipts.json.123.tmp'];
 for(const name of names)writeFileSync(join(root,name),name,{mode:0o600});return{root,names};}
test('RED23 RUN all five source kinds preserve bytes/inodes and retained destinations across upgrade retries',()=>{
 const {root,names}=seed(),inodes=names.map(n=>statSync(join(root,n)).ino);setAsideConnectors(root);const namespace=join(root,'recovery-quarantine/connector-set-aside');expect(readdirSync(namespace)).toHaveLength(1);const [id]=readdirSync(namespace),dir=join(namespace,id!);
 names.forEach((n,i)=>{expect(existsSync(join(root,n))).toBe(false);expect(readFileSync(join(dir,n),'utf8')).toBe(n);expect(statSync(join(dir,n)).ino).toBe(inodes[i]);});
 setAsideConnectors(root);expect(readdirSync(namespace)).toEqual([id]);
 writeFileSync(join(root,names[0]!), 'new',{mode:0o600});setAsideConnectors(root);expect(readdirSync(namespace)).toHaveLength(2);expect(readFileSync(join(dir,names[0]!),'utf8')).toBe(names[0]);
});
for(const fail of ['write','rename','barrier'] as const)test(`RED37 discover and resume connector transaction after ${fail}`,()=>{
 const {root,names}=seed();let crashed=false;
 expect(()=>setAsideConnectors(root,{after:(op,path)=>{if(!crashed&&op===fail&&(fail!=='barrier'||path.includes('connector-set-aside/'))){crashed=true;throw new Error('crash');}}})).toThrow('crash');
 setAsideConnectors(root);const namespace=join(root,'recovery-quarantine/connector-set-aside');for(const id of readdirSync(namespace)){const journal=join(namespace,id,'set-aside.json');if(existsSync(journal))expect(JSON.parse(readFileSync(journal,'utf8')).state).toBe('moved');}for(const name of names){expect(existsSync(join(root,name))).toBe(false);expect(readdirSync(namespace).some(id=>existsSync(join(namespace,id,name)))).toBe(true);}
});
test('RED23 health journal-only state is preserved without inventing a snapshot',()=>{
 const root=mkdtempSync(join(tmpdir(),'connector-journal-'));roots.push(root);writeFileSync(join(root,'connector-health.json.journal'),'line\n',{mode:0o600});setAsideConnectors(root);
 const namespace=join(root,'recovery-quarantine/connector-set-aside'),[id]=readdirSync(namespace);expect(readFileSync(join(namespace,id!,'connector-health.json.journal'),'utf8')).toBe('line\n');expect(existsSync(join(namespace,id!,'connector-health.json'))).toBe(false);
});
test('RED37 unexplained destination is preserved and refuses further movement',()=>{
 const {root,names}=seed(),dir=join(root,'recovery-quarantine/connector-set-aside',randomUUID());mkdirSync(dir,{recursive:true,mode:0o700});writeFileSync(join(dir,'unknown'),'kept',{mode:0o600});expect(()=>setAsideConnectors(root)).toThrow();expect(readFileSync(join(root,names[0]!),'utf8')).toBe(names[0]);expect(readFileSync(join(dir,'unknown'),'utf8')).toBe('kept');
});
test('RED23 actual health journal and desktop receipt writer outputs are retained and never restored',async()=>{
 const {ConnectorHealthStore}=await import('./connector-health-store.ts');
 // @ts-expect-error Native Electron receipt writer is an ESM JavaScript module.
 const {createConnectorNoticeReceipts}=await import('../electron/connector-notice-receipts.mjs');
 const root=mkdtempSync(join(tmpdir(),'connector-real-writers-'));roots.push(root);
 const health=new ConnectorHealthStore(join(root,'connector-health.json'),()=>123);health.mark('fixture-owner','fixture-app','fixture reconnect',null);
 expect(existsSync(join(root,'connector-health.json'))).toBe(false);expect(new ConnectorHealthStore(join(root,'connector-health.json')).get('fixture-owner','fixture-app')).toMatchObject({at:123});
 const receipts=createConnectorNoticeReceipts(join(root,'connector-notice-receipts.json'));receipts.delivered('fixture-home','fixture-incident');
 const emitted=readdirSync(root);expect(emitted).toEqual(['connector-health.json.journal','connector-notice-receipts.json']);
 const bytes=emitted.map(name=>readFileSync(join(root,name)));setAsideConnectors(root);setAsideConnectors(root);
 const namespace=join(root,'recovery-quarantine/connector-set-aside'),[id]=readdirSync(namespace);emitted.forEach((name,index)=>expect(readFileSync(join(namespace,id!,name))).toEqual(bytes[index]));
 expect(new ConnectorHealthStore(join(root,'connector-health.json')).get('fixture-owner','fixture-app')).toBeUndefined();expect(createConnectorNoticeReceipts(join(root,'connector-notice-receipts.json')).has('fixture-home','fixture-incident')).toBe(false);
});

test('AFIX H1 connector mkdir interruption rebarriers namespace ancestry before retry mutation',()=>{
 const {root,names}=seed(),quarantine=join(root,'recovery-quarantine'),namespace=join(quarantine,'connector-set-aside');
 expect(()=>setAsideConnectors(root,{after:(op,path)=>{if(op==='mkdir'&&path===namespace)throw new Error('crash-before-parent-sync');}})).toThrow('crash-before-parent-sync');
 const trace:string[]=[];
 setAsideConnectors(root,{sync:child=>{trace.push(child);return 'synced';},after:op=>{if(['mkdir','temp','metadata-rename','rename'].includes(op))expect(trace,'ancestor barriers must precede every retry mutation').toEqual(expect.arrayContaining([join(root,'.barrier'),join(quarantine,'.barrier'),join(namespace,'.barrier')]));}});
 expect(names.every(name=>!existsSync(join(root,name)))).toBe(true);
});
test('AFIX H1 connector retry parent barrier failure stops before further mutation',()=>{
 const {root,names}=seed(),quarantine=join(root,'recovery-quarantine'),namespace=join(quarantine,'connector-set-aside');
 expect(()=>setAsideConnectors(root,{after:(op,path)=>{if(op==='mkdir'&&path===namespace)throw new Error('crash');}})).toThrow();
 const mutations:string[]=[];
 expect(()=>setAsideConnectors(root,{sync:child=>{if(child===join(quarantine,'.barrier'))throw new Error('parent-sync-failed');return 'synced';},after:op=>{if(['mkdir','temp','metadata-rename','rename','write'].includes(op))mutations.push(op);}})).toThrow('parent-sync-failed');
 expect(mutations).toEqual([]);for(const name of names)expect(readFileSync(join(root,name),'utf8')).toBe(name);
});
