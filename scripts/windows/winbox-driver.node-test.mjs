import test from 'node:test';
import assert from 'node:assert/strict';
import {judgeWindows, verdict, driveWorkflow, waitUntil, phases} from './winbox-driver.mjs';
const executable='C:\\murage-ci\\results\\run\\fixture\\app\\Murage.exe';
const proc=(pid,parent=0,birth=String(pid),imagePath=`C:\\test\\p${pid}.exe`)=>({pid,parent,birth,imagePath});
const window=(pid,className='ConsoleWindowClass',extra={})=>({pid,birth:String(pid),hwnd:String(pid*100),className,visible:true,title:'test',...extra});
const samples=(windows=[])=>Array.from({length:6},(_,i)=>({at:1000+i*200,processes:[proc(10,0,'10',executable),proc(20,10),proc(30,20),proc(40)],windows:i===0?[]:windows}));
function healthy(extra={}) {return {executable,samples:samples(),metadata:[],observer:{intervalMs:200,errors:[],desktopVerified:true,terminalDefault:true,windowsBuild:26100,finalGapMs:2},scenario:{ok:true,cleanup:{ok:true},installed:{sha256:'a'.repeat(64),version:'1.0.19'},phases:phases.map(name=>({name,ok:true,startedAt:1200,endedAt:1800}))},screenshot:'desktop-end.png',screenshotBytes:1024,...extra};}

test('all three console/Terminal classes fail globally, without Murage ancestry',()=>{
  for(const cls of ['CASCADIA_HOSTING_WINDOW_CLASS','ConsoleWindowClass','PseudoConsoleWindow']) {
    const input=healthy({samples:samples([window(40,cls)]),metadata:[{...proc(40),commandLine:'cmd.exe /c echo hello'}]});
    const r=verdict(input);assert.equal(r.verdict,'FAIL');assert.equal(r.offendingWindows.length,1);assert.equal(r.offendingWindows[0].observations,5);assert.equal(r.offendingWindows[0].commandLine,'cmd.exe /c echo hello');assert.equal(r.offendingWindows[0].imagePath,'C:\\test\\p40.exe');
  }
});
test('baseline allows only already visible windows, not initially hidden windows',()=>{
  const s=samples([window(40)]);s[0].windows=[window(40)];assert.deepEqual(judgeWindows(s,executable),[]);
  s[0].windows[0].visible=false;assert.equal(judgeWindows(s,executable).length,1);
});
test('hidden console windows are recorded but never offending',()=>assert.equal(verdict(healthy({samples:samples([window(40,'ConsoleWindowClass',{visible:false})])})).verdict,'PASS'));
test('visible descendants include arbitrary classes at any tree depth; main app and unrelated GUI allowed',()=>{
  const s=samples([window(10,'Chrome_WidgetWin_1'),window(20,'PopupClass'),window(30,'OtherClass'),window(40,'NotConsole')]);
  assert.deepEqual(judgeWindows(s,executable).map(w=>[w.pid,w.reason]),[[20,'murage-child-window'],[30,'murage-child-window']]);
});
test('ancestry is resolved independent of snapshot order and executable path case/slashes',()=>{
  const s=samples([window(30,'popup')]);for(const x of s){x.processes.reverse();x.processes.find(p=>p.pid===10).imagePath=executable.toUpperCase().replaceAll('\\','/');}
  assert.equal(judgeWindows(s,executable)[0].reason,'murage-child-window');
});
test('ancestry survives exited parents and PID reuse never invents new ancestry',()=>{
  const s=samples([window(30,'popup')]);s[1].processes=s[1].processes.filter(p=>p.pid!==20);
  assert.equal(judgeWindows(s,executable)[0].reason,'murage-child-window');
  const reused=samples([window(30,'popup')]);
  for(const x of reused)x.processes=[proc(10,0,'10',executable),proc(20,10,'200'),proc(30,20,'30')];
  assert.deepEqual(judgeWindows(reused,executable),[]);
});
test('reused HWND/PID with new process birth is not baseline-exempt',()=>{
  const s=samples([window(40,'ConsoleWindowClass',{birth:'400'})]);s[0].windows=[window(40)];
  assert.equal(judgeWindows(s,executable).length,1);
});
test('short one-sample flash remains evidence; repeated observations deduplicate',()=>{
  const s=samples();s[2].windows=[window(40)];const rows=judgeWindows(s,executable);assert.equal(rows.length,1);assert.equal(rows[0].observations,1);assert.equal(rows[0].firstSeenAt,1400);
});
test('positive run requires complete workflow, cleanup, screenshot, prerequisites, and sample coverage',()=>{
  assert.equal(verdict(healthy()).verdict,'PASS');
  const bad=[{samples:[]},{samples:[samples()[0]]},{observer:{...healthy().observer,intervalMs:250}},{observer:{...healthy().observer,errors:['EnumWindows failed']}},{observer:{...healthy().observer,desktopVerified:false}},{observer:{...healthy().observer,terminalDefault:false}},{observer:{...healthy().observer,windowsBuild:19045}},{observer:{...healthy().observer,finalGapMs:401}},{screenshotBytes:0},{scenario:{...healthy().scenario,cleanup:{ok:false}}},{scenario:{...healthy().scenario,phases:healthy().scenario.phases.slice(1)}},{scenario:{...healthy().scenario,installed:null}}];
  for(const change of bad)assert.equal(verdict(healthy(change)).verdict,'FAIL',JSON.stringify(change));
  const s=samples();s[3].at+=500;assert.equal(verdict(healthy({samples:s})).verdict,'FAIL');
  const scenario=structuredClone(healthy().scenario);scenario.phases[0].startedAt=900;assert.equal(verdict(healthy({scenario})).verdict,'FAIL');
});
test('unresolvable offending owner metadata fails with actionable null fields',()=>{
  const r=verdict(healthy({samples:samples([window(40)])}));assert.equal(r.verdict,'FAIL');assert.equal(r.offendingWindows[0].commandLine,null);assert.match(r.errors.join(' '),/Missing owner metadata/);
  const partial=verdict(healthy({samples:samples([window(40)]),metadata:[{...proc(40),imagePath:'cmd.exe',commandLine:'cmd.exe /c start'}]}));assert.match(partial.errors.join(' '),/Missing owner metadata/);
});
test('self-test must FAIL and separately prove detector health; blind sampler cannot pass self-test',()=>{
  const self=healthy({selfTest:true,scenario:{ok:true,cleanup:{ok:true}},samples:samples([window(40,'CASCADIA_HOSTING_WINDOW_CLASS')]),metadata:[{...proc(40),commandLine:'WindowsTerminal.exe'}]});
  const r=verdict(self);assert.equal(r.verdict,'FAIL');assert.equal(r.selfTestPassed,true);assert.equal(r.offendingWindows.length,1);
  assert.equal(verdict({...self,samples:samples()}).selfTestPassed,false);
  assert.equal(verdict({...self,observer:{...self.observer,errors:['missed tick']}}).selfTestPassed,false);
  assert.equal(verdict({...self,metadata:[]}).selfTestPassed,false);
});
test('invalid sample ordering/identity cannot produce PASS',()=>{
  const s=samples();s[1].at=s[0].at;assert.equal(verdict(healthy({samples:s})).verdict,'FAIL');
  const p=samples();delete p[0].processes[0].birth;assert.equal(verdict(healthy({samples:p})).verdict,'FAIL');
});

test('BLOCK 1: visible owner absent from the process snapshot fails coverage',()=>{
  // EnumWindows can see a short-lived child created after Toolhelp took its snapshot.
  for(const birth of ['0','50']) {
    const s=samples();s[2].windows=[window(50,'ChildPopup',{birth,imagePath:''})];
    const r=verdict(healthy({samples:s}));
    assert.equal(r.verdict,'FAIL','an observed window with unknown ancestry must not pass');
    assert.match(r.errors.join(' '),/Unresolved visible window owner.*5000.*50/);
  }
  const s=samples();for(const row of s)row.processes.push(proc(50,10,'0'));
  s[2].windows=[window(50,'ChildPopup',{birth:'0'})];
  assert.equal(verdict(healthy({samples:s})).verdict,'FAIL','birth zero cannot prove owner identity');
});

test('BLOCK 2: later invalid samples retain earlier offenders and subsequent detections',()=>{
  for(const corrupt of [s=>{s.at=1200;},s=>{delete s.processes;},s=>{delete s.windows;},s=>{delete s.processes[0].birth;}]) {
    const s=samples();s[1].windows=[window(40)];corrupt(s[3]);s[4].windows=[window(40),window(30,'ChildPopup')];
    const metadata=[40,30].map(pid=>({...proc(pid),commandLine:`p${pid}.exe`}));
    const r=verdict(healthy({samples:s,metadata}));
    assert.equal(r.verdict,'FAIL');assert(r.errors.some(e=>/unordered|incomplete|identity/.test(e)));
    assert.deepEqual(r.offendingWindows.map(w=>w.pid),[40,30]);
    assert.equal(r.offendingWindows[0].observations,2);
    assert.equal(r.offendingWindows[0].firstSeenAt,1200);
    assert.equal(r.offendingWindows[0].commandLine,'p40.exe');
  }
});
function transport({runStatus='completed',routineRunId='run-owned'}={}) {
  const actions=[],recorded=[];let tick=1000,reads=0;
  return {actions,recorded,api:async(method,path,body)=>{
    actions.push([method,path,body]);
    if(method==='POST'&&path==='/api/routines')return {routine:{id:'routine-owned'}};
    if(path==='/api/routines/routine-owned/run')return {run:{id:routineRunId}};
    if(method==='GET'&&path==='/api/routines')return {runs:[{id:'other',status:'completed'},{id:'run-owned',status:++reads<2?'running':runStatus}]};
    return {};
  },bot:async instance=>({id:`bot-${instance}`}),turn:async(b,text)=>{actions.push(['turn',b.id,text]);return {transcript:'real test transport'};},browser:async()=>{actions.push(['browser']);return {url:'loopback'};},sentinel:async()=>{actions.push(['sentinel']);return {recurringRuns:2};},record:async row=>recorded.push(row),now:()=>tick++,wait:(fn,label)=>waitUntil(fn,label,{now:()=>tick++,sleep:async()=>{},timeout:20})};
}
test('driver executes five real transports in order and waits for its exact routine completion',async()=>{
  const d=transport();const rows=await driveWorkflow(d);assert.deepEqual(rows.map(p=>p.name),phases);assert.deepEqual(d.recorded,rows);
  assert.equal(d.actions.filter(a=>a[0]==='GET').length,2);
  const definition=d.actions.find(a=>a[1]==='/api/routines'&&a[0]==='POST')[2];assert.equal(definition.enabled,false);assert.equal(definition.botId,'bot-chat');
  assert(d.actions.some(a=>a[0]==='DELETE'&&a[1]==='/api/routines/routine-owned'));
  assert(rows.every(r=>r.ok&&r.endedAt>=r.startedAt));
});
test('failed or hung routine prevents browser/Sentinel phases and cannot be recorded successful',async()=>{
  for(const runStatus of ['failed','running']) {
    const d=transport({runStatus});await assert.rejects(driveWorkflow(d),runStatus==='failed'?/Routine failed/:/Timeout/);
    assert.deepEqual(d.recorded.map(p=>p.name),['chat','shell-tool']);assert(!d.actions.some(a=>a[0]==='browser'));
  }
});
test('missing routine run identity is fatal',async()=>{const d=transport({routineRunId:null});await assert.rejects(driveWorkflow(d),/routine run identity/);});
test('wait timeout is bounded and callback errors are not swallowed',async()=>{
  let time=0;await assert.rejects(waitUntil(()=>false,'never',{now:()=>time,sleep:async ms=>{time+=ms;},timeout:400}),/Timeout: never/);assert.equal(time,400);
  await assert.rejects(waitUntil(()=>{throw new Error('connection lost');},'read'),/connection lost/);
});

test('CLI emits JSON verdict and separate offending-owner list with failure exit status',async()=>{
  const {mkdtempSync,writeFileSync,readFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {spawnSync}=await import('node:child_process');
  const dir=mkdtempSync(join(tmpdir(),'winbox-cli-'));
  try {
    const input=healthy({selfTest:true,samples:samples([window(40,'ConsoleWindowClass')]),metadata:[{...proc(40),commandLine:'cmd.exe /c start deliberate'}]});
    const samplesFile=join(dir,'windows.jsonl');writeFileSync(samplesFile,input.samples.map(s=>JSON.stringify(s)).join('\n')+'\n');
    const request=join(dir,'verdict-input.json');writeFileSync(request,'\uFEFF'+JSON.stringify({...input,samples:undefined,samplesFile}));
    const result=spawnSync(process.execPath,['scripts/windows/winbox-driver.mjs','--verdict',request],{encoding:'utf8'});
    assert.equal(result.status,1,result.stderr);
    const r=JSON.parse(readFileSync(join(dir,'verdict.json'),'utf8'));assert.equal(r.verdict,'FAIL');assert.equal(r.selfTestPassed,true);
    const offenders=JSON.parse(readFileSync(join(dir,'offending-windows.json'),'utf8'));assert.equal(offenders[0].commandLine,'cmd.exe /c start deliberate');
    assert.deepEqual(JSON.parse(result.stdout),r);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('BLOCK 2 CLI: invalid later sample retains the offending-window artifact',async()=>{
  const {mkdtempSync,writeFileSync,readFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {spawnSync}=await import('node:child_process');
  const dir=mkdtempSync(join(tmpdir(),'winbox-invalid-'));
  try {
    const s=samples();s[1].windows=[window(40)];delete s[3].processes;
    const input=healthy({samples:s,metadata:[{...proc(40),commandLine:'cmd.exe /c start deliberate'}]});
    const samplesFile=join(dir,'windows.jsonl');writeFileSync(samplesFile,s.map(row=>JSON.stringify(row)).join('\n'));
    const request=join(dir,'verdict-input.json');writeFileSync(request,JSON.stringify({...input,samples:undefined,samplesFile}));
    const result=spawnSync(process.execPath,['scripts/windows/winbox-driver.mjs','--verdict',request],{encoding:'utf8'});
    assert.equal(result.status,1,result.stderr);
    const output=JSON.parse(readFileSync(join(dir,'verdict.json'),'utf8'));
    const offenders=JSON.parse(readFileSync(join(dir,'offending-windows.json'),'utf8'));
    assert.match(output.errors.join(' '),/incomplete sample/);
    assert.equal(offenders.length,1);assert.equal(offenders[0].pid,40);
    assert.equal(offenders[0].commandLine,'cmd.exe /c start deliberate');
    assert.deepEqual(offenders,output.offendingWindows);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('ROUND 3: malformed sample rows fail with counts and retain earlier and later detections',()=>{
  for(const bad of [null, false, 42, 'bad', [], {}, {at:null}, {at:1600,processes:[],windows:null}, {at:1600,processes:[null],windows:[]}, {at:1600,processes:[],windows:[null]}]) {
    for(const index of [0,3,5]) {
      const s=samples();s[1].windows=[window(40)];s[4].windows=[window(30,'ChildPopup')];s[index]=bad;
      const input=healthy({samples:s,metadata:[40,30].map(pid=>({...proc(pid),commandLine:`p${pid}.exe`}))});
      let output;assert.doesNotThrow(()=>{output=verdict(input);});
      assert.equal(output.verdict,'FAIL');assert.equal(output.malformedSamples,1);
      assert.deepEqual(output.offendingWindows.map(w=>[w.pid,w.commandLine]),[[40,'p40.exe'],[30,'p30.exe']]);
    }
  }
});

test('ROUND 3 CLI: later null JSONL row retains console metadata in both FAIL artifacts',async()=>{
  const {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {spawnSync}=await import('node:child_process');
  const dir=mkdtempSync(join(tmpdir(),'winbox-null-'));
  try {
    const s=samples();s[1].windows=[window(40)];s[3]=null;
    const input=healthy({samples:s,metadata:[{...proc(40),commandLine:'cmd.exe /c start deliberate'}]});
    const samplesFile=join(dir,'windows.jsonl');writeFileSync(samplesFile,s.map(row=>JSON.stringify(row)).join('\n'));
    const request=join(dir,'verdict-input.json');writeFileSync(request,JSON.stringify({...input,samples:undefined,samplesFile}));
    const result=spawnSync(process.execPath,['scripts/windows/winbox-driver.mjs','--verdict',request],{encoding:'utf8'});
    assert.equal(result.status,1,result.stderr);
    for(const file of ['verdict.json','offending-windows.json'])assert(existsSync(join(dir,file)),`${file} must survive a later null sample: ${result.stderr}`);
    const output=JSON.parse(readFileSync(join(dir,'verdict.json'),'utf8'));
    const offenders=JSON.parse(readFileSync(join(dir,'offending-windows.json'),'utf8'));
    assert.equal(output.verdict,'FAIL');assert.equal(output.malformedSamples,1);
    assert.match(output.errors.join(' '),/Malformed sample/);
    assert.deepEqual(offenders,output.offendingWindows);assert.equal(offenders.length,1);
    assert.equal(offenders[0].pid,40);assert.equal(offenders[0].imagePath,'C:\\test\\p40.exe');
    assert.equal(offenders[0].commandLine,'cmd.exe /c start deliberate');
    assert.deepEqual(JSON.parse(result.stdout),output);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
