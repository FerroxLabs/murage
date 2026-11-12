const {test}=process.env.VITEST ? await import('vitest') : await import('node:test');
import assert from 'node:assert/strict';
import {ProductClient} from './run.mjs';
test('ProductClient waits through refused submission to the replacement turn',async()=>{
 const c=new ProductClient('http://127.0.0.1:1',{},'/unused',3000);let polls=0;
 c.api=async()=>{polls++;if(polls===2)c.events.push({type:'turn.started',threadId:'t',turnId:'new'},{type:'turn.completed',threadId:'t',turnId:'new',ok:true});return {openCards:[],pending:false};};
 c.messages=async()=>[];
 const result=await c.observe({id:'b',threadId:'t'},async()=>c.events.push({type:'turn.started',threadId:'t',turnId:'old'},{type:'turn.completed',threadId:'t',turnId:'old',ok:false,stopReason:'submission_refused'}));
 assert.equal(result.ended,true);assert.equal(result.turn.turnId,'new');assert.ok(polls>=2);
});
