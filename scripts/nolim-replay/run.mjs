import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { admitCorpus, replayRuling, wipeControls } from './ruling.mjs';
function options(args) {
  const o={};const keys={'--corpus':'corpus','--sha256':'hash','--platform':'platform','--candidate':'candidate','--out':'out'};
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--release')o.release=true;
    else if(args[i]==='--worker')o.worker=true;
    else if(keys[args[i]]&&args[i+1])o[keys[args[i]]]=args[++i];
    else throw Error('Invalid replay options');
  }
  if(!o.corpus||!o.out||!['linux','darwin','win32'].includes(o.platform)||!/^[a-f0-9]{40}$/.test(o.candidate??''))throw Error('Replay requires corpus, SHA256 pin, actual platform, candidate SHA and output file');
  if(o.platform!==process.platform)throw Error('Replay platform does not match the OS rig');
  o.corpus=resolve(o.corpus);o.out=resolve(o.out);
  if(o.out==='/dev'||o.out.startsWith('/dev/'))throw Error('Evidence path under /dev');
  return o;
}
async function worker(o) {
  const owned=process.env.NOLIM_REPLAY_OWNED_ROOT;
  if(!owned || resolve(process.env.HOME??'.')!==join(owned,'home') || resolve(process.env.MURAGE_DATA_DIR??'.')!==join(owned,'data')) throw Error('Worker requires the parent-owned isolated fixture');
  // All original diagnostics stay in the private input. Public output contains
  // only row tokens/counts. Product logging is suppressed, including errors.
  console.log=console.info=console.warn=console.error=()=>{};
  let adapter;
  try {
    const rows=admitCorpus(readFileSync(o.corpus),o.hash);
    const {productionAdapter}=await import('./production.mjs');
    adapter=await productionAdapter({dataDir:process.env.MURAGE_DATA_DIR,home:process.env.HOME,platform:o.platform});
    const report=await replayRuling({rows,controls:wipeControls(o.platform),decide:r=>adapter.decide(r)});
    Object.assign(report,{schema:1,gate:'G-NL-real-log',candidateSha:o.candidate,corpusSha256:o.hash,platform:o.platform,release:o.release,
      scope:'Recorded policy and final release replay; no tool execution; origin supplied by independent labels'});
    writeFileSync(o.out,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
    return report.verdict==='PASS'?0:1;
  } catch {
    if(!existsSync(o.out))writeFileSync(o.out,JSON.stringify({verdict:'FAIL',status:'UNPROVEN',rows:257,pass:0,skipped:257,reason:'Corpus admission or isolated candidate replay failed'})+'\n',{mode:0o600,flag:'wx'});
    return 1;
  } finally {await adapter?.close();}
}
export async function main(args=process.argv.slice(2)) {
  const o=options(args);
  if(o.worker)return worker(o);
  const root=mkdtempSync(join(tmpdir(),'gnl-replay-'));
  try {
    const home=join(root,'home'),data=join(root,'data');mkdirSync(home);mkdirSync(data);
    writeFileSync(join(data,'config.json'),JSON.stringify({instances:{}}));
    // A minimal environment prevents reading provider credentials or a live
    // Murage profile. No engine executable is ever requested by this worker.
    const env={PATH:process.env.PATH,HOME:home,USERPROFILE:home,MURAGE_DATA_DIR:data,TMPDIR:root,TEMP:root,TMP:root,
      SystemRoot:process.env.SystemRoot,ComSpec:process.env.ComSpec,NODE_ENV:'test',NOLIM_REPLAY_OWNED_ROOT:root,MURAGE_ANNOUNCEMENTS_URL:'off',MURAGE_PUSH_RELAY_URL:'off'};
    const code=await new Promise(resolveCode=>{
      const child=spawn(process.execPath,['--experimental-strip-types',fileURLToPath(import.meta.url),...args,'--worker'],{env,stdio:['ignore','ignore','ignore']});
      const timer=setTimeout(()=>child.kill('SIGTERM'),120000);
      child.on('error',()=>{clearTimeout(timer);resolveCode(1);});
      child.on('close',c=>{clearTimeout(timer);resolveCode(c??1);});
    });
    if(!existsSync(o.out))writeFileSync(o.out,JSON.stringify({verdict:'FAIL',status:'UNPROVEN',rows:257,pass:0,skipped:257,reason:'Isolated replay worker did not complete'})+'\n',{mode:0o600,flag:'wx'});
    const report=JSON.parse(readFileSync(o.out));
    console.log(`GNL-REPLAY rows=${report.rows??257} pass=${report.pass??0} nonwipe_cards=${report.nonwipe_cards??0} refusals=${report.refusals??0} skipped=${report.skipped??257} controls=${report.controls?.pass??0}/3`);
    return code===0&&report.verdict==='PASS'?0:1;
  } finally {rmSync(root,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{process.exitCode=await main();}catch{console.error('Replay FAIL: invalid options or evidence path');process.exitCode=1;}
}
