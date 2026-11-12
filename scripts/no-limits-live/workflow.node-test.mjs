import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runR2 } from './r2-scenarios.mjs';
for(const [id,tool]of [['deny-host-declined','computer_screenshot'],['deny-browser-never','browser_navigate']])
test(`${id} proves successful execution with zero cards under the new ruling`,async()=>{
  let effect=0;const input={};const obs={cards:[],events:[{type:'item.started',itemType:'tool',itemId:'action',input,toolIdentity:{name:tool}},{type:'item.completed',itemType:'tool',itemId:'action',ok:true}]};
  const c={api:async()=>({}),turn:async()=>{effect++;return obs;}};
  const result=await runR2({c,f:{r2Targets:{[id]:{tool,input,readEffect:()=>effect}}},bot:{id:'fixture'},spec:{id,expected:'RUN'},cwd:'/fixture',site:{url:'http://fixture.invalid'},prompt:(_cwd,text)=>text});
  assert.equal(result.proof,true);
});
