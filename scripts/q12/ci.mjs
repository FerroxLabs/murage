// Admission/cleanup around the existing Q12 actual packaged driver. No app launch here.
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync,readdirSync,realpathSync,openSync,readSync,closeSync} from 'node:fs';
import {dirname,join,basename,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {userInfo} from 'node:os';
import {sha} from './run-q12.mjs';
import {executionProfile,memoryReading,assertPrestart,privateDirectory,sourceSeams} from './runtime.mjs';
const packet=dirname(fileURLToPath(import.meta.url)),json=p=>JSON.parse(readFileSync(p,'utf8'));
const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:120000,maxBuffer:1024*1024});return {code:r.status,stdout:r.stdout??'',stderr:r.stderr??''};};
const must=(command,args)=>{const r=run(command,args);assert.equal(r.code,0,basename(command)+' failed');return r;};
export function verifyProducer(producer,gates,{source,runId,attempt}){
 assert(/^[a-f0-9]{40}$/.test(source));assert(/^[1-9][0-9]*$/.test(String(runId)));assert(/^[1-9][0-9]*$/.test(String(attempt)));
 assert.equal(String(producer.id),String(runId));assert.equal(producer.run_attempt,Number(attempt));assert.equal(producer.head_sha,source);
 assert.equal(producer.status,'completed');assert.equal(producer.conclusion,'success');assert.equal(producer.path,'.github/workflows/package-mac-qualification.yml');
 assert.equal(gates.sourceSha,source);assert.equal(gates.appTeam,'PX6SP9GPWJ');assert(Array.isArray(gates.inventory));
 for(const file of ['Contents/MacOS/Murage','Contents/Resources/fuigo/fuigo','Contents/Resources/backup-tools/arm64/age'])assert.equal(gates.inventory.filter(e=>e.path===file&&/^[a-f0-9]{64}$/.test(e.sha256)).length,1,'Missing or ambiguous packaged identity');
}
function packageJson(asar){
 const fd=openSync(asar,'r');try{const head=Buffer.alloc(16);assert.equal(readSync(fd,head,0,16,0),16);const headerSize=head.readUInt32LE(4),length=head.readUInt32LE(12);assert(head.readUInt32LE(0)===4&&length>0&&length+8<=headerSize&&headerSize<64*1024*1024);const bytes=Buffer.alloc(length);assert.equal(readSync(fd,bytes,0,length,16),length);const entry=JSON.parse(bytes.toString()).files?.['package.json'];assert(entry&&!entry.unpacked&&Number.isSafeInteger(entry.size)&&entry.size>0&&entry.size<1024*1024&&/^\d+$/.test(entry.offset));const body=Buffer.alloc(entry.size);assert.equal(readSync(fd,body,0,body.length,8+headerSize+Number(entry.offset)),body.length);return JSON.parse(body.toString());}finally{closeSync(fd);}
}
function context(){
 const e=process.env,u=userInfo();const profile=executionProfile('DISPOSABLE_GITHUB_MAC',{env:e,platform:process.platform,arch:process.arch,username:u.username,home:u.homedir,manager:must('/bin/launchctl',['managername']).stdout.trim()});
 const root=join(realpathSync(e.RUNNER_TEMP),'murage-q12');privateDirectory(root);privateDirectory(join(root,'evidence'));
 return {root,profile,e};
}
export async function prepare(){
 const {root,profile,e}=context(),evidence=join(root,'evidence'),artifact=join(root,'artifact'),producerEvidence=join(artifact,'evidence'),repo=realpathSync(e.GITHUB_WORKSPACE),sourceRoot=join(repo,'.q12-source');
 assert.equal(repo,realpathSync(resolve(packet,'../..')));assert(!existsSync(join(root,'MANIFEST.json')),'Admission is one-shot');
 const reading=memoryReading(must('/usr/bin/vm_stat',[]).stdout,must('/usr/sbin/sysctl',['-n','hw.memsize']).stdout.trim());
 writeFileSync(join(evidence,'resource-admission.json'),JSON.stringify({profile,reading},null,2)+'\n',{mode:0o600});assertPrestart(profile,reading);
 assert.equal(must('/usr/bin/git',['-C',repo,'rev-parse','HEAD']).stdout.trim(),e.FIXTURE_SOURCE_SHA);
 assert.equal(must('/usr/bin/git',['-C',sourceRoot,'rev-parse','HEAD']).stdout.trim(),e.ARTIFACT_SOURCE_SHA);
 const producer=json(join(evidence,'producer.json')),gates=json(join(producerEvidence,'final-package-gates.json'));
 verifyProducer(producer,gates,{source:e.ARTIFACT_SOURCE_SHA,runId:e.ARTIFACT_RUN_ID,attempt:e.ARTIFACT_RUN_ATTEMPT});
 assert.equal(readFileSync(join(producerEvidence,'source-sha.txt'),'utf8').trim(),e.ARTIFACT_SOURCE_SHA);assert.equal(readFileSync(join(producerEvidence,'cleanup.txt'),'utf8').trim(),'PASS');
 const version=/export const FUIGO_VERSION = "([^"]+)"/.exec(readFileSync(join(sourceRoot,'scripts/prepare-fuigo.mjs'),'utf8'))?.[1];assert.equal(version,e.FUIGO_VERSION);
 const zips=readdirSync(artifact).filter(n=>/^Murage-.*-arm64\.zip$/.test(n));assert.equal(zips.length,1,'One exact Mac zip required');const zip=join(artifact,zips[0]);
 const listed=readFileSync(join(producerEvidence,'SHA256SUMS'),'utf8').trim().split('\n').map(line=>line.trim().split(/\s+/)).filter(([,name])=>name&&basename(name)===zips[0]);assert.equal(listed.length,1);assert.equal(await sha(zip),listed[0][0]);
 const appDir=join(root,'app');mkdirSync(appDir,{mode:0o700});writeFileSync(join(root,'OWNERSHIP.json'),JSON.stringify({uid:process.getuid(),root,app:join(appDir,'Murage.app')})+'\n',{flag:'wx',mode:0o600});
 must('/usr/bin/ditto',['-x','-k',zip,appDir]);const app=realpathSync(join(appDir,'Murage.app'));assert.equal(app,join(appDir,'Murage.app'));assert(!/AppTranslocation|\.mount_/.test(app));assert.notEqual(run('/usr/bin/xattr',['-p','com.apple.quarantine',app]).code,0);
 must('/usr/bin/codesign',['--verify','--deep','--strict',app]);const spctl=must('/usr/sbin/spctl',['-a','-vv','-t','exec',app]);assert(/accepted/.test(spctl.stdout+spctl.stderr));must('/usr/bin/xcrun',['stapler','validate',app]);const signature=must('/usr/bin/codesign',['-dv','--verbose=4',app]);assert.equal(/^TeamIdentifier=(.+)$/m.exec(signature.stderr)?.[1],gates.appTeam);
 for(const relative of ['Contents/MacOS/Murage','Contents/Resources/fuigo/fuigo','Contents/Resources/backup-tools/arm64/age'])assert.equal(await sha(join(app,relative)),gates.inventory.find(row=>row.path===relative).sha256);
 assert.equal(packageJson(join(app,'Contents/Resources/app.asar')).name,'murage');
 const keygen=join(root,'tools/age-keygen');assert.equal(await sha(keygen),'c16e229245123d0ad27442317461d63915416cad0294395cd19ca93feb3211ea');
 const appFiles=['Contents/MacOS/Murage','Contents/Resources/app.asar','Contents/Resources/server/index.js','Contents/Resources/server/installation-recovery-worker.js','Contents/Resources/fuigo/fuigo','Contents/Resources/backup-tools/arm64/age'];
 const manifest={rootApproved:true,executionProfile:profile.name,sourceCommit:e.ARTIFACT_SOURCE_SHA,fixtureCommit:e.FIXTURE_SOURCE_SHA,fuigoVersion:version,sourceRoot,taskRoot:root,app,out:join(root,'native'),keygen:{path:keygen,sha256:await sha(keygen)},appHashes:Object.fromEntries(await Promise.all(appFiles.map(async p=>[p,await sha(join(app,p))]))),sourcePins:Object.fromEntries(await Promise.all(sourceSeams.map(async p=>[p,await sha(join(sourceRoot,p))]))),pickerSha256:await sha(join(packet,'native-picker.jxa')),driverSha256:await sha(join(packet,'run-q12.mjs'))};
 writeFileSync(join(root,'MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});
 writeFileSync(join(evidence,'admission.json'),JSON.stringify({sourceCommit:manifest.sourceCommit,fixtureCommit:manifest.fixtureCommit,producerRun:e.ARTIFACT_RUN_ID,attempt:e.ARTIFACT_RUN_ATTEMPT,fuigoVersion:version,zipSha256:listed[0][0],appTeam:gates.appTeam,appHashes:manifest.appHashes,sourcePins:manifest.sourcePins,driverSha256:manifest.driverSha256,pickerSha256:manifest.pickerSha256,resourceProfile:profile},null,2)+'\n',{mode:0o600});
}
export async function cleanup(){
 const {root}=context(),file=join(root,'OWNERSHIP.json');let left=[];
 if(existsSync(file)){
  const owner=json(file),app=join(root,'app/Murage.app');assert.equal(owner.uid,process.getuid());assert.equal(owner.root,root);assert.equal(owner.app,app);
  const inventory=()=>execFileSync('/bin/ps',['-axo','pid=,comm='],{encoding:'utf8'}).split('\n').flatMap(line=>{const m=/^\s*(\d+)\s+(.+)$/.exec(line);return m&&m[2].startsWith(app+'/')?[{pid:Number(m[1]),command:m[2]}]:[];});
  for(const signal of ['SIGTERM','SIGKILL']){for(const p of inventory()){const current=inventory().find(x=>x.pid===p.pid&&x.command===p.command);if(current)try{process.kill(p.pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}}const end=Date.now()+(signal==='SIGTERM'?20000:5000);while(inventory().length&&Date.now()<end)await new Promise(r=>setTimeout(r,200));if(!inventory().length)break;}
  left=inventory();
 }
 writeFileSync(join(root,'evidence/cleanup.json'),JSON.stringify({ownedProcessesGone:left.length===0,left},null,2)+'\n',{mode:0o600});assert.equal(left.length,0,'Owned Q12 processes remain');
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 assert(['prepare','cleanup'].includes(process.argv[2]));(process.argv[2]==='prepare'?prepare():cleanup()).catch(error=>{console.error(error.name+': '+error.message);process.exitCode=1;});
}
