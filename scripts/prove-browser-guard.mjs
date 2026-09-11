import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { UnifiedBrowserController } from '../server/browser-control.ts';
import { createNativeBrowser } from '../server/browser-native-relay.ts';
import { agentBrowserIntegration } from '../server/browser-engine.ts';
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
const target=`${process.platform}-${process.arch}`, suffix=process.platform==='win32'?'.exe':'';
const chromeDir={'darwin-arm64':'mac-arm64','darwin-x64':'mac-x64','win32-x64':'win64','linux-x64':'linux64'}[target];
const root=mkdtempSync(join(tmpdir(),'murage-c11-guard-'));
const evidence=resolve(process.argv[2]??'.planning/chief-capability-evidence/C11/native');mkdirSync(evidence,{recursive:true});
const spec=agentBrowserIntegration({binaryPath:resolve(`dist-native/browser/${target}/agent-browser${suffix}`),session:'guard-proof',encryptionKey:'b'.repeat(64),dataDir:root,realmId:'guard-proof',persistent:false,env:{...process.env,AGENT_BROWSER_EXECUTABLE_PATH:resolve(`dist-native/browser/${target}/chrome/chrome-headless-shell-${chromeDir}/chrome-headless-shell${suffix}`)}});
spec.env.MURAGE_BROWSER_BUNDLE_DIR=resolve(`dist-native/browser/${target}`);
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(req.url==='/protected'?'<input type="password" value="FAKE-C11-SECRET"><p>Protected fixture</p>':'<input id="ordinary"><p>Ordinary fixture</p><button id="mutate">Mutate</button><script>document.querySelector("#mutate").onmousedown=()=>{document.querySelector("#ordinary").type="password"}; document.querySelector("#ordinary").addEventListener("input",e=>{document.body.dataset.leak=e.target.value;e.target.type="text"});</script>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const native=createNativeBrowser(spec), controller=new UnifiedBrowserController({stateFile:join(root,'control.json'),createNative:()=>native});controller.register('fixture',spec);
const checks=[];let cleanupError;
try{
  await native.command(['open',`http://127.0.0.1:${server.address().port}/`]);
  const tools=await controller.dispatch('fixture','tools/list',{},()=>true);
  if(!tools.tools?.length)throw new Error('No real native MCP browser tools');checks.push({name:'native-mcp-tools',count:tools.tools.length});
  const snapshot=await controller.dispatch('fixture','tools/call',{name:'agent_browser_snapshot'},()=>true);
  if(snapshot.isError)throw new Error('Ordinary document refused');checks.push({name:'ordinary-document-observation',pass:true});
  let navigating=await controller.take('fixture','owner');
  navigating=await controller.navigate('fixture','owner',navigating.generation,`http://127.0.0.1:${server.address().port}/protected`);
  await controller.release('fixture','owner',navigating.generation);
  let refused=false;try{await controller.dispatch('fixture','tools/call',{name:'agent_browser_snapshot'},()=>true);}catch{refused=true;}
  if(!refused)throw new Error('Protected document leaked');checks.push({name:'protected-native-observation-refused',pass:true});
  const held=await controller.take('fixture','owner');const reopened=await controller.reopen('fixture','owner',held.generation);
  await controller.navigate('fixture','owner',reopened.generation,`http://127.0.0.1:${server.address().port}/`);
  await native.protected();
  // Page-world attempts cannot clear the isolated guard.
  await native.command(['eval','globalThis.__murageGuard=()=>false;document.querySelector("#ordinary").type="password";document.querySelector("#ordinary").dispatchEvent(new InputEvent("input",{bubbles:true,data:"fake"}));document.querySelector("#ordinary").type="text"']);
  if(!await native.protected())throw new Error('Page cleared sticky protected-input guard');checks.push({name:'isolated-sticky-taint-resists-page-reset',pass:true});
}catch(error){checks.push({error:error.message});process.exitCode=1;}
finally{await controller.close().catch(e=>{cleanupError=e.message;process.exitCode=1;});await new Promise(r=>server.close(r));if(!cleanupError)safeWipeSync(root);writeFileSync(join(evidence,`${target}-guard.json`),JSON.stringify({target,checks,cleanupError},null,2));}
console.log(JSON.stringify({target,checks,cleanupError},null,2));
