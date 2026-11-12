import {createNativeLauncher,fixturePid,fixtureInput,windowsHideHookInstalled} from './native-launcher.mjs';
// Console-subsystem node.exe fixture. The packaged MCP proxy must hide this child.
import { appendFileSync, readFileSync } from 'node:fs';
const log=process.argv[2], modeFile=process.argv[3];
const record=x=>appendFileSync(log,JSON.stringify({at:Date.now(),pid:fixturePid(),...x})+'\n');
record({event:'start',override:process.env.WINSCEN_ECHO});
if(process.env.WINSCEN_CMD_CHAIN==='1') {
 if(process.platform!=='win32')throw new Error('Windows Claude chain only');
 // The inherited package preload is observed on this Node process; native
 // execution uses the shared suspended-job owner required by p11c.
 const launcher=createNativeLauncher();
 const stdout=await launcher.run(process.env.COMSPEC,['/d','/c','echo gate-cmd-chain'],10000);
 await launcher.close();
 const child={status:0,stdout};
 record({event:'cmd-chain',hookInstalled:windowsHideHookInstalled(),preloadInherited:(process.env.NODE_OPTIONS||'').includes('murage.windowsHide.installed')||(process.env.NODE_OPTIONS||'').includes('murage.windowsHide'),status:child.status,stdout:child.stdout,error:child.error?.message});
 if(child.status!==0)throw new Error('cmd chain failed');
}
const output=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
const input=fixtureInput();
input.on('line',line=>{
 const m=JSON.parse(line); record({method:m.method,params:m.params});
 if(m.method==='initialize') output(m.id,{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'gate-echo',version:'1.0.0'}});
 if(m.method==='tools/list') output(m.id,{tools:[{name:'echo',description:'Local gate echo',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]});
 if(m.method==='tools/call') {
  const mode=readFileSync(modeFile,'utf8').trim();
  if(mode==='hold') { record({event:'held'}); return; }
  const text=mode==='error'?'gate echo deliberate error':`gate echo ${process.env.WINSCEN_ECHO}: ${m.params.arguments.text}`;
  record({event:'result',text,isError:mode==='error'});
  output(m.id,{content:[{type:'text',text}],isError:mode==='error'});
 }
});
input.on('close',()=>{record({event:'closed'}); process.exit(0);});
