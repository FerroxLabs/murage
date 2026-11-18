import { expect, it } from 'vitest';
import { autoVerdict } from '../../server/auto-approve.ts';
import { noLimits, context } from './mandatory-fixture.mjs';
// Replaces the retired No limits reader/taint carve-outs in means-it-1020
// and r13-gate. Unreadable input alone is not a catastrophe.
it.each(['eval "$OPAQUE"','eval "$(ssh-agent -s)"','cat <<EOF\nfixture\nEOF','printf fixture > "$fixture_target"'])('opaque non-wipe runs: %s',command=>{
  // MAIN RULING 1114-MANDATORY-OPAQUE-RUNS: expansions reach the runtime guard.
  const verdict=autoVerdict(noLimits,'Bash',command,context(command,{inputCut:true,inputTruncated:true,outsideRead:['earlier-turn']}));
  expect(verdict.approve).not.toBeNull();
});
it('a plain literal wipe still cannot be auto-approved at the text layer',()=>{
  const command='rm -rf ~';
  expect(autoVerdict(noLimits,'Bash',command,context(command)).approve).toBeNull();
});
it('the same opaque eval expanding to a wipe has a real refused guarded-shell receipt',async()=>{
  // MAIN RULING 1114-MANDATORY-OPAQUE-RUNS, companion (b). The mandatory
  // fixture proves the actual POSIX/Git Bash guard, not engine reach or P1.
  const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,cpSync,chmodSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {fileURLToPath}=await import('node:url');
  const {spawn}=await import('node:child_process');
  const {startWipeGuardTurn}=await import('../../server/wipe-guard/server.ts');
  const {removeTempDirSync}=await import('../../server/testing/cleanup.ts');
  const {gitBashPath}=await import('../../server/tool-discovery.ts');
  const parent=mkdtempSync(join(tmpdir(),'gnl-opaque-')),home=join(parent,'home'),ordinary=join(parent,'ordinary'),shim=join(parent,'shim'),real=join(parent,'inert-rm'),receipt=join(parent,'tool-receipt');
  let guard;
  try{
    mkdirSync(home);mkdirSync(ordinary);
    cpSync(fileURLToPath(new URL('../../server/wipe-guard/shim/',import.meta.url)),shim,{recursive:true,dereference:true});
    for(const name of ['guard.sh','rm'])chmodSync(join(shim,name),0o755);
    // The only original tool records argv and never deletes anything.
    writeFileSync(real,'#!/bin/sh\nprintf "%s\\n" "$@" >> "$GNL_INERT_RECEIPT"\n',{mode:0o755});
    const posix=p=>process.platform==='win32'?p.replaceAll('\\','/'):p;
    const asks=[];
    guard=await startWipeGuardTurn({directory:parent,threadId:'mandatory-opaque',roots:[home],
      client:[posix(process.execPath),posix(fileURLToPath(new URL('../../server/wipe-guard/client.mjs',import.meta.url)))],realTools:{rm:posix(real)},
      context:{cwd:parent,home,project:home,dataDir:join(parent,'data')},isLive:()=>true,
      askWipe:async request=>{asks.push(request);return 'deny';}});
    const run=opaque=>new Promise((resolve,reject)=>{
      const shell=process.platform==='win32'?gitBashPath():'sh';
      if(!shell)return reject(Error('Required Git Bash fixture shell unavailable'));
      const child=spawn(shell,['-c','eval "$OPAQUE"'],{cwd:parent,env:{...process.env,PATH:posix(shim)+(process.platform==='win32'?';':':')+process.env.PATH,MURAGE_WIPE_GUARD:guard.file,OPAQUE:opaque,GNL_INERT_RECEIPT:posix(receipt)},stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
      child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));
    });
    const quote=p=>"'"+posix(p).replaceAll("'","'\\''")+"'";
    const safe=await run(`rm -rf -- ${quote(ordinary)}`);
    expect(safe.code).toBe(0);expect(asks).toHaveLength(0);
    const before=readFileSync(receipt,'utf8');expect(before).toContain(posix(ordinary));
    const stopped=await run(`rm -rf -- ${quote(home)}`);
    expect(stopped.code).toBe(10);expect(stopped.stderr).toContain('wipe guard: refused');
    expect(asks).toHaveLength(1);expect(asks[0].argv).toEqual(['-rf','--',posix(home)]);
    expect(readFileSync(receipt,'utf8')).toBe(before);
  }finally{await guard?.end();removeTempDirSync(parent);}
});
it('a prior non-wipe card is not retained at eligible No limits',async()=>{
  const {finalizeNoLimits}=await import('../../server/auto-approve.ts');
  expect(finalizeNoLimits(noLimits,'Bash','printf fixture',context('printf fixture'),{approve:null,source:'always-ask',rule:'unreadable'}).approve).not.toBeNull();
});
