import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installBindings } from './bindings.mjs';
for(const [id,source]of [['deny-app-denied','request-denied'],['deny-app-revoked','grant-revoked']])
test(`${id} binds a real persisted denial fixture and observes its inert app effect`,async()=>{
  const root=mkdtempSync(join(tmpdir(),'gnl-app-binding-')),capture=join(root,'app.ndjson');writeFileSync(capture,'');
  let prepared;
  const c={api:async()=>({policy:{denials:[{source:prepared}]}}),turn:async()=>{appendFileSync(capture,'{"ok":true}\n');return {cards:[],events:[{type:'item.started',itemType:'tool',itemId:'app',toolIdentity:{name:'mcp__fixture__connected_app_write'},input:{toolkit:'gmail',tool_slug:'GMAIL_SEND_EMAIL',accountId:'fixture-account',text:'fixture'}},{type:'item.completed',itemType:'tool',itemId:'app',ok:true}]};}};
  const f={client:c,appCapture:capture,prepareAppDenial:async(_id,value)=>{prepared=value;}};
  const bindings=installBindings(f);
  try {
    const result=await bindings[id]({client:c,bot:{id:'fixture'},spec:{id},cwd:root});
    assert.equal(prepared,source);assert.equal(result.proof,true);assert.equal(result.originWitness.source,source);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('a generic MCP effect cannot prove a connected-app denial target was exercised',async()=>{
 const root=mkdtempSync(join(tmpdir(),'gnl-app-wrong-target-')),capture=join(root,'app.ndjson');writeFileSync(capture,'');
 const c={api:async()=>({policy:{denials:[{source:'request-denied'}]}}),turn:async()=>{appendFileSync(capture,'{"ok":true}\n');return {cards:[],events:[{type:'item.started',itemType:'tool',itemId:'generic',toolIdentity:{name:'mcp__fixture__write'},input:{text:'fixture'}},{type:'item.completed',itemType:'tool',itemId:'generic',ok:true}]};}};
 try{
  const result=await installBindings({appCapture:capture,prepareAppDenial:async()=>{}})['deny-app-denied']({client:c,bot:{id:'fixture'},spec:{id:'deny-app-denied'}});
  assert.equal(result.proof,false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('an app tool receipt without its independently captured effect cannot prove execution',async()=>{
 const root=mkdtempSync(join(tmpdir(),'gnl-app-no-effect-')),capture=join(root,'app.ndjson');writeFileSync(capture,'');
 const c={api:async()=>({policy:{denials:[{source:'request-denied'}]}}),turn:async()=>({cards:[],events:[{type:'item.started',itemType:'tool',itemId:'app',toolIdentity:{name:'mcp__fixture__connected_app_write'},input:{toolkit:'gmail',tool_slug:'GMAIL_SEND_EMAIL',accountId:'fixture-account',text:'fixture'}},{type:'item.completed',itemType:'tool',itemId:'app',ok:true}]})};
 try{
  const result=await installBindings({appCapture:capture,prepareAppDenial:async()=>{}})['deny-app-denied']({client:c,bot:{id:'fixture'},spec:{id:'deny-app-denied'}});
  assert.equal(result.proof,false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
