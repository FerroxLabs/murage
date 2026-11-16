import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeAppDenial} from './app-fixture.mjs';
import {describe} from '../../server/decision/action.ts';
test('the inert app tool traverses the real connected-app denial classification',()=>{
 const action=describe({tool:'mcp__fixture__connected_app_write',input:{toolkit:'gmail',tool_slug:'GMAIL_SEND_EMAIL',accountId:'fixture-account',text:'fixture'}});
 assert.deepEqual(action.targets,[{kind:'connected-app',toolkit:'gmail',tool:'GMAIL_SEND_EMAIL',accountId:'fixture-account',op:'write'}]);
});
test('saved app denial represents both denied and revoked fixtures',()=>{
 const root=mkdtempSync(join(tmpdir(),'gnl-app-state-'));
 try{for(const source of ['request-denied','grant-revoked']){
  writeFileSync(join(root,'bots.json'),JSON.stringify([{id:'fixture',name:'fixture'}]));
  writeAppDenial(root,'fixture',source);
  const [bot]=JSON.parse(readFileSync(join(root,'bots.json'),'utf8'));
  assert.equal(bot.connectedAppAccess.denials[0].source,source);assert.equal(bot.connectedAppAccess.mode,'restricted');assert.deepEqual(bot.connectedAppAccess.grants,[]);
 }}finally{rmSync(root,{recursive:true,force:true});}
});
test('inert MCP exposes exact field write and connected-app tools, never executes input',()=>{
 const root=mkdtempSync(join(tmpdir(),'gnl-app-mcp-')),capture=join(root,'capture');
 const messages=[{id:1,method:'initialize'},{id:2,method:'tools/list'},
  {id:3,method:'tools/call',params:{name:'write',arguments:{text:'rm -rf ~'}}},
  {id:4,method:'tools/call',params:{name:'connected_app_write',arguments:{text:'rm -rf ~'}}}];
 try{
  const child=spawnSync(process.execPath,[fileURLToPath(new URL('./fakes/app-mcp.mjs',import.meta.url))],{input:messages.map(m=>JSON.stringify({...m,jsonrpc:'2.0'})).join('\n')+'\n',encoding:'utf8',env:{...process.env,GNL_FIXTURE_CAPTURE:capture},timeout:10000});
  assert.equal(child.status,0,child.stderr);const replies=child.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(replies[1].result.tools.map(t=>t.name).sort(),['connected_app_write','write']);
  assert.equal(replies[2].result.isError,false);assert.equal(replies[3].result.isError,false);
  assert.equal(readFileSync(capture,'utf8').trim().split('\n').length,2);
 }finally{rmSync(root,{recursive:true,force:true});}
});
