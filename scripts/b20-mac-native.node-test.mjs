import assert from 'node:assert/strict';
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import test from 'node:test';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { backupFixture, testAgeKeys } from '../server/testing/backup-fixture.ts';
import { verifiedBackupTool } from '../electron/backup-mode.mjs';
import { acquireDataDirLease } from '../electron/data-dir-lease.mjs';
import { assertRestoreReviewed } from '../electron/restore-review.mjs';

// B20 macOS qualification fixture only: synthetic installation, generated keys,
// development runtime (explicit Node) and the worktree-built private worker.
// The exact-SHA pinned age path is exercised; the signed-variant attestation
// (Developer ID app + normalized payload) is NOT exercised by this recipe.
const AGE_SHA256='4012dfc2725883beafb710894af4f599b7a94f8c8e0f51f02cc96ab8df33915e';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const code=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,100}$/.test(value)?value:null;
function digestTree(root){
  const out={};
  const walk=dir=>{for(const name of readdirSync(dir).sort()){const file=join(dir,name),rel=relative(root,file),s=lstatSync(file);
    if(s.isSymbolicLink())out[rel]='symlink';else if(s.isDirectory()){out[rel+'/']='dir';walk(file);}else out[rel]=sha(readFileSync(file));}};
  walk(root);return Object.fromEntries(Object.entries(out).sort(([a],[b])=>a<b?-1:a>b?1:0));
}

test('macOS fixed resource and built private worker capture, refuse wrong key/tamper/existing, paused restore', {timeout:180000}, async()=>{
  assert.equal(process.platform,'darwin'); assert.equal(process.arch,'arm64');
  const started=Date.now(), f=backupFixture(), keys=testAgeKeys(), wrong=testAgeKeys(); f.db.close();
  assert.notEqual(keys.recipient,wrong.recipient);
  let lease, success=false;
  const keyFile=join(f.parent,'independent-recovery-key'), wrongKeyFile=join(f.parent,'wrong-recovery-key');
  const diagnostics=[], evidence={recipe:'b20-mac-native',runtime:{node:process.version,platform:process.platform,arch:process.arch,execPath:process.execPath},signedVariantExercised:false,parent:f.parent};
  try {
    // Additional task-owned authority components, shaped like the accepted
    // encrypted restore test (server/installation-encrypted-backup.test.ts:16-21)
    // and the routine schema (server/installation-record-validation.ts:16-19).
    const channel=join(f.data,'channels','slack');mkdirSync(channel,{recursive:true});
    writeFileSync(join(channel,'connection.json'),JSON.stringify({version:1,chosen:{teamId:'TEAM',appId:'APP',ownerUserId:'OWNER',chiefBotId:'bot'},identity:{teamId:'TEAM',userId:'UBOT',botId:'BOT'},enabled:true,paused:false,binding:{connectionId:'fixture-connection',teamId:'TEAM',appId:'APP',botUserId:'UBOT',botId:'BOT',ownerUserId:'OWNER',dmId:'DOWNER',chiefBotId:'bot'},pairing:null}));
    writeFileSync(join(f.data,'startup-background.json'),JSON.stringify({keepRunning:true,startAtLogin:true}));
    writeFileSync(join(f.data,'routines.json'),JSON.stringify({version:1,routines:[{id:'routine',name:'Fixture routine',prompt:'Synthetic prompt',botId:'bot',enabled:true,schedule:{type:'daily',time:'09:00',weekdays:[1]},durationMinutes:5,nextRunAt:1,createdAt:1,updatedAt:1}],runs:[{id:'run',routineId:'routine',routineName:'Fixture routine',botId:'bot',scheduledFor:1,status:'running',manual:false,createdAt:1,startedAt:1}]}));

    const resources=join(f.parent,'Resources'), tool=join(resources,'backup-tools','arm64','age');
    mkdirSync(dirname(tool),{recursive:true}); copyFileSync(keys.ageExecutable,tool);
    assert.equal(verifiedBackupTool(resources),tool);
    assert.ok(statSync(tool).mode & 0o111);
    assert.equal(sha(readFileSync(tool)),AGE_SHA256);
    evidence.tool={sha256:AGE_SHA256,verifiedBackupTool:true,path:'exact-pinned-sha'};

    // Independent recovery keys saved outside the installation before capture.
    writeFileSync(keyFile,keys.identity,{mode:0o600}); writeFileSync(wrongKeyFile,wrong.identity,{mode:0o600});
    const originalTree=digestTree(f.data); evidence.originalTreeBefore=originalTree;
    const originalReport=readFileSync(join(f.data,'workspaces','report.md'));
    {const db=new DatabaseSync(join(f.data,'messages.db'),{readOnly:true});try{evidence.originalMemoryMode=db.prepare('SELECT mode FROM memory_meta').get().mode;}finally{db.close();}}

    const attempt=async(args,{identityFile=keyFile,delegated=false}={})=>{
      const identity=readFileSync(identityFile,'utf8');
      assert.equal(JSON.stringify(args).includes('AGE-SECRET'),false);
      const entry=new URL('../dist-server/installation-recovery-worker.js',import.meta.url).href;
      const source=`import {parentPort} from 'node:worker_threads';const listeners=new Map();process.parentPort={on(name,fn){const wrap=data=>fn({data});listeners.set(fn,wrap);parentPort.on(name,wrap);},removeListener(name,fn){parentPort.removeListener(name,listeners.get(fn));},postMessage:value=>parentPort.postMessage(value)};process.argv=[process.execPath,'worker',...${JSON.stringify(args)}];await import(${JSON.stringify(entry)});`;
      const env={PATH:dirname(process.execPath),HOME:f.parent,USERPROFILE:f.parent,...(delegated?lease.utilityServerLeaseEnvironment():{})};
      assert.equal(JSON.stringify(env).includes('AGE-SECRET'),false);
      const at=Date.now(), child=new Worker(new URL('data:text/javascript,'+encodeURIComponent(source)),{stdout:true,stderr:true,env});
      let result,inputs=0,logs='';
      child.stdout.on('data',c=>{logs+=c;}); child.stderr.on('data',c=>{logs+=c;});
      child.on('message',m=>{if(m.type==='murage:recovery-input-ready'){inputs++;child.postMessage({type:'murage:recovery-input',nonce:m.nonce,identity});}if(m.type==='murage:recovery-result'){result=m.result;child.postMessage({type:'murage:recovery-result-ack',nonce:m.nonce});}});
      const exit=await new Promise((res,rej)=>{const timer=setTimeout(()=>void child.terminate().then(()=>rej(Error('owned worker timeout'))),25000);child.once('error',e=>{clearTimeout(timer);rej(e);});child.once('exit',n=>{clearTimeout(timer);res(n);});});
      assert.equal(logs.includes('AGE-SECRET'),false);assert.equal(logs.includes('FAKE-CREDENTIAL-CANARY'),false);
      diagnostics.push({operation:args[0],exit,inputs,ok:result?.ok??null,error:code(result?.error),ms:Date.now()-at});
      return {exit,inputs,result};
    };
    const run=async(args,options)=>{const r=await attempt(args,options);assert.equal(r.exit,0,JSON.stringify(diagnostics));assert.equal(r.inputs,1);assert.equal(r.result?.ok,true);return r.result;};
    const refused=async(args,options)=>{const r=await attempt(args,options);assert.ok(r.exit!==0||r.result?.ok!==true,JSON.stringify(diagnostics));assert.notEqual(r.result?.ok,true);return code(r.result?.error);};

    // a) capture under the delegated exclusive installation owner.
    lease=acquireDataDirLease(f.data);assert.throws(()=>acquireDataDirLease(f.data));
    const archive=join(f.parent,'backup.age');
    const saved=await run(['backup-encrypted','--data-dir',f.data,'--output',archive,'--age-tool',tool,'--recipient',keys.recipient,'--credential-policy','preserve-in-encrypted-fidelity'],{delegated:true});
    assert.throws(()=>acquireDataDirLease(f.data));lease.release();lease=undefined;
    const archiveBytes=readFileSync(archive), archiveSha=sha(archiveBytes);
    assert.equal(saved.sha256,archiveSha);if(saved.bytes!==undefined)assert.equal(saved.bytes,archiveBytes.length);
    assert.equal(archiveBytes.includes(Buffer.from('FAKE-CREDENTIAL-CANARY')),false);
    evidence.capture={sha256:archiveSha,bytes:archiveBytes.length,snapshotId:saved.snapshotId??null,coverage:saved.coverage??null};

    // b) inspect with the correct independently saved key.
    const inspected=await run(['inspect-encrypted','--archive',archive,'--age-tool',tool]);
    assert.equal(inspected.sha256,archiveSha);assert.equal(inspected.activationAvailable,false);
    evidence.inspect={sha256Matches:true,activationAvailable:inspected.activationAvailable,snapshotIdMatches:saved.snapshotId&&inspected.snapshotId?saved.snapshotId===inspected.snapshotId:null};
    if(saved.snapshotId&&inspected.snapshotId)assert.equal(inspected.snapshotId,saved.snapshotId);

    // c) wrong key refuses inspect and restore; no target is created.
    const refusals={};
    refusals.inspectWrongKey=await refused(['inspect-encrypted','--archive',archive,'--age-tool',tool],{identityFile:wrongKeyFile});
    const wrongTarget=join(f.parent,'target-wrongkey');
    refusals.restoreWrongKey=await refused(['restore-encrypted-new','--data-dir',wrongTarget,'--archive',archive,'--sha256',archiveSha,'--age-tool',tool],{identityFile:wrongKeyFile});
    assert.equal(existsSync(wrongTarget),false);

    // d) tampered ciphertext refuses with the original and with its own hash.
    const tampered=join(f.parent,'tampered.age'),copy=Buffer.from(archiveBytes),offset=Math.floor(copy.length/2);
    copy[offset]^=0xff;writeFileSync(tampered,copy,{mode:0o600});const tamperedSha=sha(copy);assert.notEqual(tamperedSha,archiveSha);
    const tamperOriginal=join(f.parent,'target-tamper-original'),tamperOwn=join(f.parent,'target-tamper-own');
    refusals.tamperOriginalSha=await refused(['restore-encrypted-new','--data-dir',tamperOriginal,'--archive',tampered,'--sha256',archiveSha,'--age-tool',tool]);
    refusals.tamperOwnSha=await refused(['restore-encrypted-new','--data-dir',tamperOwn,'--archive',tampered,'--sha256',tamperedSha,'--age-tool',tool]);
    assert.equal(existsSync(tamperOriginal),false);assert.equal(existsSync(tamperOwn),false);
    assert.equal(sha(readFileSync(archive)),archiveSha);

    // e) an existing path is never overwritten (restoreInstallation requireNew,
    // server/installation-restore.ts:118 RESTORE_NEW_TARGET_REQUIRED).
    const existing=join(f.parent,'target-existing');mkdirSync(existing);writeFileSync(join(existing,'sentinel.txt'),'existing user bytes');
    const existingBefore=digestTree(existing);
    refusals.existingTarget=await refused(['restore-encrypted-new','--data-dir',existing,'--archive',archive,'--sha256',archiveSha,'--age-tool',tool]);
    assert.deepEqual(digestTree(existing),existingBefore);
    evidence.refusals=refusals;
    assert.deepEqual(readdirSync(f.parent).filter(name=>name.startsWith('.murage-encrypted')),[]);

    // f) correct key from the independent file into a NEW path.
    const target=join(f.parent,'restored');
    const restored=await run(['restore-encrypted-new','--data-dir',target,'--archive',archive,'--sha256',archiveSha,'--age-tool',tool]);
    assert.equal(restored.activationAvailable,false);
    if(restored.rawFidelityActivated!==undefined)assert.equal(restored.rawFidelityActivated,false);
    assert.equal(restored.encryptedSha256,archiveSha);
    assert.equal(restored.status,'restored-review-required');assert.equal(restored.previousDataDir,null);
    // Receipt published beside the target (server/installation-restore.ts:134-135).
    assert.equal(typeof restored.receipt,'string');assert.equal(existsSync(restored.receipt),true);

    // g) restored data, references and paused authority.
    const restoredTree=digestTree(target);evidence.restoredTree=restoredTree;
    assert.equal(readFileSync(join(target,'workspaces','report.md')).equals(originalReport),true);
    const config=readFileSync(join(target,'config.json'),'utf8');assert.equal(config.includes('FAKE-CREDENTIAL-CANARY'),false);
    const parsedConfig=JSON.parse(config);
    // installation-restore-preparation.ts:64-75: explicit discovery, every instance disabled, browser/recorder off.
    assert.equal(parsedConfig.engineDiscovery,'explicit');
    assert.equal(parsedConfig.instances.fixture.enabled,false);assert.equal(Object.values(parsedConfig.instances).every(value=>value.enabled===false),true);
    assert.equal(parsedConfig.features.browser,false);assert.equal(parsedConfig.features.skillRecorder,false);
    // installation-restore-preparation.ts:109: automatic bot authority cleared.
    assert.deepEqual((({autoApprove,busy,computer,browser,composio,autoStartVps,resumeCursors,rewound})=>({autoApprove,busy,computer,browser,composio,autoStartVps,resumeCursors,rewound}))(JSON.parse(readFileSync(join(target,'bots.json'),'utf8'))[0]),{autoApprove:false,busy:false,computer:'off',browser:false,composio:false,autoStartVps:false,resumeCursors:{},rewound:true});
    // installation-restore-preparation.ts:119-128: routines disabled, pending runs cancelled.
    const routines=JSON.parse(readFileSync(join(target,'routines.json'),'utf8'));
    assert.equal(routines.routines[0].enabled,false);assert.equal(routines.runs[0].status,'cancelled');
    // installation-encrypted-backup.ts:58-59 raw-only channels/startup never activated (restore test :45-46).
    assert.equal(existsSync(join(target,'channels')),false);assert.equal(existsSync(join(target,'startup-background.json')),false);
    // installation-restore-preparation.ts:199-201: fresh remote/companion identity and review barrier.
    const connections=JSON.parse(readFileSync(join(target,'restored-connections.json'),'utf8'));
    assert.deepEqual(Object.keys(connections).sort(),['id','version']);assert.equal(existsSync(join(target,'companion')),false);
    const review=JSON.parse(readFileSync(join(target,'restore-review.json'),'utf8'));
    // The review binds the verified inner recovery projection (preparation.ts:201,
    // encrypted-backup.ts restoreInstallation(recoveryArchive.sha256)); the result links both.
    assert.equal(review.status,'review-required');assert.match(review.archiveSha256,/^[a-f0-9]{64}$/);
    assert.equal(review.archiveSha256,restored.archiveSha256);assert.notEqual(restored.archiveSha256,archiveSha);
    assert.throws(()=>assertRestoreReviewed(target),error=>error?.code==='RESTORE_REVIEW_REQUIRED');
    const db=new DatabaseSync(join(target,'messages.db'),{readOnly:true});
    try {
      assert.match(db.prepare('SELECT json FROM messages').get().json,/WAL-visible transcript/);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM thread_state').get().n,1);
      assert.equal(db.prepare('SELECT mode FROM memory_meta').get().mode,'paused');
      assert.equal(db.prepare('SELECT target_id FROM memory_tombstones').get().target_id,'forgotten');
    } finally {db.close();}
    evidence.restore={status:restored.status,activationAvailable:restored.activationAvailable,rawFidelityActivated:restored.rawFidelityActivated??null,encryptedSha256Matches:true,previousDataDirNull:true,receiptPresent:true,
      markers:{engineDiscovery:'explicit',instancesDisabled:true,botAuthorityCleared:true,routineDisabled:true,runCancelled:true,channelsAbsent:true,startupBackgroundAbsent:true,restoredConnectionsFresh:true,reviewBarrier:true,memoryPaused:true,tombstoneRetained:true,credentialCanaryAbsent:true}};

    // h) original installation and archive unchanged.
    const originalAfter=digestTree(f.data);evidence.originalTreeAfter=originalAfter;
    // Native R2: read-only SQLite access to the closed WAL database adds only an
    // empty -wal and a -shm sidecar; every original entry stayed byte-identical.
    evidence.originalSidecarsAdded=Object.keys(originalAfter).filter(key=>!(key in originalTree));
    assert.equal(evidence.originalSidecarsAdded.every(key=>key==='messages.db-wal'||key==='messages.db-shm'),true);
    for(const [key,value] of Object.entries(originalTree))assert.equal(originalAfter[key],value,`original entry changed: ${key}`);
    if(evidence.originalSidecarsAdded.includes('messages.db-wal'))assert.equal(statSync(join(f.data,'messages.db-wal')).size,0);
    assert.equal(sha(readFileSync(archive)),archiveSha);
    evidence.originalPreserved=true;evidence.archiveUnchanged=true;
    success=true;
  } finally {
    lease?.release();
    // Synthetic key material never outlives the run, even when failure evidence is retained.
    rmSync(keyFile,{force:true});rmSync(wrongKeyFile,{force:true});
    evidence.diagnostics=diagnostics;evidence.success=success;evidence.durationMs=Date.now()-started;
    if(process.env.MURAGE_QUAL_EVIDENCE_DIR)writeFileSync(join(process.env.MURAGE_QUAL_EVIDENCE_DIR,'b20-mac-native.json'),JSON.stringify(evidence,null,1),{mode:0o600,flag:'wx'});
    console.log('B20 macOS worker receipt:',JSON.stringify({success,diagnostics}));
    if(success)safeWipeSync(f.parent);
    else console.error('B20 macOS failure artifacts retained:',f.parent);
  }
});
