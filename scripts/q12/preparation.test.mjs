import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,symlinkSync,rmSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {main,assertPaused,assertProfileRoute} from './run-q12.mjs';
import {GiB,executionProfile,memoryReading,assertPrestart,belowStop,privateDirectory,ownedPath,assertManifestIdentity,safeEncryptedResponse,sourceSeams} from './runtime.mjs';
import {verifyProducer} from './ci.mjs';
const packet=dirname(fileURLToPath(import.meta.url)),source=readFileSync(join(packet,'run-q12.mjs'),'utf8'),workflow=readFileSync(new URL('../../.github/workflows/package-mac-qualification.yml',import.meta.url),'utf8');
const hosted=()=>({platform:'darwin',arch:'arm64',username:'runner',home:'/Users/runner',manager:'Aqua',env:{GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'macOS',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',RUNNER_TEMP:'/Users/runner/work/_temp',GITHUB_WORKSPACE:'/Users/runner/work/murage/murage',MURAGE_Q12_CI_CONFIRM:'disposable-packaged-q12'}});
const sha=b=>createHash('sha256').update(b).digest('hex');
test('unadmitted driver refuses before native output or host inspection',async()=>{
 const root=mkdtempSync(join(tmpdir(),'q12-refusal-'));try{const manifest=join(root,'manifest.json'),out=join(root,'out');writeFileSync(manifest,JSON.stringify({rootApproved:false,out}));await assert.rejects(main(manifest),/Root admission required/);assert(!existsSync(out));}finally{rmSync(root,{recursive:true});}
});
test('SHARED_MAC remains default 8/4 and cannot inherit caller thresholds',()=>{
 const p=executionProfile();assert.equal(p.name,'SHARED_MAC');assert.equal(p.prestartBytes,8*GiB);assert.equal(p.stopBytes,4*GiB);assert(Object.isFrozen(p));
 assert.throws(()=>executionProfile('other'));assert.throws(()=>{p.prestartBytes=0;});
 const memory=n=>({physicalBytes:16*GiB,reserveBytes:n*GiB});assertPrestart(p,memory(8));assert.throws(()=>assertPrestart(p,memory(7.99)));assert.equal(belowStop(p,memory(4)),false);assert.equal(belowStop(p,memory(3.99)),true);
});
test('disposable profile requires every hosted identity guard and preserves time bounds',()=>{
 const p=executionProfile('DISPOSABLE_GITHUB_MAC',hosted());assert.equal(p.prestartBytes,3*GiB);assert.equal(p.stopBytes,1.5*GiB);assert.equal(p.minPhysicalBytes,6*GiB);assert.equal(p.windowMs,1800000);assert.equal(p.monitorMs,2000);
 for(const mutate of [c=>c.platform='linux',c=>c.arch='x64',c=>c.username='sean',c=>c.home='/Users/sean',c=>c.manager='Background',c=>c.env.GITHUB_ACTIONS='false',c=>c.env.RUNNER_ENVIRONMENT='self-hosted',c=>c.env.RUNNER_OS='Linux',c=>c.env.MURAGE_Q12_CI_CONFIRM='',c=>c.env.GITHUB_RUN_ID='',c=>c.env.RUNNER_TEMP='relative',c=>c.env.GITHUB_WORKSPACE='/x/../y']){const c=hosted();mutate(c);assert.throws(()=>executionProfile('DISPOSABLE_GITHUB_MAC',c));}
 const reading={physicalBytes:7*GiB,reserveBytes:3*GiB};assertPrestart(p,reading);assert.throws(()=>assertPrestart(p,{...reading,physicalBytes:5*GiB}));assert.throws(()=>assertPrestart(p,{...reading,reserveBytes:3*GiB-1}));assert.equal(belowStop(p,{...reading,reserveBytes:1.5*GiB}),false);assert.equal(belowStop(p,{...reading,reserveBytes:1.5*GiB-1}),true);
});
test('memory parser refuses unknown, duplicate or impossible readings',()=>{
 const text='Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 131072.\nPages inactive: 65536.\n';const r=memoryReading(text,7*GiB);assert.equal(r.reserveBytes,3*GiB);
 for(const bad of ['',text.replace('page size of 16384','page size of unknown'),text+'Pages free: 1.\n',text.replace('Pages inactive: 65536.','Pages inactive: -1.')])assert.throws(()=>memoryReading(bad,7*GiB));
 assert.throws(()=>memoryReading(text,GiB));assert.throws(()=>memoryReading(text,'not-a-size'));
});
test('task ownership rejects normal profiles, symlinks, existing output and nonprivate roots',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'q12-path-')));try{privateDirectory(root);mkdirSync(join(root,'owned'),{mode:0o700});assert.equal(ownedPath(root,join(root,'owned/new'),{absent:true}),join(root,'owned/new'));writeFileSync(join(root,'owned/file'),'x');assert.throws(()=>ownedPath(root,join(root,'owned/file'),{absent:true}));symlinkSync(join(root,'owned'),join(root,'link'));assert.throws(()=>ownedPath(root,join(root,'link/file')));assert.throws(()=>ownedPath(root,join(dirname(root),'normal-profile'),{absent:true}));mkdirSync(join(root,'open'),{mode:0o755});assert.throws(()=>privateDirectory(join(root,'open')));}finally{rmSync(root,{recursive:true});}
});
test('manifest and exact producer identity cannot be relabeled or silently repinned',()=>{
 const expected={sourceCommit:'a'.repeat(40),fixtureCommit:'b'.repeat(40),fuigoVersion:'1.0.19'},m={...expected,rootApproved:true,appHashes:Object.fromEntries(['a','b','c','d'].map(n=>[n,'1'.repeat(64)])),sourcePins:Object.fromEntries(sourceSeams.map(n=>[n,'2'.repeat(64)])),driverSha256:'3'.repeat(64),pickerSha256:'4'.repeat(64),keygen:{sha256:'c16e229245123d0ad27442317461d63915416cad0294395cd19ca93feb3211ea'}};assertManifestIdentity(m,expected);
 for(const mutate of [x=>x.rootApproved=false,x=>x.sourceCommit='c'.repeat(40),x=>x.fixtureCommit='c'.repeat(40),x=>x.fuigoVersion='1.0.18',x=>delete x.sourcePins,x=>x.keygen.sha256='0'.repeat(64),x=>x.appHashes.a='bad',x=>x.appHashes['../escape']='1'.repeat(64)]){const x=structuredClone(m);mutate(x);assert.throws(()=>assertManifestIdentity(x,expected));}
 const producer={id:123,run_attempt:1,head_sha:expected.sourceCommit,status:'completed',conclusion:'success',path:'.github/workflows/package-mac-qualification.yml'},gates={sourceSha:expected.sourceCommit,appTeam:'PX6SP9GPWJ',inventory:['Contents/MacOS/Murage','Contents/Resources/fuigo/fuigo','Contents/Resources/backup-tools/arm64/age'].map(path=>({path,sha256:'0'.repeat(64)}))},pin={source:expected.sourceCommit,runId:'123',attempt:'1'};verifyProducer(producer,gates,pin);
 for(const patch of [{status:'in_progress'},{conclusion:'failure'},{id:124},{run_attempt:2},{head_sha:'c'.repeat(40)},{path:'.github/workflows/ci.yml'}])assert.throws(()=>verifyProducer({...producer,...patch},gates,pin));assert.throws(()=>verifyProducer(producer,{...gates,sourceSha:'d'.repeat(40)},pin));
});
test('pinned native picker remains exact prepared Open/Save primitive',()=>{
 const picker=readFileSync(join(packet,'native-picker.jxa'),'utf8');assert.equal(sha(picker),'e7695436d769840f37fe1084048a24913761d8a884ba5163908691aedcd7b97c');new Function(picker);assert(picker.includes('picker-path-readback'));assert(picker.includes("cmd.actionButton!=='Open'&&cmd.actionButton!=='Save'"));
});
test('paused fence rejects active work and authority after restore',()=>{
 const good={meta:{mode:'paused'},delivered:0,leased:0,optimizerRunning:0,engines:[{enabled:false}],routines:[{enabled:false}],runs:[{status:'cancelled'}],webhooks:[{enabled:false}],bots:[{busy:false,autoApprove:false,resumeCursors:{},tasks:[{autoApprove:false,alwaysAllow:[],resumeCursors:{}}]}],groups:[{working:false,busyBotId:null}]};assertPaused(good);
 for(const mutate of [s=>s.meta.mode='active',s=>s.delivered=1,s=>s.leased=1,s=>s.optimizerRunning=1,s=>s.engines[0].enabled=true,s=>s.routines[0].enabled=true,s=>s.runs[0].status='running',s=>s.webhooks[0].enabled=true,s=>s.bots[0].tasks[0].resumeCursors={old:'cursor'},s=>s.groups[0].working=true]){const bad=structuredClone(good);mutate(bad);assert.throws(()=>assertPaused(bad));}
});
test('original and restored phase routing cannot be confused or invented',()=>{
 const original='/fixture/original',target='/fixture/userData/recovered-installations/new/data';assertProfileRoute(original,original,{dataDirectory:original,selected:false});assertProfileRoute(original,target,{dataDirectory:target,selected:true,originalRoot:original});
 for(const selection of [{dataDirectory:original,selected:false},{dataDirectory:target,selected:false},{dataDirectory:target,selected:true,originalRoot:'/other'}])assert.throws(()=>assertProfileRoute(original,target,selection));assert.throws(()=>assertProfileRoute(original,original,{dataDirectory:target,selected:true,originalRoot:original}));
 assert(source.includes('resolveInstallationSelection(userData,data)'));assert(source.includes('requestedData:process.env.MURAGE_DATA_DIR'));assert(source.includes('served.deletionEpoch,expected.deletion_epoch'));assert(source.includes('state.context.dataDirectory,expectedData'));
});
test('encrypted response records only finite diagnostic fields before success assertion',()=>{
 assert.deepEqual(safeEncryptedResponse({value:{error:'RECOVERY_WORKER_TIMEOUT',result:null},secret:'AGE-SECRET'}),{connectionClosed:false,error:'RECOVERY_WORKER_TIMEOUT',operation:null,ok:false});
 assert.equal(safeEncryptedResponse({value:{error:'password=secret'}}).error,null);assert.equal(safeEncryptedResponse({connectionClosed:true}).connectionClosed,true);assert(!JSON.stringify(safeEncryptedResponse({value:{error:'bad',result:{operation:'AGE-SECRET',identity:'AGE-SECRET'}}})).includes('AGE-SECRET'));
 assert(source.indexOf("record('actual-encrypted-backup-response',safeEncryptedResponse(reply))")<source.indexOf("assert(created&&!created.error"));
});
test('actual functional sequence and success criteria remain byte-for-byte after diagnostic insertion',()=>{
 let body=source.slice(source.indexOf(' let ids,'),source.indexOf('\n finally{',source.indexOf(' let ids,')));
 body=body.replace("const reply=await pending,created=reply.value;record('actual-encrypted-backup-response',safeEncryptedResponse(reply));","const created=(await pending).value;");
 assert.equal(sha(body),'d1de6b587f0cdbaa43930dd63e596e93a918cf6f26c1e562a9e240ebc7b46a3f');
 assert(source.includes('fullQ12Accepted=false'));assert(source.includes('No re-enable performed.'));assert(source.includes('window.muragebox.backup.restart()'));assert(source.includes('window.murageRecovery.action(action,id)'));assert(source.includes('assertPrestart(profile,launchMemory)'));assert(source.includes('belowStop(profile,reading)'));assert(!source.includes('/Users/seandonahoe/'));assert(!source.includes('/Volumes/Mando/'));
 assert(source.includes('Task app already running'));assert(source.indexOf('assertPrestart(profile,admittedMemory)')<source.indexOf('execFileSync(m.keygen.path'));
});
test('existing workflow has one explicit standard-runner consumer with always cleanup and safe uploads',()=>{
 const q=workflow.slice(workflow.indexOf('\n  q12:'));assert(q.includes('runs-on: macos-14'));assert(!q.includes('-xlarge'));assert(q.includes('timeout-minutes: 60'));assert(q.includes('cancel-in-progress: false'));assert.equal((q.match(/run: node --max-old-space-size=768 scripts\/q12\/run-q12.mjs/g)||[]).length,1);
 assert(q.includes('ref: ${{ env.ARTIFACT_SOURCE_SHA }}'));assert(q.includes('path: .q12-source'));assert(!q.includes('playwright install'));assert(q.includes('node scripts/q12/ci.mjs cleanup'));assert(q.includes('if: always()'));
 const upload=q.slice(q.indexOf('name: q12-mac-evidence-'));assert(upload.includes('/evidence/*.json'));assert(upload.includes('/native/RESULT.json'));assert(upload.includes('/native/*.png'));assert(!upload.includes('/keys'));assert(!upload.includes('/original'));assert(!upload.includes('/userData'));assert(!upload.includes('path: ${{ runner.temp }}/murage-q12\n'));
 assert(!workflow.includes('persist-credentials: true'));assert(workflow.includes("inputs.mode != 'q12'"));assert(workflow.includes("inputs.mode == 'q12'"));
});
