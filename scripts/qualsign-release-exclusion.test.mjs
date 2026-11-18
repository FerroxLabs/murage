import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { refuseQualificationAssets } from './qualsign-release-exclusion.mjs';

const guard=readFileSync(new URL('./release-guard.mjs',import.meta.url),'utf8');
const exclusion=readFileSync(new URL('./qualsign-release-exclusion.mjs',import.meta.url),'utf8');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(run) { const dir=mkdtempSync(join(tmpdir(),'qualsign-release-')); try{return run(dir);}finally{rmSync(dir,{recursive:true,force:true});} }
function put(dir,path,bytes) {mkdirSync(dirname(join(dir,path)),{recursive:true}); writeFileSync(join(dir,path),bytes);}
const commands=['stage','upload','upload-prepared','publish','publish-prepared'];
const badAssets=[['name','nested/WITNESS-COLLECTOR.EXE','neutral'],['artifact','nested/qualsign-collector-012345abcdef-2/asset.bin','neutral'],['schema','nested/renamed.json',JSON.stringify({schema:'qualsign-collector-v1'})],['digest','renamed-installer.exe','qualification bytes']];
// Option A (Sean 2026-11-18T06:42Z): 1.0.19 signs as 1.0.18 shipped; controller-admitted signing + SAC
// qualification are the first post-release item. The SAC promotion that used to follow the exclusion is gone,
// so the "next gate" is what really follows now: `stage` admits the set and exits 0 with no network, and every
// upload/publish command makes its first GitHub call. A gh double records that call; a planted promotion module
// that throws proves no command loads it any more.
function cli(dir,command,source=guard) {
 put(dir,'scripts/release-guard.mjs',source);
 put(dir,'scripts/qualsign-release-exclusion.mjs',exclusion);
 put(dir,'infra/windows-signing/qualsign/refused-sha256.txt',`# fixture digest\n${hash('qualification bytes')}\n`);
 put(dir,'scripts/signal-release-prerequisites.mjs','export function assertSignalReleaseReady() {}');
 put(dir,'scripts/windows-sac-promotion.mjs',`throw Error('SAC_PROMOTION_LOADED');`);
 put(dir,'scripts/windows-sac-stage-gate.mjs',`throw Error('SAC_PROMOTION_LOADED');`);
 put(dir,'bin/gh',`#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(join(dir,'network-calls'))},JSON.stringify(process.argv.slice(2))+'\\n');process.exit(1);\n`);
 chmodSync(join(dir,'bin/gh'),0o755);
 const args=command==='upload'?['1.0.19','assets']:command==='publish'?['1.0.19','71','assets']:[];
 return spawnSync(process.execPath,['scripts/release-guard.mjs',command,...args],{cwd:dir,encoding:'utf8',env:{PATH:join(dir,'bin'),RUNNER_TEMP:join(dir,'temp'),VERSION:'1.0.19',RELEASE_ID:'71'}});
}
const network=dir=>existsSync(join(dir,'network-calls'));
// Past the exclusion: stage is complete (exit 0, no network); the others have made their first GitHub call.
function expectNextGate(dir,command,result) {
 expect(result.stderr).not.toContain('qualsign-not-release-v1'); expect(result.stderr).not.toContain('SAC_PROMOTION_LOADED');
 if(command==='stage'){expect(result.status).toBe(0);expect(network(dir)).toBe(false);}
 else{expect(result.status).not.toBe(0);expect(network(dir)).toBe(true);}
}
it.each(commands)('W6 clean assets pass qualification exclusion at %s',command=>fixture(dir=>{
 put(dir,'assets/Murage-setup.exe','neutral release'); put(dir,'assets/metadata.json','{"schema":"release"}');
 expectNextGate(dir,command,cli(dir,command));
}));
it.each(commands.flatMap(command=>badAssets.map(([kind,path,bytes])=>[command,kind,path,bytes])))('R2-12 %s refuses %s before network; removing call is RED',(command,kind,path,bytes)=>fixture(dir=>{
 put(dir,`assets/${path}`,bytes);
 const green=cli(dir,command); expect(green.status).not.toBe(0); expect(green.stderr).toContain('qualsign-not-release-v1'); expect(network(dir)).toBe(false);
 // Mutant: the exclusion call is removed, the asset directory it selected is kept.
 const mutant=guard.replace(/^    refuseQualificationAssets\((validatedAssetsDir = .*)\);\n/m,'    $1;\n'); expect(mutant).not.toBe(guard);
 const red=cli(dir,command,mutant); expect(red.stderr).not.toContain('qualsign-not-release-v1');
 // A flat refused-digest file passes every later structural check, so the mutant carries it to the next gate;
 // the nested kinds are then stopped only by the flat-directory rule, which is not a qualification refusal.
 if(kind==='digest') expectNextGate(dir,command,red);
 else expect(red.stderr).toContain('release assets must be regular files');
}));
it.each(['upload','publish'])('%s checks its explicit asset operand',command=>fixture(dir=>{
 put(dir,'assets/Murage-setup.exe','clean'); put(dir,'explicit/witness-collector.exe','bad');
 // CLI operand is passed separately; changing the default assets directory cannot hide this candidate.
 cli(dir,command);
 const args=command==='upload'?['1.0.19','explicit']:['1.0.19','71','explicit'];
 const result=spawnSync(process.execPath,['scripts/release-guard.mjs',command,...args],{cwd:dir,encoding:'utf8',env:{PATH:'',RUNNER_TEMP:join(dir,'temp')}});
 expect(result.stderr).toContain('qualsign-not-release-v1');
}));
it('names, signed artifact segments, nested schemas and symlinks fail closed',()=>fixture(dir=>{
 for(const name of ['witness-collector.exe','qualsign-receipt.json','qualsign-signed-012345abcdef-1/asset.bin']) {
  const assets=join(dir,hash(name)); mkdirSync(assets); put(assets,name,'neutral'); expect(()=>refuseQualificationAssets(assets)).toThrow('qualsign-not-release-v1');
 }
 const assets=join(dir,'links'); mkdirSync(assets); put(dir,'outside.bin','neutral'); symlinkSync(join(dir,'outside.bin'),join(assets,'asset.bin'));
 expect(()=>refuseQualificationAssets(assets)).toThrow('qualsign-not-release-v1');
 expect(()=>refuseQualificationAssets(assets)).toThrow('WINDOWS_PE_FILE_UNSAFE');
}));
it('QS3 digest denylist rejects malformed lines, absence and symlinks; whitespace comments pass',()=>fixture(dir=>{
 put(dir,'scripts/qualsign-release-exclusion.mjs',exclusion); put(dir,'assets/release.bin','neutral');
 const pin='0'.repeat(64), denylist='infra/windows-signing/qualsign/refused-sha256.txt';
 const invoke=()=>spawnSync(process.execPath,['--input-type=module','-e',"import {refuseQualificationAssets} from './scripts/qualsign-release-exclusion.mjs'; refuseQualificationAssets('assets');"],{cwd:dir,encoding:'utf8'});
 for(const text of ['invalid',` ${pin}`,`${pin} `,pin.toUpperCase().replace('0','A')]) {put(dir,denylist,text);expect(invoke().status).not.toBe(0);}
 put(dir,denylist,`\n   # comment\n${pin}\n`);expect(invoke().status).toBe(0);
 rmSync(join(dir,denylist));expect(invoke().status).not.toBe(0);
 put(dir,'other-pins.txt',pin);symlinkSync(join(dir,'other-pins.txt'),join(dir,denylist));expect(invoke().status).not.toBe(0);
}));

it('QS3 schema and JSON extension comparisons ignore case',()=>fixture(dir=>{put(dir,'renamed.JSON','{\"schema\":\"QUALSIGN-COLLECTOR-V1\"}');expect(()=>refuseQualificationAssets(dir)).toThrow('qualsign-not-release-v1');}));
