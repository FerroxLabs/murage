import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchLive} from './run.mjs';
// Native loader probe lets the mutation qualifier break the actual launch
// path without rewriting a product file or relying on Vitest transform hooks.
test('the owned launcher enables permissions and authenticates its paired phone', {timeout:90000},async()=>{
 const out=mkdtempSync(join(tmpdir(),'gnl-launch-contract-'));let f;
 try{
  f=await launchLive(out,[{id:'claude',driver:'claudeAgent',path:fileURLToPath(new URL('./fakes/claude.mjs',import.meta.url))}]);
  await f.client.connect();
  const bot=await f.client.bot('Phone launch control',{id:'claude',model:'sonnet'},f.work,'unlimited');
  const got=await f.client.api('GET',`/api/bots/${bot.id}`,undefined,f.phoneHeaders);
  assert.equal(got.bot.id,bot.id);assert.equal(got.bot.noLimits,true);
 }finally{
  await f?.client.disconnect();await f?.close();if(f)assert.equal(existsSync(f.root),false);
  rmSync(out,{recursive:true,force:true});
 }
});
