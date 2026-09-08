// Isolated, no-model native browser proof. Only task-created local data is used.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { UnifiedBrowserController } from '../server/browser-control.ts';
import { createNativeBrowser } from '../server/browser-native-relay.ts';
import { agentBrowserIntegration } from '../server/browser-engine.ts';
const target = `${process.platform}-${process.arch}`;
const root = mkdtempSync(join(tmpdir(), 'murage-c11-proof-'));
const evidence = resolve(process.argv[2] ?? '.planning/chief-capability-evidence/C11/native');
mkdirSync(evidence, { recursive: true });
const binary = resolve(`dist-native/browser/${target}/agent-browser${process.platform === 'win32' ? '.exe' : ''}`);
const chromeDir = { 'darwin-arm64':'mac-arm64','darwin-x64':'mac-x64','win32-x64':'win64','linux-x64':'linux64' }[target];
const chrome = resolve(`dist-native/browser/${target}/chrome/chrome-headless-shell-${chromeDir}/chrome-headless-shell${process.platform === 'win32' ? '.exe' : ''}`);
const server = createServer((req,res) => { res.setHeader('Content-Type','text/html'); res.end('<!doctype html><html><body style="background:#123;color:white;font:24px sans-serif"><h1>Murage native browser proof</h1><label>Test name<input id="name" style="font-size:24px" /></label><button onclick="document.querySelector(\'h1\').textContent=\'Human input received\'">Continue</button></body></html>'); });
await new Promise(done => server.listen(0,'127.0.0.1',done));
const spec = agentBrowserIntegration({ binaryPath:binary, session:'murage-c11-proof', encryptionKey:'a'.repeat(64), dataDir:root, realmId:'native-fixture', persistent:false, env:{ ...process.env, AGENT_BROWSER_EXECUTABLE_PATH:chrome } });
const native = createNativeBrowser(spec);
const controller = new UnifiedBrowserController({ stateFile:join(root,'control.json'), createNative:()=>native });
spec.env.MURAGE_BROWSER_BUNDLE_DIR=resolve(`dist-native/browser/${target}`);
const results = { target, binary, chrome, profile:root, checks:[] };
try {
  controller.register('fixture',spec);
  let status = await controller.take('fixture','fixture-owner');
  results.checks.push({ name:'take',status });
  status = await controller.navigate('fixture','fixture-owner',status.generation,`http://127.0.0.1:${server.address().port}`);
  let frame;
  for (let i=0;i<50;i++) { frame=controller.frame('fixture',status.generation); if(frame)break; await new Promise(r=>setTimeout(r,100)); }
  if(!frame) throw new Error('No native stream frame');
  writeFileSync(join(evidence,`${target}-frame.jpg`),Buffer.from(frame.data,'base64'));
  const boxResult=await native.command(['get','box','#name']);
  const box=boxResult.box??boxResult;
  const x=box.x+box.width/2,y=box.y+box.height/2;
  controller.input('fixture','fixture-owner',status.generation,{type:'input_mouse',eventType:'mousePressed',x,y,button:'left',clickCount:1});
  controller.input('fixture','fixture-owner',status.generation,{type:'input_mouse',eventType:'mouseReleased',x,y,button:'left',clickCount:1});
  controller.input('fixture','fixture-owner',status.generation,{type:'input_keyboard',eventType:'char',text:'E2 native text'});
  await new Promise(r=>setTimeout(r,300));
  const value=await native.command(['get','value','#name']);
  if(value.value!=='E2 native text')throw new Error('Native typing did not reach fixture input: '+JSON.stringify(value));
  frame=controller.frame('fixture',status.generation);
  if(frame)writeFileSync(join(evidence,`${target}-input.jpg`),Buffer.from(frame.data,'base64'));
  results.checks.push({name:'native-frame-and-input',frameSeq:frame?.seq,status:controller.status('fixture')});
  status=await controller.release('fixture','fixture-owner',status.generation);
  try { await controller.dispatch('fixture','tools/call',{name:'agent_browser_snapshot'},()=>true); throw new Error('Tainted observation allowed'); } catch(error) { if(error.message==='Tainted observation allowed')throw error; }
  results.checks.push({name:'tainted-observation-refused',pass:true});
  status=await controller.take('fixture','fixture-owner');
  status=await controller.reopen('fixture','fixture-owner',status.generation);
  results.checks.push({name:'close-reopen',status});
  await native.close();
  await native.close();
  results.checks.push({name:'idempotent-idle-close',pass:true});
} catch(error) { results.error=error.message; process.exitCode=1; }
finally { await controller.close().catch(error=>{results.cleanupError=error.message;process.exitCode=1}); await new Promise(done=>server.close(done)); writeFileSync(join(evidence,`${target}.json`),JSON.stringify(results,null,2)); if(!results.cleanupError)rmSync(root,{recursive:true,force:true}); }
console.log(JSON.stringify(results,null,2));
