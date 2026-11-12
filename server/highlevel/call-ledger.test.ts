import { expect, it } from 'vitest';
import { HighLevelCallLedger } from './call-ledger.ts';
import { trustedHighlevelCallIdentity } from './engine-policy.ts';

it('only the exact recorded thread, generation and item relax a marked request',()=>{
  const ledger=new HighLevelCallLedger(()=>true);
  ledger.note('thread','turn','item',{source:'resolve_call',server:'engine',tool:'execute'});
  expect(ledger.classOf('thread','turn','item')).toBe('other');
  for(const [thread,generation,item] of [['other','turn','item'],['thread','next','item'],['thread','turn','other']])
    expect(ledger.classOf(thread,generation,item)).toBe('highlevel');
  ledger.note('thread','turn','item');
  expect(ledger.classOf('thread','turn','item')).toBe('highlevel');
  ledger.note('thread','turn','item',{source:'resolve_call',server:'engine',tool:'execute'});
  ledger.turnEnded('thread');
  expect(ledger.classOf('thread','turn','item')).toBe('highlevel');
});
it('a conflicting HighLevel identity remains held even if later relabelled',()=>{
  const ledger=new HighLevelCallLedger(()=>true);
  ledger.note('t','g','i',{source:'resolve_call',server:'own:highlevel'});
  ledger.note('t','g','i',{source:'resolve_call',server:'engine'});
  expect(ledger.classOf('t','g','i')).toBe('highlevel');
});
it('bounded retention never turns a newly proved call into a permanent deny',()=>{
  const ledger=new HighLevelCallLedger(()=>true);
  for(let i=0;i<2049;i++)expect(ledger.note('t','g',String(i),{source:'resolve_call',server:'engine'})).toBe('other');
  expect(ledger.classOf('t','g','0')).toBe('highlevel');
  expect(ledger.classOf('t','g','2048')).toBe('other');
});
it('titles and unknown driver names cannot prove a different tool',()=>{
  const event={type:'request.opened',threadId:'t',requestId:'r',toolEngine:'acp',toolKind:'other',toolCall:{name:'other',input:{title:'Bash'}}};
  expect(trustedHighlevelCallIdentity(event as never)).toBeUndefined();
  expect(trustedHighlevelCallIdentity({...event,toolEngine:'claude',toolCall:{name:'HIGHLEVEL_CONTACTS',input:{}}} as never)).toBeUndefined();
});
