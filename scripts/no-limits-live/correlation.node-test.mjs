import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CardLedger} from './counts.mjs';
test('card correlation indexes only the current thread and message window',()=>{
 const ledger=new CardLedger();
 for(let i=0;i<1000;i++)ledger.observe('unrelated-'+i,{id:'m',kind:'options',at:1,card:{requestId:'r',approvalId:'a'}});
 ledger.observe('current',{id:'m',kind:'options',at:50,card:{requestId:'r',approvalId:'a'}});
 ledger.observe('current',{id:'older',kind:'options',at:50,card:{requestId:'old',approvalId:'old'}});
 const record={id:'a',source_kind:'engine',thread_id:'current',request_id:'r',chat_message_id:'m',why:'base',evidence:JSON.stringify({items:[],initiator:{k:'other-human'}})};
 const get=ledger.cards.get.bind(ledger.cards);let cardReads=0;ledger.cards.get=key=>{cardReads++;return get(key);};
 let reads=0;const measured=new Proxy(record,{get(t,k){reads++;return t[k];}});
 ledger.correlate([measured],{threadId:'current',messageIds:['m'],start:10,end:100});
 assert.ok(cardReads<=2,`unrelated thread cards scanned: ${cardReads}`);
 assert.equal(ledger.cards.get('current:r').recordId,'a');assert.ok(reads<30,`unbounded correlation: ${reads}`);
 const old={...record,id:'old',request_id:'old',chat_message_id:'older'};
 ledger.correlate([old],{threadId:'current',messageIds:['m'],start:10,end:100});
 assert.equal(ledger.cards.get('current:old').recordId,undefined);
});
