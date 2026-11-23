// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { loadavg } from 'node:os';

export function compareRig(baseDir,tipDir,gateRC,{newFiles=[],merged=false}={}) {
  const lines=file=>new Set(readFileSync(file,'utf8').split('\n').filter(Boolean));
  const base=lines(join(baseDir,'FAILS.txt')),tip=lines(join(tipDir,'FAILS.txt'));
  const newFails=[...tip].filter(x=>!base.has(x)).sort();
  const collect=dir=>{
    const rows=new Map();
    for(const name of readdirSync(dir).filter(x=>/^s\d+(?:\.c\d+(?:\.f\d+)?)?\.json$/.test(x))){
      const data=JSON.parse(readFileSync(join(dir,name),'utf8'));
      for(const result of data.testResults??[])for(const a of result.assertionResults??[]){
        const file=result.name.replace(/^\/work\//,'');rows.set(file+' :: '+a.fullName,{file,name:a.fullName,status:a.status});
      }
    }
    return rows;
  };
  const before=collect(baseDir),after=collect(tipDir);
  const addedSkips=[...after].filter(([id,x])=>['pending','skipped','todo'].includes(x.status)&&!['pending','skipped','todo'].includes(before.get(id)?.status));
  const allowed=x=>!merged&&/^C(?:16|18)(?:\b|:)/.test(x.name);
  const filePasses=Object.fromEntries(newFiles.map(file=>[file,[...after.values()].filter(x=>x.file===file&&x.status==='passed').length]));
  const complete=dir=>existsSync(join(dir,'SUMMARY.md'))&&!/NO RESULT shards/.test(readFileSync(join(dir,'SUMMARY.md'),'utf8'))&&(!existsSync(join(dir,'NORESULT.txt'))||readFileSync(join(dir,'NORESULT.txt'),'utf8').trim()==='');
  const mergedCases=Object.fromEntries(['C16','C18'].map(id=>{const rows=[...after.values()].filter(x=>new RegExp('^'+id+'(?:\\b|:)').test(x.name));return [id,rows.length>0&&rows.every(x=>x.status==='passed')];}));
  return {raw:{newFails,addedSkips,filePasses,mergedCases},pass:{gate:gateRC===0,complete:complete(baseDir)&&complete(tipDir)&&before.size>0&&after.size>0,'new-fails':newFails.length===0,'new-files':Object.values(filePasses).every(n=>n>0),'merged-cases':!merged||Object.values(mergedCases).every(Boolean),skips:addedSkips.every(([,x])=>allowed(x))&&addedSkips.length<=2}};
}
// The shared shard entry does not forward arbitrary host environment. Keep its
// scheduler and commands intact, adding only the merged marker to Docker env.
export function mergedShardSource(source) {
  const anchor='-e HOME=/tmp/home';
  if(!source.includes(anchor))throw Error('shard Docker environment anchor changed');
  return source.replaceAll(anchor,'-e MURAGE_FTS_MERGED_SHA="${MURAGE_FTS_MERGED_SHA:?merged marker required}" '+anchor);
}
export function mergedShardArgs(out) { return ['--force','--out',out]; }
export async function runRig({worktree,tip,base='b4dc27ea9',tools='/root/fuigo-builds/tools',registry='/root/fuigo-builds/shared-base',out='evidence/r4',smoke=false}) {
  worktree=resolve(worktree);out=resolve(out);mkdirSync(out,{recursive:true});
  const commands=[];
  const merged=process.env.MURAGE_FTS_MERGED_SHA;
  if(merged&&merged!==tip&&!smoke)throw Error('merged marker must equal the sharded tip');
  const run=(file,args,env={})=>{
    commands.push({file,args,env});
    const child=spawnSync('bash',[file,...args],{encoding:'utf8',env:{...process.env,...env},maxBuffer:64*1024*1024});
    writeFileSync(join(out,basename(file)+'-'+commands.length+'.log'),(child.stdout??'')+(child.stderr??''));
    if(child.error)throw child.error;return child.status??1;
  };
  const sha=ref=>{
    const result=spawnSync('git',['-C',worktree,'rev-parse','--verify',ref+'^{commit}'],{encoding:'utf8'});
    if(result.status!==0)throw Error('unresolved rig commit');return result.stdout.trim();
  };
  if(!smoke){
    base=sha(base);tip=sha(tip);
    if(merged&&merged!==tip)throw Error('merged marker must be the full tip SHA');
    if(sha('HEAD')!==tip)throw Error('hz gate worktree HEAD must equal the tip being sharded');
    for(const ref of [base,tip]){
      const lock=spawnSync('git',['-C',worktree,'show',ref+':pnpm-lock.yaml']);
      if(lock.status!==0)throw Error('missing lockfile in rig commit');
      const hash=createHash('sha256').update(lock.stdout).digest('hex').slice(0,16);
      if(!existsSync(join(tools,'nm',hash,'node_modules')))throw Error('preseed shared dependencies before network-isolated rig: '+hash);
    }
    while(loadavg()[0]>60)await pause(20_000);
  }
  const gate=run(join(tools,'hz-gate.sh'),[worktree]);
  const gateFile=join(tools,'gate-out',basename(worktree),'gates.rc');
  const gateRC=existsSync(gateFile)?Number(readFileSync(gateFile,'utf8')):1;
  writeFileSync(join(out,'hz-gate.json'),JSON.stringify({sha:tip,gates_rc:gate===0?gateRC:gate})+'\n');
  if(gate!==0){const result={pass:{gate:false},raw:{commands,gate}};writeFileSync(join(out,'rig.json'),JSON.stringify(result,null,2)+'\n');return result;}
  // Eight ways, at most two live containers, sequential base/tip invocations.
  // The shared-base registry is reused by vt-shard itself when complete.
  const env={MAXC:'2',LOADMAX:'60',VT_REMOTE_OK:'1',VT_WIDEN:'0'};
  const baseRC=run(join(tools,'vt-shard.sh'),[worktree,base,'--shards','8','--hosts','murage-vt1,murage-vt2'],{...env,MURAGE_FTS_MERGED_SHA:''});
  let shardFile=join(tools,'vt-shard.sh'),tipDir=join(registry,tip,'out');
  const extra=[];
  if(merged){
    // A unique output and --force defeat SHA-only results, including old
    // pre-merge skips. The adapter is kept with this invocation's evidence.
    tipDir=mkdtempSync(join(out,'merged-'));
    shardFile=join(tipDir,'vt-shard-merged.sh');
    writeFileSync(shardFile,mergedShardSource(readFileSync(join(tools,'vt-shard.sh'),'utf8')));
    extra.push(...mergedShardArgs(tipDir));
  }
  const tipRC=run(shardFile,[worktree,tip,'--shards','8','--hosts','murage-vt1,murage-vt2',...extra],{...env,...(merged?{MURAGE_FTS_MERGED_SHA:merged}:{})});
  const changed=smoke?['server/synthetic.test.ts']:spawnSync('git',['-C',worktree,'diff','--name-only','--diff-filter=A',base,tip,'--','*.test.ts','*.test.mjs'],{encoding:'utf8'}).stdout.trim().split('\n').filter(Boolean).filter(p=>!p.startsWith('scripts/qualify-search/'));
  const result=compareRig(join(registry,base,'out'),tipDir,gateRC,{newFiles:changed,merged:!!merged});
  result.pass['commands']=baseRC===0&&tipRC===0;
  result.raw.commands=commands;
  result.raw.merged=merged?{sha:merged,fresh:true,output:tipDir,adapterHash:createHash('sha256').update(readFileSync(shardFile)).digest('hex')}:null;
  writeFileSync(join(out,'NEW-FAILS.txt'),result.raw.newFails.join('\n')+(result.raw.newFails.length?'\n':''));
  writeFileSync(join(out,'rig.json'),JSON.stringify(result,null,2)+'\n');return result;
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(new URL(import.meta.url).pathname)){
  const worktree=resolve(process.argv[2]??'.');
  if(process.env.MURAGE_QUAL_RIG_LOCKED!=='1'){
    const locks=join(process.env.MURAGE_QUAL_JOB_DIR??resolve(worktree,'..'),'locks');mkdirSync(locks,{recursive:true});
    const child=spawnSync('flock',[join(locks,'container-1'),'flock',join(locks,'container-2'),process.execPath,...process.argv.slice(1)],{stdio:'inherit',env:{...process.env,MURAGE_QUAL_RIG_LOCKED:'1'}});
    if(child.error)throw child.error;process.exit(child.status??1);
  }
  const result=await runRig({worktree,tip:process.argv[3]??'HEAD',out:process.argv[4]??'evidence/r4'});
  if(!Object.values(result.pass).every(Boolean))process.exitCode=1;
}
