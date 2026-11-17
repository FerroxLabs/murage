import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNodeFixture, closeLinuxFixture } from './native-launcher.mjs';
import { once } from 'node:events';
import { safeWipeSync } from '../../server/testing/safe-wipe.mjs';
for(const mode of ['echo','error','hold']) test(`stdio fixture ${mode}`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'winscen-echo-')),log=join(dir,'log'),modeFile=join(dir,'mode');writeFileSync(modeFile,mode);
 const child=startNodeFixture(['scripts/windows/echo-mcp.mjs',log,modeFile],{env:{WINSCEN_ECHO:'override-confirmed'},stdio:['pipe','pipe','pipe']});
 let stdout='';child.stdout.on('data',d=>stdout+=d);
 try {
  for(const [id,method,params] of [[1,'initialize',{}],[2,'tools/list',{}],[3,'tools/call',{name:'echo',arguments:{text:'hello'}}]]) child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  const deadline=Date.now()+5000;
  while(!stdout.includes('"id":2')||(mode!=='hold'&&!stdout.includes('"id":3'))){assert(Date.now()<deadline);await new Promise(r=>setTimeout(r,20));}
  child.stdin.end();await once(child,'exit');
  const messages=stdout.trim().split('\n').map(JSON.parse);assert.equal(messages[0].result.serverInfo.name,'gate-echo');assert.equal(messages[1].result.tools[0].name,'echo');
  if(mode==='hold') {assert.equal(messages.length,2);assert.match(readFileSync(log,'utf8'),/"event":"held"/);}
  else {assert.equal(messages[2].result.isError,mode==='error');assert.match(messages[2].result.content[0].text,mode==='echo'?/override-confirmed: hello/:/deliberate error/);}
 }finally{await closeLinuxFixture(child);safeWipeSync(dir);}
});
