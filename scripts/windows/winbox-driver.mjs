// G-WINBOX: pure verdict/workflow logic is importable on Linux without Electron.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
export const phases = ['chat', 'shell-tool', 'routine', 'browser', 'sentinel'];
const terminalClasses = new Set(['CASCADIA_HOSTING_WINDOW_CLASS', 'ConsoleWindowClass', 'PseudoConsoleWindow']);
const canonical = value => String(value ?? '').replaceAll('/', '\\').toLowerCase();
const processKey = p => `${p.pid}:${p.birth}`;
const windowKey = w => `${w.hwnd}:${w.pid}:${w.birth}:${w.className}`;

export function judgeWindows(samples, executable, errors) {
  assert(Array.isArray(samples) && samples.length, 'missing window samples');
  const baseline = new Set();
  const descendants = new Set(), roots = new Set(), history = new Map(), offenders = new Map();
  let previous = -1;
  for (const [index, sample] of samples.entries()) {
    try {
    assert(sample && typeof sample === 'object' && !Array.isArray(sample), 'invalid sample row');
    assert(Number.isFinite(sample.at) && sample.at > previous, 'unordered samples');
    assert(Array.isArray(sample.processes) && Array.isArray(sample.windows), 'incomplete sample');
    for (const p of sample.processes) {
      assert(Number.isInteger(p?.pid) && p.birth, 'missing process identity');
    }
    for (const w of sample.windows) assert(w && typeof w === 'object' && !Array.isArray(w) && typeof w.visible === 'boolean', 'malformed window');
    previous = sample.at;
    for (const p of sample.processes) history.set(processKey(p), p);
    const current = new Map(sample.processes.map(p => [p.pid, p]));
    const parentOf = p => {
      const live = current.get(p.parent);
      if (live && BigInt(live.birth) <= BigInt(p.birth)) return live;
      // Preserve ancestry when a parent exits between samples; never use a newer reused PID.
      return [...history.values()].filter(q => q.pid === p.parent && BigInt(q.birth) <= BigInt(p.birth))
        .sort((a,b) => BigInt(a.birth) > BigInt(b.birth) ? -1 : 1)[0];
    };
    const classify = (p, seen = new Set()) => {
      const key = processKey(p);
      if (descendants.has(key)) return true;
      if (roots.has(key) || seen.has(key)) return false;
      seen.add(key);
      const parent = parentOf(p);
      if (parent && (classify(parent, seen) || roots.has(processKey(parent)))) {
        descendants.add(key); return true;
      }
      if (canonical(p.imagePath) === canonical(executable)) roots.add(key);
      return false;
    };
    for (const p of sample.processes) classify(p);
    for (const w of sample.windows) {
      if (!w.visible) continue;
      const owner = current.get(w.pid);
      // Toolhelp precedes EnumWindows: a window may outlive its unsnapshotted
      // owner. Neither WMI arriving later nor birth="0" can prove ancestry.
      if (!owner || w.birth === '0' || !w.birth || owner.birth !== w.birth) {
        const message = `Unresolved visible window owner HWND ${w.hwnd} PID ${w.pid}`;
        if (errors) errors.push(message);
        else if (!terminalClasses.has(w.className)) throw new Error(message);
      }
      if (sample === samples[0]) { baseline.add(windowKey(w)); continue; }
      if (baseline.has(windowKey(w))) continue;
      const reason = terminalClasses.has(w.className) ? 'terminal-class' : descendants.has(processKey(w)) ? 'murage-child-window' : null;
      if (!reason) continue;
      const key = windowKey(w), prior = offenders.get(key);
      if (prior) { prior.lastSeenAt = sample.at; prior.observations++; }
      else offenders.set(key, {...w, reason, firstSeenAt:sample.at, lastSeenAt:sample.at, observations:1});
    }
    } catch(e) {
      if (!errors) throw e;
      errors.push(`Malformed sample ${index}: ${e.message}`);
    }
  }
  return [...offenders.values()];
}

export function verdict({samples, metadata = [], executable, observer, scenario, screenshot, screenshotBytes, selfTest = false}) {
  const errors = [], fail = message => errors.push(message);
  let offendingWindows = [];
  try { offendingWindows = judgeWindows(samples, executable, errors); } catch(e) { fail(e.message); }
  const meta = new Map(metadata.map(p => [processKey(p), p]));
  offendingWindows = offendingWindows.map(w => {
    const p = meta.get(processKey(w));
    if (!/^[a-z]:[\\/]/i.test(p?.imagePath ?? '') || !p?.commandLine) fail(`Missing owner metadata for HWND ${w.hwnd} PID ${w.pid}`);
    return {...w, imagePath:p?.imagePath || w.imagePath || null, commandLine:p?.commandLine || null, metadataError:p?.error || null};
  });
  if (observer?.intervalMs !== 200 || !Array.isArray(observer?.errors) || observer.errors.length) fail('Sampler failed or interval differs from 200 ms');
  if (!observer?.desktopVerified || !observer?.terminalDefault || observer?.windowsBuild < 22000) fail('Windows 11 / Windows Terminal / interactive desktop prerequisites unproven');
  const sampleRows = Array.isArray(samples) ? samples : [];
  // A malformed timestamp breaks coverage; keep judging/writing prior detections.
  const gaps = sampleRows.slice(1).map((s,i) => Number.isFinite(s?.at) && Number.isFinite(sampleRows[i]?.at) ? s.at-sampleRows[i].at : Infinity);
  const maxGapMs = Math.max(0,...gaps,observer?.finalGapMs ?? Infinity);
  if (sampleRows.length < 5 || maxGapMs > 400) fail('Sampler coverage missing or gap exceeds 400 ms');
  if (!screenshot || !(screenshotBytes > 100)) fail('Missing final desktop screenshot');
  if (!scenario?.ok || !scenario?.cleanup?.ok) fail('Scenario or owned cleanup failed');
  if (!selfTest) {
    for (const name of phases) {
      const rows = scenario?.phases?.filter(p => p.name === name) ?? [];
      if (rows.length !== 1 || rows[0].ok !== true) { fail(`Missing successful phase: ${name}`); continue; }
      if (!(rows[0].startedAt >= sampleRows[0]?.at && rows[0].endedAt <= sampleRows.at(-1)?.at && rows[0].endedAt >= rows[0].startedAt)) fail(`Sampler does not cover ${name}`);
    }
    if (!scenario?.installed?.sha256 || scenario.installed.version !== '1.0.19') fail('Packaged RC installation unproven');
  }
  const samplerHealthy = errors.length === 0;
  if (selfTest && !offendingWindows.some(w => terminalClasses.has(w.className))) fail('Self-test console was NOT detected');
  if (offendingWindows.length) fail(`${offendingWindows.length} NEW visible console/terminal or Murage child window(s)`);
  return {gate:'G-WINBOX', verdict:errors.length ? 'FAIL':'PASS', selfTest, selfTestPassed:selfTest && samplerHealthy && offendingWindows.some(w => terminalClasses.has(w.className)), intervalMs:200, samples:sampleRows.length, malformedSamples:errors.filter(e => e.startsWith('Malformed sample ')).length, maxGapMs, offendingWindows, errors, screenshot, scenario, observer};
}

export async function waitUntil(fn, label, {now=Date.now, sleep=ms=>new Promise(r=>setTimeout(r,ms)), timeout=120000}={}) {
  const end=now()+timeout;
  do { const value=await fn(); if(value) return value; await sleep(200); } while(now()<end);
  throw new Error(`Timeout: ${label}`);
}

// Shared with the Windows execution below; tests inject only transport/time/artifact functions.
export async function driveWorkflow({api, turn, bot, browser, sentinel, record, now=Date.now, wait=waitUntil}) {
  const rows=[];
  async function phase(name, action) {
    const startedAt=now(); const evidence=await action();
    const row={name,ok:true,startedAt,endedAt:now(),evidence};rows.push(row);await record(row);
  }
  await phase('chat',async()=>turn(await bot('chat'),'G-WINBOX real packaged chat turn'));
  await phase('shell-tool',async()=>turn(await bot('shell'),'Run local shell commands __custom_tool__:gatefallback'));
  await phase('routine',async()=>{
    const b=await bot('chat');
    const {routine}=await api('POST','/api/routines',{name:'G-WINBOX routine',botId:b.id,prompt:'G-WINBOX routine echo',enabled:false,schedule:{type:'interval',everyMinutes:30,anchorAt:now()},permissionMode:'ask'});
    assert(routine?.id,'routine creation');
    const started=await api('POST',`/api/routines/${routine.id}/run`,{});assert(started.run?.id,'routine run identity');
    const completed=await wait(async()=>{
      const {runs}=await api('GET','/api/routines');const run=runs.find(r=>r.id===started.run.id);
      if (run && ['failed','cancelled','interrupted'].includes(run.status)) throw new Error(`Routine ${run.status}`);
      return run?.status==='completed' && run;
    },'routine completed');
    await api('DELETE',`/api/routines/${routine.id}`);return {routine,completed};
  });
  await phase('browser',browser);
  await phase('sentinel',sentinel);
  return rows;
}

async function runPackaged(options) {
  assert.equal(process.platform,'win32','Windows runner only');
  const [{_electron},{seedTermsAccepted},{handleToolCall},{createNativeLauncher,fixtureEngineEntry},{createServer}] = await Promise.all([
    import('@playwright/test'),import('../control-murage.ts'),import('../mcp-server.ts'),import('./native-launcher.mjs'),import('node:http')]);
  const here=dirname(fileURLToPath(import.meta.url)), repo=resolve(here,'../..');
  const {fixture,executable,node}=options, data=join(fixture,'data'), evidence=join(fixture,'evidence');
  mkdirSync(data,{recursive:true});mkdirSync(evidence,{recursive:true});seedTermsAccepted(data);
  const json=(file,value)=>writeFileSync(file,JSON.stringify(value,null,2));
  const echoLog=join(evidence,'echo-protocol.jsonl'),modeFile=join(fixture,'echo-mode'),shellProof=join(evidence,'shell-proof.json');
  writeFileSync(modeFile,'echo');
  const engine=join(fixture,'fake-engine-entry.mjs');
  writeFileSync(engine,fixtureEngineEntry(pathToFileURL(join(repo,'server/testing/fake-codex-app-server.ts')).href,join(evidence,'mounts.jsonl')));
  const cli=`"${node}" --experimental-strip-types "${engine}"`;
  const shell=join(fixture,'gate-echo.cmd');
  writeFileSync(shell,`@echo off\r\n"${node}" "${join(here,'winbox-shell-mcp.mjs')}" "${echoLog}" "${modeFile}" "${shellProof}"\r\n`);
  json(join(data,'config.json'),{engineDiscovery:'explicit',instances:{
    chat:{driver:'codex',config:{cli,fullAuto:true},environment:{FAKE_CODEX_MODE:'happy',FAKE_CODEX_UNIQUE_THREADS:'1'}},
    shell:{driver:'codex',config:{cli,fullAuto:true},environment:{FAKE_CODEX_MODE:'happy',FAKE_CODEX_UNIQUE_THREADS:'1',FAKE_CUSTOM_TOOL_SERVER:'gatefallback',WINSCEN_ENGINE_KIND:'shell'}}
  },mcpServers:{gatefallback:{command:'gate-echo',args:[],enabled:true,env:{WINSCEN_ECHO:'override-confirmed'}}}});
  const env={};
  // Explicit allowlist: no credentials, real engine discovery, or user's app profile.
  for(const key of ['SystemRoot','WINDIR','COMSPEC','PATHEXT','COMPUTERNAME','USERNAME','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','MURAGE_DATA_DIR','MURAGE_USER_DATA','MURAGE_GATE_RUN_PREFIX','MURAGE_GATE_JOB_NAME','MURAGE_GATE_TASK_HELPER','MURAGE_GATE_NATIVE_BROKER']) if(process.env[key])env[key]=process.env[key];
  Object.assign(env,{PATH:`${fixture};${dirname(node)}`,MURAGE_ANNOUNCEMENTS_URL:'off',MURAGE_PUSH_RELAY_URL:'off'});
  const launcher=createNativeLauncher();let app,page,phaseRows=[];
  const updateConfig=join(dirname(executable),'resources','app-update.yml'), originalFeed=readFileSync(updateConfig);
  let browserRequests=0;
  const web=createServer((req,res)=>{if(req.url!=='/'){res.writeHead(404);res.end();return;}browserRequests++;res.setHeader('content-type','text/html');res.end('<!doctype html><title>G-WINBOX</title><h1>Local browser proof</h1>');});
  await new Promise((ok,no)=>{web.once('error',no);web.listen(0,'127.0.0.1',ok);});
  const url=`http://127.0.0.1:${web.address().port}/`;
  writeFileSync(updateConfig,`provider: generic\nurl: ${url}\nchannel: latest\nupdaterCacheDirName: winbox-fixture-updater\n`);
  const stop=async()=>{if(app){await app.close();app=null;}};
  try {
    app=await _electron.launch({executablePath:executable,args:[],env,timeout:120000});
    assert.equal(await app.evaluate(({app})=>app.isPackaged),true);assert.equal(await app.evaluate(({app})=>app.getVersion()),'1.0.19');
    page=await waitUntil(()=>app.windows().find(p=>p.url().startsWith('http://127.0.0.1:')),'packaged main window');
    const api=async(method,path,body)=>{
      const result=await page.evaluate(async({method,path,body})=>{
        const r=await fetch(path,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};
      },{method,path,body});assert(result.status>=200&&result.status<300,`${method} ${path}: ${JSON.stringify(result)}`);return result.body;
    };
    const call=(name,args)=>handleToolCall(name,args,(path,o={})=>api(o.method??'GET',path,o.body?JSON.parse(o.body):undefined));
    const bot=async(instance)=>{
      const {bot}=await api('POST','/api/bots',{name:`G-WINBOX ${instance}`,modelSelection:{instanceId:instance,model:'gpt-fake-default'}});
      await api('PATCH',`/api/bots/${bot.id}`,{computer:'off',browser:false,composio:false,autoApprove:true});return bot;
    };
    const turn=async(b,text)=>{
      await call('send_bot_message',{bot_id:b.id,text});
      const settled=await call('wait_for_conversation',{target_type:'bot',target_id:b.id,timeout_seconds:120});assert.equal(settled.status,'settled');
      const transcript=await call('get_bot_messages',{bot_id:b.id,limit:30});
      assert.match(JSON.stringify(transcript), b.modelSelection?.instanceId==='shell'?/gate echo override-confirmed/:/fake|gate echo/i);
      if(text.includes('__custom_tool__')) {const proof=JSON.parse(readFileSync(shellProof,'utf8'));assert.equal(proof.status,0);assert.match(proof.stdout,/winbox-shell-proof/);assert.equal(proof.hookInstalled,true);}
      return {action:text,settled,transcript};
    };
    const ps=join(env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
    await driveWorkflow({api,turn,bot,record:async row=>{phaseRows.push(row);json(join(fixture,'phases.json'),phaseRows);},
      browser:async()=>{
        const b=await bot('chat');await api('PATCH',`/api/bots/${b.id}`,{browser:true});const path=`/api/bots/${b.id}/browser`;
        await api('POST',path,{action:'restart'});await api('POST',path,{action:'take'});
        const state=await waitUntil(async()=>{const s=await api('GET',path);if(s.problem)throw new Error(s.problem);return s.connected&&s;},'packaged browser connected');
        const beforeRequests=browserRequests;
        const navigation=await api('POST',path,{action:'navigate',generation:state.generation,url});assert.equal(navigation.url,url);
        await waitUntil(()=>browserRequests>beforeRequests,'browser fetched local page');
        const frame=await waitUntil(async()=>{const s=await api('GET',path);const f=await api('GET',`${path}/frame?generation=${s.generation}`);return f?.data&&f;},'browser frame');
        const bytes=Buffer.from(frame.data.replace(/^data:image\/[^;]+;base64,/,''),'base64');assert(bytes.length>100);assert(frame.width>0&&frame.height>0);
        writeFileSync(join(evidence,'browser-frame.jpg'),bytes);await api('DELETE',`/api/bots/${b.id}`);return {navigation,width:frame.width,height:frame.height};
      },
      sentinel:async()=>{
        const script=join(here,'sentinel-scenario.ps1');
        await launcher.run(ps,['-NoProfile','-File',script,'-Mode','Open','-Fixture',fixture,'-Executable',executable]);
        await stop();
        await launcher.run(ps,['-NoProfile','-File',script,'-Mode','Closed','-Fixture',fixture,'-Executable',executable],300000);
        const proof=JSON.parse(readFileSync(join(evidence,'sentinel-closed.json'),'utf8').replace(/^\uFEFF/,''));assert(proof.recurringRuns>=2);assert.equal(proof.lastTaskResult,0);return proof;
      }
    });
  } finally {try{await stop();}finally{try{await launcher.close();}finally{writeFileSync(updateConfig,originalFeed);await new Promise(ok=>web.close(ok));}}}
}

async function main() {
  const [mode,file]=process.argv.slice(2);const input=JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  if(mode==='--run') {
    try {await runPackaged(input);} catch(e) {writeFileSync(join(input.fixture,'driver-error.json'),JSON.stringify({error:e.message,stack:e.stack},null,2));throw e;}
    return;
  }
  assert.equal(mode,'--verdict');
  const samples=readFileSync(input.samplesFile,'utf8').replace(/^\uFEFF/,'').trim().split('\n').filter(Boolean).map(JSON.parse);
  const result=verdict({...input,samples});
  writeFileSync(join(dirname(file),'offending-windows.json'),JSON.stringify(result.offendingWindows,null,2));
  writeFileSync(join(dirname(file),'verdict.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));process.exitCode=result.verdict==='PASS'?0:1;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(e=>{console.error(e.stack);process.exitCode=1;});
